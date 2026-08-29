import { rateLimitFor, deployMode } from "../src/deploy.js";
import { logEvent, LOG_EVENTS } from "../src/log.js";

// Per-IP token buckets, held in the isolate. Cloudflare may run several
// isolates, so this is a courtesy limit rather than a hard guarantee. It costs
// nothing, needs no extra service, and self-hosters never see it.
const buckets = new Map();
const MAX_TRACKED_IPS = 10000;

const LIMITED_PATHS = ["/api/check-claim", "/api/inspect-study", "/api/extract-query"];

function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown"
  );
}

export function takeToken(key, limit, now = Date.now()) {
  const refillPerMs = limit.perMinute / 60000;
  const capacity = limit.burst;

  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_TRACKED_IPS) buckets.clear();
    bucket = { tokens: capacity, at: now };
    buckets.set(key, bucket);
  }

  bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.at) * refillPerMs);
  bucket.at = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true };
  }
  return { allowed: false, retryAfter: Math.ceil((1 - bucket.tokens) / refillPerMs / 1000) };
}

export function resetBuckets() {
  buckets.clear();
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const limit = rateLimitFor(env);
  const path = new URL(request.url).pathname;

  if (!limit || !LIMITED_PATHS.includes(path)) return next();

  // A click-through from a claim result sends its own record, so it is a
  // continuation of work already paid for rather than a fresh request.
  if (path === "/api/inspect-study") {
    const clone = request.clone();
    const body = await clone.json().catch(() => null);
    if (body?.record) return next();
  }

  const { allowed, retryAfter } = takeToken(clientIp(request), limit);
  if (allowed) return next();

  logEvent(LOG_EVENTS.rateLimited, { path, mode: deployMode(env), retryAfter });
  return new Response(
    JSON.stringify({
      error:
        `This public demo allows about ${limit.perMinute} checks per minute per visitor, to keep it ` +
        `available for everyone. Wait ${retryAfter} seconds, or run Kanshiki yourself for free with ` +
        `no limits: see the self-hosting section of the README.`,
      retryAfter,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "retry-after": String(retryAfter),
      },
    },
  );
}
