"use client";

// ============================================================================
// /export — data export / backup (plan §4 module, §9 priority 7)
//
// Snapshots the local Dexie stores and offers three downloads:
//   * JSON backup — schema-versioned, round-trippable for a future import
//   * Skills markdown — re-uploadable into /skills (§5.3)
//   * Knowledge markdown — re-importable into /knowledge
// Includes tombstoned (deleted_at) rows so a backup is a faithful restore.
// ============================================================================
import { useState } from "react";
import { getDb } from "@/lib/db/client";
import type { SyncableStoreKey } from "@/lib/export/exporters";
import {
  buildJsonExport,
  buildMarkdownExport,
  downloadJson,
  downloadMarkdown,
} from "@/lib/export/exporters";
import PageNav from "@/app/components/PageNav";

export default function ExportPage() {
  const [status, setStatus] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  async function snapshot(): Promise<Record<SyncableStoreKey, Array<Record<string, unknown>>>> {
    const db = getDb();
    const result = {} as Record<SyncableStoreKey, Array<Record<string, unknown>>>;
    for (const key of ["tasks", "memory", "knowledge", "chat_history", "skills", "examples"] as SyncableStoreKey[]) {
      result[key] = (await db.table(key).toArray()) as unknown as Array<Record<string, unknown>>;
    }
    return result;
  }

  async function onJson() {
    try {
      const sources = await snapshot();
      const bundle = buildJsonExport(sources);
      downloadJson(bundle);
      const total = Object.values(bundle.counts).reduce((a, b) => a + b, 0);
      setStatus({ tone: "ok", text: `JSON backup downloaded (${total} rows across ${Object.keys(bundle.counts).length} stores).` });
    } catch (err) {
      setStatus({ tone: "err", text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function onMarkdown(type: "full" | "skills" | "knowledge") {
    try {
      const sources = await snapshot();
      const md = buildMarkdownExport(sources, { type, includeDeleted: true });
      downloadMarkdown(md, type);
      setStatus({ tone: "ok", text: `${type === "full" ? "Full markdown" : type} export downloaded.` });
    } catch (err) {
      setStatus({ tone: "err", text: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
      <PageNav
        title="Data export"
        actions={[
          { href: "/skills", label: "Skills", icon: "📚" },
          { href: "/memory", label: "Memory", icon: "🧠" },
          { href: "/search", label: "Search", icon: "🔍" },
        ]}
      />
      <p className="-mt-3 mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        Download a complete backup of your on-device data — chat, memory, tasks,
        knowledge, and skills. JSON is schema-versioned for a future import;
        the Markdown files are also re-uploadable as skill/knowledge docs.
      </p>

      <div className="grid gap-3">
        <button
          type="button"
          onClick={() => void onJson()}
          className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white px-4 py-4 text-left shadow-sm transition hover:border-emerald-500/60 hover:bg-emerald-50/40 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-emerald-500/40 dark:hover:bg-emerald-950/20"
        >
          <div>
            <h2 className="text-sm font-semibold">Full JSON backup</h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Everything, schema-versioned, restore-ready. Includes deleted-tombstone rows.
            </p>
          </div>
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Download</span>
        </button>

        <button
          type="button"
          onClick={() => void onMarkdown("full")}
          className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white px-4 py-4 text-left shadow-sm transition hover:border-emerald-500/60 hover:bg-emerald-50/40 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-emerald-500/40 dark:hover:bg-emerald-950/20"
        >
          <div>
            <h2 className="text-sm font-semibold">Full Markdown export</h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">Human/LLM-readable rendering of every store.</p>
          </div>
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Download</span>
        </button>

        <button
          type="button"
          onClick={() => void onMarkdown("skills")}
          className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white px-4 py-4 text-left shadow-sm transition hover:border-emerald-500/60 hover:bg-emerald-50/40 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-emerald-500/40 dark:hover:bg-emerald-950/20"
        >
          <div>
            <h2 className="text-sm font-semibold">Skills as Markdown</h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">Re-upload each skill into /skills on another device (§5.3).</p>
          </div>
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Download</span>
        </button>

        <button
          type="button"
          onClick={() => void onMarkdown("knowledge")}
          className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white px-4 py-4 text-left shadow-sm transition hover:border-emerald-500/60 hover:bg-emerald-50/40 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-emerald-500/40 dark:hover:bg-emerald-950/20"
        >
          <div>
            <h2 className="text-sm font-semibold">Knowledge as Markdown</h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">Re-import your knowledge base into /knowledge.</p>
          </div>
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Download</span>
        </button>
      </div>

      {status && (
        <p
          className={`mt-4 text-sm ${status.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600"}`}
          aria-live="polite"
        >
          {status.text}
        </p>
      )}
    </main>
  );
}