import { TIER_LABELS } from "./classify.js";

export const SCORING_CONFIG = {
  tierWeights: {
    "systematic-review": 100,
    "meta-analysis": 100,
    rct: 55,
    "clinical-trial": 30,
    observational: 18,
    "case-report": 5,
    review: 6,
    other: 3,
  },

  recency: {
    fullDecayYears: 25,
    floor: 0.55,
    assumedAgeYears: 10,
  },

  sampleSize: {
    unknownMultiplier: 1.0,
    brackets: [
      { min: 5000, multiplier: 1.25 },
      { min: 500, multiplier: 1.1 },
      { min: 50, multiplier: 1.0 },
      { min: 0, multiplier: 0.8 },
    ],
  },

  aggregation: {
    replicationDecay: 0.75,
    maxStudiesCounted: 25,
  },

  thresholds: {
    strong: 140,
    moderate: 50,
    weak: 15,
  },

  gates: {
    strong: { requiresTopTierOrRcts: 2 },
    moderate: {
      requiresAnyOf: ["systematic-review", "meta-analysis", "rct", "clinical-trial"],
      orObservationalCount: 3,
    },
  },
};

export const RETRACTION_POLICY = {
  excludeFromScoring: true,
};

/**
 * Splits retracted studies out before anything is scored.
 *
 * Retracted work is still returned to the caller and still shown in the UI
 * with its badge. It simply contributes nothing: not to strength, direction,
 * the spotlight, the funding mix, or any timeline checkpoint.
 */
export function partitionRetracted(studies = [], policy = RETRACTION_POLICY) {
  if (!policy.excludeFromScoring) return { included: studies, excluded: [], excludedCount: 0 };
  const included = [];
  const excluded = [];
  for (const study of studies) {
    if (study?.retraction?.retracted) excluded.push(study);
    else included.push(study);
  }
  return { included, excluded, excludedCount: excluded.length };
}

export const VERDICT_LABELS = {
  strong: "Strong evidence",
  moderate: "Moderate evidence",
  weak: "Weak evidence",
  insufficient: "Insufficient evidence",
};

function recencyMultiplier(year, cfg, currentYear) {
  const { fullDecayYears, floor, assumedAgeYears } = cfg.recency;
  const age = Number.isFinite(year) ? Math.max(0, currentYear - year) : assumedAgeYears;
  const decayed = 1 - (Math.min(age, fullDecayYears) / fullDecayYears) * (1 - floor);
  return Math.max(floor, decayed);
}

function sampleMultiplier(sampleSize, cfg) {
  if (!Number.isFinite(sampleSize) || sampleSize <= 0) return cfg.sampleSize.unknownMultiplier;
  for (const bracket of cfg.sampleSize.brackets) {
    if (sampleSize >= bracket.min) return bracket.multiplier;
  }
  return cfg.sampleSize.unknownMultiplier;
}

export function scoreStudy(study, cfg = SCORING_CONFIG, currentYear = new Date().getUTCFullYear()) {
  const base = cfg.tierWeights[study.type] ?? cfg.tierWeights.other;
  return base * recencyMultiplier(study.year, cfg, currentYear) * sampleMultiplier(study.sampleSize, cfg);
}

function passesGates(label, counts, cfg) {
  if (label === "strong") {
    const topTier = counts["systematic-review"] + counts["meta-analysis"];
    return topTier > 0 || counts.rct >= cfg.gates.strong.requiresTopTierOrRcts;
  }
  if (label === "moderate") {
    if (cfg.gates.moderate.requiresAnyOf.some((t) => counts[t] > 0)) return true;
    return counts.observational >= cfg.gates.moderate.orObservationalCount;
  }
  return true;
}

