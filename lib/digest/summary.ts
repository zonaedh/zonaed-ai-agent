// ============================================================================
// Digest summary (plan §4 /digest: daily/weekly summary generator)
//
// Pure + offline: computed entirely from the local Dexie snapshot (tasks,
// chat, memory, knowledge, skills). The push cron's digest (§10) is a
// notification-level summary; this page is the full in-app view.
// ============================================================================

export interface DigestTask {
  client_id?: string;
  title: string;
  due_at?: string | null;
  completed_at?: string | null;
  deleted_at?: string | null;
}

export interface DigestInput {
  tasks: DigestTask[];
  counts: { memory: number; knowledge: number; skills: number };
  lastChatAt?: string | null;
  /** Reference "now" — injectable for deterministic tests. */
  now?: Date;
}

export interface DigestSummary {
  overdue: DigestTask[];
  dueToday: DigestTask[];
  dueThisWeek: DigestTask[];
  later: number;
  openTotal: number;
  completedThisWeek: number;
  counts: DigestInput["counts"];
  lastChatAt?: string | null;
  headline: string;
}

function isLive(t: DigestTask): boolean {
  return !t.deleted_at && !t.completed_at;
}

function startOfDay(d: Date): number {
  return new Date(d).setHours(0, 0, 0, 0);
}

/** Build the full digest summary. Deterministic given `now`. */
export function buildDigest(input: DigestInput): DigestSummary {
  const now = input.now ?? new Date();
  const today = startOfDay(now);
  const weekEnd = today + 7 * 86_400_000;
  const weekStart = today - 7 * 86_400_000;

  const overdue: DigestTask[] = [];
  const dueToday: DigestTask[] = [];
  const dueThisWeek: DigestTask[] = [];
  let later = 0;

  for (const t of input.tasks) {
    if (!isLive(t)) continue;
    if (!t.due_at) {
      later += 1;
      continue;
    }
    const due = new Date(t.due_at).getTime();
    if (Number.isNaN(due)) {
      later += 1;
      continue;
    }
    if (due < today) overdue.push(t);
    else if (due < today + 86_400_000) dueToday.push(t);
    else if (due < weekEnd) dueThisWeek.push(t);
    else later += 1;
  }

  const completedThisWeek = input.tasks.filter((t) => {
    if (t.deleted_at || !t.completed_at) return false;
    const c = new Date(t.completed_at).getTime();
    return c >= weekStart && c < weekEnd;
  }).length;

  const openTotal = overdue.length + dueToday.length + dueThisWeek.length + later;

  const bits: string[] = [];
  if (overdue.length > 0) bits.push(`${overdue.length} overdue`);
  if (dueToday.length > 0) bits.push(`${dueToday.length} due today`);
  if (dueThisWeek.length > 0) bits.push(`${dueThisWeek.length} this week`);
  const headline =
    openTotal === 0
      ? "Nothing open — clear week!"
      : bits.length > 0
        ? `${openTotal} open task${openTotal === 1 ? "" : "s"}: ${bits.join(", ")}`
        : `${openTotal} open task${openTotal === 1 ? "" : "s"}`;

  return {
    overdue,
    dueToday,
    dueThisWeek,
    later,
    openTotal,
    completedThisWeek,
    counts: input.counts,
    lastChatAt: input.lastChatAt ?? null,
    headline,
  };
}

/** Render the digest as Markdown (for Copy / hand-off into chat). */
export function digestToMarkdown(s: DigestSummary): string {
  const lines: string[] = [`# Digest — ${new Date().toISOString().slice(0, 10)}`, "", `**${s.headline}**`, ""];

  const section = (title: string, tasks: DigestTask[]) => {
    if (tasks.length === 0) return;
    lines.push(`## ${title}`);
    for (const t of tasks) {
      const due = t.due_at ? ` (due ${new Date(t.due_at).toLocaleString()})` : "";
      lines.push(`- ${t.title}${due}`);
    }
    lines.push("");
  };

  section("Overdue", s.overdue);
  section("Due today", s.dueToday);
  section("Due this week", s.dueThisWeek);

  lines.push("## Activity");
  lines.push(`- Completed this week: ${s.completedThisWeek}`);
  lines.push(`- Open tasks (no due date / later): ${s.later}`);
  lines.push(`- Memory entries: ${s.counts.memory}`);
  lines.push(`- Knowledge docs: ${s.counts.knowledge}`);
  lines.push(`- Skills: ${s.counts.skills}`);
  if (s.lastChatAt) lines.push(`- Last chat: ${new Date(s.lastChatAt).toLocaleString()}`);
  return lines.join("\n");
}
