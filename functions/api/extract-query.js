import { extractClaim } from "../../src/pipeline.js";
import { sanitizeClaim } from "../../src/sanitize.js";

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
    return json({ error: 'Expected a JSON body like { "claim": "..." }' }, 400);
  }

  const checked = sanitizeClaim(payload?.claim);
  if (!checked.ok) {
    return json({ error: checked.error }, /too long/.test(checked.error) ? 413 : 400);
  }
  const claim = checked.value;

  const useAi = payload?.useAi !== false;
  try {
    const extracted = await extractClaim(claim, env, { useAi });
    return json({
      claim: extracted.claim,
      query: extracted.query,
      mode: useAi && !extracted.degraded ? "auto-extracted" : "keyword-fallback",
      degraded: extracted.degraded,
    });
  } catch (err) {
    console.error("extract-query failed:", err?.stack || err);
    return json({ error: "Could not build a query for that claim." }, 502);
  }
}

export function onRequestGet() {
  return json({ error: 'Use POST with { "claim": "..." }' }, 405);
}
