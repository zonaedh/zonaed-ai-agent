// ============================================================================
// iCalendar (RFC 5545) — task export/import (plan §9 item 12, nice-to-have)
//
// Pure module: deterministic, no network/env/DOM, fully exercised offline by
// scripts/verify-nice.mts. Two halves:
//
//   * buildIcs — serializes tasks into a minimal VCALENDAR (VEVENT per task,
//     UID = client_id@zonaed.ai for stable round-trips, DTSTART when due_at
//     is set, STATUS:COMPLETED for finished rows, TRANSP:TRANSPARENT so the
//     import does not double-block shared calendars).
//   * parseIcs — tolerant reader: CRLF or LF, folded continuation lines,
//     DTSTART as DATE (YYYYMMDD) or DATE-TIME (YYYYMMDDTHHMMSS with optional
//     trailing Z; floating times are treated as UTC by design and documented
//     in the UI), TEXT unescaping. Never throws on bad input — malformed
//     lines/events are dropped and counted.
//
// Line discipline per RFC 5545: CRLF endings, TEXT-escape backslash/semicolon/
// comma/newline, fold at 75 octets with CRLF+space continuation.
// ============================================================================

export interface IcsTaskInput {
  clientId: string;
  title: string;
  notes?: string;
  /** ISO-8601 due timestamp. */
  dueAt?: string;
  completed?: boolean;
}

export interface ParsedIcsEvent {
  uid?: string;
  title: string;
  notes?: string;
  /** ISO-8601 timestamp, or null for date-only events (interpreted as UTC midnight). */
  dueAt?: string;
  completed?: boolean;
}

export interface ParseIcsResult {
  events: ParsedIcsEvent[];
  /** Count of malformed lines / unparsable blocks, for the UI summary. */
  errors: number;
}

// ---------------------------------------------------------------------------
// TEXT escaping (RFC 5545 §3.3.11)
// ---------------------------------------------------------------------------

function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function unescapeText(text: string): string {
  return text
    .replace(/\\n/gi, "\n")
    .replace(/\\;/g, ";")
    .replace(/\\,/g, ",")
    .replace(/\\\\/g, "\\");
}

// ---------------------------------------------------------------------------
// Date handling
// ---------------------------------------------------------------------------

/** ISO-8601 -> RFC 5545 UTC DATE-TIME (YYYYMMDDTHHMMSSZ). */
export function toIcsDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** RFC 5545 DATE-TIME (UTC or floating) / DATE -> ISO-8601. Floating = UTC. */
export function fromIcsDateTime(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, dd, hh, mi, ss, isUtc] = m;
  if (m[4] === undefined && hh === undefined) {
    // DATE (YYYYMMDD) — full-day event; interpret as UTC midnight.
    const d = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(dd)));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // DATE-TIME with a T: UTC when it carries Z, else floating time = UTC in this
  // single-user context (documented in the import UI) — the definitive time is
  // the instant, not the wall-clock representation.
  const d = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(dd), Number(hh ?? 0), Number(mi ?? 0), Number(ss ?? 0)));
  if (Number.isNaN(d.getTime())) return null;
  return isUtc === "Z" ? d.toISOString() : d.toISOString(); // identical — UTC instant
}

// ---------------------------------------------------------------------------
// Line folding / unfolding (RFC 5545 §3.1)
// ---------------------------------------------------------------------------

/** Fold a logical line to ≤75 octets with CRLF+space continuations. */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  for (let i = 0; i < line.length; i += 74) chunks.push(line.slice(i, i + 74));
  return chunks.join("\r\n ");
}

/** Unfold CRLF/LF-separated content lines (continuation = leading space/tab). */
function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      if (line.startsWith(" ")) lines[lines.length - 1] += line.slice(1);
      else lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line.replace(/\s+$/, ""));
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// parseIcs — VCALENDAR text -> events
// ---------------------------------------------------------------------------

