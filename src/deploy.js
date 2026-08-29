export const DEPLOY_CONFIG = {
  // Local models are slower than Workers AI, so each mode gets its own budget.
  timeoutSeconds: { "self-host": 180, demo: 60 },
  rateLimit: { "self-host": null, demo: { perMinute: 6, burst: 3 } },
};

export function deployMode(env = {}) {
  return String(env.DEPLOY_MODE ?? "").toLowerCase() === "demo" ? "demo" : "self-host";
}

export function requestTimeoutMs(env = {}, cfg = DEPLOY_CONFIG) {
  const override = Number(env.REQUEST_TIMEOUT_SECONDS);
  const seconds = Number.isFinite(override) && override > 0
    ? override
    : cfg.timeoutSeconds[deployMode(env)];
  return seconds * 1000;
}

export function rateLimitFor(env = {}, cfg = DEPLOY_CONFIG) {
  const base = cfg.rateLimit[deployMode(env)];
  if (!base) return null;
  const perMinute = Number(env.RATE_LIMIT_PER_MINUTE);
  const burst = Number(env.RATE_LIMIT_BURST);
  return {
    perMinute: Number.isFinite(perMinute) && perMinute > 0 ? perMinute : base.perMinute,
    burst: Number.isFinite(burst) && burst > 0 ? burst : base.burst,
  };
}

export class TimeoutError extends Error {
  constructor(seconds) {
    super(
      `This took longer than ${seconds} seconds and was stopped. ` +
        `A local model on modest hardware can exceed this: raise REQUEST_TIMEOUT_SECONDS, ` +
        `or turn AI off for a much faster answer.`,
    );
    this.name = "TimeoutError";
    this.seconds = seconds;
  }
}

/** Rejects with TimeoutError if the work outlives the configured budget. */
export async function withTimeout(work, env = {}, cfg = DEPLOY_CONFIG) {
  const ms = requestTimeoutMs(env, cfg);
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(Math.round(ms / 1000))), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
