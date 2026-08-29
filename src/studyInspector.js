import { eutil, decodeXmlEntities, extractSampleSize } from "./pubmed.js";
import { classifyStudy, TIER_LABELS } from "./classify.js";
import { classifyFunding } from "./funding.js";
import { getAIResponse } from "./ai.js";
import { fetchStudyMetrics } from "./metrics.js";
import { scoreCredibility } from "./credibility.js";
import { formatAllCitations } from "./citations.js";
import { logEvent, LOG_EVENTS } from "./log.js";

const MAX_DOI_CHARS = 200;

export function parseStudyRef(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return invalid("Enter a PubMed link, a PMID, or a DOI.");

  const url = raw.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{1,9})/i);
  if (url) return { kind: "pmid", value: url[1] };

  const legacy = raw.match(/ncbi\.nlm\.nih\.gov\/pubmed\/(\d{1,9})/i);
  if (legacy) return { kind: "pmid", value: legacy[1] };

  const doi = raw.match(/\b(10\.\d{4,9}\/[^\s"'<>]+)/i);
  if (doi) {
    const value = doi[1].replace(/[.,;)\]]+$/, "");
    if (value.length > MAX_DOI_CHARS) return invalid("That DOI looks too long to be real.");
    return { kind: "doi", value };
  }

  const pmid = raw.match(/^(?:pmid[:\s]*)?(\d{1,9})$/i);
  if (pmid) return { kind: "pmid", value: pmid[1] };

  if (/^\d+$/.test(raw)) return invalid("That number is too long to be a PMID.");
  return invalid("Could not read that as a PubMed link, PMID, or DOI.");
}

function invalid(reason) {
  return { kind: "invalid", reason };
}

export async function resolveDoiToPmid(doi, env = {}) {
  for (const field of ["AID", "DOI"]) {
    const params = new URLSearchParams({
      db: "pubmed",
      term: `"${doi}"[${field}]`,
      retmode: "json",
      retmax: "1",
    });
    try {
      const res = await eutil("esearch.fcgi", params, env);
      const json = await res.json();
      const pmid = json?.esearchresult?.idlist?.[0];
      if (pmid) return pmid;
    } catch (err) {
      console.warn(`DOI resolution via [${field}] failed:`, err.message);
    }
  }
  return null;
}

export async function resolveToPmid(input, env = {}) {
  const ref = parseStudyRef(input);
  if (ref.kind === "invalid") return { pmid: null, error: ref.reason };
  if (ref.kind === "pmid") return { pmid: ref.value, error: null };

  const pmid = await resolveDoiToPmid(ref.value, env);
  return pmid
    ? { pmid, error: null }
    : { pmid: null, error: `No PubMed record found for DOI ${ref.value}.` };
}

// --- record parsing -------------------------------------------------------

const tag = (block, name) => {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return match ? clean(match[1]) : "";
};

