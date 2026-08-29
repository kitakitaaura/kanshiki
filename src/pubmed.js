import { classifyStudy, TIER_LABELS } from "./classify.js";
import { classifyFunding } from "./funding.js";
import { logEvent, LOG_EVENTS } from "./log.js";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const DEFAULT_RETMAX = 20;
const TIMEOUT_MS = 12000;

export const FUNDING_FETCH_CONFIG = {
  usePmcFullText: true,
  maxPmcLookups: 6,
  maxStatementChars: 1200,
};

export function decodeXmlEntities(text) {
  return decodeEntities(text);
}

function withCommonParams(params, env = {}) {
  params.set("tool", env.NCBI_TOOL || "kanshiki");
  if (env.NCBI_EMAIL) params.set("email", env.NCBI_EMAIL);
  if (env.NCBI_API_KEY) params.set("api_key", env.NCBI_API_KEY);
  return params;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function eutil(endpoint, params, env, attempt = 0) {
  const url = `${EUTILS}/${endpoint}?${withCommonParams(params, env)}`;
  const res = await fetch(url, {
    headers: { accept: "application/json,text/xml" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 3 req/sec without an API key, 10 with one.
  if ((res.status === 429 || res.status >= 500) && attempt < 2) {
    await sleep(400 * (attempt + 1));
    return eutil(endpoint, params, env, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`PubMed ${endpoint} failed: ${res.status} ${res.statusText}`);
  }
  return res;
}

export async function esearch(query, env = {}, { retmax = DEFAULT_RETMAX } = {}) {
  const params = new URLSearchParams({
    db: "pubmed",
    term: query,
    retmode: "json",
    retmax: String(retmax),
    sort: "relevance",
  });
  const res = await eutil("esearch.fcgi", params, env);
  const json = await res.json();
  const result = json?.esearchresult ?? {};
  return {
    pmids: Array.isArray(result.idlist) ? result.idlist : [],
    total: Number(result.count ?? 0) || 0,
  };
}

function parseYear(summary) {
  const raw = summary?.pubdate || summary?.epubdate || summary?.sortpubdate || "";
  const match = String(raw).match(/\b(1[89]\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

export async function esummary(pmids, env = {}) {
  if (!pmids.length) return [];
  const params = new URLSearchParams({
    db: "pubmed",
    id: pmids.join(","),
    retmode: "json",
  });
  const res = await eutil("esummary.fcgi", params, env);
  const json = await res.json();
  const uids = json?.result?.uids ?? [];
  return uids.map((uid) => {
    const s = json.result[uid] ?? {};
    return {
      pmid: uid,
      title: (s.title || "").replace(/<[^>]+>/g, "").trim(),
      journal: s.fulljournalname || s.source || "",
      year: parseYear(s),
      pubTypes: Array.isArray(s.pubtype) ? s.pubtype : [],
      authors: Array.isArray(s.authors) ? s.authors.map((a) => a.name).filter(Boolean) : [],
      doi: String(s.elocationid || "").match(/10\.\d{4,9}\/[^\s]+/)?.[0] ?? "",
      journalAbbrev: s.source || "",
      volume: s.volume || "",
      issue: s.issue || "",
      pages: s.pages || "",
      url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
    };
  });
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(x?)([0-9a-fA-F]+);/g, (whole, hex, code) => {
      const point = parseInt(code, hex ? 16 : 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : whole;
    })
    .replace(/&amp;/g, "&");
}

export function parseFundingStatements(xml) {
  const out = new Map();
  for (const block of xml.split("<PubmedArticle>").slice(1)) {
    const pmid = block.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
    if (!pmid) continue;

    const parts = [];
    const agencies = [...block.matchAll(/<Agency>([\s\S]*?)<\/Agency>/g)].map((m) =>
      decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
    );
    if (agencies.length) parts.push(`Grant agencies: ${[...new Set(agencies)].join("; ")}`);

    const coi = block.match(/<CoiStatement>([\s\S]*?)<\/CoiStatement>/)?.[1];
    if (coi) {
      parts.push(decodeEntities(coi.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim());
    }
    if (parts.length) out.set(pmid, parts.join(" | "));
  }
  return out;
}

export async function fetchPmcFunding(pmids, env = {}, cfg = FUNDING_FETCH_CONFIG) {
  const out = new Map();
  const wanted = pmids.slice(0, cfg.maxPmcLookups);
  if (!cfg.usePmcFullText || !wanted.length) return out;

  try {
    const linkParams = new URLSearchParams({ dbfrom: "pubmed", db: "pmc", retmode: "json" });
    for (const pmid of wanted) linkParams.append("id", pmid);
    const linkRes = await eutil("elink.fcgi", linkParams, env);
    const linkJson = await linkRes.json();

    const pmcToPmid = new Map();
    for (const set of linkJson?.linksets ?? []) {
      const pmid = set?.ids?.[0] != null ? String(set.ids[0]) : null;
      const link = (set?.linksetdbs ?? []).find((db) => db.linkname === "pubmed_pmc");
      const pmcid = link?.links?.[0];
      if (pmid && pmcid) pmcToPmid.set(String(pmcid), pmid);
    }
    if (!pmcToPmid.size) return out;

    const fetchParams = new URLSearchParams({
      db: "pmc",
      id: [...pmcToPmid.keys()].join(","),
      retmode: "xml",
    });
    const res = await eutil("efetch.fcgi", fetchParams, env);
    const xml = await res.text();

    for (const article of xml.split(/<article[\s>]/).slice(1)) {
      const pmid = article.match(
        /<article-id[^>]*pub-id-type="pmid"[^>]*>(\d+)<\/article-id>/,
      )?.[1];
      if (!pmid || !wanted.includes(pmid)) continue;

      const sections = [
        ...article.matchAll(/<funding-group>([\s\S]*?)<\/funding-group>/g),
        ...article.matchAll(/<funding-statement>([\s\S]*?)<\/funding-statement>/g),
        ...article.matchAll(/<ack[\s>]([\s\S]*?)<\/ack>/g),
      ].map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim());

      const text = sections.filter(Boolean).join(" | ").slice(0, cfg.maxStatementChars);
      if (text) out.set(pmid, text);
    }
  } catch (err) {
    logEvent(LOG_EVENTS.pubmedFailed, { endpoint: "pmc", reason: err.message });
  }
  return out;
}

export async function efetchAbstracts(pmids, env = {}) {
  const { abstracts } = await efetchDetails(pmids, env);
  return abstracts;
}

export async function efetchDetails(pmids, env = {}) {
  const abstracts = new Map();
  const retractions = new Map();
  let funding = new Map();
  if (!pmids.length) return { abstracts, funding, retractions };

  const params = new URLSearchParams({
    db: "pubmed",
    id: pmids.join(","),
    retmode: "xml",
    rettype: "abstract",
  });

  let xml;
  try {
    const res = await eutil("efetch.fcgi", params, env);
    xml = await res.text();
  } catch (err) {
    logEvent(LOG_EVENTS.pubmedFailed, { endpoint: "efetch", reason: err.message });
    return { abstracts, funding, retractions };
  }

  for (const block of xml.split("<PubmedArticle>").slice(1)) {
    const pmid = block.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
    if (!pmid) continue;
    const parts = [...block.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map((m) =>
      decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
    );
    if (parts.length) abstracts.set(pmid, parts.join(" "));

    const retracted =
      /<PublicationType[^>]*>Retracted Publication<\/PublicationType>/i.test(block) ||
      /<CommentsCorrections RefType="RetractionIn">/.test(block);
    if (retracted) {
      const noticePmid = block
        .match(/<CommentsCorrections RefType="RetractionIn">([\s\S]*?)<\/CommentsCorrections>/)?.[1]
        ?.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
      retractions.set(pmid, {
        retracted: true,
        noticeUrl: noticePmid ? `https://pubmed.ncbi.nlm.nih.gov/${noticePmid}/` : null,
      });
    }
  }

  funding = parseFundingStatements(xml);
  return { abstracts, funding, retractions };
}

export function extractSampleSize(text = "") {
  const patterns = [
    /\b(?:n\s*=\s*)(\d{1,3}(?:,\d{3})+|\d{2,7})\b/i,
    /\b(\d{1,3}(?:,\d{3})+|\d{2,7})\s+(?:participants|patients|subjects|adults|children|women|men|individuals)\b/i,
    /\b(?:included|enrolled|randomi[sz]ed|analy[sz]ed)\s+(\d{1,3}(?:,\d{3})+|\d{2,7})\b/i,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (match) {
      const value = Number(match[1].replace(/,/g, ""));
      if (Number.isFinite(value) && value >= 20 && value <= 50_000_000) return value;
    }
  }
  return null;
}

export async function searchStudies(
  query,
  env = {},
  { retmax = DEFAULT_RETMAX, fundingCfg = FUNDING_FETCH_CONFIG } = {},
) {
  const { pmids, total } = await esearch(query, env, { retmax });
  if (!pmids.length) return { studies: [], total: 0, query };

  // Sequential: NCBI allows 3 requests/sec without a key.
  const summaries = await esummary(pmids, env);
  const { abstracts, funding, retractions } = await efetchDetails(pmids, env);

  const gaps = summaries.map((s) => s.pmid).filter((pmid) => !funding.has(pmid));
  const pmcFunding = await fetchPmcFunding(gaps, env, fundingCfg);
  for (const [pmid, text] of pmcFunding) funding.set(pmid, text);

  const studies = summaries.map((s) => {
    const abstract = abstracts.get(s.pmid) || "";
    const type = classifyStudy(s.pubTypes, `${s.title} ${abstract}`);
    const fundingText = funding.get(s.pmid) || "";
    const { source, label } = classifyFunding(fundingText);
    return {
      ...s,
      abstract,
      type,
      typeLabel: TIER_LABELS[type] ?? TIER_LABELS.other,
      sampleSize: extractSampleSize(abstract),
      fundingText,
      fundingSource: source,
      fundingLabel: label,
      fundingFromPmc: pmcFunding.has(s.pmid),
      retraction: retractions.get(s.pmid) ?? { retracted: false, noticeUrl: null },
    };
  });

  return { studies, total, query };
}
