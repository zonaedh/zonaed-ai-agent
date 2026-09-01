// ============================================================================
// Anti-cliché filter (plan §5.1 — extension vocabulary/punctuation rules port)
//
// Two hard rules enforced identically on webapp output:
//   1. Punctuation: no em-dashes or en-dashes ( — / – ), ever.
//   2. Vocabulary: no AI-cliché words (delve, testament, tapestry, ...).
//
// The system prompt states the rules (prevention); scanOutput catches
// violations after generation so the route can strip punctuation and surface
// vocabulary hits for a one-shot retry.
// ============================================================================

/** Plan §5.1 banned word list (case-insensitive, word-boundary matched). */
export const BANNED_WORDS = [
  "delve",
  "testament",
  "tapestry",
  "embark",
  "furthermore",
  "moreover",
  "beacon",
  "game-changer",
] as const;

const DASHES = /[\u2014\u2013]/g; // em-dash, en-dash

export interface OutputScan {
  /** Banned words found (lowercased). */
  bannedWords: string[];
  /** Number of em/en dashes found. */
  dashes: number;
  clean: boolean;
}

function wordHits(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_WORDS.filter((w) =>
    new RegExp(`(^|[^\\p{L}])${w.replace("-", "[\\s-]*")}([^\\p{L}]|$)`, "u").test(lower),
  );
}

/** Scan generated text for anti-cliché violations. */
export function scanOutput(text: string): OutputScan {
  const bannedWords = wordHits(text);
  const dashes = (text.match(DASHES) ?? []).length;
  return { bannedWords, dashes, clean: bannedWords.length === 0 && dashes === 0 };
}

/**
 * Sanitize generated text: replace banned dashes with ", " (em-dash) / "-"
 * fallback so meaning survives. Vocabulary violations are NOT auto-rewritten
 * (meaning could change); callers decide whether to retry with a stronger
 * system message based on scanOutput().
 */
export function sanitizeDashes(text: string): string {
  return text.replace(DASHES, ", ").replace(/, {2,}/g, ", ").replace(/,\s*,/g, ",");
}
