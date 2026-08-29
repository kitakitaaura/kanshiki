import { getAIResponse } from "./ai.js";
import { searchStudies } from "./pubmed.js";
import {
  scoreEvidence,
  scoreDirection,
  selectSpotlight,
  scoreFunding,
  partitionRetracted,
  buildTimeline,
  scoreStudy,
  SCORING_CONFIG,
  DIRECTION_CONFIG,
  FUNDING_CONFIG,
} from "./scoring.js";
import { TIER_LABELS } from "./classify.js";
import { inputWarning } from "./sanitize.js";
import { logEvent, LOG_EVENTS } from "./log.js";

export const MAX_INPUT_CHARS = 4000;
const STUDIES_FOR_PROMPT = 10;

export const STANCE_CONFIG = {
  // Small models lose track of long numbered lists.
  maxStudies: 12,
  chunkSize: 4,
  // 0 means send the whole abstract. Measured against eval/: full abstracts
  // score 7/8, a 1200-character head 5.7/8, a split head and tail 5/8.
  abstractChars: 0,
  // Share of the excerpt taken from the start of the abstract. Splitting the
  // budget across both ends was measured and scored worse, so this stays at 1.
  headShare: 1,
};

/**
 * The abstract text sent for stance judging.
 *
 * abstractChars of 0 or less means send the whole abstract. Otherwise the
 * budget is split between the opening and the ending by headShare, since
 * structured abstracts put CONCLUSIONS last.
 */
export function excerptForStance(abstract, cfg = STANCE_CONFIG) {
  const text = String(abstract ?? "");
  if (cfg.abstractChars <= 0 || text.length <= cfg.abstractChars) return text;

  const head = Math.round(cfg.abstractChars * cfg.headShare);
  const tail = cfg.abstractChars - head;
  if (tail <= 0) return text.slice(0, cfg.abstractChars);
  return `${text.slice(0, head).trimEnd()} [...] ${text.slice(text.length - tail).trimStart()}`;
}

const EXTRACTION_SYSTEM = `You turn health claims into PubMed search queries.
Reply with JSON only, no prose, no markdown fences, in exactly this shape:
{"claim": "<the single testable claim, one short sentence>", "query": "<3-8 PubMed search terms>"}
The query must use plain medical terminology in English, no boolean operators, no quotes, no
field tags. If the claim is in another language, translate the medical terms into English.`;

const STANCE_SYSTEM = `You decide which way each study points with respect to one specific claim.

For every numbered study, choose exactly one stance:
- "supports": the study reports a benefit, effect, or association in the direction the claim asserts.
- "contradicts": the study reports no significant benefit, no effect, no association, a harm, or
  a result in the opposite direction. "No significant difference from placebo" is "contradicts",
  not "neutral". So is a review concluding the evidence does not support the claim.
- "neutral": reserve this for studies that never test the claim's intervention against the claim's
  outcome at all: background biology, prevalence surveys, protocols, or unrelated outcomes.

Most studies returned by a search on the claim DO test it. Do not default to "neutral" because a
result is small, mixed, or hedged. Decide which side it lands on. Judge only from the text given.

Reply with JSON only, no prose, no markdown fences, in exactly this shape:
{"stances": [{"n": 1, "stance": "supports"}, {"n": 2, "stance": "contradicts"}]}
Include an entry for every study number you were given.`;

const VERDICT_SYSTEM = `You summarize the state of published medical evidence for a general reader.
Rules:
- 2 to 3 sentences. Plain English. No bullet points, no headings, no preamble.
- Describe what the studies collectively show and how solid that body of evidence is.
- Say plainly when the evidence is thin, mixed, or mostly low-quality.
- Never give medical advice, dosages, or tell the reader what to do.
- Do not invent studies or numbers that are not in the list you were given.`;

