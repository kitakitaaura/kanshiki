const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "llama3.1:8b";
const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const TIMEOUT_MS = 45000;

export function isLocalMode(env = {}) {
  return String(env.LOCAL_MODE ?? "").toLowerCase() === "true";
}

export async function getAIResponse(prompt, context = {}) {
  const { env = {}, system = "", temperature = 0.2, maxTokens = 600 } = context;
  return isLocalMode(env)
    ? callOllama({ prompt, system, temperature, maxTokens, env })
    : callWorkersAI({ prompt, system, temperature, maxTokens, env });
}

async function callOllama({ prompt, system, temperature, maxTokens, env }) {
  const base = (env.OLLAMA_URL || DEFAULT_OLLAMA_URL).replace(/\/$/, "");
  const model = env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
  let res;
  try {
    res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        system: system || undefined,
        stream: false,
        options: { temperature, num_predict: maxTokens },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new AIError(
      `Could not reach Ollama at ${base}. Is it running, and is "${model}" pulled?`,
      { cause: err },
    );
  }
  if (!res.ok) {
    throw new AIError(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  return { text: String(json.response ?? "").trim(), backend: "ollama", model };
}

async function callWorkersAI({ prompt, system, temperature, maxTokens, env }) {
  const model = env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL;
  if (!env.AI || typeof env.AI.run !== "function") {
    throw new AIError(
      "Workers AI binding is missing. Set LOCAL_MODE=true for Ollama, or add an [ai] binding.",
    );
  }
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const result = await env.AI.run(model, { messages, temperature, max_tokens: maxTokens });
  const text = extractWorkersAiText(result);
  if (!text) {
    throw new AIError(
      `Workers AI model ${model} returned no usable text. Shape: ${describeShape(result)}`,
    );
  }
  return { text, backend: "workers-ai", model };
}

/**
 * Workers AI does not use one response shape. Older models return
 * { response }, newer ones return an OpenAI-style { choices: [...] }. Both are
 * accepted so swapping WORKERS_AI_MODEL cannot silently return empty text.
 */
export function extractWorkersAiText(result) {
  if (typeof result === "string") return result.trim();
  if (!result || typeof result !== "object") return "";

  const candidates = [
    result.response,
    result.result?.response,
    result.choices?.[0]?.message?.content,
    result.choices?.[0]?.text,
    result.output_text,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function describeShape(result) {
  if (result === null || result === undefined) return String(result);
  if (typeof result !== "object") return typeof result;
  return `object with keys [${Object.keys(result).slice(0, 8).join(", ")}]`;
}

export class AIError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "AIError";
  }
}