/** Tolerant ICAL reader: returns events + a malformed-block error count. */
export function parseIcs(input: string): ParseIcsResult {
  const result: ParseIcsResult = { events: [], errors: 0 };
  if (!input || !input.trim()) return result;

  const lines = unfold(input);
  let inCalendar = false;
  let inEvent = false;
  let current: Partial<ParsedIcsEvent> & { bad?: boolean } = {};
  let sawSummary = false;

  const flush = () => {
    if (inEvent) {
      const title = (current.title ?? "").trim();
      if (!title) {
        result.errors += 1; // VEVENT without a usable SUMMARY is dropped
      } else {
        result.events.push({
          uid: current.uid,
          title,
          notes: current.notes,
          dueAt: current.dueAt,
          completed: current.completed ?? false,
        } satisfies ParsedIcsEvent);
      }
      current = {};
      sawSummary = false;
    }
    inEvent = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const upper = trimmed.toUpperCase();

    if (upper === "BEGIN:VCALENDAR") {
      inCalendar = true;
      continue;
    }
    if (upper === "END:VCALENDAR") {
      flush();
      inCalendar = false;
      continue;
    }
    if (!inCalendar) continue; // ignore anything outside the VCALENDAR block

    if (upper === "BEGIN:VEVENT") {
      flush(); // close any nested block defensively
      inEvent = true;
      continue;
    }
    if (upper === "END:VEVENT") {
      flush();
      continue;
    }
    if (!inEvent) continue;

    // Parse "NAME;PARAM=VALUE:value" → name (upper), params, raw value.
    const colon = trimmed.indexOf(":");
    const name = (colon === -1 ? trimmed : trimmed.slice(0, colon)).toUpperCase().split(";")[0];
    const value = colon === -1 ? "" : trimmed.slice(colon + 1);

    switch (name) {
      case "UID":
        current.uid = value.trim();
        break;
      case "SUMMARY":
        current.title = unescapeText(value);
        sawSummary = true;
        break;
      case "DESCRIPTION":
        current.notes = unescapeText(value);
        break;
      case "STATUS":
        current.completed = value.trim().toUpperCase() === "COMPLETED";
        break;
      case "DTSTART": {
        // May carry ;VALUE=DATE or ;TZID=... params — strip them before parsing.
        const paramsPart = (colon === -1 ? trimmed : trimmed.slice(0, colon)).split(";").slice(1);
        const valueType = paramsPart
          .find((p) => p.toUpperCase().startsWith("VALUE="))
          ?.toUpperCase()
          .slice("VALUE=".length);
        const isDateOnly = valueType === "DATE" || /^\d{8}$/.test(value.trim());
        const iso = fromIcsDateTime(value);
        if (iso) current.dueAt = iso;
        else if (isDateOnly) current.dueAt = undefined; // unparsable — keep event, lose date
        break;
      }
      default:
        break;
    }
  }

  // A VCALENDAR without a closing END:VCALENDAR — flush whatever we accumulated.
  flush();
  void sawSummary;
  return result;
}

/** Serialize tasks to an iCalendar string (CRLF line endings, folded). */
export function buildIcs(tasks: IcsTaskInput[]): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Zonaed AI//Tasks v1//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  for (const task of tasks) {
    const title = (task.title || "Untitled").trim();
    if (!title && !task.notes && !task.dueAt) continue; // nothing to serialize

    const uid = `${task.clientId || "task"}@zonaed.ai`;
    lines.push("BEGIN:VEVENT", "UID:" + uid, "DTSTAMP:" + toIcsDateTime(new Date().toISOString()));
    if (task.dueAt) lines.push("DTSTART:" + toIcsDateTime(task.dueAt));
    lines.push("SUMMARY:" + escapeText(title));
    lines.push("TRANSP:TRANSPARENT");
    if (task.completed) lines.push("STATUS:COMPLETED");
    if (task.notes) lines.push("DESCRIPTION:" + escapeText(task.notes));
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