const clean = (text) => decodeXmlEntities(String(text).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function parseAuthors(block) {
  const authors = [];
  for (const match of block.matchAll(/<Author[^>]*>([\s\S]*?)<\/Author>/g)) {
    const entry = match[1];
    const last = tag(entry, "LastName");
    const fore = tag(entry, "ForeName");
    const initials = tag(entry, "Initials");
    const collective = tag(entry, "CollectiveName");
    const affiliations = [...entry.matchAll(/<Affiliation>([\s\S]*?)<\/Affiliation>/g)].map((m) =>
      clean(m[1]),
    );
    if (!last && !collective) continue;
    authors.push({
      last,
      fore,
      initials,
      collective,
      name: collective || [fore, last].filter(Boolean).join(" ") || last,
      affiliation: affiliations[0] || "",
    });
  }
  return authors;
}

function parseYear(block) {
  const dateBlock =
    block.match(/<PubDate>([\s\S]*?)<\/PubDate>/)?.[1] ??
    block.match(/<ArticleDate[^>]*>([\s\S]*?)<\/ArticleDate>/)?.[1] ??
    "";
  const year = dateBlock.match(/<Year>(\d{4})<\/Year>/)?.[1];
  if (year) return Number(year);
  const medline = dateBlock.match(/<MedlineDate>(\d{4})/)?.[1];
  return medline ? Number(medline) : null;
}

export function parseRetractionStatus(block) {
  const pubTypes = [...block.matchAll(/<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/g)].map(
    (m) => clean(m[1]),
  );
  const retractedType = pubTypes.some((t) => /^retracted publication$/i.test(t));
  const retractionRef = /<CommentsCorrections RefType="RetractionIn">/.test(block);
  const concernRef = /<CommentsCorrections RefType="ExpressionOfConcernIn">/.test(block);
  const isRetractionNotice = pubTypes.some((t) => /^retraction of publication$/i.test(t));

  let noticeUrl = null;
  if (retractionRef) {
    const noticePmid = block
      .match(/<CommentsCorrections RefType="RetractionIn">([\s\S]*?)<\/CommentsCorrections>/)?.[1]
      ?.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
    if (noticePmid) noticeUrl = `https://pubmed.ncbi.nlm.nih.gov/${noticePmid}/`;
  }

  return {
    retracted: retractedType || retractionRef,
    expressionOfConcern: concernRef,
    isRetractionNotice,
    noticeUrl,
    pubTypes,
  };
}

export async function fetchStudyRecord(pmid, env = {}) {
  const params = new URLSearchParams({ db: "pubmed", id: String(pmid), retmode: "xml" });
  const res = await eutil("efetch.fcgi", params, env);
  const xml = await res.text();

  const block = xml.split("<PubmedArticle>")[1];
  if (!block) return null;

  const confirmedPmid = block.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1] ?? String(pmid);
  const title = tag(block, "ArticleTitle") || tag(block, "VernacularTitle");

  const abstractParts = [...block.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map(
    (m) => {
      const label = m[1].match(/Label="([^"]*)"/)?.[1];
      const text = clean(m[2]);
      return label ? `${label}: ${text}` : text;
    },
  );
  const abstract = abstractParts.join(" ");

  const doi =
    block.match(/<ELocationID[^>]*EIdType="doi"[^>]*>([\s\S]*?)<\/ELocationID>/)?.[1] ??
    block.match(/<ArticleId[^>]*IdType="doi"[^>]*>([\s\S]*?)<\/ArticleId>/)?.[1] ??
    "";

  const retraction = parseRetractionStatus(block);
  const type = classifyStudy(retraction.pubTypes, `${title} ${abstract}`);

  const meshTerms = [...block.matchAll(/<DescriptorName[^>]*>([\s\S]*?)<\/DescriptorName>/g)]
    .map((m) => clean(m[1]))
    .filter(Boolean);

  const agencies = [...block.matchAll(/<Agency>([\s\S]*?)<\/Agency>/g)].map((m) => clean(m[1]));
  const coi = tag(block, "CoiStatement");
  const fundingText = [
    agencies.length ? `Grant agencies: ${[...new Set(agencies)].join("; ")}` : "",
    coi,
  ]
    .filter(Boolean)
    .join(" | ");
  const funding = classifyFunding(fundingText);

  return {
    pmid: confirmedPmid,
    title,
    abstract,
    journal: tag(block, "Title"),
    journalAbbrev: tag(block, "ISOAbbreviation"),
    year: parseYear(block),
    volume: tag(block, "Volume"),
    issue: tag(block, "Issue"),
    pages: tag(block, "MedlinePgn") || tag(block, "StartPage"),
    doi: clean(doi),
    authors: parseAuthors(block),
    type,
    typeLabel: TIER_LABELS[type] ?? TIER_LABELS.other,
    pubTypes: retraction.pubTypes,
    meshTerms: meshTerms.slice(0, 12),
    sampleSize: extractSampleSize(abstract),
    fundingText,
    fundingSource: funding.source,
    fundingLabel: funding.label,
    retraction: {
      retracted: retraction.retracted,
      expressionOfConcern: retraction.expressionOfConcern,
      isRetractionNotice: retraction.isRetractionNotice,
      noticeUrl: retraction.noticeUrl,
    },
    url: `https://pubmed.ncbi.nlm.nih.gov/${confirmedPmid}/`,
  };
}

