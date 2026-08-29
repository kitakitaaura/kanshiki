import test from "node:test";
import assert from "node:assert/strict";
import { classifyFunding, declaredNoFunding, FUNDING_LABELS } from "../src/funding.js";
import { parseFundingStatements } from "../src/pubmed.js";
import {
  scoreFunding,
  scoreEvidence,
  scoreDirection,
  FUNDING_CONFIG,
  SCORING_CONFIG,
} from "../src/scoring.js";

const YEAR = 2026;

// --- classifier fixtures ------------------------------------------------

const FIXTURES = [
  ["This work was supported by the National Institute of Mental Health (R01MH123456).", "government/nonprofit"],
  ["Grant agencies: NIMH NIH HHS; NHLBI NIH HHS", "government/nonprofit"],
  ["Funded by the Wellcome Trust and Cancer Research UK.", "government/nonprofit"],
  ["Supported by the National Natural Science Foundation of China (81773507).", "government/nonprofit"],
  ["This study was funded by Pfizer Inc.", "industry"],
  ["The trial was sponsored by Novo Nordisk A/S.", "industry"],
  ["Dr Smith has received honoraria from AstraZeneca.", "industry"],
  ["Study capsules were provided free of charge by Pharmavite.", "industry"],
  ["Supported by NIH grant R01DK000000 and an unrestricted grant from Novartis Pharmaceuticals.", "mixed"],
  ["Funded by the Medical Research Council; Dr Jones is an employee of GSK.", "mixed"],
  ["The authors declare no competing interests.", "undisclosed"],
  ["None.", "undisclosed"],
  ["This research received no specific funding from any agency.", "undisclosed"],
  ["", "undisclosed"],
  [null, "undisclosed"],
  [undefined, "undisclosed"],
];

for (const [text, expected] of FIXTURES) {
  test(`classifies: ${String(text).slice(0, 50) || "(empty)"} -> ${expected}`, () => {
    const result = classifyFunding(text);
    assert.equal(result.source, expected);
    assert.equal(result.label, FUNDING_LABELS[expected]);
  });
}

test("a no-funding declaration is undisclosed, not public funding", () => {
  const text = "This research received no specific grant from any funding agency.";
  assert.equal(classifyFunding(text).source, "undisclosed");
  assert.equal(declaredNoFunding(text), true);
  assert.equal(declaredNoFunding(""), false);
});

test("classifier reports what it matched, for auditing", () => {
  const r = classifyFunding("Funded by Pfizer Inc. and the NIH.");
  assert.equal(r.source, "mixed");
  assert.ok(r.matched.some((m) => m.startsWith("industry:")));
  assert.ok(r.matched.some((m) => m.startsWith("government/nonprofit:")));
});

test("classifier does not throw on hostile input", () => {
  for (const input of [{}, [], 42, " ", "x".repeat(50000)]) {
    assert.doesNotThrow(() => classifyFunding(input));
  }
});

// --- XML extraction -----------------------------------------------------

test("pulls grant agencies and COI text out of efetch XML", () => {
  const xml = [
    "<PubmedArticleSet>",
    '<PubmedArticle><MedlineCitation><PMID Version="1">111</PMID>',
    "<GrantList><Grant><Agency>NIMH NIH HHS</Agency></Grant>",
    "<Grant><Agency>NIMH NIH HHS</Agency></Grant>",
    "<Grant><Agency>NHLBI NIH HHS</Agency></Grant></GrantList>",
    "<CoiStatement>The authors declare no competing interests.</CoiStatement>",
    "</MedlineCitation></PubmedArticle>",
    '<PubmedArticle><MedlineCitation><PMID Version="1">222</PMID>',
    "<CoiStatement>Dr X received fees from Bayer &amp; Co.</CoiStatement>",
    "</MedlineCitation></PubmedArticle>",
    '<PubmedArticle><MedlineCitation><PMID Version="1">333</PMID></MedlineCitation></PubmedArticle>',
    "</PubmedArticleSet>",
  ].join("");

  const map = parseFundingStatements(xml);

  assert.match(map.get("111"), /NIMH NIH HHS; NHLBI NIH HHS/); // deduped
  assert.match(map.get("111"), /no competing interests/);
  assert.match(map.get("222"), /Bayer & Co\./); // entity decoded
  assert.equal(map.has("333"), false); // nothing to say is missing, not empty
  assert.equal(classifyFunding(map.get("111")).source, "government/nonprofit");
  assert.equal(classifyFunding(map.get("222")).source, "industry");
});