function parseJsonish(text) {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

const STOPWORDS = new Set(
  ("a an the is are was were be been being do does did can could will would should may might must " +
    "of for to in on at by with from about into over after before really actually just very much " +
    "you your my our it its this that these those and or but if then than as so we they i me " +
    "cure cures cured heal heals healing fix fixes boost boosts miracle proven").split(" "),
);

export function naiveQuery(input) {
  const words = String(input)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .filter((w, i) => w.length > 2 || i > 0);
  return [...new Set(words)].slice(0, 8).join(" ");
}

export async function extractClaim(input, env, { useAi = true } = {}) {
  const trimmed = input.slice(0, MAX_INPUT_CHARS);
  if (!useAi) {
    return { claim: trimmed.slice(0, 300), query: naiveQuery(trimmed), degraded: true };
  }
  try {
    const { text } = await getAIResponse(
      `Health claim or passage:\n"""${trimmed}"""\n\nJSON:`,
      { env, system: EXTRACTION_SYSTEM, temperature: 0, maxTokens: 200 },
    );
    const parsed = parseJsonish(text);
    const query = String(parsed?.query ?? "").replace(/["\[\]()]/g, " ").trim();
    if (query.length >= 3) {
      return {
        claim: String(parsed?.claim || trimmed).trim().slice(0, 300),
        query: query.slice(0, 200),
        degraded: false,
      };
    }
  } catch (err) {
    logEvent(LOG_EVENTS.aiFailed, { stage: "extraction", reason: err.message });
  }
  return { claim: trimmed.slice(0, 300), query: naiveQuery(trimmed), degraded: true };
}

function describeEvidence(claim, grade, direction, studies) {
  const lines = studies
    .slice(0, STUDIES_FOR_PROMPT)
    .map((s, i) => {
      const stance = s.stance && s.stance !== "unassessed" ? `, ${s.stance} the claim` : "";
      const bits = [
        `${i + 1}. [${TIER_LABELS[s.type] ?? "Other"}, ${s.year ?? "year unknown"}${stance}]`,
        s.title,
        s.sampleSize ? `(n≈${s.sampleSize})` : "",
      ];
      const conclusion = s.abstract ? ` Abstract excerpt: ${s.abstract.slice(0, 400)}` : "";
      return `${bits.filter(Boolean).join(" ")}${conclusion}`;
    })
    .join("\n");

  const counts = Object.entries(grade.counts)
    .filter(([, n]) => n > 0)
    .map(([tier, n]) => `${n} ${TIER_LABELS[tier] ?? tier}`)
    .join(", ");

  return `Claim under examination: "${claim}"

Automated evidence grade (computed by a fixed hierarchy, not by you): ${grade.labelText}
Automated direction of the evidence: ${direction.directionText} (${direction.counts.supports} supporting, ${direction.counts.contradicts} contradicting, ${direction.counts.neutral} neutral by weight-adjusted tally)
Study mix: ${counts || "none"}
Total PubMed matches: ${grade.studyCount} shown${grade.newestYear ? `, published ${grade.oldestYear}–${grade.newestYear}` : ""}

Studies:
${lines || "(no studies found)"}

Write the 2-3 sentence summary now. It must be consistent with the direction above.`;
}

function pluralize(word, count) {
  if (count === 1) return word;
  if (/analysis$/.test(word)) return word.replace(/analysis$/, "analyses");
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

export function fallbackSummary(claim, grade) {
  if (!grade.studyCount) {
    return `No PubMed studies matched this claim, so there is nothing published to weigh either way. That is not evidence against the claim. It usually means the wording is too specific, too novel, or not phrased in medical terms.`;
  }
  const mix = Object.entries(grade.counts)
    .filter(([, n]) => n > 0)
    .map(([tier, n]) => `${n} ${pluralize((TIER_LABELS[tier] ?? tier).toLowerCase(), n)}`)
    .join(", ");
  return `PubMed returned ${grade.studyCount} related studies: ${mix}. The strongest evidence available is at the level of a ${(grade.topTierText ?? "study").toLowerCase()}${grade.newestYear ? `, with work published up to ${grade.newestYear}` : ""}, which grades as ${grade.labelText.toLowerCase()}. Read the sources below before drawing a conclusion. This summary was generated without the language model.`;
}

export async function classifyStances(claim, studies, env, cfg = STANCE_CONFIG) {
  const subjects = studies.slice(0, cfg.maxStudies);
  const stances = new Map();
  const partialReads = new Set();
  if (!subjects.length) return { stances, partialReads, degraded: false };

  const chunks = [];
  for (let i = 0; i < subjects.length; i += cfg.chunkSize) {
    chunks.push(subjects.slice(i, i + cfg.chunkSize));
  }

  const results = await Promise.all(chunks.map((chunk) => classifyChunk(claim, chunk, env, cfg)));
  for (const chunk of results) {
    for (const [pmid, stance] of chunk.found) stances.set(pmid, stance);
    for (const pmid of chunk.truncated) partialReads.add(pmid);
  }

  return { stances, partialReads, degraded: stances.size < subjects.length };
}

async function classifyChunk(claim, chunk, env, cfg = STANCE_CONFIG) {
  const found = new Map();
  const truncated = new Set();

  const listing = chunk
    .map((s, i) => {
      const abstract = s.abstract || "";
      // Recorded where the cut happens, not re-derived later.
      if (cfg.abstractChars > 0 && abstract.length > cfg.abstractChars) truncated.add(s.pmid);
      const body = abstract ? excerptForStance(abstract, cfg) : "(no abstract available)";
      return `${i + 1}. Title: ${s.title}\n   Findings: ${body}`;
    })
    .join("\n\n");

  try {
    const { text } = await getAIResponse(
      `Claim: "${claim}"\n\nStudies:\n${listing}\n\nJSON:`,
      { env, system: STANCE_SYSTEM, temperature: 0, maxTokens: 300 },
    );
    const parsed = parseJsonish(text);
    const rows = Array.isArray(parsed?.stances) ? parsed.stances : [];
    for (const row of rows) {
      const index = Number(row?.n) - 1;
      const stance = String(row?.stance ?? "").toLowerCase().trim();
      if (chunk[index] && ["supports", "contradicts", "neutral"].includes(stance)) {
        found.set(chunk[index].pmid, stance);
      }
    }
  } catch (err) {
    logEvent(LOG_EVENTS.aiFailed, { stage: "stance", reason: err.message });
  }
  return { found, truncated };
}

export async function summarizeEvidence(claim, grade, direction, studies, env) {
  try {
    const { text } = await getAIResponse(describeEvidence(claim, grade, direction, studies), {
      env,
      system: VERDICT_SYSTEM,
      temperature: 0.2,
      maxTokens: 300,
    });
    const cleaned = text.replace(/^\s*(summary|verdict)\s*:\s*/i, "").trim();
    if (cleaned.length > 40) return { summary: cleaned, degraded: false };
  } catch (err) {
    logEvent(LOG_EVENTS.aiFailed, { stage: "summary", reason: err.message });
  }
  return { summary: fallbackSummary(claim, grade), degraded: true };
}

function toSpotlightCard(study) {
  return {
    pmid: study.pmid,
    title: study.title,
    journal: study.journal,
    year: study.year,
    type: study.type,
    typeLabel: study.typeLabel,
    sampleSize: study.sampleSize,
    stance: study.stance,
    partialRead: study.partialRead,
    fundingSource: study.fundingSource,
    fundingLabel: study.fundingLabel,
    retraction: study.retraction,
    authors: study.authors,
    doi: study.doi,
    abstract: study.abstract,
    journalAbbrev: study.journalAbbrev,
    volume: study.volume,
    issue: study.issue,
    pages: study.pages,
    excerpt: excerptFor(study),
    url: study.url,
  };
}

const EXCERPT_CUES =
  /\b(conclusions?|we conclude|these findings|our findings|results (show|suggest|indicate)|suggests? that|associated with|no significant|no evidence|did not|does not|failed to|should not|may (be|improve|reduce|help))\b/i;

const STANCE_CUES = {
  contradicts:
    /\b(no significant|not significant|no (?:clear |consistent |apparent )?(?:effect|benefit|evidence|association|difference|improvement)|did not (?:reduce|improve|differ|show|affect)|does not (?:support|appear)|failed to|were not (?:associated|significant)|should not be recommended|insufficient evidence)\b/i,
};

const EXCERPT_BOILERPLATE =
  /^(trial registration|registration|prospero|clinicaltrials\.gov|funding|copyright|©|this article is protected|crown copyright|published by|\(c\))/i;

export function excerptFor(study, maxChars = 220) {
  const abstract = study.abstract || "";
  if (!abstract) return "";

  const sentences = abstract
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 25 && !EXCERPT_BOILERPLATE.test(line));
  if (!sentences.length) return "";

  const reversed = [...sentences].reverse();
  const stanceCue = STANCE_CUES[study.stance];
  const chosen =
    (stanceCue && reversed.find((line) => stanceCue.test(line))) ??
    reversed.find((line) => EXCERPT_CUES.test(line)) ??
    sentences[sentences.length - 1];

  return chosen.length > maxChars ? `${chosen.slice(0, maxChars).trimEnd()}…` : chosen;
}

export async function checkClaim(
  input,
  env,
  { retmax = 20, useAi = true, query: overrideQuery = "" } = {},
) {
  const startedAt = Date.now();

  // A query typed by the user is passed to PubMed verbatim, including field
  // tags and boolean operators. It is never sent back through extraction.
  const manual = String(overrideQuery ?? "").trim();
  const { claim, query, degraded: extractionDegraded } = manual
    ? { claim: input.slice(0, 300), query: manual, degraded: false }
    : await extractClaim(input, env, { useAi });
  const queryMode = manual ? "user-edited" : useAi ? "auto-extracted" : "keyword-fallback";

  let studies = [];
  let total = 0;
  let searchError = null;
  try {
    ({ studies, total } = await searchStudies(query, env, { retmax }));
  } catch (err) {
    searchError = err.message;
  }

  // Retracted work is reported but never counted.
  const { included: scorable, excludedCount: excludedRetractedCount } = partitionRetracted(studies);

  const grade = scoreEvidence(
    scorable.map((s) => ({ type: s.type, year: s.year, sampleSize: s.sampleSize })),
  );

  const ranked = [...partitionRetracted(studies).included].sort(
    (a, b) =>
      (SCORING_CONFIG.tierWeights[b.type] ?? 0) - (SCORING_CONFIG.tierWeights[a.type] ?? 0) ||
      (b.year ?? 0) - (a.year ?? 0),
  );
  const { stances, partialReads, degraded: stanceDegraded } = useAi
    ? await classifyStances(claim, ranked, env)
    : { stances: new Map(), partialReads: new Set(), degraded: true };
  for (const study of studies) {
    study.stance = stances.get(study.pmid) ?? "unassessed";
    study.partialRead = partialReads.has(study.pmid);
  }

  const direction = scoreDirection(
    scorable.map((s) => ({
      type: s.type,
      year: s.year,
      sampleSize: s.sampleSize,
      stance: s.stance,
    })),
  );

  const spotlight = selectSpotlight(scorable, direction);

  const fundingBreakdown = scoreFunding(scorable);
  const timeline = buildTimeline(studies);

  const { summary, degraded: summaryDegraded } = useAi
    ? await summarizeEvidence(claim, grade, direction, ranked, env)
    : { summary: fallbackSummary(claim, grade), degraded: true };

  return {
    input: input.slice(0, MAX_INPUT_CHARS),
    claim,
    query,
    queryMode,
    excludedRetractedCount,
    verdict: {
      label: grade.label,
      labelText: grade.labelText,
      score: grade.score,
      thresholds: SCORING_CONFIG.thresholds,
      counts: grade.counts,
      topTier: grade.topTier,
      topTierText: grade.topTierText,
      rationale: grade.rationale,
      newestYear: grade.newestYear,
      oldestYear: grade.oldestYear,
    },
    direction: {
      ...direction,
      assessed: stances.size,
      thresholds: DIRECTION_CONFIG,
    },
    timeline: timeline.checkpoints,
    fundingBreakdown: {
      ...fundingBreakdown,
      thresholds: FUNDING_CONFIG,
    },
    spotlight: spotlight
      ? { for: toSpotlightCard(spotlight.for), against: toSpotlightCard(spotlight.against) }
      : null,
    summary,
    studies: studies
      .map((s) => ({
        pmid: s.pmid,
        title: s.title,
        journal: s.journal,
        year: s.year,
        type: s.type,
        typeLabel: s.typeLabel,
        sampleSize: s.sampleSize,
        stance: s.stance,
        partialRead: s.partialRead,
        fundingSource: s.fundingSource,
        fundingLabel: s.fundingLabel,
        retraction: s.retraction,
        authors: s.authors,
        url: s.url,
        doi: s.doi,
        abstract: s.abstract,
        journalAbbrev: s.journalAbbrev,
        volume: s.volume,
        issue: s.issue,
        pages: s.pages,
      }))
      .sort((a, b) => scoreStudy(b) - scoreStudy(a) || (b.year ?? 0) - (a.year ?? 0)),
    meta: {
      totalMatches: total,
      shown: studies.length,
      searchError,
      aiDegraded: extractionDegraded || summaryDegraded,
      aiDisabled: !useAi,
      stanceDegraded,
      partialReads: partialReads.size,
      timelineSkipped: timeline.skipped,
      inputWarning: inputWarning(input, { useAi }),
      elapsedMs: Date.now() - startedAt,
    },
  };
}
