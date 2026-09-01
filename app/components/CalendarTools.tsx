"use client";

// ============================================================================
// CalendarTools — iCalendar import/export for tasks (plan §9 item 12)
//
//   * Export: reads the live local task store, serializes with buildIcs, and
//     downloads "zonaed-tasks.ics" — every device's current view, no server
//     round-trip needed.
//   * Import: accepts .ics, parses with parseIcs, and inserts each event as a
//     new task via createTask. Dedupes by exact (title + due_timestamp) so
//     re-importing an exported file cannot duplicate rows. Events that lost
//     their SUMMARY during parsing are reported as skipped.
// ============================================================================

import { useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { listLive } from "@/lib/db/repo";
import type { TaskRow } from "@/lib/db/types";
import { buildIcs, parseIcs } from "@/lib/calendar/ics";
import { createTask } from "@/lib/tasks/repo";

export default function CalendarTools() {
  const fileRef = useRef<HTMLInputElement>(null);
  const tasks = useLiveQuery<TaskRow[]>(() => listLive<TaskRow>("tasks"), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  function exportIcs() {
    if (!tasks || tasks.length === 0) {
      setMessage({ tone: "err", text: "Nothing to export yet." });
      return;
    }
    const body = buildIcs(
      tasks.map((t) => ({
        clientId: t.client_id,
        title: t.title,
        notes: t.notes,
        dueAt: t.due_at,
        completed: t.completed,
      })),
    );
    const blob = new Blob([body], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "zonaed-tasks.ics";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setMessage({ tone: "ok", text:`Exported ${tasks.length} task(s).` });
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy("import");
    setMessage(null);
    try {
      const text = await file.text();
      const { events, errors } = parseIcs(text);
      const existing = (tasks ?? []).map((t) => `${t.title}@${t.due_at ?? ""}`);
      const known = new Set(existing);
      let added = 0;
      let skipped = 0;
      for (const ev of events) {
        const due = ev.dueAt ?? undefined;
        const key = `${ev.title}@${due ?? ""}`;
        if (known.has(key)) {
          skipped += 1;
          continue;
        }
        await createTask({ title: ev.title, notes: ev.notes, dueAt: due });
        known.add(key);
        added += 1;
      }
      setMessage({
        tone: "ok",
        text:
          `Imported ${added} task${added === 1 ? "" : "s"}, ` +
          `skipped ${skipped + errors} duplicate${skipped + errors === 1 ? "" : "s"}.`,
      });
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof Error ? err.message : "Could not import." });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <span className="text-sm font-semibold">Calendar</span>
      <button type="button" onClick={() => fileRef.current?.click()}  disabled={busy === "import"}
        className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:border-emerald-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
      >
        {busy === "import" ? "Importing…" : "Import .ics"}
      </button>
      <button type="button" onClick={exportIcs} disabled={busy !== null}
        className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:border-emerald-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
      >
        Export .ics
      </button>
      <input ref={fileRef} type="file" accept=".ics,text/calendar" className="hidden" onChange={(e) => void onFile(e)} />
      {message && <span className={`text-xs ${message.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{message.text}</span>}
    </div>
  );
}