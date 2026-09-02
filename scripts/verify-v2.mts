// v2 gap-fill verification — knowledge (W2), digest (W3), TSV (W4).
// Run: npm run verify:v2
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { deleteKnowledgeDoc, editKnowledgeDoc, importKnowledgeFile, saveKnowledgeDoc } from "../lib/knowledge/repo";
import { buildDigest, digestToMarkdown, type DigestTask } from "../lib/digest/summary";
import { hasMarkdownTable, markdownTableToTsv } from "../lib/export/tsv";

let passed = 0;
const TOTAL = 11;
let chain: Promise<void> = Promise.resolve();
function check(name: string, fn: () => void | Promise<void>): void {
  chain = chain.then(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok ${passed} - ${name}`);
    } catch (err: unknown) {
      console.error(`  FAIL - ${name}:`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });
}
const DAY = 86_400_000;
const NOW = new Date("2026-07-08T10:00:00Z");
const task = (p: Partial<DigestTask>): DigestTask => ({ title: "task", ...p });

check("knowledge: manual save sanitizes + tags normalize", async () => {
  const out = await saveKnowledgeDoc({ title: "Pricing policy", content: "Rate **$50/hr**.\n\n<script>alert(1)</script>", tags: ["Pricing", "pricing ", "client"] });
  assert.ok(out.ok && out.doc);
  assert.ok(!out.doc.content.includes("<script>"));
  assert.ok(out.doc.content.includes("$50/hr"));
  assert.deepEqual(out.doc.tags, ["pricing", "client"]);
  assert.equal(out.doc.source, "manual");
  assert.equal(out.doc.dirty, 1);
});

check("knowledge: .md import derives title from filename", async () => {
  const out = await importKnowledgeFile({ name: "client-brief-acme.md", text: "# Acme brief\nScope: redesign" });
  assert.ok(out.ok && out.doc);
  assert.ok(out.doc.title.toLowerCase().includes("acme"));
  assert.equal(out.doc.source, "md-import");
});

check("knowledge: rejects empty + short titles", async () => {
  assert.equal((await saveKnowledgeDoc({ title: "  ", content: "x" })).ok, false);
  assert.equal((await saveKnowledgeDoc({ title: "ok", content: "   " })).ok, false);
  assert.equal((await saveKnowledgeDoc({ title: "a", content: "x" })).ok, false);
});

check("knowledge: edit + tombstone delete", async () => {
  const created = await saveKnowledgeDoc({ title: "Spec doc", content: "v1 content", tags: ["spec"] });
  assert.ok(created.ok && created.doc);
  const edited = await editKnowledgeDoc(created.doc.client_id, { title: "Spec doc v2", content: "v2 content", tags: ["spec", "v2"] });
  assert.ok(edited.ok && edited.doc);
  assert.equal(edited.doc.title, "Spec doc v2");
  assert.deepEqual(edited.doc.tags, ["spec", "v2"]);
  await deleteKnowledgeDoc(created.doc.client_id);
  const { getDb } = await import("../lib/db/client");
  const row = await getDb().knowledge.get(created.doc.client_id);
  assert.ok(row?.deleted_at, "delete must tombstone, never hard-delete");
});

check("digest: buckets + totals", () => {
  const s = buildDigest({
    now: NOW,
    tasks: [
      task({ title: "old", due_at: new Date(NOW.getTime() - 2 * DAY).toISOString() }),
      task({ title: "today", due_at: new Date(NOW.getTime() + 5 * 3_600_000).toISOString() }),
      task({ title: "week", due_at: new Date(NOW.getTime() + 5 * DAY).toISOString() }),
      task({ title: "later", due_at: new Date(NOW.getTime() + 30 * DAY).toISOString() }),
      task({ title: "nodue" }),
    ],
    counts: { memory: 3, knowledge: 2, skills: 5 },
  });
  assert.deepEqual(s.overdue.map((t) => t.title), ["old"]);
  assert.deepEqual(s.dueToday.map((t) => t.title), ["today"]);
  assert.deepEqual(s.dueThisWeek.map((t) => t.title), ["week"]);
  assert.equal(s.later, 2);
  assert.equal(s.openTotal, 5);
});

check("digest: completed this week + tombstones ignored", () => {
  const s = buildDigest({
    now: NOW,
    tasks: [
      task({ title: "done", completed_at: new Date(NOW.getTime() - DAY).toISOString() }),
      task({ title: "deleted", due_at: new Date(NOW.getTime() - DAY).toISOString(), deleted_at: new Date(NOW.getTime() - DAY).toISOString() }),
    ],
    counts: { memory: 0, knowledge: 0, skills: 0 },
  });
  assert.equal(s.completedThisWeek, 1);
  assert.equal(s.openTotal, 0);
  assert.match(s.headline, /Nothing open/);
});

check("digest: headline counts", () => {
  const s = buildDigest({
    now: NOW,
    tasks: [task({ due_at: new Date(NOW.getTime() - DAY).toISOString() }), task({ due_at: new Date(NOW.getTime() + 3_600_000).toISOString() })],
    counts: { memory: 1, knowledge: 1, skills: 1 },
  });
  assert.match(s.headline, /2 open tasks/);
  assert.match(s.headline, /1 overdue/);
  assert.match(s.headline, /1 due today/);
});

check("digest: markdown render", () => {
  const s = buildDigest({
    now: NOW,
    tasks: [task({ title: "Ship it", due_at: new Date(NOW.getTime() - DAY).toISOString() })],
    counts: { memory: 2, knowledge: 1, skills: 4 },
  });
  const md = digestToMarkdown(s);
  assert.ok(md.includes("## Overdue"));
  assert.ok(md.includes("- Ship it"));
  assert.ok(md.includes("Memory entries: 2"));
});

check("tsv: converts a Markdown table", () => {
  const { tsv, tables } = markdownTableToTsv("| Name | Rate |\n|---|---|\n| Acme | $50 |\n| Globex \\| 2 | $75 |");
  assert.equal(tables, 1);
  assert.equal(tsv, "Name\tRate\nAcme\t$50\nGlobex | 2\t$75");
});

check("tsv: multiple tables separated by blank line", () => {
  const { tsv, tables } = markdownTableToTsv("| A |\n|---|\n| 1 |\n\ntext\n\n| B |\n|---|\n| 2 |");
  assert.equal(tables, 2);
  assert.equal(tsv, "A\n1\n\nB\n2");
});

check("tsv: no table → empty", () => {
  assert.equal(hasMarkdownTable("just text, no pipes here"), false);
  const no = markdownTableToTsv("plain text");
  assert.equal(no.tables, 0);
  assert.equal(no.tsv, "");
  assert.equal(hasMarkdownTable("| A |\n|---|\n| 1 |"), true);
});

await chain;
console.log(`\n${passed}/${TOTAL} v2 checks passed`);
if (passed !== TOTAL) process.exit(1);

