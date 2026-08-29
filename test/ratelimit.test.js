import test from "node:test";
import assert from "node:assert/strict";
import { onRequest, takeToken, resetBuckets } from "../functions/_middleware.js";
import { rateLimitFor } from "../src/deploy.js";

const DEMO = { DEPLOY_MODE: "demo", RATE_LIMIT_PER_MINUTE: "6", RATE_LIMIT_BURST: "3" };
const SELF_HOST = {};

const post = (path, body) =>
  new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body: JSON.stringify(body ?? {}),
  });

const passthrough = () => new Response("ok", { status: 200 });

test.beforeEach(() => resetBuckets());

// --- the bucket itself ---------------------------------------------------

test("a burst is allowed, then further requests are refused", () => {
  const limit = { perMinute: 6, burst: 3 };
  const now = Date.now();
  const results = Array.from({ length: 5 }, () => takeToken("ip", limit, now).allowed);
  assert.deepEqual(results, [true, true, true, false, false]);
});

test("tokens refill over time", () => {
  const limit = { perMinute: 6, burst: 3 };
  const now = Date.now();
  for (let i = 0; i < 3; i += 1) takeToken("ip", limit, now);
  assert.equal(takeToken("ip", limit, now).allowed, false);
  // 6 per minute means one token every 10 seconds.
  assert.equal(takeToken("ip", limit, now + 10_001).allowed, true);
});

test("a refusal says how long to wait", () => {
  const limit = { perMinute: 6, burst: 1 };
  const now = Date.now();
  takeToken("ip", limit, now);
  const refused = takeToken("ip", limit, now);
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfter > 0 && refused.retryAfter <= 60);
});

test("one visitor's limit does not affect another", () => {
  const limit = { perMinute: 6, burst: 1 };
  const now = Date.now();
  takeToken("visitor-a", limit, now);
  assert.equal(takeToken("visitor-a", limit, now).allowed, false);
  assert.equal(takeToken("visitor-b", limit, now).allowed, true);
});

// --- middleware behaviour ------------------------------------------------

test("a self-hosted instance is never rate limited", async () => {
  for (let i = 0; i < 25; i += 1) {
    const res = await onRequest({ request: post("/api/check-claim"), env: SELF_HOST, next: passthrough });
    assert.equal(res.status, 200, `request ${i} should pass`);
  }
  assert.equal(rateLimitFor(SELF_HOST), null);
});

test("the demo refuses once the burst is spent, with 429 and Retry-After", async () => {
  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    const res = await onRequest({ request: post("/api/check-claim"), env: DEMO, next: passthrough });
    statuses.push(res.status);
    if (res.status === 429) {
      assert.ok(res.headers.get("retry-after"), "must tell the caller when to retry");
      const body = await res.json();
      assert.match(body.error, /self-host/i, "the refusal points at the free alternative");
      assert.ok(body.retryAfter > 0);
    }
  }
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
});

test("a click-through carrying its own record is not counted again", async () => {
  // Spend the whole burst on claim checks.
  for (let i = 0; i < 3; i += 1) {
    await onRequest({ request: post("/api/check-claim"), env: DEMO, next: passthrough });
  }
  assert.equal(
    (await onRequest({ request: post("/api/check-claim"), env: DEMO, next: passthrough })).status,
    429,
  );

  // Opening the inspector from that result must still work.
  const clickThrough = post("/api/inspect-study", { ref: "9500320", record: { pmid: "9500320" } });
  const res = await onRequest({ request: clickThrough, env: DEMO, next: passthrough });
  assert.equal(res.status, 200, "a continuation of paid-for work is not a fresh hit");
});

test("a fresh study lookup with no record is counted normally", async () => {
  for (let i = 0; i < 3; i += 1) {
    await onRequest({ request: post("/api/inspect-study", { ref: "9500320" }), env: DEMO, next: passthrough });
  }
  const res = await onRequest({ request: post("/api/inspect-study", { ref: "1" }), env: DEMO, next: passthrough });
  assert.equal(res.status, 429);
});

test("unlimited paths are never counted", async () => {
  for (let i = 0; i < 20; i += 1) {
    const res = await onRequest({ request: post("/api/export"), env: DEMO, next: passthrough });
    assert.equal(res.status, 200);
  }
  const stillAllowed = await onRequest({ request: post("/api/check-claim"), env: DEMO, next: passthrough });
  assert.equal(stillAllowed.status, 200, "export traffic must not consume the claim budget");
});

test("a malformed click-through body does not crash the limiter", async () => {
  const bad = new Request("https://example.test/api/inspect-study", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.9" },
    body: "not json",
  });
  const res = await onRequest({ request: bad, env: DEMO, next: passthrough });
  assert.ok([200, 429].includes(res.status));
});

test("requests with no client IP header still get limited together", async () => {
  const anonymous = () =>
    new Request("https://example.test/api/check-claim", { method: "POST", body: "{}" });
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    statuses.push((await onRequest({ request: anonymous(), env: DEMO, next: passthrough })).status);
  }
  assert.equal(statuses.at(-1), 429, "unattributable traffic must not bypass the limit");
});
