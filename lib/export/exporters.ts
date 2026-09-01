// ============================================================================
// Data export / backup (plan §4 /export module + §9 priority 7)
//
// Local-first: everything the user can see is on the device, so export is a
// pure snapshot of the Dexie stores — no Supabase round-trip. The builder is
// environment-agnostic (callers supply the rows) so it tests cleanly in Node
// and runs in the browser.
//
// JSON export is schema-versioned and round-trippable (import later restores
// exactly these rows). Markdown export is human/LLM-readable per type and can
// be re-uploaded as a skill/knowledge file on another device.
//
// Fields are stripped of local-only bookkeeping (dirty) but sync identifiers
// (client_id, timestamps, deleted_at tombstones) are kept so a future import
// can re-merge without losing conflict-resolution context.
// ============================================================================

export const EXPORT_SCHEMA_VERSION = 1;

export interface ExportBundle {
  app: "zonaed-ai-agent";
  schemaVersion: 1;
  exportedAt: string;
  data: {
    tasks: Array<Record<string, unknown>>;
    memory: Array<Record<string, unknown>>;
    knowledge: Array<Record<string, unknown>>;
    chat_history: Array<Record<string, unknown>>;
    skills: Array<Record<string, unknown>>;
    examples: Array<Record<string, unknown>>;
  };
  counts: Record<string, number>;
}

/** Strip local-only fields (dirty) but keep timestamps/client_id/deleted_at. */
function stripRow<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const rest = { ...row };
  delete rest.dirty; // local-only sync bookkeeping
  return rest;
}

export type SyncableStoreKey =
  | "tasks"
  | "memory"
  | "knowledge"
  | "chat_history"
  | "skills"
  | "examples";

export function buildJsonExport(sources: Record<SyncableStoreKey, Array<Record<string, unknown>>>): ExportBundle {
  const data = {} as ExportBundle["data"];
  const counts = {} as Record<string, number>;
  for (const key of Object.keys(sources) as SyncableStoreKey[]) {
    const rows = sources[key].map(stripRow);
    data[key] = rows;
    counts[key] = rows.length;
  }
  return {
    app: "zonaed-ai-agent",
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data,
    counts,
  };
}

/** Markdown-safe rendering of a row's fields (escapes pipes + newlines). */
export function markdownRow(row: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) continue;
    let val = typeof v === "string" ? v : JSON.stringify(v);
    val = val.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
    lines.push(`- **${k}**: ${val}`);
  }
  return lines.join("\n");
}

/** Markdown export: one section per store, one subsection per row. */
export function buildMarkdownExport(
  sources: Record<SyncableStoreKey, Array<Record<string, unknown>>>,
  opts: { includeDeleted?: boolean; type?: "full" | "skills" | "knowledge" } = {},
): string {
  const { includeDeleted = true, type = "full" } = opts;
  const CONFIG: Record<SyncableStoreKey, { label: string; show: (r: Record<string, unknown>) => boolean }> = {
    tasks: { label: "Tasks", show: () => true },
    memory: { label: "Memory", show: () => true },
    knowledge: { label: "Knowledge", show: () => true },
    chat_history: { label: "Chat History", show: () => true },
    skills: { label: "Skills", show: () => true },
    examples: { label: "Examples", show: () => true },
  };
  const sections: string[] = [];

  for (const key of Object.keys(CONFIG) as SyncableStoreKey[]) {
    if (type === "skills" && key !== "skills") continue;
    if (type === "knowledge" && key !== "knowledge") continue;
    const rows = sources[key].filter((r) => {
      if (!includeDeleted && r.deleted_at) return false;
      return CONFIG[key].show(r);
    });
    if (rows.length === 0) continue;

    const body = rows
      .map((r, i) => `### ${i + 1}. ${r.title ?? r.category ?? key}\n\n${markdownRow(r)}`)
      .join("\n\n");

    sections.push(`## ${CONFIG[key].label}\n\n${body}`);
  }

  const header = [
    `# Zonaed AI — ${type === "full" ? "Full Data" : type === "skills" ? "Skills" : "Knowledge"} Export`,
    "",
    `Exported: ${new Date().toISOString()}`,
    "",
  ].join("\n");
  return `${header}${sections.join("\n\n")}\n`;
}

/** Build a browser Blob and trigger a download (atomic via object URL). */
export function downloadJson(bundle: ExportBundle): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  triggerDownload(blob, `zonaed-backup-${new Date().toISOString().slice(0, 10)}.json`);
}

export function downloadMarkdown(text: string, type: "full" | "skills" | "knowledge" = "full"): void {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  triggerDownload(blob, `zonaed-${type}-${new Date().toISOString().slice(0, 10)}.md`);
}

/** Shared DOM download helper (excluded from Node tests; guarded). */
function triggerDownload(blob: Blob, filename: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}