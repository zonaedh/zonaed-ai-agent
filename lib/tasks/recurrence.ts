// ============================================================================
// Recurrence engine (plan §4 /tasks + §9 priority 8)
//
// Pure, RRULE-subset recurrence for tasks. A task's `recurrence` column is a
// JSON object; this module turns it into concrete next-due dates. The engine
// has no DOM/Dexie coupling so it unit-tests cleanly.
//
// Supported shape (kept intentionally small but real):
//   { freq: "daily"|"weekly"|"monthly"|"yearly",
//     interval?: number (>=1, default 1),
//     weekdays?: number[] (0=Sun..6=Sat)  — weekly only; empty = every interval weeks
//     dayOfMonth?: number (1..31)         — monthly/yearly; clamped to month length
//     month?: number (1..12)              — yearly only; default = anchor month
//     until?: string (ISO)                — hard stop (inclusive at that instant)
//   }
//
// Guarantees:
//   * nextOccurrence() is STRICTLY after `after` (an occurrence exactly on
//     `after` does not count) — so completing a due task schedules the next
//     one, never the same instant.
//   * month-end dayOfMonth clamps (Jan 31 -> Feb 28/29 -> Mar 31...).
//   * `until` can return null once the schedule is exhausted.
// ============================================================================

export type RecurrenceFreq = "daily" | "weekly" | "monthly" | "yearly";

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  interval?: number;
  weekdays?: number[];
  dayOfMonth?: number;
  month?: number;
  until?: string;
}

const FREQS: readonly RecurrenceFreq[] = ["daily", "weekly", "monthly", "yearly"];
const MAX_ITERATIONS = 800;

function intInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Structural validation used by both the engine and the UI form. */
export function isRecurrenceRule(value: unknown): value is RecurrenceRule {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.freq !== "string" || !FREQS.includes(r.freq as RecurrenceFreq)) return false;
  if (r.interval !== undefined && !intInRange(r.interval, 1, 366)) return false;
  if (r.weekdays !== undefined) {
    if (!Array.isArray(r.weekdays) || r.weekdays.length === 0) return false;
    if (!r.weekdays.every((d) => intInRange(d, 0, 6))) return false;
    if (r.freq !== "weekly") return false;
  }
  if (r.dayOfMonth !== undefined && !intInRange(r.dayOfMonth, 1, 31)) return false;
  if (r.month !== undefined && !intInRange(r.month, 1, 12)) return false;
  if (r.until !== undefined && (typeof r.until !== "string" || Number.isNaN(Date.parse(r.until)))) return false;
  return true;
}

