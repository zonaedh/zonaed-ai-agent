// ============================================================================
// Auto-learn (§5.1) verification — trigger matrix, extraction, categories,
// no-false-positives. Run: npm run verify:autolearn
// ============================================================================
import assert from "node:assert/strict";
import { classifyCategory, detectMemoryCapture } from "../lib/ai/auto-learn";

let passed = 0;
const TOTAL = 15;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${passed} - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n`, err);
    process.exitCode = 1;
  }
}

check("english trigger: remember that", () => {
  const c = detectMemoryCapture("Remember that my business name is Shark Web");
  assert.ok(c);
  assert.equal(c.content, "my business name is Shark Web");
  assert.equal(c.category, "business");
});

check("english trigger: note that + punctuation", () => {
  const c = detectMemoryCapture("Note that: I prefer short replies");
  assert.ok(c);
  assert.equal(c.content, "I prefer short replies");
  assert.equal(c.category, "preference");
});

check("banglish trigger: amar business holo", () => {
  const c = detectMemoryCapture("Amar business holo web agency");
  assert.ok(c);
  assert.equal(c.content, "web agency");
  assert.equal(c.category, "business");
});

check("banglish trigger: mon e rakho", () => {
  const c = detectMemoryCapture("Mon e rakho je client er deadline July 4");
  assert.ok(c);
  assert.ok(c.content.includes("deadline"));
  // Business bucket precedes project; content mentions "client".
  assert.equal(c.category, "business");
});

check("banglish trigger: project without business words", () => {
  const c = detectMemoryCapture("Mon e rakho deadline July 4 for the launch");
  assert.ok(c);
  assert.equal(c.category, "project");
});

check("bengali trigger: মনে রাখো", () => {
  const c = detectMemoryCapture("মনে রাখো আমার ব্যবসা ওয়েব এজেন্সি");
  assert.ok(c);
  assert.ok(c.content.includes("ওয়েব এজেন্সি"));
  assert.equal(c.category, "business");
});

check("bengali preference", () => {
  const c = detectMemoryCapture("মনে রাখো আমি সবসময় ছোট উত্তর পছন্দ করি");
  assert.ok(c);
  assert.equal(c.category, "preference");
});

check("correction category", () => {
  const c = detectMemoryCapture("Remember that from now on invoices use 15% VAT");
  assert.ok(c);
  assert.equal(c.category, "correction");
});

check("general fallback category", () => {
  const c = detectMemoryCapture("Remember that the office reopens Sunday");
  assert.ok(c);
  assert.equal(c.category, "general");
});

check("trigger mid-sentence still captures", () => {
  const c = detectMemoryCapture("hey just remember that we ship on Fridays");
  assert.ok(c);
  assert.equal(c.content, "we ship on Fridays");
});

check("no trigger → null (no false positive)", () => {
  assert.equal(detectMemoryCapture("what is my business name?"), null);
  assert.equal(detectMemoryCapture("hello there"), null);
  assert.equal(detectMemoryCapture("remember?"), null);
});

check("trigger with no fact → null", () => {
  assert.equal(detectMemoryCapture("remember that"), null);
  assert.equal(detectMemoryCapture("মনে রাখো"), null);
});

check("whitespace collapsed + long content clamped", () => {
  const long = "x".repeat(500);
  const c = detectMemoryCapture(`remember that\n\n   ${long}`);
  assert.ok(c);
  assert.ok(c.content.length <= 401); // 400 + ellipsis
  assert.ok(c.content.endsWith("…"));
});

check("long content exactly at clamp", () => {
  const c = detectMemoryCapture(`remember that ${"y".repeat(390)}`);
  assert.ok(c);
  assert.ok(!c.content.endsWith("…"));
});

check("classifyCategory exported helper", () => {
  assert.equal(classifyCategory("my pricing sheet"), "business");
  assert.equal(classifyCategory("random note"), "general");
});

if (passed !== TOTAL || process.exitCode === 1) {
  console.error(`\n${passed}/${TOTAL} auto-learn checks passed`);
  process.exit(1);
}
console.log(`\n${passed}/${TOTAL} auto-learn checks passed`);
