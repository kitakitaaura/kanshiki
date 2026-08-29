import test from "node:test";
import assert from "node:assert/strict";
import { findRelated, similarity, tokenize, createHistory, RELATED_CONFIG } from "../public/related.js";

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

const HISTORY = [
  { claim: "Does vitamin D treat depression?", verdict: "Strong evidence", direction: "Mixed evidence" },
  { claim: "Omega-3 supplements prevent heart attacks", verdict: "Moderate evidence" },
  { claim: "Curcumin helps with arthritis pain", verdict: "Strong evidence" },
];

test("finds a paraphrase of a previously checked claim", () => {
  const match = findRelated("Vitamin D cures depression", HISTORY);
  assert.ok(match, "a paraphrase should be found");
  assert.equal(match.claim, "Does vitamin D treat depression?");
  assert.equal(match.verdict, "Strong evidence");
  assert.ok(match.score >= RELATED_CONFIG.minSimilarity);
});

test("finds a paraphrase that swaps a common synonym in wording", () => {
  const match = findRelated("Turmeric reduces arthritis pain", HISTORY);
  assert.ok(match);
  assert.equal(match.claim, "Curcumin helps with arthritis pain");
});

test("does not match an unrelated claim", () => {
  assert.equal(findRelated("Ivermectin treats COVID-19", HISTORY), null);
  assert.equal(findRelated("Does coffee cause cancer?", HISTORY), null);
});

test("does not match a different claim about the same substance", () => {
  // Same nutrient, different outcome: not a related question.
  assert.equal(findRelated("Vitamin D prevents bone fractures", HISTORY), null);
});

test("the identical question is not offered as a related claim", () => {
  assert.equal(findRelated("Does vitamin D treat depression?", HISTORY), null);
  assert.equal(findRelated("  does VITAMIN d treat depression?  ", HISTORY), null);
});

test("returns the closest match when several are similar", () => {
  const history = [
    { claim: "Vitamin D and depression in adults", verdict: "A" },
    { claim: "Vitamin D supplementation for depressive symptoms in adults", verdict: "B" },
  ];
  const match = findRelated("Vitamin D for depression in adults", history);
  assert.ok(match);
  assert.equal(match.claim, "Vitamin D and depression in adults");
});

test("an empty or trivial claim matches nothing", () => {
  assert.equal(findRelated("", HISTORY), null);
  assert.equal(findRelated("the", HISTORY), null);
  assert.equal(findRelated(null, HISTORY), null);
});

test("an empty history matches nothing and does not throw", () => {
  assert.equal(findRelated("Vitamin D cures depression", []), null);
  assert.equal(findRelated("Vitamin D cures depression", undefined), null);
  assert.equal(findRelated("Vitamin D cures depression", [null, {}, { claim: "" }]), null);
});

test("similarity is symmetric and bounded", () => {
  const a = "Vitamin D cures depression";
  const b = "Does vitamin D treat depression?";
  assert.equal(similarity(a, b), similarity(b, a));
  assert.ok(similarity(a, b) <= 1 && similarity(a, b) >= 0);
  assert.equal(similarity("", ""), 0);
});

test("tokenizing drops filler words and punctuation", () => {
  assert.deepEqual(tokenize("Does vitamin D really treat depression?!").sort(), ["depression", "vitamin"]);
});

// --- history ------------------------------------------------------------

test("history records claims and finds related ones later", () => {
  const h = createHistory(fakeStorage());
  h.record({ claim: "Does vitamin D treat depression?", verdict: { labelText: "Strong evidence" }, studies: [1, 2] });
  const match = h.findRelated("Vitamin D cures depression");
  assert.ok(match);
  assert.equal(match.verdict, "Strong evidence");
  assert.equal(match.studyCount, 2);
});

test("re-checking a claim replaces its history entry rather than duplicating", () => {
  const h = createHistory(fakeStorage());
  h.record({ claim: "Turmeric reduces arthritis pain" });
  h.record({ claim: "Turmeric reduces arthritis pain" });
  assert.equal(h.list().length, 1);
});

test("history is capped and keeps the most recent entries", () => {
  const h = createHistory(fakeStorage(), { ...RELATED_CONFIG, maxHistory: 3 });
  for (const n of [1, 2, 3, 4]) h.record({ claim: `claim number ${n}` });
  const claims = h.list().map((e) => e.claim);
  assert.equal(claims.length, 3);
  assert.equal(claims[0], "claim number 4");
  assert.ok(!claims.includes("claim number 1"));
});

test("a result with no claim is not recorded", () => {
  const h = createHistory(fakeStorage());
  h.record({});
  h.record(null);
  assert.equal(h.list().length, 0);
});

test("history failures never propagate to the caller", () => {
  const hostile = {
    getItem: () => "{{{not json",
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {},
  };
  const h = createHistory(hostile);
  // A broken store must not break checking a claim.
  assert.doesNotThrow(() => h.record({ claim: "Vitamin D cures depression" }));
  assert.deepEqual(h.list(), []);
  assert.equal(h.findRelated("Vitamin D cures depression"), null);
});

test("finding a related claim does not mutate the history or the query", () => {
  const h = createHistory(fakeStorage());
  h.record({ claim: "Does vitamin D treat depression?", verdict: { labelText: "Strong evidence" } });
  const before = JSON.stringify(h.list());
  const claim = "Vitamin D cures depression";
  h.findRelated(claim);
  assert.equal(JSON.stringify(h.list()), before);
  assert.equal(claim, "Vitamin D cures depression");
});
