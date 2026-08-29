import test from "node:test";
import assert from "node:assert/strict";
import { createCollection, CollectionError, COLLECTION_CONFIG, itemKey } from "../public/collection.js";

// Stands in for window.localStorage, including its quota failure.
function fakeStorage({ quotaBytes = Infinity } = {}) {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (String(v).length > quotaBytes) {
        const err = new Error("QuotaExceededError");
        err.name = "QuotaExceededError";
        throw err;
      }
      map.set(k, v);
    },
    removeItem: (k) => map.delete(k),
    _raw: map,
  };
}

const CLAIM = {
  claim: "Turmeric reduces arthritis pain",
  verdict: { labelText: "Strong evidence" },
  direction: { directionText: "Mixed evidence" },
  studies: [
    { pmid: "1", title: "Study one", abstract: "a".repeat(4000) },
    { pmid: "2", title: "Study two" },
  ],
};

const STUDY = {
  record: { pmid: "9500320", title: "A withdrawn paper", journal: "Lancet", year: 1998, abstract: "b".repeat(4000) },
  credibility: { labelText: "Retracted" },
};

const fresh = () => createCollection(fakeStorage());

test("adds claims and studies, and reports its size", () => {
  const c = fresh();
  assert.equal(c.size(), 0);
  assert.deepEqual(c.add("claim", CLAIM), { added: true });
  assert.deepEqual(c.add("study", STUDY), { added: true });
  assert.equal(c.size(), 2);
  assert.equal(c.has("claim", CLAIM), true);
});

test("adding the same item twice is a no-op with a reason", () => {
  const c = fresh();
  c.add("claim", CLAIM);
  const second = c.add("claim", CLAIM);
  assert.equal(second.added, false);
  assert.match(second.reason, /already/i);
  assert.equal(c.size(), 1);
});

test("claims are keyed by text and studies by PMID", () => {
  assert.equal(itemKey("claim", { claim: "Turmeric HELPS " }), "claim:turmeric helps");
  assert.equal(itemKey("study", STUDY), "study:9500320");
});

test("removing an item updates the stored state immediately", () => {
  const c = fresh();
  c.add("claim", CLAIM);
  c.add("study", STUDY);
  const key = itemKey("study", STUDY);

  assert.equal(c.remove(key), true);
  assert.equal(c.size(), 1);
  assert.equal(c.has("study", STUDY), false);
  // A later export must not still contain the removed item.
  assert.ok(!c.toJson().includes("9500320"));
  assert.equal(c.remove("no-such-key"), false, "removing a missing key is harmless");
});

test("export, clear, and import round-trips to identical state", () => {
  const c = fresh();
  c.add("claim", CLAIM);
  c.add("study", STUDY);
  const before = c.list();
  const backup = c.toJson();

  c.clear();
  assert.equal(c.size(), 0);

  const imported = c.fromJson(backup);
  assert.equal(imported, 2);
  assert.deepEqual(c.list(), before, "state after import must match state before export");
});

test("a round trip survives a different browser with empty storage", () => {
  const source = fresh();
  source.add("claim", CLAIM);
  source.add("study", STUDY);
  const backup = source.toJson();

  const destination = createCollection(fakeStorage());
  assert.equal(destination.size(), 0);
  destination.fromJson(backup);
  assert.deepEqual(destination.list(), source.list());
});

test("import replaces rather than merges, so a round trip cannot duplicate", () => {
  const c = fresh();
  c.add("claim", CLAIM);
  const backup = c.toJson();
  c.fromJson(backup);
  c.fromJson(backup);
  assert.equal(c.size(), 1);
});

test("abstracts are trimmed on store to protect the storage quota", () => {
  const c = fresh();
  c.add("claim", CLAIM);
  const stored = c.list()[0].result.studies[0].abstract;
  assert.equal(stored.length, COLLECTION_CONFIG.maxAbstractChars);
  // A study with no abstract is left alone rather than gaining an empty one.
  assert.equal(c.list()[0].result.studies[1].abstract, undefined);
});

test("rejects files that are not a Kanshiki collection", () => {
  const c = fresh();
  assert.throws(() => c.fromJson("not json at all"), CollectionError);
  assert.throws(() => c.fromJson('{"items":[]}'), CollectionError);
  assert.throws(() => c.fromJson('{"format":"something-else","items":[]}'), CollectionError);
});

test("import skips malformed entries instead of failing the whole file", () => {
  const c = fresh();
  const payload = JSON.stringify({
    format: "kanshiki-collection",
    version: 1,
    items: [
      { kind: "claim", result: CLAIM, key: "claim:x", label: "ok", addedAt: "2026-01-01" },
      { kind: "claim" },
      null,
      "garbage",
    ],
  });
  assert.equal(c.fromJson(payload), 1);
  assert.equal(c.size(), 1);
});

test("import backfills a missing key and label", () => {
  const c = fresh();
  c.fromJson(JSON.stringify({ format: "kanshiki-collection", version: 1, items: [{ kind: "study", result: STUDY }] }));
  const item = c.list()[0];
  assert.equal(item.key, "study:9500320");
  assert.equal(item.label, "A withdrawn paper");
});

test("corrupt storage reads as empty rather than throwing", () => {
  const storage = fakeStorage();
  storage.setItem(COLLECTION_CONFIG.storageKey, "{not json");
  const c = createCollection(storage);
  assert.deepEqual(c.list(), []);
  assert.equal(c.size(), 0);
});

test("a full quota surfaces an actionable error", () => {
  const c = createCollection(fakeStorage({ quotaBytes: 200 }));
  assert.throws(
    () => c.add("claim", CLAIM),
    (err) => err instanceof CollectionError && /export/i.test(err.message),
  );
});

test("the item cap is enforced", () => {
  const c = createCollection(fakeStorage(), { ...COLLECTION_CONFIG, maxItems: 2 });
  c.add("claim", { claim: "one" });
  c.add("claim", { claim: "two" });
  assert.throws(() => c.add("claim", { claim: "three" }), CollectionError);
  assert.equal(c.size(), 2);
});

test("the exported file names its format and version", () => {
  const c = fresh();
  c.add("claim", CLAIM);
  const parsed = JSON.parse(c.toJson());
  assert.equal(parsed.format, "kanshiki-collection");
  assert.equal(parsed.version, COLLECTION_CONFIG.formatVersion);
  assert.ok(parsed.exportedAt);
});
