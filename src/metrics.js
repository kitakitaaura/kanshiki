import { logEvent, LOG_EVENTS } from "./log.js";

const OPENALEX = "https://api.openalex.org";
const SEMANTIC_SCHOLAR = "https://api.semanticscholar.org/graph/v1";
const TIMEOUT_MS = 10000;

export const METRICS_CONFIG = {
  maxAuthorLookups: 2,
  defaultMailto: "kanshiki@example.invalid",
  useSemanticScholarFallback: true,
};

async function getJson(url, { headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function mailtoFor(env, cfg) {
  return env.OPENALEX_MAILTO || env.NCBI_EMAIL || cfg.defaultMailto;
}

// --- OpenAlex -------------------------------------------------------------

export async function fetchOpenAlexWork(record, env = {}, cfg = METRICS_CONFIG) {
  const mailto = encodeURIComponent(mailtoFor(env, cfg));
  const keys = [record.pmid ? `pmid:${record.pmid}` : null, record.doi ? `doi:${record.doi}` : null]
    .filter(Boolean);

  for (const key of keys) {
    try {
      return await getJson(`${OPENALEX}/works/${encodeURIComponent(key)}?mailto=${mailto}`);
    } catch (err) {
      if (err.status !== 404) console.warn(`OpenAlex work lookup (${key}) failed:`, err.message);
    }
  }
  return null;
}

async function fetchOpenAlexEntity(url, env, cfg, label) {
  try {
    const mailto = encodeURIComponent(mailtoFor(env, cfg));
    const id = String(url).split("/").pop();
    return await getJson(`${OPENALEX}/${label}/${id}?mailto=${mailto}`);
  } catch (err) {
    console.warn(`OpenAlex ${label} lookup failed:`, err.message);
    return null;
  }
}

function authorMatches(pubmedAuthor, openAlexName) {
  if (!pubmedAuthor || !openAlexName) return false;
  const surname = foldName(pubmedAuthor.last || pubmedAuthor.collective || "");
  if (!surname) return false;
  return foldName(openAlexName).includes(surname);
}

function foldName(value) {
  return String(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function summarizeAuthor(entity, pubmedAuthor, openAlexName) {
  const matched = authorMatches(pubmedAuthor, openAlexName);
  if (!entity || !matched) {
    return {
      name: pubmedAuthor?.name ?? openAlexName ?? "Unknown",
      matched: false,
      reason: !openAlexName
        ? "No indexed author profile for this byline."
        : !matched
          ? `Indexed profile ("${openAlexName}") did not confidently match the byline.`
          : "Author profile could not be retrieved.",
      worksCount: null,
      citedByCount: null,
      hIndex: null,
      careerSpan: null,
    };
  }

  const years = (entity.counts_by_year ?? []).map((row) => row.year).filter(Number.isFinite);
  return {
    name: entity.display_name ?? pubmedAuthor?.name ?? "Unknown",
    matched: true,
    reason: null,
    worksCount: entity.works_count ?? null,
    citedByCount: entity.cited_by_count ?? null,
    hIndex: entity.summary_stats?.h_index ?? null,
    careerSpan: years.length ? { from: Math.min(...years), to: Math.max(...years) } : null,
    profileUrl: entity.id ?? null,
  };
}

// --- Semantic Scholar fallback -------------------------------------------

export async function fetchSemanticScholar(record, cfg = METRICS_CONFIG) {
  if (!cfg.useSemanticScholarFallback) return null;
  const key = record.pmid ? `PMID:${record.pmid}` : record.doi ? `DOI:${record.doi}` : null;
  if (!key) return null;

  const fields = [
    "title",
    "year",
    "citationCount",
    "influentialCitationCount",
    "venue",
    "publicationVenue",
    "authors.name",
    "authors.hIndex",
    "authors.paperCount",
    "authors.citationCount",
  ].join(",");

  try {
    return await getJson(`${SEMANTIC_SCHOLAR}/paper/${encodeURIComponent(key)}?fields=${fields}`);
  } catch (err) {
    // 429 is routine on the keyless endpoint.
    console.warn("Semantic Scholar lookup failed:", err.message);
    return null;
  }
}

// --- normalization --------------------------------------------------------

function citationsPerYear(citations, year, currentYear) {
  if (!Number.isFinite(citations) || !Number.isFinite(year)) return null;
  // Guards against dividing by zero in the publication year.
  const age = Math.max(1, currentYear - year);
  return Math.round((citations / age) * 10) / 10;
}

const EMPTY_METRICS = {
  available: false,
  source: null,
  citations: null,
  citationsPerYear: null,
  ageYears: null,
  venue: null,
  authors: [],
  authorsMatched: false,
  openAlexRetracted: null,
  note: "Citation and venue statistics were unavailable for this record.",
};

export async function fetchStudyMetrics(
  record,
  env = {},
  cfg = METRICS_CONFIG,
  currentYear = new Date().getUTCFullYear(),
) {
  const work = await fetchOpenAlexWork(record, env, cfg);

  if (work) {
    const citations = work.cited_by_count ?? null;
    const year = record.year ?? work.publication_year ?? null;

    const sourceRef = work.primary_location?.source ?? null;
    const sourceEntity = sourceRef?.id
      ? await fetchOpenAlexEntity(sourceRef.id, env, cfg, "sources")
      : null;

    const authorships = work.authorships ?? [];
    const picks = [];
    if (authorships.length) picks.push({ authorship: authorships[0], index: 0 });
    if (authorships.length > 1) {
      picks.push({ authorship: authorships[authorships.length - 1], index: authorships.length - 1 });
    }

    const authors = [];
    for (const { authorship, index } of picks.slice(0, cfg.maxAuthorLookups)) {
      const openAlexName = authorship?.author?.display_name ?? null;
      const pubmedAuthor = record.authors?.[index] ?? null;
      const entity = authorship?.author?.id
        ? await fetchOpenAlexEntity(authorship.author.id, env, cfg, "authors")
        : null;
      authors.push({
        role: index === 0 ? "first" : "last",
        ...summarizeAuthor(entity, pubmedAuthor, openAlexName),
      });
    }

    const venueRate = sourceEntity?.summary_stats?.["2yr_mean_citedness"] ?? null;
    const perYear = citationsPerYear(citations, year, currentYear);

    return {
      available: true,
      source: "openalex",
      citations,
      citationsPerYear: perYear,
      ageYears: Number.isFinite(year) ? Math.max(0, currentYear - year) : null,
      venue: sourceRef
        ? {
            name: sourceEntity?.display_name ?? sourceRef.display_name ?? record.journal,
            // OpenAlex mean citedness, not Impact Factor.
            journalCitationRate: venueRate != null ? Math.round(venueRate * 100) / 100 : null,
            hIndex: sourceEntity?.summary_stats?.h_index ?? null,
            worksCount: sourceEntity?.works_count ?? null,
            isOpenAccess: sourceEntity?.is_oa ?? null,
          }
        : null,
      relativeToVenue:
        perYear != null && venueRate ? Math.round((perYear / venueRate) * 100) / 100 : null,
      authors,
      authorsMatched: authors.some((a) => a.matched),
      openAlexRetracted: work.is_retracted ?? null,
      note: null,
    };
  }

  const paper = await fetchSemanticScholar(record, cfg);
  if (paper) {
    const citations = paper.citationCount ?? null;
    const year = record.year ?? paper.year ?? null;
    const authors = (paper.authors ?? []).slice(0, cfg.maxAuthorLookups).map((a, index) => ({
      role: index === 0 ? "first" : "last",
      name: a.name ?? "Unknown",
      matched: authorMatches(record.authors?.[index], a.name),
      reason: authorMatches(record.authors?.[index], a.name)
        ? null
        : "Indexed profile did not confidently match the byline.",
      worksCount: a.paperCount ?? null,
      citedByCount: a.citationCount ?? null,
      hIndex: a.hIndex ?? null,
      careerSpan: null,
    }));

    return {
      available: true,
      source: "semantic-scholar",
      citations,
      citationsPerYear: citationsPerYear(citations, year, currentYear),
      ageYears: Number.isFinite(year) ? Math.max(0, currentYear - year) : null,
      venue: paper.venue
        ? { name: paper.venue, journalCitationRate: null, hIndex: null, worksCount: null }
        : null,
      relativeToVenue: null,
      authors,
      authorsMatched: authors.some((a) => a.matched),
      openAlexRetracted: null,
      note: "OpenAlex had no record; figures come from Semantic Scholar and cover less ground.",
    };
  }

  logEvent(LOG_EVENTS.metricsUnavailable, { pmid: record.pmid, doi: record.doi });
  return { ...EMPTY_METRICS };
}
