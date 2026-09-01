"use client";

// ============================================================================
// /tasks — task list + recurring scheduling (plan §4 module, §9 priority 8)
//
//   * Open tasks first (overdue highlighted), completed history below.
//   * New-task form: title, optional due datetime, recurrence
//     (daily/weekly+weekdays/monthly/yearly × interval). Completing a
//     recurring task spawns its next occurrence automatically (see
//     lib/tasks/repo.ts completeTask).
//   * Quick capture: opening /tasks?capture=1 (PWA "Quick Capture" shortcut)
//     focuses the title input so a task is one type + Enter away.
//   * Offline-first: reads via useLiveQuery over the local Dexie store.
// ============================================================================
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { RecurrenceFreq, RecurrenceRule } from "@/lib/tasks/recurrence";
import { describeRecurrence } from "@/lib/tasks/recurrence";
import type { TaskRow } from "@/lib/db/types";
import {
  completeTask,
  createTask,
  deleteTask,
  listCompletedTasks,
  listOpenTasks,
  rescheduleTask,
  setTaskCompleted,
} from "@/lib/tasks/repo";

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"] as const;
const FREQS: Array<{ value: RecurrenceFreq | "none"; label: string }> = [
  { value: "none", label: "No repeat" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];

/** ISO -> <input type="datetime-local"> value in the local timezone. */
function toInputValue(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value -> ISO (null when empty/invalid). */
function fromInputValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// A render-safe clock (react-hooks/purity bans Date.now() during render).
// External-store pattern: the snapshot advances only on subscription ticks
// (1/min is plenty for "overdue" highlighting), 0 on the server prerender.
const CLOCK_TICK_MS = 60_000;
let clockSnapshot = 0;
function subscribeClock(onChange: () => void): () => void {
  clockSnapshot = Date.now();
  const id = setInterval(() => {
    clockSnapshot = Date.now();
    onChange();
  }, CLOCK_TICK_MS);
  return () => clearInterval(id);
}
function useNow(): number {
  return useSyncExternalStore(subscribeClock, () => clockSnapshot, () => 0);
}

function formatDue(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function ruleFromForm(freq: RecurrenceFreq | "none", interval: number, weekdays: number[]): RecurrenceRule | null {
  if (freq === "none") return null;
  const rule: RecurrenceRule = { freq };
  if (interval > 1) rule.interval = interval;
  if (freq === "weekly" && weekdays.length > 0) rule.weekdays = weekdays.slice().sort((a, b) => a - b);
  return rule;
}

export default function TasksPage() {
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [dueInput, setDueInput] = useState("");
  const [freq, setFreq] = useState<RecurrenceFreq | "none">("none");
  const [interval, setInterval] = useState(1);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [status, setStatus] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const now = useNow();

  // Quick-capture shortcut: autofocus the title, ready for type + Enter.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("capture") === "1") {
      titleRef.current?.focus();
    }
  }, []);

  const open = useLiveQuery(listOpenTasks, []);
  const done = useLiveQuery(listCompletedTasks, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const rule = ruleFromForm(freq, interval, weekdays);
      await createTask({ title, notes: notes.trim() || undefined, dueAt: fromInputValue(dueInput), recurrence: rule });
      setTitle("");
      setNotes("");
      setDueInput("");
      setStatus({ tone: "ok", text: "Task added." });
      titleRef.current?.focus(); // capture flow: keep typing the next one
    } catch (err) {
      setStatus({ tone: "err", text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function onComplete(task: TaskRow) {
    try {
      const result = await completeTask(task.client_id);
      setStatus(
        result.next?.due_at
          ? { tone: "ok", text: `Completed — next occurrence ${formatDue(result.next.due_at)}.` }
          : { tone: "ok", text: "Completed." },
      );
    } catch (err) {
      setStatus({ tone: "err", text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function onReschedule(task: TaskRow, value: string) {
    try {
      await rescheduleTask(task.client_id, fromInputValue(value));
    } catch (err) {
      setStatus({ tone: "err", text: err instanceof Error ? err.message : String(err) });
    }
  }

  const intervalLabel = (t: TaskRow) =>
    t.recurrence ? describeRecurrence(t.recurrence as unknown as RecurrenceRule) : null;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
      <h1 className="mb-1 text-2xl font-bold tracking-tight">Tasks</h1>
      <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        Offline-first checklist. Completing a recurring task schedules its next occurrence automatically.
      </p>

      <form onSubmit={onSubmit} className="mb-8 space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          aria-label="Task title"
          className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700"
        />
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          aria-label="Task notes"
          className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="datetime-local"
            value={dueInput}
            onChange={(e) => setDueInput(e.target.value)}
            aria-label="Due date"
            className="rounded-lg border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
          />
          <select
            value={freq}
            onChange={(e) => setFreq(e.target.value as RecurrenceFreq | "none")}
            aria-label="Repeat"
            className="rounded-lg border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
          >
            {FREQS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          {freq !== "none" && (
            <label className="flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
              every
              <input
                type="number"
                min={1}
                max={366}
                value={interval}
                onChange={(e) => setInterval(Math.max(1, Math.min(366, Number(e.target.value) || 1)))}
                aria-label="Repeat interval"
                className="w-14 rounded-lg border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
              />
            </label>
          )}
        </div>
        {freq === "weekly" && (
          <div className="flex items-center gap-1" role="group" aria-label="Repeat on weekdays">
            {WEEKDAY_LABELS.map((label, day) => {
              const active = weekdays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setWeekdays(active ? weekdays.filter((d) => d !== day) : [...weekdays, day])}
                  className={`h-8 w-8 rounded-full text-xs font-semibold ${
                    active ? "bg-blue-600 text-white" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                  }`}
                >
                  {label}
                </button>
              );
            })}
            <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
              {weekdays.length === 0 ? "every N weeks (unset days)" : "on selected days"}
            </span>
          </div>
        )}
        {freq !== "none" && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {describeRecurrence(ruleFromForm(freq, interval, weekdays) as RecurrenceRule)}
            {freq === "monthly" || freq === "yearly" ? " — anchored on the due date's day" : ""}
          </p>
        )}
        <button
          type="submit"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          disabled={!title.trim()}
        >
          Add task
        </button>
        {status && (
          <p className={`text-sm ${status.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
            {status.text}
          </p>
        )}
      </form>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Open {open ? `(${open.length})` : ""}
      </h2>
      {open === undefined ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : open.length === 0 ? (
        <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">Nothing open. Quick-capture something above.</p>
      ) : (
        <ul className="mb-6 space-y-2">
          {open.map((t) => {
            const overdue = Boolean(t.due_at) && Date.parse(t.due_at as string) < now;
            const rec = intervalLabel(t);
            return (
              <li key={t.client_id} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    aria-label={`Complete ${t.title}`}
                    onChange={() => onComplete(t)}
                    className="mt-1 h-4 w-4"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{t.title}</p>
                    {t.notes && <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">{t.notes}</p>}
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      {t.due_at && (
                        <span className={overdue ? "font-semibold text-red-600 dark:text-red-400" : "text-zinc-500 dark:text-zinc-400"}>
                          {overdue ? "Overdue: " : "Due: "}
                          {formatDue(t.due_at)}
                        </span>
                      )}
                      {rec && (
                        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                          ↻ {rec}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <input
                      type="datetime-local"
                      defaultValue={toInputValue(t.due_at)}
                      onChange={(e) => onReschedule(t, e.target.value)}
                      aria-label={`Reschedule ${t.title}`}
                      className="rounded-lg border border-zinc-300 bg-transparent px-1.5 py-1 text-[11px] dark:border-zinc-700"
                    />
                    <button
                      type="button"
                      onClick={() => deleteTask(t.client_id)}
                      className="text-[11px] text-zinc-400 hover:text-red-500"
                      aria-label={`Delete ${t.title}`}
                    >
                      delete
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Completed {done ? `(${done.length})` : ""}
      </h2>
      {done !== undefined && done.length > 0 && (
        <ul className="space-y-1">
          {done.slice(0, 20).map((t) => (
            <li key={t.client_id} className="flex items-center gap-3 text-sm text-zinc-500 dark:text-zinc-400">
              <input
                type="checkbox"
                checked
                aria-label={`Reopen ${t.title}`}
                onChange={() => setTaskCompleted(t.client_id, false)}
                className="h-4 w-4"
              />
              <span className="min-w-0 flex-1 truncate line-through">{t.title}</span>
              {t.completed_at && <span className="text-xs">{formatDue(t.completed_at)}</span>}
              <button
                type="button"
                onClick={() => deleteTask(t.client_id)}
                className="text-[11px] text-zinc-400 hover:text-red-500"
                aria-label={`Delete ${t.title}`}
              >
                delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}