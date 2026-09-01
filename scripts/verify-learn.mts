// ============================================================================
// verify-learn.mts — Priority 11 checks (plan §9 item 11, §5.4, §8 #9)
//
// Offline suite: exercises the exact pure logic the /api/learn/cron job runs
// (day-window selection, transcript capping, prompt building, output parsing,
// dedupe), validates the API route contracts, the migration SQL, and the
// settings/hub wiring. Run with: npm run verify:learn
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = process.cwd();

let passed = 0;
const TOTAL = 27;
function check(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok ${passed} - ${name}`);
    } catch (err: unknown) {
      console.error(`FAIL - ${name}:`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  })();
}

// ---------------------------------------------------------------- imports --

const extract = await import("../lib/learn/extract");
const providers = await import("../lib/ai/providers");

// ------------------------------------------------------------------- run --

console.log("\nChat-history learning (Priority 11)\n");

// ------------------------------------------------------ day-window logic --

await check("utcDayKey: UTC date for a timestamp", () => {
  assert.equal(extract.utcDayKey(Date.parse("2026-01-05T23:30:00Z")), "2026-01-05");
  assert.equal(extract.utcDayKey(Date.parse("2026-01-06T00:00:00Z")), "2026-01-06");
});

await check("pendingDays: with no watermark, proposes yesterday only… bounded", () => {
  const days = extract.pendingDays(null, Date.parse("2026-01-06T12:00:00Z"), 3);
  assert.deepEqual(days, ["2026-01-03", "2026-01-04", "2026-01-05"]); // oldest first
});

await check("pendingDays: respects the watermark (already-processed days skipped)", () => {
  const days = extract.pendingDays("2026-01-04", Date.parse("2026-01-06T12:00:00Z"), 3);
  assert.deepEqual(days, ["2026-01-05"]);
});

await check("pendingDays: fully caught-up → empty (no LLM calls)", () => {
  const days = extract.pendingDays("2026-01-05", Date.parse("2026-01-06T12:00:00Z"), 3);
  assert.deepEqual(days, []);
});

await check("utcDayBounds: half-open UTC window for range queries", () => {
  const b = extract.utcDayBounds("2026-01-05");
  assert.equal(b.start, "2026-01-05T00:00:00.000Z");
  assert.equal(b.end, "2026-01-06T00:00:00.000Z");
  assert.throws(() => extract.utcDayBounds("not-a-day"));
});

// ------------------------------------------------------- prompt building --

await check("capMessages: sorts chronologically and caps the newest messages", () => {
  const msgs = [
    { role: "user", content: "a".repeat(600), created_at: "2026-01-05T10:00:00Z" },
    { role: "assistant", content: "b".repeat(600), created_at: "2026-01-05T09:00:00Z" },
    { role: "user", content: "c".repeat(600), created_at: "2026-01-05T11:00:00Z" },
  ];
  const capped = extract.capMessages(msgs);
  assert.equal(capped.length, 3); // 1800 chars total — under the 30k cap, all kept
  assert.equal(capped[0].content[0], "b"); // chronological: 09:00 first
  assert.equal(capped[1].content[0], "a"); // 10:00
  assert.equal(capped[2].content[0], "c"); // 11:00 last
});

await check("buildExtractionMessages: system rule + transcript in user role", () => {
  const messages = extract.buildExtractionMessages([
    { role: "user", content: "Remember that my business is web design", created_at: "2026-01-05T10:00:00Z" },
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.ok(messages[0].content.includes("durable"));
  assert.ok(messages[0].content.includes("JSON"));
  assert.equal(messages[1].role, "user");
  assert.ok(messages[1].content.includes("[user] Remember that my business is web design"));
});

await check("buildExtractionMessages: empty day still yields a valid call", () => {
  const messages = extract.buildExtractionMessages([]);
  assert.ok(messages[1].content.includes("no chat activity"));
});

// ------------------------------------------------------- output parsing --

await check("parseSuggestions: plain JSON array parsed and typed", () => {
  const out = extract.parseSuggestions(
    '[{"target":"memory","title":"Business","content":"My business is web design","category":"business","excerpt":"my business is web design"}]',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].target, "memory");
  assert.equal(out[0].category, "business");
});

await check("parseSuggestions: tolerates code fences and prose around the array", () => {
  const out = extract.parseSuggestions(
    'Sure! Here are my findings:\n```json\n[{"target":"skill","content":"Prefer Bengali replies"}]\n```',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].target, "skill");
  assert.equal(out[0].category, "general"); // unknown category falls back
});

await check("parseSuggestions: drops malformed entries without losing the rest", () => {
  const out = extract.parseSuggestions(
    '[{"target":"nope","content":"bad target"},{"content":"missing target"},{"target":"memory","content":"   "},{"target":"memory","content":"Valid durable fact"},{"broken": ]',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].content, "Valid durable fact");
});

await check("parseSuggestions: no array → no candidates (never throws)", () => {
  assert.deepEqual(extract.parseSuggestions("I could not find anything worth remembering."), []);
  assert.deepEqual(extract.parseSuggestions('{"broken": true}'), []);
});

await check("parseSuggestions: caps count, cleans whitespace, clamps length", () => {
  const eight = Array.from({ length: 12 }, (_, i) => ({
    target: "memory",
    content: `fact number ${i}`,
  }));
  assert.equal(extract.parseSuggestions(JSON.stringify(eight)).length, 8);
  const dirty = extract.parseSuggestions(
    JSON.stringify([{ target: "memory", content: "  multi   space\nfact  " + "x".repeat(3000) }]),
  );
  assert.equal(dirty.length, 1);
  assert.ok(dirty[0].content.startsWith("multi space fact"));
  assert.ok(dirty[0].content.length <= 2000);
});

await check("parseSuggestions: dedupes repeated content within one response", () => {
  const out = extract.parseSuggestions(
    JSON.stringify([
      { target: "memory", content: "I run a web design studio" },
      { target: "memory", content: "I run a Web-Design  studio!" },
    ]),
  );
  assert.equal(out.length, 1);
});

// --------------------------------------------------------------- dedupe --

await check("dedupeCandidates: drops overlap with existing memory (both directions)", () => {
  const candidates = [
    { target: "memory" as const, title: "t", content: "My business is web design", category: "business", excerpt: "" },
    { target: "memory" as const, title: "t2", content: "I prefer minimal UI layouts", category: "preference", excerpt: "" },
  ];
  const kept = extract.dedupeCandidates(candidates, ["my business is WEB design!"]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].content, "I prefer minimal UI layouts");
});

await check("dedupeCandidates: existing text contained inside candidate also dupes", () => {
  const kept = extract.dedupeCandidates(
    [{ target: "skill" as const, title: "t", content: "always answer in bengali first then english", category: "general", excerpt: "" }],
    ["answer in bengali"],
  );
  assert.equal(kept.length, 0);
});

// ------------------------------------------- non-streaming provider path --

await check("completeWithFailover: first provider success returns buffered text", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "extracted facts" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const saved = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "test-key";
  try {
    const result = await providers.completeWithFailover(
      [providers.PROVIDERS.groq, providers.PROVIDERS.deepseek],
      [{ role: "user", content: "day transcript" }],
      fakeFetch,
    );
    assert.equal(result.text, "extracted facts");
    assert.equal(result.provider.id, "groq");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("/chat/completions"));
  } finally {
    if (saved === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = saved;
  }
});

await check("completeWithFailover: 429 fails over to the next provider", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "fallback" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const savedGroq = process.env.GROQ_API_KEY;
  const savedDeep = process.env.DEEPSEEK_API_KEY;
  process.env.GROQ_API_KEY = "test-key";
  process.env.DEEPSEEK_API_KEY = "test-key";
  try {
    const result = await providers.completeWithFailover(
      [providers.PROVIDERS.groq, providers.PROVIDERS.deepseek],
      [{ role: "user", content: "x" }],
      fakeFetch,
    );
    assert.equal(result.text, "fallback");
    assert.equal(result.provider.id, "deepseek");
    assert.equal(calls.length, 2);
  } finally {
    if (savedGroq === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedGroq;
    if (savedDeep === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedDeep;
  }
});

// --------------------------------------------------------- route wiring --

await check("/api/learn/cron: exists, CRON-gated, per-run caps", () => {
  const src = readFileSync(join(ROOT, "app/api/learn/cron/route.ts"), "utf8");
  assert.ok(src.includes("CRON_SECRET"));
  assert.ok(src.includes("401"));
  assert.ok(src.includes("force-dynamic"));
  assert.ok(src.includes("completeWithFailover"));
  assert.ok(src.includes("pendingDays"));
  assert.ok(src.includes("dedupeCandidates"));
  assert.ok(src.includes("learn_suggestions"));
});

await check("/api/learn/preferences: GET/POST toggle, session-guarded", () => {
  const src = readFileSync(join(ROOT, "app/api/learn/preferences/route.ts"), "utf8");
  assert.ok(src.includes("export async function GET"));
  assert.ok(src.includes("export async function POST"));
  assert.ok(src.includes("requireSession"));
  assert.ok(src.includes("LEARN_SETTING_KEY"));
  assert.ok(src.includes('typeof body.enabled !== "boolean"'));
});

await check("/api/learn/suggestions: approve writes real rows, discard only marks", () => {
  const src = readFileSync(join(ROOT, "app/api/learn/suggestions/route.ts"), "utf8");
  assert.ok(src.includes("export async function GET"));
  assert.ok(src.includes("export async function POST"));
  assert.ok(src.includes("requireSession"));
  assert.ok(src.includes("checkRateLimit"));
  assert.ok(src.includes('from("memory")'));
  assert.ok(src.includes('from("skills")'));
  assert.ok(src.includes('"learn-review"'));
  assert.ok(src.includes('status: "approved"'));
  assert.ok(src.includes('status: "discarded"'));
});

await check("migration 0003: learn_suggestions with statuses, RLS, trigger", () => {
  const sql = readFileSync(join(ROOT, "supabase/migrations/0003_learn_suggestions.sql"), "utf8");
  assert.ok(sql.includes("create table public.learn_suggestions"));
  assert.ok(sql.includes("check (target in ('memory', 'skill'))"));
  assert.ok(sql.includes("check (status in ('pending', 'approved', 'discarded'))"));
  assert.ok(sql.includes("enable row level security"));
  assert.ok(sql.includes("set_updated_at"));
  assert.ok(!/delete from/i.test(sql), "no hard deletes (plan §3)");
});

await check("vercel.json: daily learn cron + minutely push cron", () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
    crons: { path: string; schedule: string }[];
  };
  const learn = cfg.crons.find((c) => c.path === "/api/learn/cron");
  const push = cfg.crons.find((c) => c.path === "/api/push/cron");
  assert.ok(learn, "learn cron registered");
  assert.equal(learn.schedule, "10 0 * * *");
  assert.ok(push, "push cron still registered");
});

await check("settings page: opt-in toggle present, /memory linked", () => {
  const src = readFileSync(join(ROOT, "app/settings/page.tsx"), "utf8");
  assert.ok(src.includes("Learn from my chat history"));
  assert.ok(src.includes("/api/learn/preferences"));
  assert.ok(src.includes('href="/memory"'));
});

await check("memory page: review queue with approve/edit/discard + live list", () => {
  const src = readFileSync(join(ROOT, "app/memory/page.tsx"), "utf8");
  assert.ok(src.includes("Learning review"));
  assert.ok(src.includes('"approve"'));
  assert.ok(src.includes('"discard"'));
  assert.ok(src.includes("useLiveQuery"));
  assert.ok(src.includes("listLive"));
  assert.ok(src.includes("softDeleteLocal"));
});

await check("hub links /memory", () => {
  const src = readFileSync(join(ROOT, "lib/navigation.ts"), "utf8");
  assert.ok(src.includes('href: "/memory"'));
});

await check("package.json: verify:learn script registered", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(pkg.scripts["verify:learn"], "tsx scripts/verify-learn.mts");
});

// ------------------------------------------------------------------ tally --

console.log(`\n${passed}/${TOTAL} checks passed\n`);
if (passed !== TOTAL) process.exitCode = 1;



