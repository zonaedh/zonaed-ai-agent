// ============================================================================
// Skill/Knowledge upload system verification (plan §5.3, §7)
//
// Runs the real upload pipeline (lib/skills/*) against fake-indexeddb and
// checks: sanitization rules, size cap, title derivation, §5.3 versioning
// (re-upload = new version, old body archived, never destroyed), pause/edit,
// and end-to-end injection through the §5.1 preamble builder.
// ============================================================================
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { sanitizeMarkdown, stripHtml, titleFromFilename, MAX_UPLOAD_BYTES } from "../lib/skills/sanitize";
import { editSkill, setSkillActive, uploadSkillFile } from "../lib/skills/upload";
import { buildPreamble, matchSkills } from "../lib/ai/matching";
import type { MemoryRow, SkillRow } from "../lib/db/types";
import { getDb } from "../lib/db/client";

let passed = 0;
const TOTAL = 12;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok ${passed} - ${name}`);
    });
}

async function main() {
  console.log("verify:skills — §5.3 upload system");

  // --- sanitize.ts ---------------------------------------------------------
  await check("sanitize: strips <script> with inner content", () => {
    const out = stripHtml("before<script>alert(1)</script>after");
    assert.equal(out, "beforeafter");
  });

  await check("sanitize: strips tags but keeps text, kills on* handlers", () => {
    const out = stripHtml("Hi <b onclick=\"evil()\">there</b>");
    assert.ok(out.includes("Hi"));
    assert.ok(out.includes("there"));
    assert.ok(!out.includes("onclick"));
    assert.ok(!out.includes("<b"));
  });

  await check("sanitize: kills javascript: URLs", () => {
    const out = stripHtml("[click](javascript:alert(1)) and <a href=\"javascript:x\">y</a>");
    assert.ok(!out.includes("javascript:"));
  });

  await check("sanitize: removes invisible/bidi characters", () => {
    const out = sanitizeMarkdown("normal\u200Btext\u202Ereversed");
    assert.ok(out.ok);
    assert.equal(out.content, "normaltextreversed");
  });

  await check("sanitize: enforces size cap", () => {
    const big = "x".repeat(MAX_UPLOAD_BYTES + 1);
    const out = sanitizeMarkdown(big);
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /limit/);
  });

  await check("sanitize: rejects empty file", () => {
    assert.equal(sanitizeMarkdown("").ok, false);
  });

  await check("sanitize: title derived from filename", () => {
    assert.equal(titleFromFilename("my-client-sop.md"), "My client sop");
    assert.equal(titleFromFilename("pricing.md"), "Pricing");
  });

  // --- upload.ts (real Dexie) ---------------------------------------------
  await check("upload: first upload stores v1 with trigger keywords", async () => {
    const outcome = await uploadSkillFile(
      { name: "pricing.md", text: "# Pricing\n\nBasic site 15k BDT. Landing 8k BDT." },
      { triggerKeywords: ["pricing", "cost"] },
    );
    assert.ok(outcome.ok);
    assert.equal(outcome.skill?.version, 1);
    assert.equal(outcome.skill?.title, "Pricing");
    assert.deepEqual(outcome.skill?.trigger_keywords, ["pricing", "cost"]);
    assert.equal(outcome.skill?.source, "upload");
  });

  await check("upload: re-upload same title = v2, old body archived (§5.3)", async () => {
    const before = (await getDb().skills.toArray()).find((s) => s.title === "Pricing");
    const outcome = await uploadSkillFile({ name: "pricing.md", text: "# Pricing\n\nUpdated: Basic 18k BDT." });
    assert.ok(outcome.ok);
    assert.equal(outcome.skill?.client_id, before?.client_id); // same remote row
    assert.equal(outcome.skill?.version, 2);
    assert.equal(outcome.replacedVersion, 1);
    const archived = await getDb().conflict_archive.where("client_id").equals(before!.client_id).toArray();
    assert.equal(archived.length, 1);
    assert.equal((archived[0].losing as unknown as SkillRow).content, before!.content); // old body never destroyed
    assert.ok(outcome.skill?.content.includes("18k"));
    assert.ok(!outcome.skill?.content.includes("15k"));
  });

  await check("upload: paused state survives re-upload; explicit edit does not bump version", async () => {
    const row = (await getDb().skills.toArray()).find((s) => s.title === "Pricing")!;
    await setSkillActive(row.client_id, false);
    const again = await uploadSkillFile({ name: "pricing.md", text: "# Pricing\n\nv3 body." });
    assert.equal(again.skill?.active, false);
    assert.equal(again.skill?.version, 3);
    await editSkill(row.client_id, { content: "# Pricing\n\nEdited body." });
    const afterEdit = (await getDb().skills.get(row.client_id))!;
    assert.equal(afterEdit.version, 3); // explicit edit ≠ re-upload
    assert.equal(afterEdit.dirty, 1); // flagged for push
  });

  await check("injection: paused skill never matches; trigger fires on keyword only", async () => {
    const rows = (await getDb().skills.toArray()) as SkillRow[];
    const pricing = rows.find((s) => s.title === "Pricing")!;
    // Still paused from the previous check.
    assert.ok(!matchSkills("what is your pricing?", rows).some((s) => s.client_id === pricing.client_id));
    await setSkillActive(pricing.client_id, true);
    const rows2 = (await getDb().skills.toArray()) as SkillRow[];
    assert.ok(matchSkills("what is your pricing?", rows2).some((s) => s.client_id === pricing.client_id));
    assert.ok(!matchSkills("tell me a joke", rows2).some((s) => s.client_id === pricing.client_id));
  });

  await check("injection: always-on skill injects for ANY message, end-to-end preamble", async () => {
    await uploadSkillFile({ name: "voice.md", text: "Write short. No em-dashes. Plain words." });
    const rows = (await getDb().skills.toArray()) as SkillRow[];
    const voice = rows.find((s) => s.title === "Voice")!;
    assert.ok(matchSkills("tell me a joke", rows).some((s) => s.client_id === voice.client_id));
    const memories: MemoryRow[] = [];
    const p = buildPreamble("what is your pricing for web design?", rows, memories, []);
    const titles = p.skills.map((s) => s.title);
    assert.ok(titles.includes("Voice")); // always-on
    assert.ok(titles.includes("Pricing")); // keyword hit
    const pricingBlock = p.skills.find((s) => s.title === "Pricing")!;
    assert.ok(pricingBlock.content.includes("Edited body."));
  });

  console.log(`\n${passed}/${TOTAL} passed`);
  if (passed !== TOTAL) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
