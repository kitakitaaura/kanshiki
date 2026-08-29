import test from "node:test";
import assert from "node:assert/strict";
import { selectSpotlight, scoreDirection, scoreStudy, SCORING_CONFIG } from "../src/scoring.js";

const YEAR = 2026;
const MIXED = { direction: "mixed" };

const study = (pmid, type, stance, year = 2024, sampleSize) => ({
  pmid,
  type,
  stance,
  year,
  sampleSize,
});

const pick = (studies, direction = MIXED) =>
  selectSpotlight(studies, direction, SCORING_CONFIG, YEAR);

test("picks the strongest study on each side", () => {
  const studies = [
    study("weak-for", "case-report", "supports"),
    study("best-for", "meta-analysis", "supports"),
    study("weak-against", "observational", "contradicts"),
    study("best-against", "rct", "contradicts"),
    study("ignored", "rct", "neutral"),
  ];
  const spot = pick(studies);
  assert.equal(spot.for.pmid, "best-for");
  assert.equal(spot.against.pmid, "best-against");
});

test("returns null unless the direction is mixed", () => {
  const studies = [study("a", "rct", "supports"), study("b", "rct", "contradicts")];
  for (const direction of ["supported", "contradicted", "leans-supported", "unassessed"]) {
    assert.equal(pick(studies, { direction }), null, `expected null for ${direction}`);
  }
  assert.equal(selectSpotlight(studies, null, SCORING_CONFIG, YEAR), null);
});

test("returns null when one side has no studies", () => {
  assert.equal(pick([study("a", "rct", "supports"), study("b", "rct", "neutral")]), null);
  assert.equal(pick([study("a", "rct", "contradicts")]), null);
  assert.equal(pick([]), null);
});

test("ties on tier are broken by the same composite the verdict uses", () => {
  const small = study("small", "rct", "supports", 2024, 40);
  const large = study("large", "rct", "supports", 2024, 20000);
  const against = study("x", "rct", "contradicts", 2024, 100);
  assert.ok(scoreStudy(large, SCORING_CONFIG, YEAR) > scoreStudy(small, SCORING_CONFIG, YEAR));
  assert.equal(pick([small, large, against]).for.pmid, "large");

  const older = study("older", "rct", "contradicts", 1999, 100);
  const newer = study("newer", "rct", "contradicts", 2025, 100);
  assert.equal(pick([small, older, newer]).against.pmid, "newer");
});

test("a lower tier does not beat a higher one on sample size alone", () => {
  const huge = study("huge-cohort", "observational", "supports", 2025, 500000);
  const meta = study("meta", "meta-analysis", "supports", 2019);
  const against = study("x", "rct", "contradicts");
  assert.equal(pick([huge, meta, against]).for.pmid, "meta");
});

test("selection is consistent with the direction tally's weighting", () => {
  const studies = [
    study("meta", "meta-analysis", "supports", 2025, 8000),
    study("case", "case-report", "contradicts", 2025),
    study("rct", "rct", "contradicts", 2024, 900),
  ];
  const spot = pick(studies);
  const chosen = studies.find((s) => s.pmid === spot.against.pmid);
  const other = studies.find((s) => s.pmid === "case");
  assert.ok(scoreStudy(chosen, SCORING_CONFIG, YEAR) > scoreStudy(other, SCORING_CONFIG, YEAR));
});

test("studies missing a year or sample size are still selectable", () => {
  const spot = pick([
    { pmid: "a", type: "rct", stance: "supports" },
    { pmid: "b", type: "rct", stance: "contradicts" },
  ]);
  assert.equal(spot.for.pmid, "a");
  assert.equal(spot.against.pmid, "b");
});

test("real mixed verdicts produce a spotlight end to end", () => {
  const studies = [
    study("s1", "meta-analysis", "supports", 2024, 5000),
    study("s2", "rct", "supports", 2023, 200),
    study("c1", "meta-analysis", "contradicts", 2025, 6000),
    study("c2", "rct", "contradicts", 2022, 300),
  ];
  const direction = scoreDirection(studies, SCORING_CONFIG, undefined, YEAR);
  assert.equal(direction.direction, "mixed");
  const spot = selectSpotlight(studies, direction, SCORING_CONFIG, YEAR);
  assert.equal(spot.for.pmid, "s1");
  assert.equal(spot.against.pmid, "c1");
});

// --- excerpt selection -------------------------------------------------

import { excerptFor } from "../src/pipeline.js";

test("excerpt prefers the concluding finding over opening background", () => {
  const abstract =
    "Neurosteroid and immunological actions of vitamin D may regulate depression-linked physiology. " +
    "We searched five databases through 2023 for randomized trials in adults. " +
    "Twelve trials were included in the meta-analysis. " +
    "Conclusions: vitamin D supplementation did not significantly reduce depressive symptoms.";
  assert.match(excerptFor({ abstract }), /did not significantly reduce/);
});

test("excerpt skips trailing registration and copyright boilerplate", () => {
  const abstract =
    "Background information about the condition and its prevalence worldwide. " +
    "We found no significant difference between groups at twelve weeks of follow-up. " +
    "Trial registration: ClinicalTrials.gov NCT01234567 registered on 1 January 2020. " +
    "Copyright 2024 The Authors, published by Elsevier under a user license.";
  const text = excerptFor({ abstract });
  assert.match(text, /no significant difference/);
  assert.doesNotMatch(text, /NCT01234567|Copyright/);
});

test("excerpt falls back to the last real sentence when no cue matches", () => {
  const abstract =
    "This paper describes a laboratory assay for measuring serum levels. " +
    "The assay was applied to samples collected across three separate sites.";
  assert.match(excerptFor({ abstract }), /three separate sites/);
});

test("excerpt handles a missing or unusable abstract", () => {
  assert.equal(excerptFor({ abstract: "" }), "");
  assert.equal(excerptFor({}), "");
  assert.equal(excerptFor({ abstract: "Too short." }), "");
});

test("excerpt truncates long sentences with an ellipsis", () => {
  const long = `We conclude that ${"x".repeat(400)}.`;
  const text = excerptFor({ abstract: `Background sentence here for padding. ${long}` }, 120);
  assert.ok(text.length <= 121, `got ${text.length}`);
  assert.ok(text.endsWith("…"));
});

test("a contradicting study's excerpt prefers its null result", () => {
  const abstract =
    "Vitamin D has been linked to mood regulation in observational work. " +
    "Supplementation showed no benefit on symptom scores at twelve months. " +
    "Further trials are warranted in larger and more diverse populations.";

  assert.match(excerptFor({ abstract, stance: "contradicts" }), /no benefit/);
  assert.match(excerptFor({ abstract }), /Further trials/);
});

test("supporting studies fall through to the general conclusion cues", () => {
  const abstract =
    "Background on the intervention and its proposed mechanism of action. " +
    "These findings suggest a modest benefit on symptom scores over placebo. " +
    "Limitations include heterogeneity in dose and duration across sites.";
  assert.match(excerptFor({ abstract, stance: "supports" }), /modest benefit/);
});
