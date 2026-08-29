import test from "node:test";
import assert from "node:assert/strict";
import { parseStudyRef, parseRetractionStatus } from "../src/studyInspector.js";
import { scoreCredibility, CREDIBILITY_CONFIG } from "../src/credibility.js";

// --- reference parsing ---------------------------------------------------

const VALID_REFS = [
  ["https://pubmed.ncbi.nlm.nih.gov/9500320/", "pmid", "9500320"],
  ["https://pubmed.ncbi.nlm.nih.gov/9500320", "pmid", "9500320"],
  ["pubmed.ncbi.nlm.nih.gov/38908535/?utm_source=x", "pmid", "38908535"],
  ["https://www.ncbi.nlm.nih.gov/pubmed/12345678", "pmid", "12345678"],
  ["9500320", "pmid", "9500320"],
  ["  9500320  ", "pmid", "9500320"],
  ["PMID: 9500320", "pmid", "9500320"],
  ["pmid9500320", "pmid", "9500320"],
  ["10.1016/S0140-6736(97)11096-0", "doi", "10.1016/S0140-6736(97)11096-0"],
  ["https://doi.org/10.1017/S0033291724001697", "doi", "10.1017/S0033291724001697"],
  ["doi:10.1136/bmj.c7452", "doi", "10.1136/bmj.c7452"],
];

for (const [input, kind, value] of VALID_REFS) {
  test(`parses ${kind}: ${input.slice(0, 46)}`, () => {
    assert.deepEqual(parseStudyRef(input), { kind, value });
  });
}

test("rejects malformed input with a reason, not an exception", () => {
  const cases = ["", "   ", "not a reference at all", "12345678901234", "https://example.com/paper"];
  for (const input of cases) {
    const result = parseStudyRef(input);
    assert.equal(result.kind, "invalid", `expected invalid for ${JSON.stringify(input)}`);
    assert.ok(result.reason.length > 10, "should explain what went wrong");
  }
});

test("rejects non-string input without throwing", () => {
  for (const input of [null, undefined, 42, {}, []]) {
    assert.doesNotThrow(() => parseStudyRef(input));
  }
  assert.equal(parseStudyRef(null).kind, "invalid");
  assert.deepEqual(parseStudyRef(9500320), { kind: "pmid", value: "9500320" });
});

test("strips trailing sentence punctuation from a pasted DOI", () => {
  assert.equal(parseStudyRef("see 10.1136/bmj.c7452.").value, "10.1136/bmj.c7452");
});

// --- retraction parsing --------------------------------------------------

const retractedXml = [
  '<PublicationType UI="D016428">Journal Article</PublicationType>',
  '<PublicationType UI="D016441">Retracted Publication</PublicationType>',
  '<CommentsCorrections RefType="RetractionIn"><RefSource>Lancet. 2004</RefSource>',
  '<PMID Version="1">15016483</PMID></CommentsCorrections>',
].join("");

test("detects a retraction and links the notice", () => {
  const status = parseRetractionStatus(retractedXml);
  assert.equal(status.retracted, true);
  assert.equal(status.noticeUrl, "https://pubmed.ncbi.nlm.nih.gov/15016483/");
});

test("an expression of concern is not treated as a retraction", () => {
  const xml =
    '<PublicationType UI="D016428">Journal Article</PublicationType>' +
    '<CommentsCorrections RefType="ExpressionOfConcernIn"><PMID Version="1">999</PMID></CommentsCorrections>';
  const status = parseRetractionStatus(xml);
  assert.equal(status.retracted, false);
  assert.equal(status.expressionOfConcern, true);
});

test("a clean record reports no retraction", () => {
  const status = parseRetractionStatus('<PublicationType UI="D016428">Journal Article</PublicationType>');
  assert.equal(status.retracted, false);
  assert.equal(status.expressionOfConcern, false);
  assert.equal(status.noticeUrl, null);
});

test("a retraction notice itself is distinguished from a retracted paper", () => {
  const xml = '<PublicationType UI="D016440">Retraction of Publication</PublicationType>';
  const status = parseRetractionStatus(xml);
  assert.equal(status.isRetractionNotice, true);
  assert.equal(status.retracted, false);
});

// --- credibility scoring -------------------------------------------------

const STRONG_RECORD = {
  type: "meta-analysis",
  sampleSize: 7035,
  fundingSource: "government/nonprofit",
  fundingLabel: "Public or nonprofit funding",
  retraction: { retracted: false, expressionOfConcern: false },
};

const STRONG_METRICS = {
  available: true,
  source: "openalex",
  citations: 2953,
  citationsPerYear: 105.5,
  ageYears: 28,
  relativeToVenue: 5.25,
  venue: { name: "The Lancet", journalCitationRate: 20.11, hIndex: 1209 },
  authors: [{ role: "first", name: "A Researcher", matched: true, hIndex: 40, worksCount: 83 }],
  authorsMatched: true,
};

