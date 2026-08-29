import { isLocalMode } from "../../src/ai.js";

export function onRequestGet({ env }) {
  return new Response(
    JSON.stringify({
      ok: true,
      aiBackend: isLocalMode(env) ? "ollama" : "workers-ai",
      model: isLocalMode(env)
        ? env.OLLAMA_MODEL || "llama3.2"
        : env.WORKERS_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8",
      workersAiBindingPresent: Boolean(env.AI),
      ncbiApiKey: Boolean(env.NCBI_API_KEY),
    }),
    { headers: { "content-type": "application/json" } },
  );
}