test("malformed XML yields no funding rather than throwing", () => {
  assert.equal(parseFundingStatements("").size, 0);
  assert.equal(parseFundingStatements("<PubmedArticle>garbage no pmid").size, 0);
  assert.equal(parseFundingStatements("<PubmedArticle><PMID>1</PMID><CoiStatement>unclosed").size, 0);
});

// --- weighted aggregate -------------------------------------------------

const study = (type, fundingSource, stance = "supports", year = 2024) => ({
  type,
  fundingSource,
  stance,
  year,
});

const funding = (studies) => scoreFunding(studies, SCORING_CONFIG, FUNDING_CONFIG, YEAR);

test("weights the funding mix by study quality, not headcount", () => {
  const r = funding([
    study("meta-analysis", "industry"),
    study("case-report", "government/nonprofit"),
    study("case-report", "government/nonprofit"),
    study("case-report", "government/nonprofit"),
  ]);
  assert.ok(r.industryWeight > r.nonIndustryWeight);
  assert.equal(r.counts["government/nonprofit"], 3);
});

test("mixed funding is split between both buckets", () => {
  const r = funding([study("rct", "mixed")]);
  assert.equal(r.industryWeight, 0.5);
  assert.equal(r.nonIndustryWeight, 0.5);
  assert.equal(r.undisclosedWeight, 0);
});

test("shares are fractions of the whole", () => {
  const r = funding([
    study("rct", "industry"),
    study("rct", "government/nonprofit"),
    study("rct", "undisclosed"),
  ]);
  const sum = r.industryWeight + r.nonIndustryWeight + r.undisclosedWeight;
  assert.ok(Math.abs(sum - 1) < 0.02, `shares summed to ${sum}`);
});

test("mostly-undisclosed funding is reported as insufficient coverage", () => {
  const r = funding([
    study("meta-analysis", "undisclosed"),
    study("meta-analysis", "undisclosed"),
    study("case-report", "industry"),
  ]);
  assert.equal(r.sufficient, false);
  assert.ok(r.coverage < FUNDING_CONFIG.minCoverage);
});

test("counts industry funding among supporting studies specifically", () => {
  const r = funding([
    study("rct", "industry", "supports"),
    study("rct", "mixed", "supports"),
    study("rct", "government/nonprofit", "supports"),
    study("rct", "industry", "contradicts"),
  ]);
  assert.deepEqual(r.amongSupporting, { industry: 2, total: 3 });
});

test("missing and unknown funding sources fall back to undisclosed", () => {
  const r = funding([{ type: "rct", year: 2024 }, study("rct", "not-a-real-source")]);
  assert.equal(r.counts.undisclosed, 2);
  assert.equal(r.undisclosedWeight, 1);
});

test("no studies produces zeroes, not NaN", () => {
  const r = funding([]);
  for (const key of ["industryWeight", "nonIndustryWeight", "undisclosedWeight", "coverage"]) {
    assert.equal(r[key], 0, key);
  }
  assert.equal(r.sufficient, false);
});

test("funding never moves the strength or direction verdict", () => {
  const base = [
    { type: "meta-analysis", year: 2024, sampleSize: 5000, stance: "supports" },
    { type: "rct", year: 2023, sampleSize: 400, stance: "contradicts" },
  ];
  const industry = base.map((s) => ({ ...s, fundingSource: "industry" }));
  const publicly = base.map((s) => ({ ...s, fundingSource: "government/nonprofit" }));

  assert.equal(scoreEvidence(industry).score, scoreEvidence(publicly).score);
  assert.equal(scoreEvidence(industry).label, scoreEvidence(base).label);
  assert.equal(scoreDirection(industry).direction, scoreDirection(publicly).direction);
  assert.equal(scoreDirection(industry).supportWeight, scoreDirection(base).supportWeight);
});
