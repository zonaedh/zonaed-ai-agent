// ============================================================================
// Memory/skills/example injector (plan §5.1 memory-skills.ts port + §5.3)
//
// Matches the incoming message against keyword-triggered skills (or injects
// always-on skills unconditionally), selects relevant long-term memories, and
// assembles the few-shot example block. PURE: operates on row-shaped data, so
// the client can run it against Dexie (source of truth, works offline) and the
// server against Supabase rows — same logic, same results.
// ============================================================================
import type { ExampleRow, MemoryRow, SkillRow } from "../db/types";

export interface Preamble {
  skills: { title: string; content: string }[];
  memories: { category: string; content: string }[];
  examples: { input: string; output: string }[];
}

/** Normalize a keyword for matching: lowercase, trim, collapse spaces. */
function norm(word: string): string {
  return word.toLowerCase().trim();
}

/** True when any skill keyword appears in the message (word-ish match). */
export function skillMatches(message: string, skill: SkillRow): boolean {
  if (skill.deleted_at) return false;
  if (!skill.active) return false;
  // Always-on skill: empty trigger list (plan §5.1/§5.3).
  if (!skill.trigger_keywords || skill.trigger_keywords.length === 0) return true;
  const haystack = message.toLowerCase();
  return skill.trigger_keywords.some((k) => {
    const kw = norm(k);
    if (!kw) return false;
    // Multi-word keywords substring-match; single words match on boundaries.
    return kw.includes(" ")
      ? haystack.includes(kw)
      : new RegExp(`(^|[^\\p{L}])${kw}([^\\p{L}]|$)`, "u").test(haystack);
  });
}

/** Select active, non-deleted skills relevant to this message (plan §5.3 injection rule). */
export function matchSkills(message: string, skills: SkillRow[]): SkillRow[] {
  return skills.filter((s) => skillMatches(message, s));
}

/**
 * Select memories relevant to the message: matching category or content
 * keyword overlap, capped to keep the prompt lean.
 */
const MAX_MEMORIES = 8;

export function matchMemories(message: string, memories: MemoryRow[]): MemoryRow[] {
  const live = memories.filter((m) => !m.deleted_at);
  const words = new Set(message.toLowerCase().split(/[^\p{L}\d]+/u).filter((w) => w.length > 2));
  const scored = live.map((m) => {
    let score = 0;
    if (words.has(m.category.toLowerCase())) score += 2;
    for (const w of words) {
      if (m.content.toLowerCase().includes(w)) score += 1;
    }
    return { m, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MEMORIES)
    .map((s) => s.m);
}

/** Build the full preamble payload for the chat request. */
export function buildPreamble(
  message: string,
  skills: SkillRow[],
  memories: MemoryRow[],
  examples: ExampleRow[],
): Preamble {
  const liveExamples = examples
    .filter((e) => !e.deleted_at)
    .slice(0, 3)
    .map((e) => ({ input: e.input, output: e.output }));
  return {
    skills: matchSkills(message, skills).map((s) => ({ title: s.title, content: s.content })),
    memories: matchMemories(message, memories).map((m) => ({ category: m.category, content: m.content })),
    examples: liveExamples,
  };
}

/** True when the preamble carries nothing (skip preamble block in the prompt). */
export function isEmptyPreamble(p: Preamble): boolean {
  return p.skills.length === 0 && p.memories.length === 0 && p.examples.length === 0;
}
