export const RELATED_CONFIG = {
  storageKey: "kanshiki.history.v1",
  maxHistory: 25,
  // Jaccard overlap of meaningful words. Tuned so paraphrases match and
  // unrelated claims about the same nutrient do not.
  minSimilarity: 0.4,
  minTokens: 2,
};

const STOPWORDS = new Set(
  ("a an the is are was were be been being do does did can could will would should may might must " +
   "of for to in on at by with from about into over after before really actually just very much " +
   "you your my our it its this that these those and or but if then than as so we they i me " +
   "help helps helping cause causes causing cure cures treat treats treating prevent prevents").split(" "),
);

export function tokenize(claim) {
  return [
    ...new Set(
      String(claim ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((word) => word.length > 1 && !STOPWORDS.has(word)),
    ),
  ];
}

export function similarity(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * The closest previously checked claim, or null. Exact repeats of the same
 * claim are not "related", they are the same question asked again.
 */
export function findRelated(claim, history = [], cfg = RELATED_CONFIG) {
  if (tokenize(claim).length < cfg.minTokens) return null;
  // Only the identical question is excluded. Two claims can reduce to the
  // same keywords and still be worth showing as a paraphrase.
  const same = String(claim ?? "").trim().toLowerCase();

  let best = null;
  for (const entry of history) {
    if (!entry?.claim) continue;
    if (String(entry.claim).trim().toLowerCase() === same) continue;
    const score = similarity(claim, entry.claim);
    if (score >= cfg.minSimilarity && (!best || score > best.score)) {
      best = { ...entry, score: Math.round(score * 100) / 100 };
    }
  }
  return best;
}

export function createHistory(storage, cfg = RELATED_CONFIG) {
  const read = () => {
    try {
      const parsed = JSON.parse(storage.getItem(cfg.storageKey) ?? "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  return {
    list: () => read(),

    record(result) {
      if (!result?.claim) return;
      const entry = {
        claim: result.claim,
        query: result.query ?? "",
        verdict: result.verdict?.labelText ?? "",
        direction: result.direction?.directionText ?? "",
        studyCount: result.studies?.length ?? 0,
        at: new Date().toISOString(),
      };
      const kept = read().filter((item) => item.claim !== entry.claim);
      kept.unshift(entry);
      try {
        storage.setItem(cfg.storageKey, JSON.stringify(kept.slice(0, cfg.maxHistory)));
      } catch {
        // History is a convenience; losing it must never break a result.
      }
    },

    findRelated: (claim) => findRelated(claim, read(), cfg),
    clear: () => storage.removeItem(cfg.storageKey),
  };
}
