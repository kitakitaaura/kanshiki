export const EVIDENCE_TIERS = [
  "systematic-review",
  "meta-analysis",
  "rct",
  "clinical-trial",
  "observational",
  "case-report",
  "review",
  "other",
];

export const TIER_LABELS = {
  "systematic-review": "Systematic review",
  "meta-analysis": "Meta-analysis",
  rct: "Randomized controlled trial",
  "clinical-trial": "Clinical trial (non-randomized)",
  observational: "Observational study",
  "case-report": "Case report",
  review: "Narrative review",
  other: "Other",
};

// First match wins.
const PUBTYPE_RULES = [
  ["meta-analysis", ["meta-analysis"]],
  ["systematic-review", ["systematic review"]],
  ["rct", ["randomized controlled trial", "randomised controlled trial"]],
  ["clinical-trial", ["clinical trial", "controlled clinical trial", "pragmatic clinical trial"]],
  ["observational", ["observational study", "comparative study", "multicenter study", "twin study"]],
  ["case-report", ["case reports", "case report"]],
  ["review", ["review", "scoping review", "narrative review"]],
];

// Fallback when publication types are uninformative.
const TEXT_RULES = [
  ["meta-analysis", /\bmeta[- ]analys[ie]s\b/i],
  ["systematic-review", /\bsystematic review\b/i],
  ["rct", /\brandomi[sz]ed (controlled |clinical )?trial\b|\bdouble[- ]blind\b|\bplacebo[- ]controlled\b/i],
  ["observational", /\b(cohort|cross[- ]sectional|case[- ]control|longitudinal) (study|analysis)\b|\bprospective cohort\b/i],
  ["case-report", /\bcase report\b|\bcase series\b/i],
];

export function classifyStudy(pubTypes = [], text = "") {
  const normalized = pubTypes.map((t) => String(t).toLowerCase().trim());
  for (const [tier, needles] of PUBTYPE_RULES) {
    if (normalized.some((t) => needles.includes(t))) return tier;
  }
  for (const [tier, re] of TEXT_RULES) {
    if (re.test(text)) return tier;
  }
  return "other";
}