test("strong signals across the board produce a high label", () => {
  const result = scoreCredibility(STRONG_RECORD, STRONG_METRICS);
  assert.equal(result.label, "high");
  assert.ok(result.composite >= CREDIBILITY_CONFIG.thresholds.high);
  assert.equal(result.retracted, false);
});

test("retraction caps the composite despite every other signal being strong", () => {
  const retracted = {
    ...STRONG_RECORD,
    retraction: { retracted: true, expressionOfConcern: false, noticeUrl: "https://pubmed.ncbi.nlm.nih.gov/15016483/" },
  };
  const result = scoreCredibility(retracted, STRONG_METRICS);

  assert.equal(result.label, "retracted");
  assert.equal(result.retracted, true);
  assert.ok(
    result.composite <= CREDIBILITY_CONFIG.retraction.compositeCap,
    `composite ${result.composite} should be capped`,
  );
  assert.match(result.note, /retracted/i);
  assert.equal(result.retractionNoticeUrl, "https://pubmed.ncbi.nlm.nih.gov/15016483/");

  const citations = result.signals.find((s) => s.key === "citations");
  assert.equal(citations.score, 1, "individual signals stay as measured");
});

test("a retracted study always scores below a clean one", () => {
  const clean = scoreCredibility(STRONG_RECORD, STRONG_METRICS).composite;
  const weakButClean = scoreCredibility(
    { type: "case-report", sampleSize: 4, fundingSource: "undisclosed", retraction: {} },
    { available: false, citations: null, authors: [], venue: null },
  ).composite;
  const retracted = scoreCredibility(
    { ...STRONG_RECORD, retraction: { retracted: true } },
    STRONG_METRICS,
  ).composite;

  assert.ok(retracted < clean);
  assert.ok(retracted < weakButClean, "retraction must outrank a merely weak study");
});

test("an expression of concern caps the score but stays below retraction severity", () => {
  const concerned = scoreCredibility(
    { ...STRONG_RECORD, retraction: { retracted: false, expressionOfConcern: true } },
    STRONG_METRICS,
  );
  assert.equal(concerned.label !== "retracted", true);
  assert.ok(concerned.composite <= CREDIBILITY_CONFIG.retraction.concernCap);
  assert.ok(concerned.composite > CREDIBILITY_CONFIG.retraction.compositeCap);
  assert.match(concerned.note, /expression of concern/i);
});

test("missing metrics drop out of the composite instead of scoring zero", () => {
  const noMetrics = { available: false, citations: null, venue: null, authors: [] };
  const result = scoreCredibility(STRONG_RECORD, noMetrics);

  assert.equal(result.coverage.scored, 3);
  assert.equal(result.coverage.total, 6);
  assert.ok(result.composite > 0.8, `got ${result.composite}`);
  for (const key of ["citations", "venue", "authors"]) {
    const item = result.signals.find((s) => s.key === key);
    assert.equal(item.available, false);
    assert.ok(item.detail.length > 5, `${key} should explain why it is missing`);
  }
});

test("every signal is reported separately, never collapsed to the label alone", () => {
  const result = scoreCredibility(STRONG_RECORD, STRONG_METRICS);
  assert.deepEqual(
    result.signals.map((s) => s.key).sort(),
    ["authors", "citations", "design", "funding", "sample", "venue"],
  );
  for (const item of result.signals) {
    assert.ok(item.label, "each signal needs a display label");
    assert.ok(item.detail, "each signal needs a human-readable detail line");
  }
});

test("a very new paper's citation count is not scored", () => {
  const result = scoreCredibility(STRONG_RECORD, {
    ...STRONG_METRICS,
    citations: 1,
    citationsPerYear: 1,
    ageYears: 1,
    relativeToVenue: 0.05,
  });
  const citations = result.signals.find((s) => s.key === "citations");
  assert.equal(citations.available, false);
  assert.match(citations.detail, /too early/i);
});

test("unmatched authors are an explicit state, not a zero", () => {
  const result = scoreCredibility(STRONG_RECORD, {
    ...STRONG_METRICS,
    authors: [{ role: "first", name: "A Researcher", matched: false, reason: "no confident match", hIndex: null }],
    authorsMatched: false,
  });
  const authors = result.signals.find((s) => s.key === "authors");
  assert.equal(authors.available, false);
  assert.match(authors.detail, /could not confidently match/i);
  assert.equal(authors.unmatched.length, 1);
});

test("the response states what the score does and does not measure", () => {
  const result = scoreCredibility(STRONG_RECORD, STRONG_METRICS);
  assert.match(result.measures, /not an assessment of whether the findings are correct/i);
});

test("an empty record scores without throwing", () => {
  const result = scoreCredibility({}, {});
  assert.ok(["low", "moderate", "high"].includes(result.label));
  assert.equal(result.retracted, false);
});