// --- summary and orchestration -------------------------------------------

export const INSPECTOR_CONFIG = {
  summaryAbstractChars: 2500,
};

const SUMMARY_SYSTEM = `You explain one medical paper to a general reader.

Cover, in this order and only if the text supports it:
- what was tested
- on whom (population and size)
- what was found
- any limitations the authors state

Rules:
- 3 to 4 sentences. Plain English. No bullet points, no headings, no preamble.
- Describe only what this paper says. Do not judge whether it is right, do not
  bring in outside knowledge, and do not give medical advice.
- If the text does not say something, leave it out rather than guessing.`;

export async function summarizeStudy(record, env, cfg = INSPECTOR_CONFIG, { useAi = true } = {}) {
  const abstract = record.abstract || "";
  if (!useAi) {
    return {
      summary: "",
      partialRead: false,
      degraded: true,
      note: "AI is switched off, so the abstract is shown as published.",
    };
  }
  if (!abstract) {
    return {
      summary: "",
      partialRead: false,
      degraded: true,
      note: "This record has no abstract, so there is nothing to summarize.",
    };
  }

  const partialRead = abstract.length > cfg.summaryAbstractChars;
  const body = abstract.slice(0, cfg.summaryAbstractChars);

  try {
    const { text } = await getAIResponse(
      `Title: ${record.title}\n\nAbstract:\n${body}\n\nSummary:`,
      { env, system: SUMMARY_SYSTEM, temperature: 0.2, maxTokens: 320 },
    );
    const cleaned = text.replace(/^\s*(summary|explanation)\s*:\s*/i, "").trim();
    if (cleaned.length > 40) return { summary: cleaned, partialRead, degraded: false, note: null };
  } catch (err) {
    logEvent(LOG_EVENTS.aiFailed, { stage: "study-summary", reason: err.message });
  }

  return {
    summary: "",
    partialRead,
    degraded: true,
    note: "The language model was unavailable, so the abstract is shown as published.",
  };
}

export async function inspectStudy(pmid, env = {}, { knownRecord = null, useAi = true } = {}) {
  const startedAt = Date.now();

  const record = knownRecord ?? (await fetchStudyRecord(pmid, env));
  if (!record) return null;

  const [metrics, summary] = await Promise.all([
    fetchStudyMetrics(record, env).catch((err) => {
      console.warn("metrics lookup failed:", err.message);
      return { available: false, source: null, citations: null, citationsPerYear: null, ageYears: null, venue: null, authors: [], authorsMatched: false, openAlexRetracted: null, note: "Citation and venue statistics were unavailable for this record." };
    }),
    summarizeStudy(record, env, INSPECTOR_CONFIG, { useAi }),
  ]);

  const credibility = scoreCredibility(record, metrics);

  return {
    record: {
      pmid: record.pmid,
      title: record.title,
      abstract: record.abstract,
      journal: record.journal,
      journalAbbrev: record.journalAbbrev,
      year: record.year,
      volume: record.volume,
      issue: record.issue,
      pages: record.pages,
      doi: record.doi,
      authors: record.authors,
      type: record.type,
      typeLabel: record.typeLabel,
      pubTypes: record.pubTypes,
      meshTerms: record.meshTerms,
      sampleSize: record.sampleSize,
      fundingSource: record.fundingSource,
      fundingLabel: record.fundingLabel,
      retraction: record.retraction,
      url: record.url,
    },
    summary: summary.summary,
    summaryNote: summary.note,
    partialRead: summary.partialRead,
    metrics,
    credibility,
    citations: formatAllCitations(record),
    meta: {
      fromCache: Boolean(knownRecord),
      aiDegraded: summary.degraded,
      aiDisabled: !useAi,
      elapsedMs: Date.now() - startedAt,
    },
  };
}
