export const INPUT_CONFIG = {
  maxClaimChars: 4000,
  maxQueryChars: 500,
  maxRefChars: 300,
  // Below this share of Latin letters the keyword fallback cannot build a
  // usable PubMed query, so the response says so instead of guessing.
  minLatinRatio: 0.5,
};

const TAG = /<\/?[a-z][^>]*>/gi;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const SCRIPT_BLOCK = /<script[\s\S]*?<\/script\s*>/gi;
const STYLE_BLOCK = /<style[\s\S]*?<\/style\s*>/gi;
const DANGEROUS_URL = /\b(?:javascript|vbscript|data)\s*:/gi;
const EVENT_HANDLER = /\bon[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
// Control characters other than tab and newline, plus the invisible
// formatting characters used to disguise or reverse text.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Nothing in this app interpolates HTML, so this is defence in depth. It also
 * keeps markup from reaching the model as instructions, and from being echoed
 * into an export.
 */
export function stripMarkup(value) {
  return String(value ?? "")
    .replace(COMMENT, " ")
    .replace(SCRIPT_BLOCK, " ")
    .replace(STYLE_BLOCK, " ")
    .replace(EVENT_HANDLER, " ")
    .replace(TAG, " ")
    .replace(DANGEROUS_URL, " ")
    .replace(CONTROL, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function latinRatio(value) {
  const letters = String(value ?? "").match(/\p{L}/gu) ?? [];
  if (!letters.length) return 1;
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  return latin / letters.length;
}

export function sanitizeClaim(input, cfg = INPUT_CONFIG) {
  if (typeof input !== "string") return { ok: false, error: "Enter a health claim to check." };

  const cleaned = stripMarkup(input);
  if (!cleaned) {
    return {
      ok: false,
      error: /\S/.test(input)
        ? "That input had no readable text once markup was removed."
        : "Enter a health claim to check.",
    };
  }
  if (cleaned.length > cfg.maxClaimChars) {
    return { ok: false, error: `Claim is too long (limit ${cfg.maxClaimChars} characters).` };
  }
  return { ok: true, value: cleaned };
}

export function sanitizeQuery(input, cfg = INPUT_CONFIG) {
  // PubMed syntax survives: brackets, quotes, parentheses and operators are
  // all meaningful, so only markup and control characters are removed.
  return stripMarkup(input).slice(0, cfg.maxQueryChars);
}

export function sanitizeRef(input, cfg = INPUT_CONFIG) {
  return stripMarkup(input).slice(0, cfg.maxRefChars);
}

export function inputWarning(claim, { useAi = true } = {}, cfg = INPUT_CONFIG) {
  if (latinRatio(claim) >= cfg.minLatinRatio) return null;
  return useAi
    ? "This claim is not written in a Latin script. Kanshiki will try to build an English PubMed query from it, but PubMed indexes English, so results may be thin."
    : "This claim is not written in a Latin script and AI is switched off, so the keyword fallback cannot build a usable PubMed query. Turn AI on, or type an English query yourself.";
}
