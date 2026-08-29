import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTimeline,
  scoreEvidence,
  scoreDirection,
  TIMELINE_CONFIG,
  SCORING_CONFIG,
} from "../src/scoring.js";

const YEAR = 2026;
const study = (type, year, stance, sampleSize = 500) => ({ type, year, stance, sampleSize });
const timeline = (studies, tcfg = TIMELINE_CONFIG) =>
  buildTimeline(studies, SCORING_CONFIG, tcfg, YEAR);

const SHIFTING = [
  study("case-report", 2005, "supports"),
  study("observational", 2008, "supports"),
  study("rct", 2014, "supports"),
  study("rct", 2018, "contradicts"),
  study("meta-analysis", 2022, "contradicts"),
  study("meta-analysis", 2024, "contradicts"),
];

test("checkpoints reflect a verdict that shifted over time", () => {
  const { checkpoints, skipped } = timeline(SHIFTING);
  assert.equal(skipped, null);
  assert.ok(checkpoints.length >= 2);

  const first = checkpoints[0];
  const last = checkpoints[checkpoints.length - 1];

  assert.equal(first.direction, "supported");
  assert.equal(last.direction, "contradicted");
  assert.equal(last.strength, "strong");
  assert.ok(last.score > first.score);
});

test("checkpoints are cumulative and ordered", () => {
  const { checkpoints } = timeline(SHIFTING);
  for (let i = 1; i < checkpoints.length; i += 1) {
    assert.ok(checkpoints[i].year > checkpoints[i - 1].year, "years must increase");
    assert.ok(
      checkpoints[i].studyCount > checkpoints[i - 1].studyCount,
      "study counts must accumulate",
    );
  }
  assert.equal(checkpoints[checkpoints.length - 1].studyCount, SHIFTING.length);
});

test("a checkpoint matches scoring the same filtered list directly", () => {
  const { checkpoints } = timeline(SHIFTING);
  const point = checkpoints[checkpoints.length - 1];
  const upTo = SHIFTING.filter((s) => s.year <= point.year);

  const grade = scoreEvidence(upTo, SCORING_CONFIG, point.year);
  const direction = scoreDirection(upTo, SCORING_CONFIG, undefined, point.year);

  assert.equal(point.strength, grade.label);
  assert.equal(point.score, grade.score);
  assert.equal(point.direction, direction.direction);
});

test("skips the timeline when all evidence is recent", () => {
  const recent = [
    study("rct", 2025, "supports"),
    study("rct", 2025, "supports"),
    study("meta-analysis", 2026, "supports"),
    study("rct", 2026, "contradicts"),
  ];
  const { checkpoints, skipped } = timeline(recent);
  assert.deepEqual(checkpoints, []);
  assert.match(skipped, /2025 and 2026/);
  assert.match(skipped, /not enough history/i);
});

test("skips the timeline when too few studies carry a date", () => {
  const undated = [
    { type: "rct", stance: "supports" },
    { type: "rct", stance: "supports" },
    study("meta-analysis", 2005, "supports"),
    study("rct", 2024, "contradicts"),
  ];
  const { checkpoints, skipped } = timeline(undated);
  assert.deepEqual(checkpoints, []);
  assert.match(skipped, /publication dates/i);
});

test("handles an empty study list without throwing", () => {
  const { checkpoints, skipped } = timeline([]);
  assert.deepEqual(checkpoints, []);
  assert.ok(skipped);
});

test("collapses checkpoints that added no new studies", () => {
  const gappy = [
    study("rct", 2000, "supports"),
    study("rct", 2001, "supports"),
    study("rct", 2002, "supports"),
    study("meta-analysis", 2024, "contradicts"),
  ];
  const { checkpoints } = timeline(gappy);
  const counts = checkpoints.map((c) => c.studyCount);
  assert.deepEqual(counts, [...new Set(counts)], `repeated counts in ${counts}`);
});

test("checkpoint count is configurable", () => {
  const few = timeline(SHIFTING, { ...TIMELINE_CONFIG, checkpoints: 2 });
  const many = timeline(SHIFTING, { ...TIMELINE_CONFIG, checkpoints: 8 });
  assert.ok(few.checkpoints.length <= 2);
  assert.ok(many.checkpoints.length >= few.checkpoints.length);
});

test("stable evidence produces a stable timeline", () => {
  const stable = [
    study("meta-analysis", 2008, "contradicts"),
    study("meta-analysis", 2013, "contradicts"),
    study("meta-analysis", 2018, "contradicts"),
    study("meta-analysis", 2024, "contradicts"),
  ];
  const { checkpoints } = timeline(stable);
  assert.ok(checkpoints.every((c) => c.direction === "contradicted"));
});

test("each checkpoint is scored as of its own year, not today", () => {
  const studies = [
    study("meta-analysis", 2004, "supports"),
    study("meta-analysis", 2010, "supports"),
    study("rct", 2016, "supports"),
    study("rct", 2022, "supports"),
  ];
  const { checkpoints } = timeline(studies);
  const point = checkpoints[0];
  const upTo = studies.filter((s) => s.year <= point.year);

  const asOfThen = scoreEvidence(upTo, SCORING_CONFIG, point.year).score;
  const asOfNow = scoreEvidence(upTo, SCORING_CONFIG, YEAR).score;

  assert.equal(point.score, asOfThen);
  assert.ok(asOfThen > asOfNow, "scoring as of the checkpoint year should decay less");
});

test("timeline never mutates the studies it is given", () => {
  const input = SHIFTING.map((s) => ({ ...s }));
  const snapshot = JSON.stringify(input);
  timeline(input);
  assert.equal(JSON.stringify(input), snapshot);
});
