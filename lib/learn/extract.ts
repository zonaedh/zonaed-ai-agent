// ============================================================================
// Chat-history learning — pure logic (plan §5.4, Priority 11)
//
// No network, no env access: everything here is deterministic and exercised
// offline by scripts/verify-learn.mts. The cron route (app/api/learn/cron)
// owns orchestration; this module owns the decisions:
//
//   * which UTC days still need processing (catch-up, bounded),
//   * the extraction prompt sent to the LLM,
//   * parsing/validating/sanitizing whatever the model answers,
//   * deduping candidates against memory that already exists.
// ============================================================================

import type { ChatMessageInput } from "@/lib/ai/providers";

// ---------------------------------------------------------------------------
// Settings-table keys (server-owned rows, client_id = SERVER_SETTINGS_CLIENT_ID)
// ---------------------------------------------------------------------------

/** Opt-in toggle written by /api/learn/preferences (plan §5.4: off by default). */
export const LEARN_SETTING_KEY = "learn_from_chat";
/** Watermark: the last UTC day (YYYY-MM-DD) successfully processed for a user. */
export const LEARN_STATE_KEY = "learn_last_day";

// ---------------------------------------------------------------------------
// Day window selection
// ---------------------------------------------------------------------------

/** UTC day key ('YYYY-MM-DD') for a timestamp. */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Days that still need processing, oldest first: every completed UTC day
 * (yesterday and back) newer than the watermark, capped at `lookbackDays`
 * so a long-offline account cannot trigger a burst of LLM calls. Days older
 * than the cap are intentionally skipped — the watermark jumps to the newest
 * processed day.
 */
export function pendingDays(
  lastProcessedDay: string | null,
  nowMs: number,
  lookbackDays = 3,
): string[] {
  const pending: string[] = [];
  const dayMs = 86_400_000;
  // Walk back from yesterday (a "completed" day is fully past in UTC).
  for (let back = 1; back <= lookbackDays; back++) {
    const day = utcDayKey(nowMs - back * dayMs);
    if (lastProcessedDay !== null && day <= lastProcessedDay) break;
    pending.unshift(day); // oldest first
  }
  return pending;
}

/** Start/end (exclusive) ISO bounds of a UTC day, for created_at range queries. */
export function utcDayBounds(day: string): { start: string; end: string } {
  // The day key always originates from our own watermark, but validate anyway.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) {
    throw new Error(`Invalid day key: ${day}`);
  }
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return { start: new Date(start).toISOString(), end: new Date(start + 86_400_000).toISOString() };
}

// ---------------------------------------------------------------------------
// Chat window → extraction prompt
// ---------------------------------------------------------------------------

export interface LearnChatMessage {
  role: string;
  content: string;
  created_at: string;
}

const MAX_MESSAGES = 120;
const MAX_PROMPT_CHARS = 30_000;

/** Trim a day's chat log to a bounded, chronological window (newest kept). */
export function capMessages(messages: LearnChatMessage[]): LearnChatMessage[] {
  const chronological = [...messages].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );
  const capped = chronological.slice(-MAX_MESSAGES);
  let total = 0;
  const kept: LearnChatMessage[] = [];
  for (let i = capped.length - 1; i >= 0; i--) {
    total += capped[i].content.length;
    if (total > MAX_PROMPT_CHARS && kept.length > 0) break;
    kept.unshift(capped[i]);
  }
  return kept;
}


/** The system instruction for the extraction call. */
export function extractionSystemPrompt(): string {
  return [
    "You review a day's chat transcript between the user and their AI assistant.",
    "Extract candidate DURABLE facts worth remembering long-term: stable facts about",
    "the user (business, clients, projects, preferences, working style), corrections",
    "the user made about the assistant's behavior, and recurring topics or patterns.",
    "",
    "Rules:",
    "- Only durable, reusable knowledge. Never extract one-off conversation content,",
    "  questions, chit-chat, code snippets, or anything ephemeral like 'today I…'.",
    "- Write each suggestion as a self-contained statement in the user's own voice",
    "  (e.g. 'My business is…', 'I prefer…'), not 'The user said…'.",
    "- Prefer fewer, higher-quality suggestions. It is fine to return none.",
    '- "target" must be "memory" (fact/preference) or "skill" (how-to/behavior rule).',
    '- "category" is one of: business, preference, correction, project, general.',
    '- "excerpt": a short quote from the chat that justifies the suggestion.',
    "",
    "Answer with ONLY a JSON array (no prose, no code fences) of objects:",
    '{"target":"memory|skill","title":"short label","content":"the durable statement",',
    ' "category":"business|preference|correction|project|general","excerpt":"quote"}',
  ].join("\n");
}

