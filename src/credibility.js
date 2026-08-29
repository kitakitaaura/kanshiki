import { TIER_LABELS } from "./classify.js";

export const CREDIBILITY_CONFIG = {
  weights: {
    design: 0.28,
    citations: 0.2,
    venue: 0.18,
    authors: 0.16,
    sample: 0.12,
    funding: 0.06,
  },

  designScores: {
    "systematic-review": 1,
    "meta-analysis": 1,
    rct: 0.8,
    "clinical-trial": 0.6,
    observational: 0.45,
    review: 0.3,
    "case-report": 0.2,
    other: 0.25,
  },

  sampleBrackets: [
    { min: 5000, score: 1 },
    { min: 1000, score: 0.85 },
    { min: 300, score: 0.7 },
    { min: 100, score: 0.55 },
    { min: 30, score: 0.4 },
    { min: 0, score: 0.25 },
  ],

  citations: {
    minAgeYears: 2,
    relativeBrackets: [
      { min: 2, score: 1 },
      { min: 1, score: 0.85 },
      { min: 0.5, score: 0.65 },
      { min: 0.2, score: 0.45 },
      { min: 0, score: 0.25 },
    ],
    perYearBrackets: [
      { min: 20, score: 1 },
      { min: 5, score: 0.8 },
      { min: 1, score: 0.6 },
      { min: 0.2, score: 0.4 },
      { min: 0, score: 0.2 },
    ],
  },

  venue: {
    citationRateBrackets: [
      { min: 10, score: 1 },
      { min: 5, score: 0.85 },
      { min: 2, score: 0.65 },
      { min: 1, score: 0.5 },
      { min: 0, score: 0.35 },
    ],
  },

  authors: {
    hIndexBrackets: [
      { min: 40, score: 1 },
      { min: 20, score: 0.85 },
      { min: 10, score: 0.7 },
      { min: 4, score: 0.55 },
      { min: 0, score: 0.4 },
    ],
  },

  funding: {
    scores: {
      "government/nonprofit": 1,
      mixed: 0.75,
      industry: 0.65,
      undisclosed: 0.4,
    },
  },

  retraction: {
    compositeCap: 0.12,
    concernCap: 0.45,
  },

  thresholds: { high: 0.7, moderate: 0.45 },
};

export const CREDIBILITY_LABELS = {
  retracted: "Retracted",
  high: "Strong credibility signals",
  moderate: "Moderate credibility signals",
  low: "Weak credibility signals",
};

function bracketScore(value, brackets) {
  if (!Number.isFinite(value)) return null;
  for (const bracket of brackets) {
    if (value >= bracket.min) return bracket.score;
  }
  return brackets[brackets.length - 1]?.score ?? null;
}

const signal = (key, label, score, detail, extra = {}) => ({
  key,
  label,
  score,
  available: score !== null,
  detail,
  ...extra,
});

