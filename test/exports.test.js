import test from "node:test";
import assert from "node:assert/strict";
import {
  toCsv,
  studyToCsvRow,
  claimCsv,
  claimRis,
  claimReportHtml,
  studyReportHtml,
  generatedStamp,
  METHODOLOGY_FOOTER,
  EXPORT_CONFIG,
} from "../src/exportFormats.js";

const NOW = new Date("2026-08-28T12:00:00Z");

const STUDY = {
  pmid: "35935936",
  title: 'Curcumin in arthritis: a "systematic" review, with commas',
  authors: ["Zeng L", "Yang T"],
  journal: "Frontiers in immunology",
  year: 2022,
  typeLabel: "Meta-analysis",
  type: "meta-analysis",
  sampleSize: 2396,
  stance: "supports",
  fundingLabel: "Public or nonprofit funding",
  fundingSource: "government/nonprofit",
  retraction: { retracted: false },
  doi: "10.3389/fimmu.2022.891822",
  url: "https://pubmed.ncbi.nlm.nih.gov/35935936/",
  volume: "13",
  pages: "891822",
};

const RETRACTED = {
  ...STUDY,
  pmid: "9500320",
  title: "A withdrawn paper",
  stance: "contradicts",
  retraction: { retracted: true, noticeUrl: "https://pubmed.ncbi.nlm.nih.gov/15016483/" },
};

// A claim with every optional section populated.
const FULL_CLAIM = {
  claim: "Turmeric reduces arthritis pain",
  query: "turmeric arthritis pain",
  queryMode: "auto-extracted",
  summary: "The evidence is mixed but leans supportive.",
  verdict: {
    label: "strong",
    labelText: "Strong evidence",
    score: 298.8,
    rationale: ["Capped below Strong: no systematic review or meta-analysis."],
  },
  direction: { direction: "mixed", directionText: "Mixed evidence" },
  fundingBreakdown: {
    industryWeight: 0.3,
    nonIndustryWeight: 0.5,
    undisclosedWeight: 0.2,
    sufficient: true,
    counts: { industry: 1, "government/nonprofit": 2, mixed: 0, undisclosed: 1 },
    amongSupporting: { industry: 1, total: 3 },
  },
  timeline: [
    { year: 2019, strength: "moderate", strengthText: "Moderate evidence", direction: "supported", directionText: "Supported by the evidence", studyCount: 3 },
    { year: 2026, strength: "strong", strengthText: "Strong evidence", direction: "mixed", directionText: "Mixed evidence", studyCount: 20 },
  ],
  spotlight: { for: STUDY, against: RETRACTED },
  studies: [STUDY, RETRACTED],
  meta: { totalMatches: 445, shown: 20 },
};

// The same shape with every optional section absent.
const MINIMAL_CLAIM = {
  claim: "An obscure claim",
  query: "obscure claim",
  verdict: { label: "insufficient", labelText: "Insufficient evidence", score: 0, rationale: [] },
  direction: { direction: "unassessed", directionText: "Direction not assessed" },
  fundingBreakdown: { counts: { industry: 0, "government/nonprofit": 0, mixed: 0, undisclosed: 0 } },
  timeline: [],
  spotlight: null,
  studies: [],
  summary: "",
  meta: { totalMatches: 0, shown: 0 },
};

// --- CSV ----------------------------------------------------------------

test("CSV header covers every column the researcher schema promises", () => {
  const header = claimCsv(FULL_CLAIM).split("\r\n")[0];
  for (const label of [
    "Title", "Authors", "Journal", "Year", "Study type",
    "Sample size", "Direction", "Funding", "Retracted", "DOI", "PMID", "PubMed link",
  ]) {
    assert.ok(header.includes(`"${label}"`), `missing column ${label}`);
  }
});

test("CSV writes one row per study with the expected values", () => {
  const rows = claimCsv(FULL_CLAIM).trim().split("\r\n");
  assert.equal(rows.length, 3, "header plus two studies");
  assert.match(rows[1], /"Zeng L; Yang T"/);
  assert.match(rows[1], /"2396"/);
  assert.match(rows[1], /"supports"/);
  assert.match(rows[1], /"no"/);
  assert.match(rows[2], /"yes"/, "retracted study flagged");
});

test("CSV escapes quotes and commas inside fields", () => {
  const row = claimCsv(FULL_CLAIM).split("\r\n")[1];
  assert.match(row, /""systematic""/, "inner quotes doubled");
  assert.equal((row.match(/","/g) || []).length, EXPORT_CONFIG.csvColumns.length - 1);
});

test("CSV of a claim with no studies is a header alone, not an error", () => {
  const out = claimCsv(MINIMAL_CLAIM);
  assert.equal(out.trim().split("\r\n").length, 1);
  assert.doesNotMatch(out, /undefined|null|NaN/);
});

test("CSV never emits undefined for missing optional fields", () => {
  const bare = { pmid: "1", title: "Bare" };
  const out = toCsv([studyToCsvRow(bare)]);
  assert.doesNotMatch(out, /undefined|null|NaN/);
  assert.match(out, /"not assessed"/);
  assert.match(out, /"Funding not disclosed"/);
});

