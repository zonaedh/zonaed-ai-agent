// ============================================================================
// Intelligence-stack verification (plan §5.1, §8 Automated)
//
// Run: npm run verify:intelligence
// Exercises the pure modules (tone, anti-cliché, matching, system prompt) and
// the provider layer (SSE parsing for both protocols + 429/503 failover) with
// stub fetch — no network, no real keys needed.
// ============================================================================
import assert from "node:assert/strict";
import { detectLanguageMode } from "../lib/ai/tone";
import { BANNED_WORDS, sanitizeDashes, scanOutput } from "../lib/ai/anti-cliche";
import { buildPreamble, matchMemories, matchSkills } from "../lib/ai/matching";
import { buildSystemPrompt } from "../lib/ai/system-prompt";
import {
  availableProviders,
  PROVIDERS,
  ProviderError,
  shouldFailover,
  streamFromProvider,
  streamWithFailover,
} from "../lib/ai/providers";
import type { ExampleRow, MemoryRow, SkillRow } from "../lib/db/types";

let passed = 0;
let finished = 0;
const TOTAL = 16;

function maybeDone() {
  finished += 1;
  if (finished === TOTAL) {
    if (process.exitCode === 1) process.exit(1);
    console.log(`\n${passed}/${TOTAL} intelligence checks passed`);
  }
}

