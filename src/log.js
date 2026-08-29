/**
 * One-line JSON events for the failures worth noticing.
 *
 * Cloudflare captures console output for the demo, and a self-hoster reads the
 * same lines in their terminal. No logging service, nothing to configure, and
 * nothing a self-hoster has to replicate.
 */
export const LOG_EVENTS = {
  pubmedFailed: "pubmed_failed",
  metricsUnavailable: "metrics_unavailable",
  aiFailed: "ai_failed",
  rateLimited: "rate_limited",
  requestTimeout: "request_timeout",
};

// Never log claim text or user input: it can be personal health information.
export function logEvent(event, fields = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    safe[key] = typeof value === "string" ? value.slice(0, 200) : value;
  }
  console.warn(JSON.stringify({ event, at: new Date().toISOString(), ...safe }));
}
