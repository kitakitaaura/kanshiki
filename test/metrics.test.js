import test from "node:test";
import assert from "node:assert/strict";
import { fetchStudyMetrics, METRICS_CONFIG } from "../src/metrics.js";
import { inspectStudy } from "../src/studyInspector.js";

const YEAR = 2026;

const RECORD = {
  pmid: "9500320",
  doi: "10.1016/s0140-6736(97)11096-0",
  title: "A study",
  year: 2018,
  journal: "The Lancet",
  authors: [{ last: "Wakefield", name: "A J Wakefield" }, { last: "Vidal", name: "J E Vidal" }],
};

function stubFetch(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    for (const [pattern, handler] of Object.entries(routes)) {
      if (href.includes(pattern)) {
        const result = typeof handler === "function" ? handler(href) : handler;
        if (result.status && result.status >= 400) {
          return { ok: false, status: result.status, statusText: result.statusText ?? "Error" };
        }
        return { ok: true, status: 200, json: async () => result.body, text: async () => JSON.stringify(result.body) };
      }
    }
    return { ok: false, status: 404, statusText: "Not Found" };
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const OPENALEX_WORK = {
  body: {
    cited_by_count: 400,
    publication_year: 2018,
    is_retracted: false,
    primary_location: { source: { id: "https://openalex.org/S49861241", display_name: "The Lancet" } },
    authorships: [
      { author: { id: "https://openalex.org/A1", display_name: "A J Wakefield" } },
      { author: { id: "https://openalex.org/A2", display_name: "José Ernesto Vidal" } },
    ],
  },
};

const OPENALEX_SOURCE = {
  body: {
    display_name: "The Lancet",
    works_count: 475874,
    summary_stats: { "2yr_mean_citedness": 20.11, h_index: 1209 },
    is_oa: false,
  },
};

const OPENALEX_AUTHOR = {
  body: {
    display_name: "A J Wakefield",
    works_count: 83,
    cited_by_count: 6966,
    summary_stats: { h_index: 34 },
    counts_by_year: [{ year: 2020 }, { year: 2013 }],
  },
};

test("uses OpenAlex when it answers", async () => {
  const stub = stubFetch({
    "/works/": OPENALEX_WORK,
    "/sources/": OPENALEX_SOURCE,
    "/authors/": OPENALEX_AUTHOR,
  });
  try {
    const metrics = await fetchStudyMetrics(RECORD, {}, METRICS_CONFIG, YEAR);
    assert.equal(metrics.source, "openalex");
    assert.equal(metrics.available, true);
    assert.equal(metrics.citations, 400);
    assert.equal(metrics.citationsPerYear, 50); // 400 over 8 years
    assert.equal(metrics.venue.journalCitationRate, 20.11);
    assert.equal(metrics.venue.hIndex, 1209);
    assert.equal(metrics.relativeToVenue, 2.49); // 50 / 20.11
    assert.equal(metrics.authors[0].matched, true);
    assert.equal(metrics.authors[0].hIndex, 34);
    assert.ok(stub.calls.every((url) => !url.includes("semanticscholar")), "fallback not needed");
  } finally {
    stub.restore();
  }
});

test("falls back to Semantic Scholar when OpenAlex has nothing", async () => {
  const stub = stubFetch({
    "api.openalex.org": { status: 404, statusText: "Not Found" },
    "semanticscholar.org": {
      body: {
        citationCount: 120,
        year: 2018,
        venue: "Journal of Testing",
        authors: [{ name: "A J Wakefield", hIndex: 12, paperCount: 40, citationCount: 900 }],
      },
    },
  });
  try {
    const metrics = await fetchStudyMetrics(RECORD, {}, METRICS_CONFIG, YEAR);
    assert.equal(metrics.source, "semantic-scholar");
    assert.equal(metrics.available, true);
    assert.equal(metrics.citations, 120);
    assert.equal(metrics.citationsPerYear, 15);
    assert.equal(metrics.venue.name, "Journal of Testing");
    assert.equal(metrics.venue.journalCitationRate, null);
    assert.equal(metrics.relativeToVenue, null);
    assert.equal(metrics.authors[0].hIndex, 12);
    assert.match(metrics.note, /OpenAlex had no record/);
    assert.ok(stub.calls.some((url) => url.includes("semanticscholar")));
  } finally {
    stub.restore();
  }
});

test("degrades to 'stats unavailable' when neither source has data", async () => {
  const stub = stubFetch({
    "api.openalex.org": { status: 404, statusText: "Not Found" },
    "semanticscholar.org": { status: 404, statusText: "Not Found" },
  });
  try {
    const metrics = await fetchStudyMetrics(RECORD, {}, METRICS_CONFIG, YEAR);
    assert.equal(metrics.available, false);
    assert.equal(metrics.source, null);
    assert.equal(metrics.citations, null);
    assert.equal(metrics.venue, null);
    assert.deepEqual(metrics.authors, []);
    assert.match(metrics.note, /unavailable/i);
  } finally {
    stub.restore();
  }
});

test("a rate-limited Semantic Scholar is missing data, not an error", async () => {
  const stub = stubFetch({
    "api.openalex.org": { status: 500, statusText: "Server Error" },
    "semanticscholar.org": { status: 429, statusText: "Too Many Requests" },
  });
  try {
    const metrics = await fetchStudyMetrics(RECORD, {}, METRICS_CONFIG, YEAR);
    assert.equal(metrics.available, false);
    assert.match(metrics.note, /unavailable/i);
  } finally {
    stub.restore();
  }
});

test("network failures are contained rather than thrown", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("connection refused");
  };
  try {
    const metrics = await fetchStudyMetrics(RECORD, {}, METRICS_CONFIG, YEAR);
    assert.equal(metrics.available, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("the fallback can be turned off by config", async () => {
  const stub = stubFetch({
    "api.openalex.org": { status: 404, statusText: "Not Found" },
    "semanticscholar.org": { body: { citationCount: 5 } },
  });
  try {
    const metrics = await fetchStudyMetrics(
      RECORD,
      {},
      { ...METRICS_CONFIG, useSemanticScholarFallback: false },
      YEAR,
    );
    assert.equal(metrics.available, false);
    assert.ok(!stub.calls.some((url) => url.includes("semanticscholar")));
  } finally {
    stub.restore();
  }
});

test("a paper published this year is not divided by zero years", async () => {
  const stub = stubFetch({
    "/works/": { body: { ...OPENALEX_WORK.body, cited_by_count: 3 } },
    "/sources/": OPENALEX_SOURCE,
    "/authors/": OPENALEX_AUTHOR,
  });
  try {
    const metrics = await fetchStudyMetrics({ ...RECORD, year: YEAR }, {}, METRICS_CONFIG, YEAR);
    assert.equal(metrics.ageYears, 0);
    assert.equal(metrics.citationsPerYear, 3);
    assert.ok(Number.isFinite(metrics.citationsPerYear));
  } finally {
    stub.restore();
  }
});

test("an author OpenAlex cannot match is reported, not guessed", async () => {
  const stub = stubFetch({
    "/works/": {
      body: {
        ...OPENALEX_WORK.body,
        authorships: [{ author: { id: "https://openalex.org/A9", display_name: "Someone Entirely Else" } }],
      },
    },
    "/sources/": OPENALEX_SOURCE,
    "/authors/": { body: { display_name: "Someone Entirely Else", summary_stats: { h_index: 90 } } },
  });
  try {
    const metrics = await fetchStudyMetrics(RECORD, {}, METRICS_CONFIG, YEAR);
    assert.equal(metrics.authors[0].matched, false);
    assert.equal(metrics.authors[0].hIndex, null, "unmatched authors contribute no figures");
    assert.match(metrics.authors[0].reason, /did not confidently match/i);
    assert.equal(metrics.authorsMatched, false);
  } finally {
    stub.restore();
  }
});

test("accented and unaccented spellings of a surname still match", async () => {
  const stub = stubFetch({
    "/works/": {
      body: {
        ...OPENALEX_WORK.body,
        authorships: [{ author: { id: "https://openalex.org/A3", display_name: "Adrían V. Hernández" } }],
      },
    },
    "/sources/": OPENALEX_SOURCE,
    "/authors/": { body: { display_name: "Adrían V. Hernández", summary_stats: { h_index: 73 }, works_count: 504 } },
  });
  try {
    const metrics = await fetchStudyMetrics(
      { ...RECORD, authors: [{ last: "Hernandez", name: "Adrian V Hernandez" }] },
      {},
      METRICS_CONFIG,
      YEAR,
    );
    assert.equal(metrics.authors[0].matched, true);
    assert.equal(metrics.authors[0].hIndex, 73);
  } finally {
    stub.restore();
  }
});

// --- click-through ------------------------------------------------------

test("a record passed from a claim result skips the PubMed fetch", async () => {
  const stub = stubFetch({
    "/works/": OPENALEX_WORK,
    "/sources/": OPENALEX_SOURCE,
    "/authors/": OPENALEX_AUTHOR,
  });
  try {
    const knownRecord = {
      pmid: "9500320",
      title: "Already fetched by the claim pipeline",
      abstract: "We tested a thing on some people and found a result worth reporting here.",
      journal: "The Lancet",
      year: 2018,
      doi: "10.1016/x",
      authors: [{ last: "Wakefield", name: "A J Wakefield", initials: "AJ" }],
      type: "rct",
      typeLabel: "Randomized controlled trial",
      sampleSize: 400,
      fundingSource: "undisclosed",
      retraction: { retracted: false },
    };

    const result = await inspectStudy("9500320", { LOCAL_MODE: "true", OLLAMA_URL: "http://127.0.0.1:1" }, { knownRecord });

    assert.equal(result.meta.fromCache, true);
    assert.equal(result.record.title, "Already fetched by the claim pipeline");
    assert.ok(
      !stub.calls.some((url) => url.includes("eutils.ncbi.nlm.nih.gov")),
      `PubMed should not be called again; saw ${stub.calls.filter((u) => u.includes("eutils"))}`,
    );
    assert.match(result.citations.apa, /Wakefield/);
    assert.ok(result.credibility.composite > 0);
  } finally {
    stub.restore();
  }
});

// --- cached-record fidelity ---------------------------------------------

import { sanitizeKnownRecord, parseSummaryAuthor } from "../functions/api/inspect-study.js";
import { formatCitation } from "../src/citations.js";

test("PubMed summary bylines are parsed surname-first", () => {
  assert.deepEqual(parseSummaryAuthor("Zeng L"), {
    name: "Zeng L",
    last: "Zeng",
    fore: "",
    initials: "L",
    collective: "",
  });
  assert.equal(parseSummaryAuthor("Walker-Smith JA").last, "Walker-Smith");
  assert.equal(parseSummaryAuthor("van der Berg AB").last, "van der Berg");
  assert.equal(parseSummaryAuthor("GBD 2023 Collaborators").last, "GBD 2023 Collaborators");
});

test("a cached record produces the same byline as a freshly fetched one", () => {
  const cached = sanitizeKnownRecord({
    pmid: "35935936",
    title: "Efficacy and Safety of Curcumin in Arthritis",
    abstract: "A meta-analysis of randomized controlled trials in arthritis patients.",
    journal: "Frontiers in immunology",
    year: 2022,
    volume: "13",
    pages: "891822",
    doi: "10.3389/fimmu.2022.891822",
    authors: ["Zeng L", "Yang T", "Yang K"],
  });

  const apa = formatCitation(cached, "apa");
  assert.match(apa, /^Zeng, L\., Yang, T\., & Yang, K\./);
  assert.doesNotMatch(apa, /^L, T/, "surname and initials must not be swapped");
  assert.match(apa, /Frontiers in immunology, 13, 891822\./);
});

test("a cached record without an abstract is rejected so the fetch path runs", () => {
  assert.equal(sanitizeKnownRecord({ pmid: "123", title: "No abstract here" }), null);
  assert.equal(sanitizeKnownRecord({ abstract: "text but no pmid" }), null);
  assert.equal(sanitizeKnownRecord(null), null);
  assert.equal(sanitizeKnownRecord("not an object"), null);
});

test("a cached record is reshaped, never spread wholesale", () => {
  const cached = sanitizeKnownRecord({
    pmid: "123",
    abstract: "An abstract long enough to be useful for summarizing purposes.",
    title: "T",
    authors: ["Solo X"],
    unexpectedField: "should not survive",
    retraction: { retracted: "yes-ish" },
  });
  assert.equal(cached.unexpectedField, undefined);
  assert.equal(cached.retraction.retracted, true);
  assert.equal(cached.retraction.expressionOfConcern, false);
});

test("an oversized cached field is truncated rather than passed through", () => {
  const cached = sanitizeKnownRecord({
    pmid: "123",
    abstract: "x".repeat(100000),
    title: "y".repeat(5000),
    authors: [],
  });
  assert.ok(cached.abstract.length <= 20000);
  assert.ok(cached.title.length <= 1000);
});

// --- caching (v3) --------------------------------------------------------

test("upstream responses are served from the edge cache when available", async () => {
  const original = globalThis.caches;
  const store = new Map();
  let upstreamCalls = 0;

  globalThis.caches = {
    default: {
      match: async (req) => store.get(req.url) ?? undefined,
      put: async (req, res) => store.set(req.url, res),
    },
  };
  const stub = stubFetch({
    "/works/": () => {
      upstreamCalls += 1;
      return OPENALEX_WORK;
    },
    "/sources/": OPENALEX_SOURCE,
    "/authors/": OPENALEX_AUTHOR,
  });

  try {
    const first = await fetchStudyMetrics(RECORD, {}, METRICS_CONFIG, YEAR);
    const second = await fetchStudyMetrics(RECORD, {}, METRICS_CONFIG, YEAR);

    assert.equal(first.citations, 400);
    assert.equal(second.citations, 400, "a cached response must parse the same way");
    assert.equal(upstreamCalls, 1, "the second lookup must not hit the upstream service");
  } finally {
    stub.restore();
    globalThis.caches = original;
  }
});

test("a broken cache never breaks a lookup", async () => {
  const original = globalThis.caches;
  globalThis.caches = {
    default: {
      match: async () => {
        throw new Error("cache exploded");
      },
      put: async () => {
        throw new Error("cache exploded");
      },
    },
  };
  const stub = stubFetch({ "/works/": OPENALEX_WORK, "/sources/": OPENALEX_SOURCE, "/authors/": OPENALEX_AUTHOR });
  try {
    const metrics = await fetchStudyMetrics(RECORD, {}, METRICS_CONFIG, YEAR);
    assert.equal(metrics.available, true);
    assert.equal(metrics.citations, 400);
  } finally {
    stub.restore();
    globalThis.caches = original;
  }
});

test("a rate-limited upstream reports the status rather than a blank result", async () => {
  const stub = stubFetch({
    "api.openalex.org": { status: 429, statusText: "Too Many Requests" },
    "semanticscholar.org": { status: 429, statusText: "Too Many Requests" },
  });
  try {
    const metrics = await fetchStudyMetrics(RECORD, {}, METRICS_CONFIG, YEAR);
    assert.equal(metrics.available, false);
    assert.match(metrics.reason, /429/);
    assert.match(metrics.note, /429/);
  } finally {
    stub.restore();
  }
});

test("a surname alone is not treated as an author match", async () => {
  const stub = stubFetch({
    "/works/": {
      body: {
        ...OPENALEX_WORK.body,
        authorships: [{ author: { id: "https://openalex.org/A9", display_name: "Denis Wakefield" } }],
      },
    },
    "/sources/": OPENALEX_SOURCE,
    "/authors/": { body: { display_name: "Denis Wakefield", summary_stats: { h_index: 6 }, works_count: 40 } },
  });
  try {
    const metrics = await fetchStudyMetrics(
      { ...RECORD, authors: [{ last: "Wakefield", fore: "A J", initials: "AJ", name: "A J Wakefield" }] },
      {},
      METRICS_CONFIG,
      YEAR,
    );
    assert.equal(metrics.authors[0].matched, false, "a different first name is a different person");
    assert.equal(metrics.authors[0].hIndex, null, "no record may be attributed to the wrong person");
  } finally {
    stub.restore();
  }
});

test("the same person written differently still matches", async () => {
  for (const indexed of ["Andrew J Wakefield", "A J Wakefield", "A. Wakefield"]) {
    const stub = stubFetch({
      "/works/": {
        body: {
          ...OPENALEX_WORK.body,
          authorships: [{ author: { id: "https://openalex.org/A1", display_name: indexed } }],
        },
      },
      "/sources/": OPENALEX_SOURCE,
      "/authors/": { body: { display_name: indexed, summary_stats: { h_index: 34 }, works_count: 83 } },
    });
    try {
      const metrics = await fetchStudyMetrics(
        { ...RECORD, authors: [{ last: "Wakefield", fore: "A J", initials: "AJ" }] },
        {},
        METRICS_CONFIG,
        YEAR,
      );
      assert.equal(metrics.authors[0].matched, true, `should match ${indexed}`);
    } finally {
      stub.restore();
    }
  }
});

test("a throttled OpenAlex is reported differently from an unindexed one", async () => {
  const throttled = stubFetch({
    "api.openalex.org": { status: 429, statusText: "Too Many Requests" },
    "semanticscholar.org": { body: { citationCount: 5, year: 2018, venue: "V", authors: [] } },
  });
  try {
    const metrics = await fetchStudyMetrics(RECORD, {}, METRICS_CONFIG, YEAR);
    assert.equal(metrics.source, "semantic-scholar");
    assert.match(metrics.note, /unavailable/i);
    assert.doesNotMatch(metrics.note, /had no record/i, "429 is not the same as not indexed");
  } finally {
    throttled.restore();
  }
});
