// ============================================================================
// Tone profiler (plan §5.1 — port of extension src/lib/tone-profiler.ts)
//
// Detects Bengali Unicode / Banglish patterns in the incoming message and
// returns the language mode the system prompt must adopt. Pure function —
// no I/O, safe on server and client.
// ============================================================================

export type LanguageMode = "bengali" | "banglish" | "english";

/** Bengali Unicode block (U+0980–U+09FF). */
const BENGALI_RE = /[\u0980-\u09FF]/;

/**
 * Common Banglish (Bengali written in Latin script) words. Matching is done on
 * word boundaries so English words like "amend" don't trip "amar".
 */
const BANGLISH_WORDS = [
  "amar", "amake", "ami", "tumi", "tui", "apni", "apnar", "tomar",
  "koro", "koren", "kori", "korbo", "korchen", "hobe", "holo", "hocche",
  "keno", "ki", "kivabe", "kothay", "kemon", "bhalo", "valo", "kharap",
  "dorkar", "lagbe", "ache", "chilo", "korchi", "korlam", "dibo", "dao",
  "janlo", "jani", "thik", "ache", "sondro", "shundo",
  "kaj", "tuk", "taka", "poisha", "din", "son", "ajke", "agami",
];

function countBanglish(text: string): number {
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.filter((w) => BANGLISH_WORDS.includes(w)).length;
}

/**
 * Classify the language mode of a user message:
 *  - any Bengali-script characters → "bengali"
 *  - ≥2 Banglish word hits → "banglish" (mixed; reply in the same style)
 *  - otherwise → "english"
 */
export function detectLanguageMode(message: string): LanguageMode {
  if (BENGALI_RE.test(message)) return "bengali";
  return countBanglish(message) >= 2 ? "banglish" : "english";
}
