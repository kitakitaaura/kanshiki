import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { getAIResponse, isLocalMode, AIError } from "../src/ai.js";
import { extractClaim, naiveQuery, fallbackSummary } from "../src/pipeline.js";
import { scoreEvidence } from "../src/scoring.js";

function mockOllama(handler) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const out = handler(JSON.parse(body), req);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

test("LOCAL_MODE routes to Ollama and normalizes the response", async () => {
  const seen = [];
  const { server, url } = await mockOllama((body) => {
    seen.push(body);
    return { body: { response: "  hello from ollama  " } };
  });
  try {
    const res = await getAIResponse("ping", {
      env: { LOCAL_MODE: "true", OLLAMA_URL: url, OLLAMA_MODEL: "llama3.2" },
      system: "be brief",
    });
    assert.deepEqual(res, { text: "hello from ollama", backend: "ollama", model: "llama3.2" });
    assert.equal(seen[0].prompt, "ping");
    assert.equal(seen[0].system, "be brief");
    assert.equal(seen[0].stream, false);
  } finally {
    server.close();
  }
});

test("non-local mode routes to the Workers AI binding, same response shape", async () => {
  const calls = [];
  const env = {
    LOCAL_MODE: "false",
    WORKERS_AI_MODEL: "@cf/meta/llama-3.1-8b-instruct",
    AI: {
      run: async (model, opts) => {
        calls.push({ model, opts });
        return { response: "hello from workers ai" };
      },
    },
  };
  const res = await getAIResponse("ping", { env, system: "be brief" });
  assert.equal(res.text, "hello from workers ai");
  assert.equal(res.backend, "workers-ai");
  assert.equal(calls[0].opts.messages[0].role, "system");
  assert.equal(calls[0].opts.messages[1].content, "ping");
});

test("a missing Workers AI binding is a clear error, not a crash", async () => {
  await assert.rejects(() => getAIResponse("ping", { env: { LOCAL_MODE: "false" } }), AIError);
});

test("isLocalMode only accepts the literal string true", () => {
  assert.equal(isLocalMode({ LOCAL_MODE: "true" }), true);
  assert.equal(isLocalMode({ LOCAL_MODE: "TRUE" }), true);
  assert.equal(isLocalMode({ LOCAL_MODE: "false" }), false);
  assert.equal(isLocalMode({}), false);
});

test("claim extraction survives a model that wraps JSON in prose and fences", async () => {
  const { server, url } = await mockOllama(() => ({
    body: {
      response:
        'Sure! Here you go:\n```json\n{"claim": "Vitamin D treats depression", "query": "vitamin D supplementation depressive symptoms"}\n```',
    },
  }));
  try {
    const r = await extractClaim("vitamin d cures depression!!", {
      LOCAL_MODE: "true",
      OLLAMA_URL: url,
    });
    assert.equal(r.query, "vitamin D supplementation depressive symptoms");
    assert.equal(r.degraded, false);
  } finally {
    server.close();
  }
});

test("claim extraction falls back to a keyword query when the model misbehaves", async () => {
  const { server, url } = await mockOllama(() => ({ body: { response: "I cannot help with that." } }));
  try {
    const r = await extractClaim("vitamin D cures depression", { LOCAL_MODE: "true", OLLAMA_URL: url });
    assert.equal(r.degraded, true);
    assert.equal(r.query, "vitamin d depression");
  } finally {
    server.close();
  }
});

test("claim extraction falls back when the AI backend is unreachable", async () => {
  const r = await extractClaim("does turmeric help arthritis", {
    LOCAL_MODE: "true",
    OLLAMA_URL: "http://127.0.0.1:1",
  });
  assert.equal(r.degraded, true);
  assert.ok(r.query.includes("turmeric"));
});

test("naiveQuery keeps qualifiers and drops hype", () => {
  assert.equal(naiveQuery("Vitamin D cures depression"), "vitamin d depression");
  assert.equal(naiveQuery("turmeric is a miracle cure for arthritis"), "turmeric arthritis");
});

test("fallbackSummary is honest about zero results", () => {
  const text = fallbackSummary("x", scoreEvidence([]));
  assert.match(text, /No PubMed studies matched/);
  assert.doesNotMatch(text, /disproven|false/i);
});