export function scoreCredibility(record = {}, metrics = {}, cfg = CREDIBILITY_CONFIG) {
  const signals = [];

  // --- design ---
  const designScore = cfg.designScores[record.type] ?? cfg.designScores.other;
  signals.push(
    signal(
      "design",
      "Study design",
      designScore,
      TIER_LABELS[record.type] ?? "Unclassified publication type",
    ),
  );

  // --- sample size ---
  const sample = record.sampleSize;
  signals.push(
    signal(
      "sample",
      "Sample size",
      Number.isFinite(sample) ? bracketScore(sample, cfg.sampleBrackets) : null,
      Number.isFinite(sample)
        ? `About ${sample.toLocaleString()} participants`
        : "No enrollment figure found in the abstract",
    ),
  );

  // --- citation traction ---
  signals.push(citationSignal(metrics, cfg));

  // --- venue standing ---
  const venueRate = metrics.venue?.journalCitationRate;
  signals.push(
    signal(
      "venue",
      "Venue standing",
      Number.isFinite(venueRate) ? bracketScore(venueRate, cfg.venue.citationRateBrackets) : null,
      Number.isFinite(venueRate)
        ? `${metrics.venue.name}: journal citation rate ${venueRate}` +
            (metrics.venue.hIndex ? `, venue h-index ${metrics.venue.hIndex}` : "")
        : metrics.venue?.name
          ? `${metrics.venue.name}: no citation statistics indexed`
          : "Venue not indexed",
    ),
  );

  // --- author track record ---
  signals.push(authorSignal(metrics, cfg));

  // --- funding disclosure ---
  const fundingScore = cfg.funding.scores[record.fundingSource] ?? cfg.funding.scores.undisclosed;
  signals.push(
    signal(
      "funding",
      "Funding disclosure",
      fundingScore,
      record.fundingLabel ?? "Funding not disclosed",
    ),
  );

  // --- composite over the signals that had data ---
  let totalWeight = 0;
  let weighted = 0;
  for (const item of signals) {
    if (!item.available) continue;
    const weight = cfg.weights[item.key] ?? 0;
    totalWeight += weight;
    weighted += weight * item.score;
  }
  let composite = totalWeight > 0 ? weighted / totalWeight : null;

  // --- retraction override ---
  const retracted = Boolean(record.retraction?.retracted);
  const concern = Boolean(record.retraction?.expressionOfConcern);
  let note = null;

  // Hard override, not a deduction.
  if (retracted) {
    composite = Math.min(composite ?? cfg.retraction.compositeCap, cfg.retraction.compositeCap);
    note = "This paper has been retracted. Retraction overrides every other signal below.";
  } else if (concern) {
    composite = Math.min(composite ?? cfg.retraction.concernCap, cfg.retraction.concernCap);
    note = "This paper carries an expression of concern from the journal.";
  }

  let label = "low";
  if (retracted) label = "retracted";
  else if (composite === null) label = "low";
  else if (composite >= cfg.thresholds.high) label = "high";
  else if (composite >= cfg.thresholds.moderate) label = "moderate";

  return {
    label,
    labelText: CREDIBILITY_LABELS[label],
    composite: composite === null ? null : Math.round(composite * 100) / 100,
    retracted,
    expressionOfConcern: concern,
    retractionNoticeUrl: record.retraction?.noticeUrl ?? null,
    signals,
    coverage: {
      scored: signals.filter((s) => s.available).length,
      total: signals.length,
    },
    note,
    measures:
      "Credibility signals only: retraction status, study design, citation traction, venue, authors, funding disclosure. Not an assessment of whether the findings are correct.",
  };
}

function citationSignal(metrics, cfg) {
  const { citations, citationsPerYear, ageYears, relativeToVenue } = metrics;

  if (!Number.isFinite(citations)) {
    return signal("citations", "Citation traction", null, "No citation data indexed");
  }
  if (Number.isFinite(ageYears) && ageYears < cfg.citations.minAgeYears) {
    return signal(
      "citations",
      "Citation traction",
      null,
      `Published ${ageYears < 1 ? "less than a year" : `${ageYears} year${ageYears === 1 ? "" : "s"}`} ago, too early for citation counts to mean much (${citations} so far)`,
    );
  }

  if (Number.isFinite(relativeToVenue)) {
    return signal(
      "citations",
      "Citation traction",
      bracketScore(relativeToVenue, cfg.citations.relativeBrackets),
      `${citations.toLocaleString()} citations, ${citationsPerYear}/year, about ${relativeToVenue}× the typical rate for this journal`,
    );
  }

  return signal(
    "citations",
    "Citation traction",
    bracketScore(citationsPerYear, cfg.citations.perYearBrackets),
    `${citations.toLocaleString()} citations, ${citationsPerYear ?? "?"}/year`,
  );
}

function authorSignal(metrics, cfg) {
  const matched = (metrics.authors ?? []).filter((a) => a.matched && Number.isFinite(a.hIndex));
  if (!matched.length) {
    const attempted = (metrics.authors ?? []).length;
    return signal(
      "authors",
      "Author track record",
      null,
      attempted
        ? "Could not confidently match these authors to an indexed profile"
        : "No author profiles indexed",
      { unmatched: (metrics.authors ?? []).map((a) => ({ name: a.name, reason: a.reason })) },
    );
  }

  const best = matched.reduce((top, a) => (a.hIndex > top.hIndex ? a : top), matched[0]);
  return signal(
    "authors",
    "Author track record",
    bracketScore(best.hIndex, cfg.authors.hIndexBrackets),
    `${best.name}: h-index ${best.hIndex}` +
      (Number.isFinite(best.worksCount) ? `, ${best.worksCount.toLocaleString()} works` : "") +
      (Number.isFinite(best.citedByCount) ? `, ${best.citedByCount.toLocaleString()} citations` : ""),
    { matchedAuthors: matched.length },
  );
}
