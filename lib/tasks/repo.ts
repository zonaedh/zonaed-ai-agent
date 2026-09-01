// ============================================================================
// Task CRUD (plan §4 /tasks + §9 priority 8)
//
// Thin domain layer over lib/db/repo.ts so the UI never touches Dexie directly.
// Two rules honored here:
//   * every write goes through putLocal/softDeleteLocal (updated_at + dirty
//     stamped, delete = soft tombstone),
//   * completing a RECURRING task keeps the finished row (history) and spawns
//     the NEXT occurrence as a new client_id row (plan §8: "recurring tasks").
//     The spawn is idempotent — completing an already-completed row never
//     double-spawns.
// ============================================================================
import { getDb } from "../db/client";
import { newClientId, putLocal, softDeleteLocal } from "../db/repo";
import type { TaskRow } from "../db/types";
import { nextOccurrence, parseRecurrence, type RecurrenceRule } from "./recurrence";

export interface NewTaskInput {
  title: string;
  notes?: string;
  /** ISO timestamp or null/undefined for "no due date". */
  dueAt?: string | null;
  recurrence?: RecurrenceRule | null;
}

function blankTask(input: NewTaskInput): TaskRow {
  const now = new Date().toISOString();
  const row: TaskRow = {
    client_id: newClientId(),
    title: input.title,
    completed: false,
    created_at: now,
    updated_at: now,
    dirty: 1,
  };
  if (input.notes) row.notes = input.notes;
  if (input.dueAt) row.due_at = input.dueAt;
  if (input.recurrence) row.recurrence = { ...input.recurrence } as unknown as Record<string, unknown>;
  return row;
}

/** Create a task. Throws on empty title or structurally invalid recurrence. */
export async function createTask(input: NewTaskInput): Promise<TaskRow> {
  const title = input.title.trim();
  if (!title) throw new Error("Task title is required");
  if (input.recurrence && !parseRecurrence(input.recurrence)) {
    throw new Error("Invalid recurrence rule");
  }
  if (input.dueAt && Number.isNaN(Date.parse(input.dueAt))) throw new Error("Invalid due date");
  return putLocal("tasks", blankTask({ ...input, title }));
}

async function requireTask(clientId: string): Promise<TaskRow> {
  const db = getDb();
  const task = await db.tasks.get(clientId);
  if (!task || task.deleted_at) throw new Error(`Task ${clientId} not found`);
  return task;
}

export interface CompletionResult {
  completed: TaskRow;
  /** The spawned next occurrence, if the rule produced one. */
  next?: TaskRow;
}

/**
 * Mark a task completed. For a recurring task, compute the next occurrence
 * (anchored on the future due date when it hasn't arrived yet, otherwise on
 * now) and spawn a fresh row carrying title/notes/recurrence.
 */
export async function completeTask(clientId: string): Promise<CompletionResult> {
  const task = await requireTask(clientId);
  const now = new Date();
  const completed = await putLocal("tasks", {
    ...task,
    completed: true,
    completed_at: now.toISOString(),
  });

  // Idempotency: never spawn twice for the same occurrence.
  if (task.completed) return { completed };

  const rule = parseRecurrence(task.recurrence);
  if (!rule) return { completed };

  const anchor = task.due_at && Date.parse(task.due_at) > now.getTime() ? task.due_at : now.toISOString();
  const next = nextOccurrence(rule, anchor);
  if (!next) return { completed }; // schedule exhausted (until) — row just stays completed

  const spawned = await putLocal("tasks", {
    ...task,
    id: undefined,
    client_id: newClientId(),
    completed: false,
    completed_at: undefined,
    due_at: next.toISOString(),
    created_at: now.toISOString(),
  });
  return { completed, next: spawned };
}

/** Move a due date (null clears it). Stamps updated_at + dirty via putLocal. */
export async function rescheduleTask(clientId: string, dueAt: string | null): Promise<TaskRow> {
  const task = await requireTask(clientId);
  if (dueAt && Number.isNaN(Date.parse(dueAt))) throw new Error("Invalid due date");
  const next: TaskRow = { ...task };
  if (dueAt) next.due_at = dueAt;
  else delete next.due_at;
  return putLocal("tasks", next);
}

/** Toggle completion without recurrence spawning (reopen / manual tick). */
export async function setTaskCompleted(clientId: string, completed: boolean): Promise<TaskRow> {
  const task = await requireTask(clientId);
  const next: TaskRow = { ...task, completed };
  if (completed) next.completed_at = new Date().toISOString();
  else delete next.completed_at;
  return putLocal("tasks", next);
}

/** Soft-delete (tombstone) — the row survives for sync + export. */
export async function deleteTask(clientId: string): Promise<void> {
  await requireTask(clientId);
  await softDeleteLocal("tasks", clientId);
}

/** Open (not completed, not deleted) tasks: undated last, then by due date. */
export async function listOpenTasks(): Promise<TaskRow[]> {
  const db = getDb();
  const rows = await db.tasks.toArray();
  return rows
    .filter((r) => !r.deleted_at && !r.completed)
    .sort((a, b) => {
      const ad = a.due_at ? Date.parse(a.due_at) : Number.POSITIVE_INFINITY;
      const bd = b.due_at ? Date.parse(b.due_at) : Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
      return Date.parse(a.created_at ?? a.updated_at) - Date.parse(b.created_at ?? b.updated_at);
    });
}

/** Recently completed first (history view). */
export async function listCompletedTasks(): Promise<TaskRow[]> {
  const db = getDb();
  const rows = await db.tasks.toArray();
  return rows
    .filter((r) => !r.deleted_at && r.completed)
    .sort((a, b) => Date.parse(b.completed_at ?? b.updated_at) - Date.parse(a.completed_at ?? a.updated_at));
}