// --- Workers AI response shapes (v3) -------------------------------------

import { extractWorkersAiText } from "../src/ai.js";

test("accepts both Workers AI response shapes", () => {
  // Older models return { response }.
  assert.equal(extractWorkersAiText({ response: "hello" }), "hello");
  // Newer models return an OpenAI-style completion.
  assert.equal(
    extractWorkersAiText({ choices: [{ message: { content: "hello" } }] }),
    "hello",
  );
  assert.equal(extractWorkersAiText({ choices: [{ text: "hello" }] }), "hello");
  assert.equal(extractWorkersAiText({ result: { response: "hello" } }), "hello");
  assert.equal(extractWorkersAiText("hello"), "hello");
});

test("an unusable Workers AI response is empty, not a silent blank", () => {
  for (const shape of [null, undefined, {}, 42, { choices: [] }, { response: "" }, { response: "   " }]) {
    assert.equal(extractWorkersAiText(shape), "", `shape ${JSON.stringify(shape)}`);
  }
});

test("a Workers AI model returning an unknown shape raises a described error", async () => {
  const env = {
    LOCAL_MODE: "false",
    WORKERS_AI_MODEL: "@cf/some/model",
    AI: { run: async () => ({ unexpected: "shape" }) },
  };
  await assert.rejects(
    () => getAIResponse("ping", { env }),
    (err) => err instanceof AIError && /returned no usable text/.test(err.message) && /unexpected/.test(err.message),
  );
});

test("the OpenAI-style shape works end to end through getAIResponse", async () => {
  const env = {
    LOCAL_MODE: "false",
    WORKERS_AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    AI: { run: async () => ({ choices: [{ message: { content: " judged " } }] }) },
  };
  const res = await getAIResponse("ping", { env });
  assert.equal(res.text, "judged");
  assert.equal(res.backend, "workers-ai");
});

// --- deployment mode isolation (v3) --------------------------------------

test("LOCAL_MODE=true never reaches Workers AI, even with a live binding", async () => {
  let workersAiCalls = 0;
  const { server, url } = await mockOllama(() => ({ body: { response: "from ollama" } }));
  try {
    const env = {
      LOCAL_MODE: "true",
      OLLAMA_URL: url,
      // A binding is present and would work. It must still never be touched.
      AI: {
        run: async () => {
          workersAiCalls += 1;
          return { response: "from workers ai" };
        },
      },
    };
    const res = await getAIResponse("ping", { env });
    assert.equal(res.backend, "ollama");
    assert.equal(res.text, "from ollama");
    assert.equal(workersAiCalls, 0, "the Workers AI binding must not be called in local mode");
  } finally {
    server.close();
  }
});

test("a self-hosted instance works with no Workers AI binding at all", async () => {
  const { server, url } = await mockOllama(() => ({ body: { response: "fine" } }));
  try {
    const res = await getAIResponse("ping", { env: { LOCAL_MODE: "true", OLLAMA_URL: url } });
    assert.equal(res.text, "fine");
  } finally {
    server.close();
  }
});

test("LOCAL_MODE=false never contacts Ollama", async () => {
  let ollamaCalls = 0;
  const { server, url } = await mockOllama(() => {
    ollamaCalls += 1;
    return { body: { response: "from ollama" } };
  });
  try {
    const env = {
      LOCAL_MODE: "false",
      OLLAMA_URL: url,
      AI: { run: async () => ({ response: "from workers ai" }) },
    };
    const res = await getAIResponse("ping", { env });
    assert.equal(res.backend, "workers-ai");
    assert.equal(ollamaCalls, 0, "Ollama must not be contacted in hosted mode");
  } finally {
    server.close();
  }
});

test("switching modes needs only the env var, no other change", async () => {
  const { server, url } = await mockOllama(() => ({ body: { response: "local" } }));
  try {
    const shared = {
      OLLAMA_URL: url,
      AI: { run: async () => ({ response: "hosted" }) },
    };
    const local = await getAIResponse("ping", { env: { ...shared, LOCAL_MODE: "true" } });
    const hosted = await getAIResponse("ping", { env: { ...shared, LOCAL_MODE: "false" } });
    assert.equal(local.text, "local");
    assert.equal(hosted.text, "hosted");
  } finally {
    server.close();
  }
});
