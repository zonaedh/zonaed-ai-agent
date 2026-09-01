// ============================================================================
// Export verification (plan §4 /export, §9 priority 7)
// Pure tests of lib/export/exporters.ts — no network, no Dexie needed.
// Run: npm run verify:export
// ============================================================================
import assert from "node:assert/strict";
import {
  buildJsonExport,
  buildMarkdownExport,
  EXPORT_SCHEMA_VERSION,
  markdownRow,
  type SyncableStoreKey,
} from "../lib/export/exporters";

let passed = 0;
const TOTAL = 12;

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

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: "row-1",
    title: "Sample",
    content: "body",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function sources(): Record<SyncableStoreKey, Array<Record<string, unknown>>> {
  return {
    tasks: [row({ title: "Task A", completed: true })],
    memory: [row({ category: "business", content: "sells web design" })],
    knowledge: [row({ title: "Doc", tags: ["seo"] })],
    chat_history: [row({ role: "user", content: "hello" })],
    skills: [row({ title: "SOP", trigger_keywords: ["client"] })],
    examples: [row({ input: "hi", output: "yo" })],
  };
}

// ---------------------------------------------------------------------------
// JSON export
// ---------------------------------------------------------------------------
check("JSON: bundle is schema-versioned with app marker + exportedAt", () => {
  const b = buildJsonExport(sources());
  assert.equal(b.app, "zonaed-ai-agent");
  assert.equal(b.schemaVersion, EXPORT_SCHEMA_VERSION);
  assert.ok(!Number.isNaN(Date.parse(b.exportedAt)));
});

check("JSON: all six stores present, counts match", () => {
  const b = buildJsonExport(sources());
  assert.deepEqual(
    {
      tasks: b.data.tasks.length,
      memory: b.data.memory.length,
      knowledge: b.data.knowledge.length,
      chat_history: b.data.chat_history.length,
      skills: b.data.skills.length,
      examples: b.data.examples.length,
    },
    { tasks: 1, memory: 1, knowledge: 1, chat_history: 1, skills: 1, examples: 1 },
  );
  assert.equal(b.counts.skills, 1);
});

check("JSON: strips local-only dirty flag but keeps client_id/deleted_at", () => {
  const withMeta = sources();
  withMeta.skills[0].dirty = 1 as never;
  withMeta.skills[0].deleted_at = "2026-09-02T00:00:00.000Z" as never;
  const b = buildJsonExport(withMeta);
  const skill = b.data.skills[0];
  assert.equal("dirty" in skill, false, "dirty must be stripped");
  assert.equal(skill.deleted_at, "2026-09-02T00:00:00.000Z", "deleted_at tombstone must be kept");
  assert.equal(skill.client_id, "row-1", "client_id kept");
});

check("JSON: round-trip restores exactly the same rows (parse of its stringify)", () => {
  const b = buildJsonExport(sources());
  const revived = JSON.parse(JSON.stringify(b)) as typeof b;
  assert.deepEqual(revived, b);
});

check("JSON: empty stores produce zero counts, not missing keys", () => {
  const empty = { tasks: [], memory: [], knowledge: [], chat_history: [], skills: [], examples: [] } as Record<SyncableStoreKey, Array<Record<string, unknown>>>;
  const b = buildJsonExport(empty);
  assert.equal(b.data.tasks.length, 0);
  assert.equal(b.counts.tasks, 0);
});

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------
check("MD: full export has header title and sections for every populated store", () => {
  const md = buildMarkdownExport(sources(), { type: "full" });
  assert.ok(md.startsWith("# Zonaed AI — Full Data Export"));
  for (const section of ["## Tasks", "## Memory", "## Knowledge", "## Chat History", "## Skills", "## Examples"]) {
    assert.ok(md.includes(section), `missing section ${section}`);
  }
});

check("MD: includeDeleted=false drops tombstoned rows", () => {
  const src = sources();
  src.tasks[0].deleted_at = "2026-09-02T00:00:00.000Z" as never;
  const md = buildMarkdownExport(src, { includeDeleted: false });
  assert.ok(!md.includes("Task A"), "deleted task must not appear");
});

check("MD: type=skills emits only the Skills section", () => {
  const md = buildMarkdownExport(sources(), { type: "skills" });
  assert.ok(md.includes("## Skills"));
  assert.ok(!md.includes("## Tasks"));
  assert.ok(!md.includes("## Knowledge"));
});

check("MD: type=knowledge emits only the Knowledge section", () => {
  const md = buildMarkdownExport(sources(), { type: "knowledge" });
  assert.ok(md.includes("## Knowledge"));
  assert.ok(!md.includes("## Skills"));
  assert.ok(!md.includes("## Chat History"));
});

check("MD: markdownRow escapes pipes and newlines in values", () => {
  const md = markdownRow({ title: "a|b", content: "line1\nline2", tags: ["x", "y"] });
  assert.ok(md.includes("a\\|b"), "pipe must be escaped");
  assert.ok(md.includes("line1 line2"), "newline must be flattened");
});

check("MD: empty result still has header (no bare sections)", () => {
  const md = buildMarkdownExport(
    { tasks: [], memory: [], knowledge: [], chat_history: [], skills: [], examples: [] },
    { type: "full" },
  );
  assert.ok(md.startsWith("# Zonaed AI — Full Data Export"));
  assert.ok(!md.includes("## Tasks"));
});

// ---------------------------------------------------------------------------
// Cross-check
// ---------------------------------------------------------------------------
check("export JSON contains all fields users care about (spot check)", () => {
  const b = buildJsonExport(sources());
  const skill = b.data.skills[0];
  assert.equal(skill.title, "SOP");
  assert.deepEqual(skill.trigger_keywords, ["client"]);
  const task = b.data.tasks[0];
  assert.equal(task.completed, true);
});

console.log(`\n${passed}/${TOTAL} export checks passed`);
if (passed !== TOTAL) process.exit(1);