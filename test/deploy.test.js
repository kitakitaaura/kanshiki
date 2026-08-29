import test from "node:test";
import assert from "node:assert/strict";
import {
  deployMode,
  requestTimeoutMs,
  rateLimitFor,
  withTimeout,
  TimeoutError,
  DEPLOY_CONFIG,
} from "../src/deploy.js";

test("self-host is the default mode", () => {
  assert.equal(deployMode({}), "self-host");
  assert.equal(deployMode({ DEPLOY_MODE: "" }), "self-host");
  assert.equal(deployMode({ DEPLOY_MODE: "anything-else" }), "self-host");
  assert.equal(deployMode({ DEPLOY_MODE: "demo" }), "demo");
  assert.equal(deployMode({ DEPLOY_MODE: "DEMO" }), "demo");
});

test("self-host gets a longer timeout than the demo", () => {
  const selfHost = requestTimeoutMs({});
  const demo = requestTimeoutMs({ DEPLOY_MODE: "demo" });
  assert.ok(selfHost > demo, "a local model is slower and needs more room");
  assert.equal(selfHost, DEPLOY_CONFIG.timeoutSeconds["self-host"] * 1000);
});

test("the timeout is overridable per instance", () => {
  assert.equal(requestTimeoutMs({ REQUEST_TIMEOUT_SECONDS: "30" }), 30000);
  assert.equal(requestTimeoutMs({ DEPLOY_MODE: "demo", REQUEST_TIMEOUT_SECONDS: "5" }), 5000);
  // Nonsense values fall back to the mode default rather than disabling it.
  for (const bad of ["0", "-1", "abc", ""]) {
    assert.equal(requestTimeoutMs({ REQUEST_TIMEOUT_SECONDS: bad }), requestTimeoutMs({}));
  }
});

test("self-host has no rate limit; demo does", () => {
  assert.equal(rateLimitFor({}), null, "self-hosters must not inherit the demo's limit");
  const demo = rateLimitFor({ DEPLOY_MODE: "demo" });
  assert.ok(demo.perMinute > 0);
  assert.ok(demo.burst > 0);
});

test("the demo rate limit is configurable", () => {
  const limit = rateLimitFor({ DEPLOY_MODE: "demo", RATE_LIMIT_PER_MINUTE: "20", RATE_LIMIT_BURST: "5" });
  assert.equal(limit.perMinute, 20);
  assert.equal(limit.burst, 5);
  // A bad value falls back to the default instead of removing the limit.
  const bad = rateLimitFor({ DEPLOY_MODE: "demo", RATE_LIMIT_PER_MINUTE: "abc" });
  assert.equal(bad.perMinute, DEPLOY_CONFIG.rateLimit.demo.perMinute);
});

test("setting a rate limit on a self-host instance still yields no limit", () => {
  assert.equal(rateLimitFor({ RATE_LIMIT_PER_MINUTE: "1" }), null);
});

// --- timeout behaviour ---------------------------------------------------

test("work that finishes in time passes its value through", async () => {
  const value = await withTimeout(Promise.resolve("done"), { REQUEST_TIMEOUT_SECONDS: "5" });
  assert.equal(value, "done");
});

test("work that overruns rejects with an actionable message", async () => {
  const slow = new Promise((resolve) => setTimeout(resolve, 5000));
  await assert.rejects(
    () => withTimeout(slow, {}, { ...DEPLOY_CONFIG, timeoutSeconds: { "self-host": 0.05, demo: 0.05 } }),
    (err) => {
      assert.ok(err instanceof TimeoutError);
      assert.match(err.message, /REQUEST_TIMEOUT_SECONDS/);
      assert.match(err.message, /turn AI off/i);
      return true;
    },
  );
});

test("a rejection from the work itself is not disguised as a timeout", async () => {
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error("PubMed unreachable")), {}),
    (err) => !(err instanceof TimeoutError) && /PubMed unreachable/.test(err.message),
  );
});

test("the timeout timer is cleared so a fast call does not hang the process", async () => {
  // If the timer were left pending, node's test runner would wait on it.
  const started = Date.now();
  await withTimeout(Promise.resolve(1), { REQUEST_TIMEOUT_SECONDS: "30" });
  assert.ok(Date.now() - started < 1000);
});
