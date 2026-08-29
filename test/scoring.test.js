import test from "node:test";
import assert from "node:assert/strict";
import { scoreEvidence, scoreStudy, SCORING_CONFIG } from "../src/scoring.js";
import { classifyStudy } from "../src/classify.js";

const YEAR = 2026;
const study = (type, year = YEAR - 2, sampleSize) => ({ type, year, sampleSize });

test("no studies is insufficient, not an error", () => {
  const r = scoreEvidence([], SCORING_CONFIG, YEAR);
  assert.equal(r.label, "insufficient");
  assert.equal(r.score, 0);
  assert.equal(r.topTier, null);
});

test("a recent meta-analysis plus RCTs reaches strong", () => {
  const r = scoreEvidence(
    [study("meta-analysis", 2024, 12000), study("rct", 2023, 800), study("rct", 2021, 400)],
    SCORING_CONFIG,
    YEAR,
  );
  assert.equal(r.label, "strong");
  assert.equal(r.topTier, "meta-analysis");
});

test("a single RCT is moderate at best", () => {
  const r = scoreEvidence([study("rct", 2024, 200)], SCORING_CONFIG, YEAR);
  assert.ok(["weak", "moderate"].includes(r.label));
  assert.notEqual(r.label, "strong");
});

test("a pile of observational studies cannot reach strong", () => {
  const many = Array.from({ length: 40 }, () => study("observational", 2024, 9000));
  const r = scoreEvidence(many, SCORING_CONFIG, YEAR);
  assert.notEqual(r.label, "strong");
});

test("case reports alone stay below moderate", () => {
  const r = scoreEvidence(
    Array.from({ length: 10 }, () => study("case-report", 2025)),
    SCORING_CONFIG,
    YEAR,
  );
  assert.ok(["weak", "insufficient"].includes(r.label));
});

test("recency lowers the score of an identical older study", () => {
  const recent = scoreStudy(study("rct", 2025, 500), SCORING_CONFIG, YEAR);
  const old = scoreStudy(study("rct", 1995, 500), SCORING_CONFIG, YEAR);
  assert.ok(old < recent);
  assert.ok(old / recent >= SCORING_CONFIG.recency.floor - 1e-9);
});

test("larger samples score at least as high", () => {
  const small = scoreStudy(study("rct", 2024, 30), SCORING_CONFIG, YEAR);
  const large = scoreStudy(study("rct", 2024, 20000), SCORING_CONFIG, YEAR);
  assert.ok(large > small);
});

test("missing year and sample size are handled", () => {
  const r = scoreEvidence([{ type: "rct" }], SCORING_CONFIG, YEAR);
  assert.ok(Number.isFinite(r.score));
  assert.equal(r.newestYear, null);
});

test("unknown study type falls back to the 'other' weight", () => {
  const r = scoreEvidence([{ type: "nonsense-tier", year: 2025 }], SCORING_CONFIG, YEAR);
  assert.equal(r.score, scoreEvidence([{ type: "other", year: 2025 }], SCORING_CONFIG, YEAR).score);
  assert.equal(r.label, "insufficient");
});

test("the strong gate demotes a big pile of trial-free evidence", () => {
  const many = Array.from({ length: 30 }, () => ({ type: "clinical-trial", year: 2025, sampleSize: 50000 }));
  const r = scoreEvidence(many, SCORING_CONFIG, YEAR);
  assert.equal(r.label, "moderate");
  assert.ok(r.rationale.some((line) => line.startsWith("Capped below Strong")));
});

test("classifier prefers publication types over title text", () => {
  assert.equal(classifyStudy(["Meta-Analysis", "Journal Article"], "a cohort study"), "meta-analysis");
  assert.equal(classifyStudy(["Journal Article"], "A double-blind placebo-controlled trial"), "rct");
  assert.equal(classifyStudy([], ""), "other");
});

// --- retraction exclusion (v3) -------------------------------------------

import { partitionRetracted, buildTimeline, scoreDirection, RETRACTION_POLICY } from "../src/scoring.js";

const retracted = (base) => ({ ...base, retraction: { retracted: true, noticeUrl: "x" } });

test("a retracted study contributes nothing to the strength score", () => {
  const clean = [study("rct", 2024, 300)];
  const withRetracted = [...clean, retracted(study("meta-analysis", 2025, 50000))];

  const { included, excludedCount } = partitionRetracted(withRetracted);
  assert.equal(excludedCount, 1);
  assert.equal(included.length, 1);
  assert.equal(
    scoreEvidence(included, SCORING_CONFIG, YEAR).score,
    scoreEvidence(clean, SCORING_CONFIG, YEAR).score,
    "a retracted meta-analysis must not raise the score at all",
  );
});

test("a retracted study contributes nothing to direction", () => {
  const supporting = [{ type: "rct", year: 2024, stance: "supports" }];
  const plusRetracted = [
    ...supporting,
    retracted({ type: "meta-analysis", year: 2025, stance: "contradicts", sampleSize: 90000 }),
  ];
  const { included } = partitionRetracted(plusRetracted);
  assert.equal(
    scoreDirection(included, SCORING_CONFIG, undefined, YEAR).contradictWeight,
    0,
    "a retracted contradicting study must not shift direction",
  );
});

test("partitioning keeps the retracted studies so they can still be shown", () => {
  const item = retracted(study("rct", 2024, 100));
  const { included, excluded, excludedCount } = partitionRetracted([item, study("rct", 2023, 100)]);
  assert.equal(excludedCount, 1);
  assert.deepEqual(excluded, [item], "excluded studies are returned, not discarded");
  assert.equal(included.length, 1);
});

test("nothing is excluded when no study is retracted", () => {
  const clean = [study("rct", 2024, 100), { type: "rct", year: 2020, retraction: { retracted: false } }];
  const { included, excludedCount } = partitionRetracted(clean);
  assert.equal(excludedCount, 0);
  assert.equal(included.length, 2);
});

test("partitioning handles studies with no retraction field at all", () => {
  const { excludedCount } = partitionRetracted([{ type: "rct" }, {}, null].filter(Boolean));
  assert.equal(excludedCount, 0);
});

test("the timeline excludes retracted studies at every checkpoint", () => {
  const base = [
    { type: "rct", year: 2005, stance: "supports", sampleSize: 200 },
    { type: "rct", year: 2012, stance: "supports", sampleSize: 200 },
    { type: "rct", year: 2018, stance: "supports", sampleSize: 200 },
    { type: "rct", year: 2024, stance: "supports", sampleSize: 200 },
  ];
  const withRetracted = [...base, retracted({ type: "meta-analysis", year: 2006, stance: "contradicts", sampleSize: 80000 })];

  const plain = buildTimeline(base, SCORING_CONFIG, undefined, YEAR);
  const polluted = buildTimeline(withRetracted, SCORING_CONFIG, undefined, YEAR);

  assert.deepEqual(
    polluted.checkpoints.map((c) => [c.year, c.score, c.studyCount]),
    plain.checkpoints.map((c) => [c.year, c.score, c.studyCount]),
    "a retracted study must not appear in any checkpoint, including ones after its publication",
  );
});

test("the exclusion policy is a config value, not a hardcoded rule", () => {
  const item = retracted(study("rct", 2024, 100));
  const off = partitionRetracted([item], { excludeFromScoring: false });
  assert.equal(off.excludedCount, 0);
  assert.equal(off.included.length, 1);
  assert.equal(RETRACTION_POLICY.excludeFromScoring, true, "excluded by default");
});
