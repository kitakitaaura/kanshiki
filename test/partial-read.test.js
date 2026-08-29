import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { classifyStances, excerptForStance, STANCE_CONFIG } from "../src/pipeline.js";
import { scoreEvidence, scoreDirection } from "../src/scoring.js";

function mockOllama(handler) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ response: handler(JSON.parse(body)) }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

// The shipping config sends whole abstracts, so these tests pass an explicit
// budget to exercise the truncation mechanism itself.
const BUDGET = { ...STANCE_CONFIG, abstractChars: 1200, headShare: 1 };

const allSupport = (n) =>
  JSON.stringify({ stances: Array.from({ length: n }, (_, i) => ({ n: i + 1, stance: "supports" })) });

test("truncation is flagged only for abstracts over the budget", async () => {
  const { server, url } = await mockOllama(() => allSupport(4));
  const studies = [
    { pmid: "long", title: "A", abstract: "x".repeat(BUDGET.abstractChars + 1) },
    { pmid: "exact", title: "B", abstract: "x".repeat(BUDGET.abstractChars) },
    { pmid: "short", title: "C", abstract: "brief findings" },
    { pmid: "none", title: "D", abstract: "" },
  ];
  try {
    const { partialReads } = await classifyStances(
      claimless(),
      studies,
      { LOCAL_MODE: "true", OLLAMA_URL: url },
      BUDGET,
    );
    assert.deepEqual([...partialReads], ["long"]);
    assert.equal(partialReads.has("exact"), false);
    assert.equal(partialReads.has("short"), false);
    assert.equal(partialReads.has("none"), false);
  } finally {
    server.close();
  }
});

test("studies never sent for judging are not flagged", async () => {
  const { server, url } = await mockOllama(() => allSupport(4));
  const studies = Array.from({ length: BUDGET.maxStudies + 3 }, (_, i) => ({
    pmid: `p${i}`,
    title: `Study ${i}`,
    abstract: "x".repeat(BUDGET.abstractChars + 500),
  }));
  try {
    const { partialReads } = await classifyStances(
      claimless(),
      studies,
      { LOCAL_MODE: "true", OLLAMA_URL: url },
      BUDGET,
    );
    assert.equal(partialReads.size, STANCE_CONFIG.maxStudies);
    assert.equal(partialReads.has(`p${STANCE_CONFIG.maxStudies}`), false);
  } finally {
    server.close();
  }
});

test("truncation is recorded even when the model call fails", async () => {
  const studies = [{ pmid: "1", title: "A", abstract: "x".repeat(5000) }];
  const { stances, partialReads } = await classifyStances(
    claimless(),
    studies,
    { LOCAL_MODE: "true", OLLAMA_URL: "http://127.0.0.1:1" },
    BUDGET,
  );
  assert.equal(stances.size, 0);
  assert.deepEqual([...partialReads], ["1"]);
});

test("the budget is configurable, and the flag follows it", async () => {
  const { server, url } = await mockOllama(() => allSupport(1));
  const studies = [{ pmid: "1", title: "A", abstract: "x".repeat(300) }];
  try {
    const wide = await classifyStances(claimless(), studies, { LOCAL_MODE: "true", OLLAMA_URL: url });
    assert.equal(wide.partialReads.size, 0);

    const narrow = await classifyStances(
      claimless(),
      studies,
      { LOCAL_MODE: "true", OLLAMA_URL: url },
      { ...STANCE_CONFIG, abstractChars: 100 },
    );
    assert.equal(narrow.partialReads.size, 1);
  } finally {
    server.close();
  }
});

test("partialRead is not an input to strength or direction scoring", () => {
  const base = [
    { type: "meta-analysis", year: 2024, sampleSize: 900, stance: "supports" },
    { type: "rct", year: 2022, sampleSize: 300, stance: "contradicts" },
  ];
  const flagged = base.map((s) => ({ ...s, partialRead: true }));

  assert.equal(scoreEvidence(base).score, scoreEvidence(flagged).score);
  assert.equal(scoreEvidence(base).label, scoreEvidence(flagged).label);
  assert.equal(scoreDirection(base).direction, scoreDirection(flagged).direction);
  assert.equal(scoreDirection(base).supportWeight, scoreDirection(flagged).supportWeight);
});

function claimless() {
  return "some health claim";
}

test("retraction is carried for display but never moves a claim score", () => {
  const base = [
    { type: "meta-analysis", year: 2024, sampleSize: 900, stance: "supports" },
    { type: "rct", year: 2022, sampleSize: 300, stance: "contradicts" },
  ];
  const retracted = base.map((s) => ({ ...s, retraction: { retracted: true, noticeUrl: "x" } }));

  assert.equal(scoreEvidence(base).score, scoreEvidence(retracted).score);
  assert.equal(scoreEvidence(base).label, scoreEvidence(retracted).label);
  assert.equal(scoreDirection(base).direction, scoreDirection(retracted).direction);
  assert.equal(scoreDirection(base).supportWeight, scoreDirection(retracted).supportWeight);
});

test("the shipping config sends whole abstracts, so nothing is a partial read", async () => {
  assert.equal(STANCE_CONFIG.abstractChars, 0, "0 means send the whole abstract");
  const studies = [{ pmid: "1", title: "A", abstract: "x".repeat(9000) }];
  const { partialReads } = await classifyStances(claimless(), studies, {
    LOCAL_MODE: "true",
    OLLAMA_URL: "http://127.0.0.1:1",
  });
  assert.equal(partialReads.size, 0);
});

test("excerptForStance returns the whole abstract when no budget is set", () => {
  const abstract = "y".repeat(5000);
  assert.equal(excerptForStance(abstract, { abstractChars: 0, headShare: 1 }), abstract);
  assert.equal(excerptForStance(abstract, { abstractChars: 100, headShare: 1 }).length, 100);
});
