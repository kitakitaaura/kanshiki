import { resolveToPmid, inspectStudy } from "../../src/studyInspector.js";
import { normalizeAuthor } from "../../src/citations.js";
import { sanitizeRef } from "../../src/sanitize.js";
import { withTimeout, TimeoutError } from "../../src/deploy.js";
import { logEvent, LOG_EVENTS } from "../../src/log.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export function sanitizeKnownRecord(input) {
  if (!input || typeof input !== "object") return null;
  const str = (value, max = 20000) => (typeof value === "string" ? value.slice(0, max) : "");
  const pmid = str(input.pmid, 12).match(/^\d{1,9}$/)?.[0];
  if (!pmid) return null;
  // No abstract means a fetch beats the cached record.
  if (!str(input.abstract)) return null;

  return {
    pmid,
    title: str(input.title, 1000),
    abstract: str(input.abstract),
    journal: str(input.journal, 300),
    journalAbbrev: str(input.journalAbbrev, 120),
    year: Number.isFinite(input.year) ? input.year : null,
    volume: str(input.volume, 40),
    issue: str(input.issue, 40),
    pages: str(input.pages, 40),
    doi: str(input.doi, 200),
    authors: Array.isArray(input.authors)
      ? input.authors.slice(0, 60).map((a) =>
          typeof a === "string"
            ? normalizeAuthor(a)
            : {
                name: str(a?.name, 200),
                last: str(a?.last, 100),
                fore: str(a?.fore, 100),
                initials: str(a?.initials, 12),
                collective: str(a?.collective, 200),
                affiliation: str(a?.affiliation, 500),
              },
        )
      : [],
    type: str(input.type, 40),
    typeLabel: str(input.typeLabel, 80),
    pubTypes: [],
    meshTerms: [],
    sampleSize: Number.isFinite(input.sampleSize) ? input.sampleSize : null,
    fundingSource: str(input.fundingSource, 40) || "undisclosed",
    fundingLabel: str(input.fundingLabel, 80),
    retraction: {
      retracted: Boolean(input.retraction?.retracted),
      expressionOfConcern: Boolean(input.retraction?.expressionOfConcern),
      isRetractionNotice: false,
      noticeUrl: str(input.retraction?.noticeUrl, 200) || null,
    },
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
  };
}

export const parseSummaryAuthor = normalizeAuthor;

export async function onRequestPost({ request, env }) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body like { "ref": "..." }' }, 400);
  }

  const ref = sanitizeRef(payload?.ref ?? payload?.pmid);
  if (!ref) return json({ error: "Enter a PubMed link, a PMID, or a DOI." }, 400);

  const { pmid, error } = await resolveToPmid(ref, env);
  if (!pmid) return json({ error }, 400);

  const knownRecord = sanitizeKnownRecord(payload?.record);
  // Only trust a record matching the requested PMID.
  const usable = knownRecord && knownRecord.pmid === pmid ? knownRecord : null;

  try {
    const useAi = payload?.useAi !== false;
    const result = await withTimeout(inspectStudy(pmid, env, { knownRecord: usable, useAi }), env);
    if (!result) return json({ error: `No PubMed record found for PMID ${pmid}.` }, 404);
    return json(result);
  } catch (err) {
    if (err instanceof TimeoutError) {
      logEvent(LOG_EVENTS.requestTimeout, { seconds: err.seconds });
      return json({ error: err.message }, 504);
    }
    console.error("inspect-study failed:", err?.stack || err);
    return json({ error: "The study lookup failed. Please try again." }, 502);
  }
}

export function onRequestGet() {
  return json({ error: 'Use POST with { "ref": "PMID, PubMed URL, or DOI" }' }, 405);
}
