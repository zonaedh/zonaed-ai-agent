// ============================================================================
// Search-engine verification (plan §4 /search, priority 6)
// Pure tests against the local FTS engine — no network, no Dexie needed.
// Run: npm run verify:search
// ============================================================================
import assert from "node:assert/strict";
import {
  highlight,
  makeSnippet,
  normalizeText,
  searchDocuments,
  tokenize,
  type SearchDocument,
} from "../lib/search/engine";

let passed = 0;
const TOTAL = 15;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${passed} - ${name}`);
  } catch (err: unknown) {
    console.error(`  FAIL - ${name}:`, err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

let seq = 0;
function doc(partial: Partial<SearchDocument>): SearchDocument {
  seq += 1;
  const now = new Date().toISOString();
  return {
    source: "memory",
    clientId: `c-${seq}`,
    title: "",
    body: "",
    tags: [],
    updatedAt: now,
    row: {},
    ...partial,
  };
}

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// 1. Tokenizer / normalizer
// ---------------------------------------------------------------------------
check("tokenize: splits, lowercases, strips punctuation/accents", () => {
  assert.deepEqual(tokenize("Hello, World!!"), ["hello", "world"]);
  assert.deepEqual(tokenize("Café au Lait"), ["cafe", "au", "lait"]);
});

check("tokenize: handles Bengali + Banglish, empty input -> []", () => {
  assert.deepEqual(tokenize("আমার ব্যবসা"), ["আমার", "ব্যবসা"]);
  assert.deepEqual(tokenize("amr business"), ["amr", "business"]);
  assert.deepEqual(tokenize("   "), []);
  assert.deepEqual(tokenize(""), []);
});

check("normalizeText: NFD accented input collates, whitespace collapsed", () => {
  assert.equal(normalizeText("Naïve"), "naive");
  assert.equal(normalizeText("  Multi  Space  "), "multi space");
});

// ---------------------------------------------------------------------------
// 2. Scoring / ranking
// ---------------------------------------------------------------------------
check("searchDocuments: empty query -> []", () => {
  assert.deepEqual(searchDocuments([doc({ source: "memory" })], ""), []);
  assert.deepEqual(searchDocuments([doc({ source: "memory" })], "   "), []);
});

check("searchDocuments: no match -> []", () => {
  const d = doc({ source: "knowledge", title: "Pricing", body: "web design packages" });
  assert.deepEqual(searchDocuments([d], "irrelevant"), []);
});

check("scoring: exact phrase outranks single-term matches", () => {
  const exact = doc({ source: "knowledge", title: "Pricing Guide", body: "custom web design packages for clients" });
  const partial = doc({ source: "knowledge", title: "Portfolio", body: "web design work, packages available on request" });
  const results = searchDocuments([exact, partial], "web design packages");
  assert.equal(results[0].doc.clientId, exact.clientId);
  assert.ok(results[0].score > results[1].score);
});

check("scoring: title match outranks body-only match", () => {
  const titleMatch = doc({ source: "skills", title: "Outreach Email Template", body: "hello" });
  const bodyMatch = doc({ source: "skills", title: "Something Else", body: "an outreach email template for cold outreach" });
  const results = searchDocuments([bodyMatch, titleMatch], "outreach");
  assert.equal(results[0].doc.clientId, titleMatch.clientId);
});

check("scoring: tags (trigger keywords) participate and outrank body-only", () => {
  const tagged = doc({ source: "skills", title: "SOP", body: "internal steps", tags: ["client", "pricing"] });
  const plain = doc({ source: "skills", title: "Notes", body: "about pricing" });
  const results = searchDocuments([plain, tagged], "pricing");
  assert.equal(results[0].doc.clientId, tagged.clientId);
  assert.ok(results[0].score > results[1].score);
});

check("scoring: multi-term query ranks all-terms-in-title above term-in-body", () => {
  const both = doc({ source: "memory", title: "Client Requests", body: "recurring" });
  const one = doc({ source: "memory", title: "Other", body: "client requests come in weekly" });
  const r = searchDocuments([one, both], "client requests");
  assert.equal(r[0].doc.clientId, both.clientId);
});

check("scoring: recency bonus breaks near ties", () => {
  const recent = doc({ source: "chat_history", title: "user", body: "need the report", updatedAt: iso(1) });
  const old = doc({ source: "chat_history", title: "user", body: "need the report", updatedAt: iso(90) });
  const r = searchDocuments([old, recent], "report");
  assert.equal(r[0].doc.clientId, recent.clientId);
});

// ---------------------------------------------------------------------------
// 3. Snippet + highlight
// ---------------------------------------------------------------------------
check("makeSnippet: window around first hit with ellipses on both sides", () => {
  const long = "A".repeat(60) + " target word here " + "B".repeat(300);
  const d = doc({ source: "knowledge", body: long });
  const segs = makeSnippet(d, ["target"], "target");
  const text = segs.map((s) => s.text).join("");
  assert.ok(text.startsWith("…"), "leading ellipsis expected");
  assert.ok(text.endsWith("…"), "trailing ellipsis expected");
  assert.ok(text.includes("target word here"));
  assert.ok(text.length < long.length);
  const hit = segs.find((s) => s.hit);
  assert.equal(hit?.text, "target");
});

check("makeSnippet: no ellipsis when hit near the start", () => {
  const d = doc({ source: "skills", title: "Short Title", body: "keyword at the very beginning here" });
  const text = makeSnippet(d, ["keyword"], "keyword").map((s) => s.text).join("");
  assert.ok(!text.startsWith("…"));
});

check("highlight: marks every occurrence, plain text untouched", () => {
  const segs = highlight("one two one three", ["one"]);
  assert.equal(segs.filter((s) => s.hit).length, 2);
  assert.equal(highlight("abc", ["nope"]).length, 1);
});

// ---------------------------------------------------------------------------
// 4. Limits / determinism
// ---------------------------------------------------------------------------
check("searchDocuments: limit is respected", () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    doc({ source: "memory", body: `shared term number ${i}`, updatedAt: iso(i) }),
  );
  const r = searchDocuments(many, "shared", { limit: 5 });
  assert.equal(r.length, 5);
});

check("searchDocuments: deterministic order — newer first on equal score", () => {
  const a = doc({ source: "memory", body: "same words here", updatedAt: iso(2) });
  const b = doc({ source: "memory", body: "same words here", updatedAt: iso(1) });
  const r = searchDocuments([a, b], "same words");
  assert.equal(r[0].doc.clientId, b.clientId);
});

console.log(`\n${passed}/${TOTAL} search checks passed`);
if (passed !== TOTAL) process.exit(1);