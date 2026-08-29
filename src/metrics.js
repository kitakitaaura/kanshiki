import { logEvent, LOG_EVENTS } from "./log.js";

const OPENALEX = "https://api.openalex.org";
const SEMANTIC_SCHOLAR = "https://api.semanticscholar.org/graph/v1";
const TIMEOUT_MS = 10000;

export const METRICS_CONFIG = {
  maxAuthorLookups: 2,
  // Citation counts move slowly, so a long cache is safe and cuts outbound
  // requests hard. On a shared Cloudflare IP the upstream quota is spent by
  // every other Worker too, so volume is the thing that matters.
  cacheSeconds: 86400,
  defaultMailto: "kanshiki@example.invalid",
  useSemanticScholarFallback: true,
};

/**
 * OpenAlex grants higher limits to callers that identify themselves, in the
 * User-Agent as well as the mailto parameter. Without it a request from a
 * shared cloud IP range looks anonymous and gets throttled, which is why a
 * deployment can fail from one Cloudflare datacenter and work from another.
 */
function userAgent(env, cfg) {
  return `Kanshiki/1.0 (+https://github.com/kitakitaaura/kanshiki; mailto:${mailtoFor(env, cfg)})`;
}

async function getJson(url, { headers = {}, cacheSeconds = METRICS_CONFIG.cacheSeconds } = {}) {
  // caches.default exists in Workers and Pages Functions, not in Node.
  const cache = globalThis.caches?.default;
  const cacheKey = cache ? new Request(url, { method: "GET" }) : null;

  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit.json();
  }

  const res = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }

  const body = await res.text();
  if (cache) {
    await cache
      .put(
        cacheKey,
        new Response(body, {
          headers: {
            "content-type": "application/json",
            "cache-control": `public, max-age=${cacheSeconds}`,
          },
        }),
      )
      .catch(() => {});
  }
  return JSON.parse(body);
}

function mailtoFor(env, cfg) {
  return env.OPENALEX_MAILTO || env.NCBI_EMAIL || cfg.defaultMailto;
}

// --- OpenAlex -------------------------------------------------------------

// The reason the last lookup failed, surfaced in the response so a broken
// deployment explains itself instead of silently reporting "no data".
let failures = [];
let failureStatuses = [];

function noteFailure(reason, status) {
  failures.push(String(reason).slice(0, 120));
  if (Number.isFinite(status)) failureStatuses.push(status);
}

export function lastMetricsFailure() {
  return failures.join(" | ") || null;
}

// Matching a status out of the message text is unsafe: a PMID like 9500320
// contains "500". The codes are tracked separately.
function wasThrottledOrDown() {
  return failureStatuses.some((status) => status === 429 || status >= 500);
}

export async function fetchOpenAlexWork(record, env = {}, cfg = METRICS_CONFIG) {
  const mailto = encodeURIComponent(mailtoFor(env, cfg));
  const keys = [record.pmid ? `pmid:${record.pmid}` : null, record.doi ? `doi:${record.doi}` : null]
    .filter(Boolean);

  for (const key of keys) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await getJson(`${OPENALEX}/works/${encodeURIComponent(key)}?mailto=${mailto}`, {
        headers: { "user-agent": userAgent(env, cfg) },
      });
    } catch (err) {
      const retryable = err.status === 429 || err.status >= 500 || !err.status;
      if (retryable && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      noteFailure(`openalex ${key}: ${err.name}: ${err.message}`, err.status);
      if (err.status !== 404) console.warn(`OpenAlex work lookup (${key}) failed:`, err.message);
    }
    break;
    }
  }
  return null;
}

async function fetchOpenAlexEntity(url, env, cfg, label) {
  try {
    const mailto = encodeURIComponent(mailtoFor(env, cfg));
    const id = String(url).split("/").pop();
    return await getJson(`${OPENALEX}/${label}/${id}?mailto=${mailto}`, {
      headers: { "user-agent": userAgent(env, cfg) },
    });
  } catch (err) {
    console.warn(`OpenAlex ${label} lookup failed:`, err.message);
    return null;
  }
}

/**
 * A surname alone is not an identity. "Denis Wakefield" is not "A J
 * Wakefield", and attaching one researcher's record to another's paper is a
 * real harm, so a mismatched first initial rejects the match outright.
 */
function authorMatches(pubmedAuthor, indexedName) {
  if (!pubmedAuthor || !indexedName) return false;

  const surname = foldName(pubmedAuthor.last || pubmedAuthor.collective || "");
  if (!surname) return false;
  if (!foldName(indexedName).includes(surname)) return false;

  const claimed = firstInitial(pubmedAuthor.fore || pubmedAuthor.initials);
  const found = firstInitialOfDisplayName(indexedName, pubmedAuthor.last);
  // With no initial on either side there is nothing to contradict.
  if (!claimed || !found) return true;
  return claimed === found;
}

function firstInitial(value) {
  const letter = String(value ?? "").trim()[0];
  return letter ? foldName(letter) : "";
}

// Indexed names read "Andrew J Wakefield", so the given name comes first.
function firstInitialOfDisplayName(displayName, surname) {
  const folded = foldName(surname ?? "");
  const parts = String(displayName)
    .trim()
    .split(/\s+/)
    .filter((part) => foldName(part) && foldName(part) !== folded);
  return parts.length ? firstInitial(parts[0]) : "";
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
    return await getJson(`${SEMANTIC_SCHOLAR}/paper/${encodeURIComponent(key)}?fields=${fields}`, {
      headers: { "user-agent": `Kanshiki/1.0 (+https://github.com/kitakitaaura/kanshiki)` },
    });
  } catch (err) {
    noteFailure(`semantic-scholar: ${err.name}: ${err.message}`, err.status);
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
  failures = [];
  failureStatuses = [];
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
      // Distinguish "not indexed" from "we were throttled": they need
      // different responses from whoever is reading this.
      note: wasThrottledOrDown()
        ? "OpenAlex was unavailable, so these figures come from Semantic Scholar and cover less ground."
        : "OpenAlex had no record; figures come from Semantic Scholar and cover less ground.",
    };
  }

  const reason = lastMetricsFailure();
  logEvent(LOG_EVENTS.metricsUnavailable, { pmid: record.pmid, doi: record.doi, reason });
  return {
    ...EMPTY_METRICS,
    reason,
    note: reason
      ? `Citation and venue statistics were unavailable: ${reason}`
      : EMPTY_METRICS.note,
  };
}