/** Normalize an unknown stored value into a validated rule (or null). */
export function parseRecurrence(value: unknown): RecurrenceRule | null {
  return isRecurrenceRule(value) ? value : null;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function strictAfter(candidate: Date, anchor: Date): boolean {
  return candidate.getTime() > anchor.getTime();
}

function withUntil(rule: RecurrenceRule, candidate: Date | null): Date | null {
  if (!candidate) return null;
  if (rule.until && Number.isFinite(Date.parse(rule.until)) && candidate.getTime() > Date.parse(rule.until)) {
    return null;
  }
  return candidate;
}

/**
 * Next occurrence strictly after `after`. Returns null when the rule is
 * structurally invalid, the anchor date is unparseable, or the schedule is
 * exhausted by `until`.
 *
 * Semantics:
 *  - daily   : anchor + i*interval days (i counts from 1 => strictly after).
 *  - weekly  : with a weekday set -> first matching weekday after the anchor
 *              (scanned day-by-day, at most 7*interval+7 days); without ->
 *              anchor + i*7*interval days.
 *  - monthly : anchor month + i*interval months, dayOfMonth clamped to the
 *              real month length (Jan 31 -> Feb 28 -> Mar 31 ...).
 *  - yearly  : anchor year + i*interval years, month/dayOfMonth clamped
 *              (Feb 29 -> Feb 28 in common years).
 */
export function nextOccurrence(rule: RecurrenceRule, after: Date | string): Date | null {
  if (!isRecurrenceRule(rule)) return null;
  const anchor = typeof after === "string" ? new Date(after) : after;
  if (!(anchor instanceof Date) || Number.isNaN(anchor.getTime())) return null;

  const interval = intInRange(rule.interval, 1, 366) ? (rule.interval as number) : 1;

  // Weekly with an explicit weekday set: scan forward day-by-day.
  if (rule.freq === "weekly" && rule.weekdays) {
    const wanted = new Set(rule.weekdays);
    const limit = 7 * interval + 7; // one full cycle of the pattern, +1 week safety
    for (let i = 1; i <= limit; i++) {
      const candidate = new Date(anchor.getTime());
      candidate.setDate(anchor.getDate() + i);
      if (wanted.has(candidate.getDay()) && strictAfter(candidate, anchor)) return withUntil(rule, candidate);
    }
    return null;
  }

  // Monthly/yearly start at i=0: an occurrence later in the anchor's own
  // month/year still counts (e.g. rule "July 4 yearly" from Jan 1 2026 is
  // July 4 2026, not 2027). The strictAfter check below skips i=0 when the
  // candidate lands exactly on the anchor.
  const start = rule.freq === "monthly" || rule.freq === "yearly" ? 0 : 1;
  for (let i = start; i <= MAX_ITERATIONS; i++) {
    let candidate: Date;
    if (rule.freq === "daily") {
      candidate = new Date(anchor.getTime());
      candidate.setDate(anchor.getDate() + i * interval);
    } else if (rule.freq === "weekly") {
      candidate = new Date(anchor.getTime());
      candidate.setDate(anchor.getDate() + i * 7 * interval);
    } else if (rule.freq === "monthly") {
      const day = intInRange(rule.dayOfMonth, 1, 31) ? (rule.dayOfMonth as number) : anchor.getDate();
      candidate = new Date(
        anchor.getFullYear(),
        anchor.getMonth() + i * interval,
        1,
        anchor.getHours(),
        anchor.getMinutes(),
        anchor.getSeconds(),
        anchor.getMilliseconds(),
      );
      candidate.setDate(Math.min(day, daysInMonth(candidate.getFullYear(), candidate.getMonth())));
    } else {
      // yearly
      const day = intInRange(rule.dayOfMonth, 1, 31) ? (rule.dayOfMonth as number) : anchor.getDate();
      const monthIndex = intInRange(rule.month, 1, 12) ? (rule.month as number) - 1 : anchor.getMonth();
      candidate = new Date(
        anchor.getFullYear() + i * interval,
        monthIndex,
        1,
        anchor.getHours(),
        anchor.getMinutes(),
        anchor.getSeconds(),
        anchor.getMilliseconds(),
      );
      candidate.setDate(Math.min(day, daysInMonth(candidate.getFullYear(), candidate.getMonth())));
    }
    if (strictAfter(candidate, anchor)) return withUntil(rule, candidate);
  }
  return null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const UNIT_SINGULAR: Record<RecurrenceFreq, string> = { daily: "day", weekly: "week", monthly: "month", yearly: "year" };
const UNIT_PLURAL: Record<RecurrenceFreq, string> = { daily: "days", weekly: "weeks", monthly: "months", yearly: "years" };

/** Human label for the UI: "Every 2 weeks on Mon, Wed" / "Every month". */
export function describeRecurrence(rule: RecurrenceRule): string {
  if (!isRecurrenceRule(rule)) return "Custom";
  const interval = intInRange(rule.interval, 1, 366) ? (rule.interval as number) : 1;
  const every = interval === 1 ? `Every ${UNIT_SINGULAR[rule.freq]}` : `Every ${interval} ${UNIT_PLURAL[rule.freq]}`;
  if (rule.freq === "weekly" && rule.weekdays && rule.weekdays.length > 0) {
    const days = rule.weekdays
      .slice()
      .sort((a, b) => a - b)
      .map((d) => WEEKDAYS[d] ?? String(d))
      .join(", ");
    return `${every} on ${days}`;
  }
  if (rule.freq === "monthly" && rule.dayOfMonth) return `${every} on day ${rule.dayOfMonth}`;
  if (rule.freq === "yearly" && rule.month && rule.dayOfMonth) return `${every} on ${rule.month}/${rule.dayOfMonth}`;
  return every;
}