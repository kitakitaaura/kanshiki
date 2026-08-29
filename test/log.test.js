import test from "node:test";
import assert from "node:assert/strict";
import { logEvent, LOG_EVENTS } from "../src/log.js";

function capture(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (line) => lines.push(line);
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

test("events are single-line JSON with a name and timestamp", () => {
  const [line] = capture(() => logEvent(LOG_EVENTS.pubmedFailed, { endpoint: "esearch" }));
  assert.doesNotMatch(line, /\n/);
  const parsed = JSON.parse(line);
  assert.equal(parsed.event, "pubmed_failed");
  assert.equal(parsed.endpoint, "esearch");
  assert.ok(Date.parse(parsed.at));
});

test("null and undefined fields are dropped rather than logged", () => {
  const [line] = capture(() => logEvent("x", { a: 1, b: null, c: undefined, d: false }));
  const parsed = JSON.parse(line);
  assert.equal(parsed.a, 1);
  assert.equal(parsed.d, false);
  assert.ok(!("b" in parsed));
  assert.ok(!("c" in parsed));
});

test("long values are truncated so a log line cannot be flooded", () => {
  const [line] = capture(() => logEvent("x", { reason: "e".repeat(5000) }));
  assert.ok(JSON.parse(line).reason.length <= 200);
});

test("every documented event name is defined", () => {
  for (const name of Object.values(LOG_EVENTS)) {
    assert.match(name, /^[a-z_]+$/);
  }
});
