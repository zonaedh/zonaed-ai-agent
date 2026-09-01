// ============================================================================
// Push payload builders + cron selection logic (plan §4 /push, Priority 10)
//
// Pure functions only — no network, no env access — so scripts/verify-push.mts
// can exercise the exact code the cron route runs, offline.
// ============================================================================

/** The JSON every notification carries; the service worker reads this. */
export interface PushPayload {
  title: string;
  body: string;
  /** Where a notification click should land. */
  url: string;
  tag: string;
}

// ---------------------------------------------------------------------------
// Reminder payloads
// ---------------------------------------------------------------------------

export function reminderPayload(task: {
  title: string;
  due_at?: string | null;
  notes?: string | null;
}): PushPayload {
  const when = task.due_at ? formatDueShort(task.due_at) : null;
  const body = when
    ? `Due ${when}${task.notes ? ` — ${truncate(task.notes, 80)}` : ""}`
    : truncate(task.notes || "Task due now", 120);
  return {
    title: truncate(task.title, 80),
    body,
    url: "/tasks",
    tag: `task:${task.due_at ?? "now"}`,
  };
}

function formatDueShort(iso: string): string {
  const due = Date.parse(iso);
  if (Number.isNaN(due)) return "";
  const diffMin = Math.round((due - Date.now()) / 60_000);
  if (diffMin <= 0 && diffMin > -60) return "now";
  if (diffMin > 0 && diffMin < 1) return "now";
  if (diffMin > 0 && diffMin < 60) return `in ${diffMin} min`;
  const hours = Math.round(diffMin / 60);
  if (Math.abs(hours) < 24) return diffMin > 0 ? `in ${hours} h` : `${-hours} h ago`;
  return new Date(due).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Digest (daily/weekly summary) — built from the user's open tasks
// ---------------------------------------------------------------------------

export type DigestFrequency = "daily" | "weekly";

export function isDigestFrequency(value: unknown): value is DigestFrequency {
  return value === "daily" || value === "weekly";
}

export interface DigestInputTask {
  title: string;
  due_at?: string | null;
  completed: boolean;
  deleted_at?: string | null;
}

export function digestPayload(
  tasks: DigestInputTask[],
  frequency: DigestFrequency,
): PushPayload {
  const summary = buildDigestSummary(tasks);
  return {
    title: frequency === "daily" ? "Daily digest" : "Weekly digest",
    body: summary,
    url: "/tasks",
    tag: `digest:${frequency}`,
  };
}

/**
 * One-line summary of open tasks: overdue + due today + this week, then the
 * next few titles. Tasks must already be filtered to open (not completed,
 * not deleted) by the caller when counting is done via SQL — but this
 * function re-filters defensively so both call shapes are safe.
 */
export function buildDigestSummary(tasks: DigestInputTask[]): string {
  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const in7Days = new Date(endOfToday.getTime() + 7 * 86_400_000);

  const open = tasks.filter((t) => !t.completed && !t.deleted_at);
  const withDue = open.filter(
    (t) => t.due_at && Number.isFinite(Date.parse(t.due_at)),
  );

  const overdue = withDue.filter((t) => Date.parse(t.due_at as string) < now.getTime());
  const today = withDue.filter((t) => {
    const due = Date.parse(t.due_at as string);
    return due >= now.getTime() && due <= endOfToday.getTime();
  });
  const week = withDue.filter((t) => {
    const due = Date.parse(t.due_at as string);
    return due > endOfToday.getTime() && due <= in7Days.getTime();
  });

  if (open.length === 0) return "No open tasks. Enjoy the clear runway.";
  if (withDue.length === 0) return `${open.length} open task(s), none scheduled.`;

  const parts: string[] = [];
  if (overdue.length > 0) parts.push(`${overdue.length} overdue`);
  if (today.length > 0) parts.push(`${today.length} due today`);
  if (week.length > 0) parts.push(`${week.length} this week`);
  const unscheduled = open.length - withDue.length;
  if (unscheduled > 0) parts.push(`${unscheduled} unscheduled`);

  const next = withDue
    .filter((t) => Date.parse(t.due_at as string) >= now.getTime())
    .sort((a, b) => Date.parse(a.due_at as string) - Date.parse(b.due_at as string))
    .slice(0, 3)
    .map((t) => truncate(t.title, 30));

  let line = parts.join(", ");
  if (next.length > 0) line += ` — next: ${next.join("; ")}`;
  return truncate(line, 200);
}

// ---------------------------------------------------------------------------
// Cron bookkeeping (settings-table keys, server-written rows)
// ---------------------------------------------------------------------------

/** client_id used for every settings row the server itself writes. */
export const SERVER_SETTINGS_CLIENT_ID = "server";

export const DIGEST_SETTING_KEY = "push_digest";
export const DIGEST_STATE_KEY = "push_digest_last_sent";