/** Build the full message list for the extraction call from a day's chat log. */
export function buildExtractionMessages(messages: LearnChatMessage[]): ChatMessageInput[] {
  const capped = capMessages(messages);
  const transcript = capped
    .map((m) => `[${m.role}] ${m.content.replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return [
    { role: "system", content: extractionSystemPrompt() },
    { role: "user", content: transcript.length > 0 ? transcript : "(no chat activity this day)" },
  ];
}

// ---------------------------------------------------------------------------
// LLM output → validated candidates
// ---------------------------------------------------------------------------

export type LearnTarget = "memory" | "skill";

export interface LearnCandidate {
  target: LearnTarget;
  title: string;
  content: string;
  category: string;
  excerpt: string;
}

const CATEGORIES = new Set(["business", "preference", "correction", "project", "general"]);
const MAX_SUGGESTIONS = 8;
const MAX_TITLE = 120;
const MAX_CONTENT = 2_000;
const MAX_EXCERPT = 300;

/** Pull the outermost JSON array out of a possibly fenced/prosed response. */
function sliceJsonArray(raw: string): string {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("model response contained no JSON array");
  }
  return raw.slice(start, end + 1);
}

/**
 * Salvage pass for truncated/fenced output: collect top-level {…} spans by
 * brace matching (string-aware) and parse each individually. A malformed or
 * truncated entry is dropped instead of losing the whole batch.
 */
function salvageObjects(slice: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          out.push(JSON.parse(slice.slice(start, i + 1)) as unknown);
        } catch {
          // Drop the malformed entry; keep going.
        }
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

function parseModelArray(raw: string): unknown {
  const slice = sliceJsonArray(raw);
  try {
    return JSON.parse(slice) as unknown;
  } catch {
    // Whole-array parse failed (truncated tail, stray prose inside the array):
    // salvage whatever complete entries exist.
    return salvageObjects(slice);
  }
}


function clean(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Parse + validate the model's answer. Lenient about formatting (code fences,
 * prose around the array), strict about shape: malformed entries are dropped,
 * not fatal — one bad suggestion must not lose the rest.
 */
export function parseSuggestions(raw: string): LearnCandidate[] {
  let parsed: unknown;
  try {
    parsed = parseModelArray(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: LearnCandidate[] = [];
  const seenContent = new Set<string>();
  for (const entry of parsed) {
    if (out.length >= MAX_SUGGESTIONS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const target = e.target === "memory" || e.target === "skill" ? e.target : null;
    const content = typeof e.content === "string" ? clean(e.content, MAX_CONTENT) : "";
    if (!target || !content) continue;
    const key = normalize(content);
    if (seenContent.has(key)) continue; // model repeated itself
    seenContent.add(key);
    const category =
      typeof e.category === "string" && CATEGORIES.has(e.category) ? e.category : "general";
    out.push({
      target,
      content,
      title:
        typeof e.title === "string" && e.title.trim()
          ? clean(e.title, MAX_TITLE)
          : content.slice(0, 80),
      category,
      excerpt: typeof e.excerpt === "string" ? clean(e.excerpt, MAX_EXCERPT) : "",
    });
  }
  return out;
}

/**
 * Drop candidates the agent already knows: exact or containment overlap with
 * any existing memory/skill text (both directions, normalized). A cheap
 * substring test instead of embeddings — right size for a single-user MVP.
 */
export function dedupeCandidates(
  candidates: LearnCandidate[],
  existingTexts: string[],
): LearnCandidate[] {
  const existing = existingTexts.map(normalize).filter((t) => t.length > 0);
  return candidates.filter((candidate) => {
    const key = normalize(candidate.content);
    if (!key) return false;
    return !existing.some((text) => text.includes(key) || key.includes(text));
  });
}
