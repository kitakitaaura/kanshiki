import { deployMode, rateLimitFor } from "../../src/deploy.js";

// Lets the frontend show demo-only notices without hardcoding a mode.
export function onRequestGet({ env }) {
  const limit = rateLimitFor(env);
  return new Response(
    JSON.stringify({
      mode: deployMode(env),
      rateLimited: Boolean(limit),
      perMinute: limit?.perMinute ?? null,
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}