export function scoreEvidence(studies = [], cfg = SCORING_CONFIG, currentYear = new Date().getUTCFullYear()) {
  const counts = Object.fromEntries(Object.keys(cfg.tierWeights).map((t) => [t, 0]));
  for (const s of studies) counts[s.type] = (counts[s.type] ?? 0) + 1;

  const scored = studies
    .map((s) => ({ study: s, score: scoreStudy(s, cfg, currentYear) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.aggregation.maxStudiesCounted);

  const total = scored.reduce(
    (sum, s, i) => sum + s.score * Math.pow(cfg.aggregation.replicationDecay, i),
    0,
  );
  const score = Math.round(total * 10) / 10;

  let label = "insufficient";
  if (studies.length > 0) {
    if (score >= cfg.thresholds.strong) label = "strong";
    else if (score >= cfg.thresholds.moderate) label = "moderate";
    else if (score >= cfg.thresholds.weak) label = "weak";
  }

  const rationale = [];
  const ladder = ["strong", "moderate", "weak", "insufficient"];
  let i = ladder.indexOf(label);
  while (i < ladder.length - 1 && !passesGates(ladder[i], counts, cfg)) {
    rationale.push(
      ladder[i] === "strong"
        ? "Capped below Strong: no systematic review or meta-analysis, and fewer than " +
            `${cfg.gates.strong.requiresTopTierOrRcts} randomized trials.`
        : "Capped below Moderate: no controlled trial, and too few observational studies to compensate.",
    );
    i += 1;
  }
  label = ladder[i];

  const years = studies.map((s) => s.year).filter(Number.isFinite);
  const ranked = Object.keys(cfg.tierWeights).sort((a, b) => cfg.tierWeights[b] - cfg.tierWeights[a]);
  const topTier = ranked.find((t) => counts[t] > 0) ?? null;

  return {
    score,
    label,
    labelText: VERDICT_LABELS[label],
    counts,
    topTier,
    topTierText: topTier ? TIER_LABELS[topTier] : null,
    studyCount: studies.length,
    newestYear: years.length ? Math.max(...years) : null,
    oldestYear: years.length ? Math.min(...years) : null,
    rationale,
  };
}

export const STANCES = ["supports", "contradicts", "neutral", "unassessed"];

export const DIRECTION_CONFIG = {
  minDecisiveShare: 0.3,
  clearMajority: 0.7,
  leaning: 0.55,
};

export const DIRECTION_LABELS = {
  supported: "Supported by the evidence",
  "leans-supported": "Leans supportive",
  mixed: "Mixed evidence",
  "leans-contradicted": "Leans against",
  contradicted: "Contradicted by the evidence",
  unassessed: "Direction not assessed",
};

export function scoreDirection(
  studies = [],
  cfg = SCORING_CONFIG,
  dcfg = DIRECTION_CONFIG,
  currentYear = new Date().getUTCFullYear(),
) {
  const counts = { supports: 0, contradicts: 0, neutral: 0, unassessed: 0 };
  let supportWeight = 0;
  let contradictWeight = 0;
  let totalWeight = 0;

  for (const study of studies) {
    const stance = STANCES.includes(study.stance) ? study.stance : "unassessed";
    counts[stance] += 1;
    const weight = scoreStudy(study, cfg, currentYear);
    totalWeight += weight;
    if (stance === "supports") supportWeight += weight;
    if (stance === "contradicts") contradictWeight += weight;
  }

  const decisive = supportWeight + contradictWeight;
  const decisiveShare = totalWeight > 0 ? decisive / totalWeight : 0;

  let direction = "unassessed";
  if (decisive > 0 && decisiveShare >= dcfg.minDecisiveShare) {
    const supportShare = supportWeight / decisive;
    if (supportShare >= dcfg.clearMajority) direction = "supported";
    else if (supportShare >= dcfg.leaning) direction = "leans-supported";
    else if (1 - supportShare >= dcfg.clearMajority) direction = "contradicted";
    else if (1 - supportShare >= dcfg.leaning) direction = "leans-contradicted";
    else direction = "mixed";
  }

  return {
    direction,
    directionText: DIRECTION_LABELS[direction],
    supportWeight: Math.round(supportWeight * 10) / 10,
    contradictWeight: Math.round(contradictWeight * 10) / 10,
    decisiveShare: Math.round(decisiveShare * 100) / 100,
    counts,
  };
}

export function selectSpotlight(
  studies = [],
  direction = null,
  cfg = SCORING_CONFIG,
  currentYear = new Date().getUTCFullYear(),
) {
  if (direction?.direction !== "mixed") return null;

  const best = (stance) =>
    studies
      .filter((s) => s.stance === stance)
      .reduce(
        (winner, s) =>
          !winner || scoreStudy(s, cfg, currentYear) > scoreStudy(winner, cfg, currentYear)
            ? s
            : winner,
        null,
      );

  const supporting = best("supports");
  const contradicting = best("contradicts");

  if (!supporting || !contradicting) return null;

  return { for: supporting, against: contradicting };
}

export const FUNDING_CONFIG = {
  minCoverage: 0.5,
  mixedIndustryShare: 0.5,
};

export function scoreFunding(
  studies = [],
  cfg = SCORING_CONFIG,
  fcfg = FUNDING_CONFIG,
  currentYear = new Date().getUTCFullYear(),
) {
  const counts = { industry: 0, "government/nonprofit": 0, mixed: 0, undisclosed: 0 };
  let industry = 0;
  let nonIndustry = 0;
  let undisclosed = 0;
  let total = 0;

  for (const study of studies) {
    const source = counts[study.fundingSource] !== undefined ? study.fundingSource : "undisclosed";
    counts[source] += 1;

    const weight = scoreStudy(study, cfg, currentYear);
    total += weight;

    if (source === "industry") industry += weight;
    else if (source === "government/nonprofit") nonIndustry += weight;
    else if (source === "mixed") {
      industry += weight * fcfg.mixedIndustryShare;
      nonIndustry += weight * (1 - fcfg.mixedIndustryShare);
    } else undisclosed += weight;
  }

  const share = (value) => (total > 0 ? Math.round((value / total) * 100) / 100 : 0);
  const coverage = total > 0 ? (industry + nonIndustry) / total : 0;

  const supporting = studies.filter((s) => s.stance === "supports");
  const amongSupporting = {
    industry: supporting.filter((s) => s.fundingSource === "industry" || s.fundingSource === "mixed")
      .length,
    total: supporting.length,
  };

  return {
    industryWeight: share(industry),
    nonIndustryWeight: share(nonIndustry),
    undisclosedWeight: share(undisclosed),
    coverage: Math.round(coverage * 100) / 100,
    sufficient: coverage >= fcfg.minCoverage,
    counts,
    amongSupporting,
  };
}

export const TIMELINE_CONFIG = {
  checkpoints: 5,
  minYearSpan: 6,
  minDatedStudies: 4,
};

export function buildTimeline(
  studies = [],
  cfg = SCORING_CONFIG,
  tcfg = TIMELINE_CONFIG,
  currentYear = new Date().getUTCFullYear(),
) {
  // Retracted studies are dropped from every checkpoint, not just the ones
  // after the notice. PubMed gives the retraction notice's PMID but not its
  // date without another fetch, so the earlier checkpoints understate what
  // was known at the time. Excluding throughout is the safer error.
  const { included } = partitionRetracted(studies);
  const dated = included.filter((s) => Number.isFinite(s.year));
  if (dated.length < tcfg.minDatedStudies) {
    return { checkpoints: [], skipped: "Too few studies with publication dates to show a timeline." };
  }

  const years = dated.map((s) => s.year);
  const first = Math.min(...years);
  const last = Math.max(...years);
  const span = last - first;

  if (span < tcfg.minYearSpan) {
    return {
      checkpoints: [],
      skipped: `All of this evidence was published between ${first} and ${last}, which is not enough history to show how the picture changed.`,
    };
  }

  const stops = [];
  for (let i = 1; i <= tcfg.checkpoints; i += 1) {
    const year = Math.round(first + (span * i) / tcfg.checkpoints);
    if (!stops.includes(year)) stops.push(year);
  }

  const checkpoints = [];
  for (const year of stops) {
    const known = dated.filter((s) => s.year <= year);
    if (!known.length) continue;

    const previous = checkpoints[checkpoints.length - 1];
    if (previous && previous.studyCount === known.length) {
      checkpoints[checkpoints.length - 1] = { ...previous, year };
      continue;
    }

    const asOf = Math.min(year, currentYear);
    const grade = scoreEvidence(known, cfg, asOf);
    const direction = scoreDirection(known, cfg, DIRECTION_CONFIG, asOf);

    checkpoints.push({
      year,
      strength: grade.label,
      strengthText: grade.labelText,
      score: grade.score,
      direction: direction.direction,
      directionText: direction.directionText,
      studyCount: known.length,
    });
  }

  if (checkpoints.length < 2) {
    return {
      checkpoints: [],
      skipped: "The evidence arrived too close together to show a meaningful progression.",
    };
  }

  return { checkpoints, skipped: null };
}