function check(name: string, fn: () => void | Promise<void>): void {
  const result = fn();
  if (result instanceof Promise) {
    void result.then(
      () => {
        passed += 1;
        console.log(`  ok ${passed} - ${name}`);
        maybeDone();
      },
      (err) => {
        console.error(`  FAIL - ${name}\n`, err);
        process.exitCode = 1;
        maybeDone();
      },
    );
  } else {
    passed += 1;
    console.log(`  ok ${passed} - ${name}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Tone profiler
// ---------------------------------------------------------------------------
check("tone: Bengali script → bengali", () => {
  assert.equal(detectLanguageMode("আমার ব্যবসা কেমন চলছে বলো"), "bengali");
});

check("tone: Banglish (2+ hits) → banglish", () => {
  assert.equal(detectLanguageMode("amar business holo web design, tumi ki koro"), "banglish");
});

check("tone: English with false-positive words → english", () => {
  assert.equal(detectLanguageMode("Please amend the report and confirm the hotel booking"), "english");
});

// ---------------------------------------------------------------------------
// 2. Anti-cliché filter
// ---------------------------------------------------------------------------
check("anti-cliche: catches banned words and dashes", () => {
  const scan = scanOutput("This is a testament to our game-changer strategy — moreover, it works");
  assert.deepEqual(scan.bannedWords, [...BANNED_WORDS].filter((w) => ["testament", "game-changer", "moreover"].includes(w)));
  assert.equal(scan.dashes, 1);
  assert.equal(scan.clean, false);
});

check("anti-cliche: word-boundary safe (no false positives)", () => {
  assert.deepEqual(scanOutput("The team will deliver the campaign").bannedWords, []);
});

check("anti-cliche: sanitizeDashes replaces em/en dashes", () => {
  const out = sanitizeDashes("A — B – C");
  assert.ok(!/[\u2014\u2013]/.test(out));
  assert.deepEqual(scanOutput(out).dashes, 0);
});

// ---------------------------------------------------------------------------
// 3. Matching / preamble
// ---------------------------------------------------------------------------
const skills: SkillRow[] = [
  {
    client_id: "s1", title: "Pricing", content: "Our web design price is $1,200.",
    trigger_keywords: ["pricing", "cost"], source: "upload", version: 1, active: true, updated_at: new Date().toISOString(),
  },
  {
    client_id: "s2", title: "Always-on bio", content: "Zonaed runs thesharkweb.com.",
    trigger_keywords: [], source: "upload", version: 1, active: true, updated_at: new Date().toISOString(),
  },
  {
    client_id: "s3", title: "Inactive", content: "never inject",
    trigger_keywords: [], source: "upload", version: 1, active: false, updated_at: new Date().toISOString(),
  },
];

check("matching: trigger skill fires on keyword; always-on always; inactive never", () => {
  const pricing = matchSkills("what is your pricing for a site?", skills).map((s) => s.client_id);
  assert.ok(pricing.includes("s1") && pricing.includes("s2") && !pricing.includes("s3"));
  const unrelated = matchSkills("tell me about cats", skills).map((s) => s.client_id);
  assert.deepEqual(unrelated, ["s2"]);
});

const memories: MemoryRow[] = [
  { client_id: "m1", category: "business", content: "Zonaed sells web design packages", source: "manual", updated_at: new Date().toISOString() },
  { client_id: "m2", category: "preference", content: "Prefers short replies", source: "manual", updated_at: new Date().toISOString() },
  { client_id: "m3", category: "misc", content: "Totally unrelated text about orchids", source: "manual", updated_at: new Date().toISOString() },
];

check("matching: memories scored by relevance, no blind dump", () => {
  const hits = matchMemories("pricing for my web design business?", memories);
  assert.equal(hits[0]?.client_id, "m1");
  assert.ok(!hits.some((m) => m.client_id === "m3"));
});

check("matching: buildPreamble returns all three blocks", () => {
  const examples: ExampleRow[] = [
    { client_id: "e1", input: "write a sales email", output: "Short punchy email.", tags: [], updated_at: new Date().toISOString() },
  ];
  const p = buildPreamble("what is your pricing for my web design business?", skills, memories, examples);
  assert.equal(p.skills.length, 2);
  assert.ok(p.memories.length >= 1);
  assert.equal(p.examples.length, 1);
});

// ---------------------------------------------------------------------------
// 4. System prompt
// ---------------------------------------------------------------------------
check("system-prompt: persona + language mode + anti-cliche rules + preamble", () => {
  const p = buildPreamble("what is your pricing for my web design business?", skills, memories, []);
  const prompt = buildSystemPrompt({ languageMode: "english", preamble: p });
  assert.ok(prompt.includes("Zonaed's personal AI assistant"));
  assert.ok(prompt.includes("Reply in clear English"));
  assert.ok(prompt.includes(BANNED_WORDS.join(", ")));
  assert.ok(prompt.includes("Skill: Pricing"));
  assert.ok(prompt.includes("Zonaed sells web design packages"));
});

check("system-prompt: banglish mode + chain-of-draft instructions", () => {
  const prompt = buildSystemPrompt({ languageMode: "banglish", outlineOnly: true });
  assert.ok(prompt.includes("Banglish"));
  assert.ok(prompt.includes("CHAIN-OF-DRAFT MODE"));
});

// ---------------------------------------------------------------------------
// 5. Provider layer (stub fetch)
// ---------------------------------------------------------------------------
check("providers: availableProviders filters placeholders", () => {
  const providers = availableProviders({
    GROQ_API_KEY: "placeholder",
    GEMINI_API_KEY: "real-key",
    DEEPSEEK_API_KEY: undefined,
    OPENROUTER_API_KEY: "real-key-2",
  });
  assert.deepEqual(providers.map((p) => p.id), ["gemini", "openrouter"]);
});

check("providers: shouldFailover only for 429/503/network", () => {
  assert.equal(shouldFailover(new ProviderError("rate", 429, "groq")), true);
  assert.equal(shouldFailover(new ProviderError("down", 503, "groq")), true);
  assert.equal(shouldFailover(new ProviderError("bad", 400, "groq")), false);
  assert.equal(shouldFailover(new TypeError("fetch failed")), true);
});

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

async function runStreamProtocols() {
  // OpenAI-compatible protocol (Groq)
  let captured = "";
  const openaiChunks = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const fetchOpenai: typeof fetch = async (_url, init) => {
    captured = String(init!.body);
    return sseResponse(openaiChunks);
  };
  let text = "";
  for await (const d of streamFromProvider(PROVIDERS.groq, "k", [{ role: "user", content: "hi" }], fetchOpenai)) {
    text += d;
  }
  assert.equal(text, "Hello");
  const body = JSON.parse(captured) as { model: string; stream: boolean };
  assert.equal(body.model, PROVIDERS.groq.model);
  assert.equal(body.stream, true);

  // Gemini protocol
  const geminiChunks = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Namaskar"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":" bolo"}]}}]}\n\n',
  ];
  let geminiUrl = "";
  const fetchGemini: typeof fetch = async (url) => {
    geminiUrl = String(url);
    return sseResponse(geminiChunks);
  };
  text = "";
  for await (const d of streamFromProvider(PROVIDERS.gemini, "k", [{ role: "user", content: "hi" }], fetchGemini)) {
    text += d;
  }
  assert.equal(text, "Namaskar bolo");
  assert.ok(geminiUrl.includes("streamGenerateContent?alt=sse"));
}

check("providers: SSE parsing for OpenAI-compatible and Gemini protocols", runStreamProtocols);

async function runFailover() {
  const calls: string[] = [];
  const fetchFailover: typeof fetch = async (_url, init) => {
    const auth = (init!.headers as Record<string, string>).Authorization ?? "";
    calls.push(auth);
    if (auth.includes("groq-key")) return new Response('{"error":"rate limited"}', { status: 429 });
    return sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]);
  };
  const providers = [PROVIDERS.groq, PROVIDERS.deepseek];
  const savedKeys = [process.env.GROQ_API_KEY, process.env.DEEPSEEK_API_KEY];
  process.env.GROQ_API_KEY = "groq-key";
  process.env.DEEPSEEK_API_KEY = "deepseek-key";
  try {
    const { stream, provider } = await streamWithFailover(providers, [{ role: "user", content: "hi" }], fetchFailover);
    assert.equal(provider.id, "deepseek");
    let text = "";
    for await (const d of stream) text += d;
    assert.equal(text, "ok");
    assert.equal(calls.length, 2, "both providers attempted exactly once");
  } finally {
    process.env.GROQ_API_KEY = savedKeys[0];
    process.env.DEEPSEEK_API_KEY = savedKeys[1];
  }
}

check("providers: 429 on first provider fails over to second, before any delta", runFailover);

async function runAllExhausted() {
  const fetchAlways429: typeof fetch = async () => new Response("{}", { status: 429 });
  const saved = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "k";
  try {
    await assert.rejects(
      () => streamWithFailover([PROVIDERS.groq], [{ role: "user", content: "hi" }], fetchAlways429),
      /All providers failed/,
    );
  } finally {
    process.env.GROQ_API_KEY = saved;
  }
}

check("providers: all providers exhausted → aggregated error", runAllExhausted);

// Keep the process alive until async checks settle.
setInterval(() => {}, 1000);