// --- printable report ----------------------------------------------------

test("a full claim report includes every optional section", () => {
  const html = claimReportHtml(FULL_CLAIM, { now: NOW });
  for (const heading of [
    "Summary", "Why this grade", "Funding", "Evidence over time",
    "Strongest evidence on each side", "Source studies (2)",
  ]) {
    assert.ok(html.includes(`<h2>${heading}</h2>`), `missing section ${heading}`);
  }
  assert.ok(html.includes("Strong evidence"));
  assert.ok(html.includes("Mixed evidence"));
  assert.ok(html.includes("Capped below Strong"), "gate explanation carried through");
  assert.ok(html.includes("2019") && html.includes("2026"), "timeline checkpoints present");
});

test("a minimal claim report omits absent sections rather than showing empty ones", () => {
  const html = claimReportHtml(MINIMAL_CLAIM, { now: NOW });
  for (const heading of [
    "Why this grade", "Funding", "Evidence over time", "Strongest evidence on each side", "Summary",
  ]) {
    assert.ok(!html.includes(`<h2>${heading}</h2>`), `${heading} should be omitted`);
  }
  assert.ok(html.includes("No studies matched this claim."));
  assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/);
});

test("reports escape HTML in claim and study text", () => {
  const hostile = {
    ...MINIMAL_CLAIM,
    claim: '<script>alert("x")</script>',
    studies: [{ ...STUDY, title: "<img onerror=alert(1)>" }],
  };
  const html = claimReportHtml(hostile, { now: NOW });
  assert.ok(!html.includes("<script>alert"), "claim text must be escaped");
  assert.ok(!html.includes("<img onerror"), "study title must be escaped");
  assert.ok(html.includes("&lt;script&gt;"));
});

test("reports mark retracted studies in the source table", () => {
  const html = claimReportHtml(FULL_CLAIM, { now: NOW });
  assert.match(html, /\[RETRACTED\]/);
});

test("every report carries the methodology footer and a timestamp", () => {
  for (const html of [
    claimReportHtml(FULL_CLAIM, { now: NOW }),
    claimReportHtml(MINIMAL_CLAIM, { now: NOW }),
    studyReportHtml({ record: STUDY, credibility: { labelText: "Strong credibility signals", signals: [] } }, { now: NOW }),
  ]) {
    assert.ok(html.includes("Generated 2026-08-28 12:00 UTC"));
    assert.ok(html.includes(METHODOLOGY_FOOTER[0].slice(0, 40)));
    assert.ok(html.includes("PubMed"), "data sources named");
  }
});

test("generatedStamp is stable and minute-resolution", () => {
  assert.equal(generatedStamp(NOW), "Generated 2026-08-28 12:00 UTC");
});

// --- study report --------------------------------------------------------

test("a study report renders the credibility breakdown", () => {
  const html = studyReportHtml(
    {
      record: STUDY,
      summary: "A meta-analysis of arthritis trials.",
      credibility: {
        labelText: "Strong credibility signals",
        measures: "Credibility signals only.",
        signals: [
          { key: "design", label: "Study design", score: 1, available: true, detail: "Meta-analysis" },
          { key: "venue", label: "Venue standing", score: null, available: false, detail: "Venue not indexed" },
        ],
      },
      metrics: { citations: 145, citationsPerYear: 36.3, relativeToVenue: 6.84, venue: { journalCitationRate: 5.31 } },
    },
    { now: NOW },
  );
  assert.ok(html.includes("Study design"));
  assert.ok(html.includes("Meta-analysis"));
  assert.ok(html.includes("no data"), "unavailable signals say so rather than showing 0");
  assert.ok(html.includes("145 citations"));
});

test("a retracted study report leads with the retraction", () => {
  const html = studyReportHtml(
    { record: RETRACTED, credibility: { labelText: "Retracted", retracted: true, signals: [] } },
    { now: NOW },
  );
  const retractionIndex = html.indexOf("has been retracted");
  const credibilityIndex = html.indexOf("Credibility signals");
  assert.ok(retractionIndex > 0);
  assert.ok(credibilityIndex === -1 || retractionIndex < credibilityIndex);
});

test("a study report with almost no data still renders", () => {
  const html = studyReportHtml({ record: { pmid: "1" } }, { now: NOW });
  assert.ok(html.includes("PMID 1"));
  assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/);
});

// --- RIS bulk ------------------------------------------------------------

test("claim RIS export contains one record per study with bylines", () => {
  const ris = claimRis(FULL_CLAIM);
  assert.equal((ris.match(/^TY {2}- JOUR$/gm) || []).length, 2);
  assert.match(ris, /^AU {2}- Zeng, L$/m, "string bylines are parsed surname first");
  assert.match(ris, /^N1 {2}- Retracted publication$/m);
});

test("claim RIS export of an empty claim is empty, not malformed", () => {
  assert.equal(claimRis(MINIMAL_CLAIM).trim(), "");
});
