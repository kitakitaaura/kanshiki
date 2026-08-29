import test from "node:test";
import assert from "node:assert/strict";
import {
  stripMarkup,
  sanitizeClaim,
  sanitizeQuery,
  sanitizeRef,
  latinRatio,
  inputWarning,
  INPUT_CONFIG,
} from "../src/sanitize.js";

const INJECTIONS = [
  ["<script>alert(1)</script>Vitamin D cures depression", "Vitamin D cures depression"],
  ["<SCRIPT SRC=//evil.example/x.js></SCRIPT>turmeric", "turmeric"],
  ["<img src=x onerror=alert(1)>turmeric", "turmeric"],
  ["<a href=\"javascript:alert(1)\">click</a> turmeric", "click turmeric"],
  ["<style>body{display:none}</style>omega 3", "omega 3"],
  ["<b>bold</b> and <i>italic</i> claim", "bold and italic claim"],
  ["<div onclick='steal()'>vitamin C</div>", "vitamin C"],
  ["vitamin D <!-- comment --> depression", "vitamin D depression"],
];

for (const [attack, expected] of INJECTIONS) {
  test(`strips markup: ${attack.slice(0, 44)}`, () => {
    const result = sanitizeClaim(attack);
    assert.equal(result.ok, true);
    assert.equal(result.value, expected);
    assert.doesNotMatch(result.value, /<|>|javascript:|onerror|onclick/i);
  });
}

test("markup-only input is rejected with an explanation", () => {
  for (const input of ["<script></script>", "<div></div>", "<!-- -->"]) {
    const result = sanitizeClaim(input);
    assert.equal(result.ok, false);
    assert.match(result.error, /no readable text/i);
  }
});

test("empty and whitespace-only input is rejected before any downstream call", () => {
  for (const input of ["", "   ", "\t\n  "]) {
    const result = sanitizeClaim(input);
    assert.equal(result.ok, false);
    assert.match(result.error, /Enter a health claim/i);
  }
});

test("non-string input is rejected without throwing", () => {
  for (const input of [null, undefined, 42, {}, []]) {
    assert.doesNotThrow(() => sanitizeClaim(input));
    assert.equal(sanitizeClaim(input).ok, false);
  }
});

test("oversized input is rejected at the configured limit", () => {
  const long = "vitamin ".repeat(INPUT_CONFIG.maxClaimChars);
  const result = sanitizeClaim(long);
  assert.equal(result.ok, false);
  assert.match(result.error, /too long/i);

  const atLimit = "a".repeat(INPUT_CONFIG.maxClaimChars);
  assert.equal(sanitizeClaim(atLimit).ok, true, "exactly at the limit is allowed");
});

test("control characters and invisible formatting are removed", () => {
  const sneaky =
    "Vitamin\u0000 \u200bD\u202e cures\ufeff depression\u0008";
  const result = sanitizeClaim(sneaky);
  assert.equal(result.value, "Vitamin D cures depression");
  assert.doesNotMatch(result.value, /[\u0000-\u0008\u200b-\u200f\u202a-\u202e\ufeff]/);
});

test("ordinary punctuation and medical notation survive", () => {
  const claim = "Vitamin D (25-OH) at 2,000 IU/day reduces depression by 30%: true?";
  assert.equal(sanitizeClaim(claim).value, claim);
});

// --- query -------------------------------------------------------------

test("PubMed query syntax survives sanitizing", () => {
  const query = '("vitamin D"[MeSH Terms] OR cholecalciferol) AND depression[Title/Abstract] NOT review[Publication Type]';
  assert.equal(sanitizeQuery(query), query);
});

test("markup is stripped from a query without harming its operators", () => {
  const out = sanitizeQuery('<script>x</script>turmeric AND arthritis[MeSH]');
  assert.equal(out, "turmeric AND arthritis[MeSH]");
});

test("an oversized query is truncated at the configured limit", () => {
  assert.equal(sanitizeQuery("a".repeat(1000)).length, INPUT_CONFIG.maxQueryChars);
});

// --- reference ----------------------------------------------------------

test("a study reference is stripped and capped", () => {
  assert.equal(sanitizeRef("<script>x</script>9500320"), "9500320");
  assert.equal(sanitizeRef("x".repeat(999)).length, INPUT_CONFIG.maxRefChars);
  assert.equal(sanitizeRef(null), "");
});

// --- language -----------------------------------------------------------

test("latinRatio distinguishes scripts", () => {
  assert.equal(latinRatio("Vitamin D cures depression"), 1);
  assert.ok(latinRatio("ビタミンDはうつ病を治す") < 0.5);
  assert.ok(latinRatio("Витамин D лечит депрессию") < 0.5);
  // Digits and punctuation alone should not be treated as non-Latin.
  assert.equal(latinRatio("12345 !!!"), 1);
  assert.equal(latinRatio(""), 1);
});

test("non-Latin input warns rather than silently producing garbage", () => {
  const withAi = inputWarning("ビタミンDはうつ病を治す", { useAi: true });
  const withoutAi = inputWarning("ビタミンDはうつ病を治す", { useAi: false });

  assert.match(withAi, /English PubMed query/i);
  assert.match(withoutAi, /AI is switched off/i);
  assert.match(withoutAi, /type an English query/i);
  assert.notEqual(withAi, withoutAi, "the advice differs by mode");
});

test("English input produces no warning in either mode", () => {
  assert.equal(inputWarning("Vitamin D cures depression", { useAi: true }), null);
  assert.equal(inputWarning("Vitamin D cures depression", { useAi: false }), null);
});

test("mixed-script input with mostly Latin text is not warned about", () => {
  assert.equal(inputWarning("Vitamin D (ビタミン) cures depression", { useAi: false }), null);
});

// --- stripMarkup directly ------------------------------------------------

test("stripMarkup never throws on hostile input", () => {
  for (const input of [null, undefined, 42, {}, [], "<".repeat(5000), "<<<>>>"]) {
    assert.doesNotThrow(() => stripMarkup(input));
  }
});
