import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { scoreDirection, DIRECTION_CONFIG, SCORING_CONFIG } from "../src/scoring.js";
import { classifyStances } from "../src/pipeline.js";

const YEAR = 2026;
const s = (type, stance, year = 2024, sampleSize) => ({ type, stance, year, sampleSize });
const dir = (studies) => scoreDirection(studies, SCORING_CONFIG, DIRECTION_CONFIG, YEAR);

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

test("unanimous support reads as supported", () => {
  assert.equal(dir([s("meta-analysis", "supports"), s("rct", "supports")]).direction, "supported");
});

test("unanimous opposition reads as contradicted", () => {
  assert.equal(
    dir([s("meta-analysis", "contradicts"), s("rct", "contradicts")]).direction,
    "contradicted",
  );
});

test("an even split reads as mixed", () => {
  assert.equal(dir([s("rct", "supports"), s("rct", "contradicts")]).direction, "mixed");
});

test("direction is weighted by study quality, not by headcount", () => {
  const studies = [
    s("meta-analysis", "contradicts", 2025, 40000),
    ...Array.from({ length: 5 }, () => s("case-report", "supports", 2025)),
  ];
  const r = dir(studies);
  assert.ok(["contradicted", "leans-contradicted"].includes(r.direction));
  assert.ok(r.contradictWeight > r.supportWeight);
});

test("mostly-unjudged studies leave the direction unassessed", () => {
  const studies = [
    s("rct", "supports"),
    ...Array.from({ length: 9 }, () => s("rct", "unassessed")),
  ];
  assert.equal(dir(studies).direction, "unassessed");
});

test("neutral studies dilute confidence without voting", () => {
  const withNeutrals = dir([
    s("rct", "supports"),
    ...Array.from({ length: 8 }, () => s("rct", "neutral")),
  ]);
  assert.equal(withNeutrals.direction, "unassessed");
  assert.equal(withNeutrals.counts.neutral, 8);
  assert.equal(withNeutrals.supportWeight > 0, true);
});

test("no studies is unassessed, not an error", () => {
  const r = dir([]);
  assert.equal(r.direction, "unassessed");
  assert.equal(r.decisiveShare, 0);
});

test("an unrecognized stance string counts as no vote", () => {
  const r = dir([s("rct", "definitely-yes"), s("rct", "supports")]);
  assert.equal(r.counts.unassessed, 1);
  assert.equal(r.counts.supports, 1);
});

test("stance classification parses a batched model reply", async () => {
  const { server, url } = await mockOllama(() =>
    'Here you go:\n```json\n{"stances":[{"n":1,"stance":"contradicts"},{"n":2,"stance":"neutral"}]}\n```',
  );
  const studies = [
    { pmid: "1", title: "Trial A", abstract: "No benefit found." },
    { pmid: "2", title: "Trial B", abstract: "Unrelated outcome." },
  ];
  try {
    const { stances, degraded } = await classifyStances("x cures y", studies, {
      LOCAL_MODE: "true",
      OLLAMA_URL: url,
    });
    assert.equal(stances.get("1"), "contradicts");
    assert.equal(stances.get("2"), "neutral");
    assert.equal(degraded, false);
  } finally {
    server.close();
  }
});

test("studies the model skips or mislabels stay unassessed", async () => {
  const { server, url } = await mockOllama(() =>
    '{"stances":[{"n":1,"stance":"supports"},{"n":2,"stance":"probably?"},{"n":99,"stance":"supports"}]}',
  );
  const studies = [
    { pmid: "1", title: "A", abstract: "" },
    { pmid: "2", title: "B", abstract: "" },
    { pmid: "3", title: "C", abstract: "" },
  ];
  try {
    const { stances, degraded } = await classifyStances("claim", studies, {
      LOCAL_MODE: "true",
      OLLAMA_URL: url,
    });
    assert.equal(stances.size, 1);
    assert.equal(stances.get("1"), "supports");
    assert.equal(degraded, true);
  } finally {
    server.close();
  }
});

test("an unreachable model leaves every stance unassessed", async () => {
  const { stances, degraded } = await classifyStances(
    "claim",
    [{ pmid: "1", title: "A", abstract: "" }],
    { LOCAL_MODE: "true", OLLAMA_URL: "http://127.0.0.1:1" },
  );
  assert.equal(stances.size, 0);
  assert.equal(degraded, true);
});

test("stance classification batches into a bounded number of calls", async () => {
  let calls = 0;
  const { server, url } = await mockOllama(() => {
    calls += 1;
    return '{"stances":[]}';
  });
  const studies = Array.from({ length: 20 }, (_, i) => ({
    pmid: String(i),
    title: `Study ${i}`,
    abstract: "text",
  }));
  try {
    await classifyStances("claim", studies, { LOCAL_MODE: "true", OLLAMA_URL: url });
    assert.equal(calls, 3);
  } finally {
    server.close();
  }
});
