import { checkClaim } from "../../src/pipeline.js";
import { sanitizeClaim, sanitizeQuery } from "../../src/sanitize.js";
import { withTimeout, TimeoutError } from "../../src/deploy.js";
import { logEvent, LOG_EVENTS } from "../../src/log.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export async function onRequestPost({ request, env }) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Expected a JSON body like { \"claim\": \"...\" }" }, 400);
  }

  const checked = sanitizeClaim(payload?.claim);
  if (!checked.ok) {
    return json({ error: checked.error }, /too long/.test(checked.error) ? 413 : 400);
  }
  const claim = checked.value;

  try {
    const useAi = payload?.useAi !== false;
    const query = sanitizeQuery(payload?.query);
    const result = await withTimeout(
      checkClaim(claim, env, { retmax: Number(env.PUBMED_RETMAX) || 20, useAi, query }),
      env,
    );
    return json(result);
  } catch (err) {
    if (err instanceof TimeoutError) {
      logEvent(LOG_EVENTS.requestTimeout, { seconds: err.seconds });
      return json({ error: err.message }, 504);
    }
    console.error("check-claim failed:", err?.stack || err);
    return json({ error: "The evidence check failed. Please try again." }, 502);
  }
}

export function onRequestGet() {
  return json({ error: "Use POST with { \"claim\": \"...\" }" }, 405);
}
