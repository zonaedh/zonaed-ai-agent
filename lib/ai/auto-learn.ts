// ============================================================================
// Conversational auto-learn (plan §5.1, ported from the extension "as-is"):
// the user says "Remember that …", "Amar business holo …", "মনে রাখো …" etc.
// and the assistant captures the fact into the synced `memory` store with the
// same trigger phrases and category classification as the extension.
//
// Pure + injectable-free: no DOM, no network — deterministic and unit-tested
// (scripts/verify-autolearn.mts). The chat page calls detectMemoryCapture()
// on every outgoing user message and persists a positive hit via putLocal.
// ============================================================================

export type MemoryCategory =
  | "business"
  | "preference"
  | "correction"
  | "project"
  | "general";

export interface MemoryCapture {
  /** Cleaned fact text (trigger phrase stripped, whitespace collapsed). */
  content: string;
  category: MemoryCategory;
  /** The trigger phrase that matched (for UI feedback/debugging). */
  trigger: string;
}

/** Longest-first so "amar business holo" wins over a bare "amar" etc. */
const TRIGGERS: string[] = [
  // English
  "remember that",
  "remember this",
  "remember:",
  "remember -",
  "note that",
  "note:",
  "don't forget that",
  "dont forget that",
  "keep in mind that",
  // Banglish (transliterated)
  "amar business holo",
  "amar business name",
  "mon e rakho",
  "mone rakho",
  "ei kotha mon e rakho",
  // Bengali script
  "মনে রাখো",
  "মনে রাখবেন",
  "এই কথা মনে রাখো",
];

/** Lowest-first: the first matching bucket wins (extension parity). */
const CATEGORY_RULES: Array<{ category: MemoryCategory; patterns: RegExp[] }> = [
  {
    category: "business",
    patterns: [
      /\b(business|company|firm|agency|service|pricing|price|rate|invoice|client|customer|brand)\b/i,
      /ব্যবসা|ব্যাবসা|প্রাইস|ক্লায়েন্ট/i,
    ],
  },
  {
    category: "preference",
    patterns: [
      /\b(i prefer|i like|i love|i hate|i always|i never|favourite|favorite|style|tone)\b/i,
      /পছন্দ|আমি সবসময়|আমি কখনো/i,
    ],
  },
  {
    category: "correction",
    patterns: [
      /\b(actually|correction|not \w+ but|wrong|instead|from now on|stop doing)\b/i,
      /আসলে|ভুল|থেকে এখন থেকে/i,
    ],
  },
  {
    category: "project",
    patterns: [
      /\b(project|deadline|milestone|sprint|launch|shipment|deploy)\b/i,
      /প্রজেক্ট|ডেডলাইন|লঞ্চ/i,
    ],
  },
];

export const AUTO_LEARN_MIN_CONTENT = 3;
/** Facts longer than this get clamped — memory entries stay prompt-lean. */
export const AUTO_LEARN_MAX_CONTENT = 400;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Detect a memory-capture trigger in a user message.
 * Returns null when the message is not a capture command, or a capture with
 * the cleaned fact + category when it is. Deterministic, allocation-light.
 */
export function detectMemoryCapture(rawMessage: string): MemoryCapture | null {
  const message = normalize(rawMessage);
  if (message.length < AUTO_LEARN_MIN_CONTENT) return null;

  const lower = message.toLowerCase();
  for (const trigger of TRIGGERS) {
    const idx = lower.indexOf(trigger.toLowerCase());
    if (idx === -1) continue;
    // The fact starts right after the trigger (allow ":" / "," / whitespace).
    let content = message
      .slice(idx + trigger.length)
      .replace(/^[\s:,\-–—]+/u, "")
      .trim();
    if (content.length < AUTO_LEARN_MIN_CONTENT) return null; // trigger with no fact
    if (content.length > AUTO_LEARN_MAX_CONTENT) {
      content = content.slice(0, AUTO_LEARN_MAX_CONTENT).trimEnd() + "…";
    }
    return { content, category: classifyCategory(content), trigger };
  }
  return null;
}

/** Same bucket order as the extension: business → preference → correction → project → general. */
export function classifyCategory(content: string): MemoryCategory {
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((p) => p.test(content))) return rule.category;
  }
  return "general";
}
