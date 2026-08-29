import test from "node:test";
import assert from "node:assert/strict";
import { checkClaim } from "../src/pipeline.js";

/**
 * Stubs PubMed and the model together, recording every outbound request so a
 * test can assert what was and was not called.
 */
function stubWorld({ esearchCount = 0 } = {}) {
  const original = globalThis.fetch;
  const calls = { terms: [], prompts: [], systems: [] };

  globalThis.fetch = async (url, init) => {
    const href = String(url);

    if (href.includes("esearch.fcgi")) {
      calls.terms.push(new URL(href).searchParams.get("term"));
      return json({ esearchresult: { count: String(esearchCount), idlist: [] } });
    }
    if (href.includes("eutils.ncbi.nlm.nih.gov")) {
      return json({ result: { uids: [] } });
    }
    if (href.includes("11434") || href.includes("api/generate")) {
      const body = JSON.parse(init?.body ?? "{}");
      calls.prompts.push(body.prompt ?? "");
      calls.systems.push(body.system ?? "");
      return json({ response: '{"claim": "AI rewrote this", "query": "ai generated query"}' });
    }
    return { ok: false, status: 404, statusText: "Not Found" };
  };

  return { calls, restore: () => { globalThis.fetch = original; } };
}

const json = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const AI_ENV = { LOCAL_MODE: "true", OLLAMA_URL: "http://127.0.0.1:11434" };

test("a user-supplied query bypasses AI extraction entirely", async () => {
  const stub = stubWorld();
  try {
    const result = await checkClaim("Vitamin D cures depression", AI_ENV, {
      query: "vitamin D[MeSH] AND depression",
    });

    assert.equal(result.query, "vitamin D[MeSH] AND depression");
    assert.equal(result.queryMode, "user-edited");
    // The extraction prompt must never have been issued.
    assert.ok(
      !stub.calls.systems.some((s) => s.includes("PubMed search queries")),
      "extraction should be skipped when a query is supplied",
    );
    assert.ok(
      !stub.calls.terms.includes("ai generated query"),
      "the model's query must not reach PubMed",
    );
  } finally {
    stub.restore();
  }
});

test("PubMed syntax reaches the search unmangled", async () => {
  const stub = stubWorld();
  const query =
    '("vitamin D"[MeSH Terms] OR cholecalciferol) AND depression[Title/Abstract] NOT review[Publication Type]';
  try {
    const result = await checkClaim("anything", AI_ENV, { query });
    assert.equal(result.query, query);
    assert.equal(stub.calls.terms[0], query, "the term sent to PubMed must match exactly");
    // Quotes, brackets, slashes, and boolean operators all survive.
    for (const fragment of ['"vitamin D"', "[MeSH Terms]", "OR", "[Title/Abstract]", "NOT"]) {
      assert.ok(stub.calls.terms[0].includes(fragment), `lost ${fragment}`);
    }
  } finally {
    stub.restore();
  }
});

test("an empty or whitespace query falls back to the automatic path", async () => {
  for (const query of ["", "   ", undefined, null]) {
    const stub = stubWorld();
    try {
      const result = await checkClaim("Vitamin D cures depression", AI_ENV, { query });
      assert.equal(result.queryMode, "auto-extracted", `for ${JSON.stringify(query)}`);
      assert.equal(result.query, "ai generated query");
      assert.ok(stub.calls.systems.some((s) => s.includes("PubMed search queries")));
    } finally {
      stub.restore();
    }
  }
});

test("the automatic path is unchanged when AI is switched off", async () => {
  const stub = stubWorld();
  try {
    const result = await checkClaim("Vitamin D cures depression", AI_ENV, { useAi: false });
    assert.equal(result.queryMode, "keyword-fallback");
    assert.equal(result.query, "vitamin d depression");
    assert.equal(stub.calls.prompts.length, 0, "no model calls at all");
  } finally {
    stub.restore();
  }
});

test("a user query is honoured even with AI switched off", async () => {
  const stub = stubWorld();
  try {
    const result = await checkClaim("anything", AI_ENV, {
      useAi: false,
      query: "curcumin[Title] AND osteoarthritis",
    });
    assert.equal(result.queryMode, "user-edited");
    assert.equal(result.query, "curcumin[Title] AND osteoarthritis");
    assert.equal(stub.calls.prompts.length, 0);
  } finally {
    stub.restore();
  }
});

test("the query mode is reported in the result for later review", async () => {
  const stub = stubWorld();
  try {
    const auto = await checkClaim("Vitamin D cures depression", AI_ENV, {});
    const manual = await checkClaim("Vitamin D cures depression", AI_ENV, { query: "x[MeSH]" });
    assert.notEqual(auto.queryMode, manual.queryMode);
    assert.ok(["auto-extracted", "keyword-fallback", "user-edited"].includes(auto.queryMode));
  } finally {
    stub.restore();
  }
});

test("a manual query does not disturb grading of a zero-result search", async () => {
  const stub = stubWorld({ esearchCount: 0 });
  try {
    const result = await checkClaim("anything", AI_ENV, { query: "nonsense[MeSH]" });
    assert.equal(result.verdict.label, "insufficient");
    assert.equal(result.studies.length, 0);
    assert.equal(result.meta.searchError, null);
  } finally {
    stub.restore();
  }
});
