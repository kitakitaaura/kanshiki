export const COLLECTION_CONFIG = {
  storageKey: "kanshiki.collection.v1",
  formatVersion: 1,
  maxItems: 50,
  // Abstracts dominate the stored size, so they are trimmed rather than
  // dropped: RIS keeps a usable AB field without filling the quota.
  maxAbstractChars: 1200,
};

export class CollectionError extends Error {}

function trimStudy(study, cfg) {
  if (!study || typeof study !== "object") return study;
  const abstract = typeof study.abstract === "string" ? study.abstract.slice(0, cfg.maxAbstractChars) : study.abstract;
  return abstract === undefined ? study : { ...study, abstract };
}

function trimResult(kind, result, cfg) {
  if (!result || typeof result !== "object") return result;
  if (kind === "claim") {
    return { ...result, studies: (result.studies ?? []).map((s) => trimStudy(s, cfg)) };
  }
  return { ...result, record: trimStudy(result.record, cfg) };
}

export function itemKey(kind, result) {
  if (kind === "claim") return `claim:${String(result?.claim ?? "").trim().toLowerCase()}`;
  return `study:${result?.record?.pmid ?? result?.pmid ?? ""}`;
}

function labelFor(kind, result) {
  if (kind === "claim") return result?.claim ?? "Untitled claim";
  return result?.record?.title ?? `PMID ${result?.record?.pmid ?? "?"}`;
}

export function createCollection(storage, cfg = COLLECTION_CONFIG) {
  const read = () => {
    try {
      const raw = storage.getItem(cfg.storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.items) ? parsed.items : [];
    } catch {
      return [];
    }
  };

  const write = (items) => {
    const payload = JSON.stringify({ version: cfg.formatVersion, items });
    try {
      storage.setItem(cfg.storageKey, payload);
    } catch {
      throw new CollectionError(
        "Browser storage is full. Export the collection to a file, then remove some items.",
      );
    }
  };

  return {
    list: () => read(),
    size: () => read().length,
    has: (kind, result) => read().some((item) => item.key === itemKey(kind, result)),

    add(kind, result, { now = () => new Date().toISOString() } = {}) {
      const items = read();
      const key = itemKey(kind, result);
      if (items.some((item) => item.key === key)) return { added: false, reason: "already in the collection" };
      if (items.length >= cfg.maxItems) {
        throw new CollectionError(`A collection holds at most ${cfg.maxItems} items.`);
      }
      items.push({
        key,
        kind,
        label: labelFor(kind, result),
        addedAt: now(),
        result: trimResult(kind, result, cfg),
      });
      write(items);
      return { added: true };
    },

    remove(key) {
      const items = read();
      const next = items.filter((item) => item.key !== key);
      write(next);
      return items.length !== next.length;
    },

    clear() {
      storage.removeItem(cfg.storageKey);
    },

    toJson() {
      return JSON.stringify(
        { format: "kanshiki-collection", version: cfg.formatVersion, exportedAt: new Date().toISOString(), items: read() },
        null,
        2,
      );
    },

    // Import replaces the collection wholesale so a round trip is exact.
    fromJson(text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new CollectionError("That file is not valid JSON.");
      }
      if (parsed?.format !== "kanshiki-collection" || !Array.isArray(parsed.items)) {
        throw new CollectionError("That file is not a Kanshiki collection export.");
      }
      const items = parsed.items
        .filter((item) => item && typeof item === "object" && item.kind && item.result)
        .slice(0, cfg.maxItems)
        .map((item) => ({
          key: item.key || itemKey(item.kind, item.result),
          kind: item.kind,
          label: item.label || labelFor(item.kind, item.result),
          addedAt: item.addedAt || new Date().toISOString(),
          result: item.result,
        }));
      write(items);
      return items.length;
    },
  };
}
