// ============================================================================
// Offline full-text search engine (plan §4 /search + priority 6:
// "Full-text search spanning chat, memory, knowledge, and skills")
//
// Dexie / IndexedDB is the source of truth, so search runs locally over cached
// data (works in airplane mode). The engine is pure and testable: callers feed
// it normalized SearchDocuments (see lib/search/adapters.ts for the Dexie-row
// -> document mapping used by the UI; the verify script builds docs inline).
//
// Scoring (weighted, deterministic):
//   * exact multi-word phrase match  +6 overall, plus +6 title / +4 tags / +2 body
//   * per term: +2 title, +1.5 tags, +1 + small frequency bonus body
//   * recency: rows updated within 30 days get +0.5
//   * zero score => no match (dropped)
// Results sort by score desc, then updated_at desc.
// ============================================================================

export type SearchSource = "chat_history" | "memory" | "knowledge" | "skills";

export interface SearchDocument {
  source: SearchSource;
  clientId: string;
  /** Short heading for the result (knowledge/skill title, memory category, chat role). */
  title: string;
  /** Main body text to search and snippet from. */
  body: string;
  /** Secondary keywords (knowledge tags, skill trigger keywords). */
  tags: string[];
  updatedAt: string;
  /** Original Dexie row, kept for the UI to render extra fields. */
  row: Record<string, unknown>;
}

export interface TextSegment {
  text: string;
  hit: boolean;
}

export interface ScoredDocument {
  score: number;
  matchedFields: string[];
}

export interface ScoredResult {
  doc: SearchDocument;
  score: number;
  matchedFields: string[];
  snippet: TextSegment[];
}

/**
 * Normalize a string for matching: lowercase, strip latin combining accents,
 * collapse punctuation to single spaces, collapse whitespace. Length is NOT
 * preserved (NFD can decompose), so highlighting must operate on real text,
 * not normalized text.
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Keep letters, combining marks (Indic vowel signs like Bengali া are \p{M},
    // not \p{L}!), numbers, whitespace — everything else becomes a space.
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split into lowercase, whitespace-separated terms (empty input -> []). */
export function tokenize(text: string): string[] {
  const norm = normalizeText(text);
  return norm ? norm.split(" ") : [];
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Weighted score for one document; zero score means "no match". */
export function scoreDocument(doc: SearchDocument, terms: string[], phrase: string): ScoredDocument {
  const title = normalizeText(doc.title);
  const body = normalizeText(doc.body);
  const tags = normalizeText(doc.tags.join(" "));

  let score = 0;
  const matched = new Set<string>();

  // Exact multi-word phrase anywhere in the doc is a strong signal.
  if (phrase && terms.length > 1) {
    const all = `${title} ${body} ${tags}`;
    if (all.includes(phrase)) {
      score += 6;
      if (title.includes(phrase)) { score += 6; matched.add("title"); }
      if (tags.includes(phrase)) { score += 4; matched.add("tags"); }
      if (body.includes(phrase)) { score += 2; matched.add("body"); }
    }
  }

  for (const term of terms) {
    if (term && title.includes(term)) { score += 2; matched.add("title"); }
    if (term && tags.includes(term)) { score += 1.5; matched.add("tags"); }
    if (term) {
      const bodyCount = countOccurrences(body, term);
      if (bodyCount > 0) { score += 1 + Math.min(1, bodyCount * 0.25); matched.add("body"); }
    }
  }

  // Recency bonus only breaks ties among REAL matches — it must never create a
  // match out of thin air (a doc with zero term hits scores 0 regardless of age).
  if (score <= 0) return { score: 0, matchedFields: [] };

  const ageMs = Date.parse(doc.updatedAt);
  if (!Number.isNaN(ageMs)) {
    const days = (Date.now() - ageMs) / 86_400_000;
    if (days >= 0 && days < 30) score += 0.5;
  }

  const rounded = Math.round(score * 10) / 10;
  return { score: rounded, matchedFields: [...matched] };
}

/** Highlight occurrences of the query terms in real text (case-insensitive). */
export function highlight(text: string, terms: string[]): TextSegment[] {
  const patterns = terms
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (patterns.length === 0) return [{ text, hit: false }];
  const regex = new RegExp(patterns.join("|"), "gi");
  const segments: TextSegment[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > cursor) segments.push({ text: text.slice(cursor, m.index), hit: false });
    segments.push({ text: m[0], hit: true });
    cursor = m.index + m[0].length;
    if (m.index === regex.lastIndex) regex.lastIndex += 1;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}

/**
 * A short window of text around the first hit in the best-matching field,
 * with hits marked. Default window: 80 chars before, 40 after.
 */
export function makeSnippet(
  doc: SearchDocument,
  terms: string[],
  phrase: string,
  window = 80,
): TextSegment[] {
  const fields = [doc.title, doc.body, doc.tags.join(" ")];
  const searchIn =
    fields.find((field) => {
      const lt = field.toLowerCase();
      if (phrase && terms.length > 1 && lt.includes(phrase)) return true;
      return terms.some((t) => t && lt.includes(t));
    }) ?? doc.body;

  let idx = -1;
  const lt = searchIn.toLowerCase();
  if (phrase && terms.length > 1) idx = lt.indexOf(phrase);
  if (idx === -1) {
    for (const t of terms) {
      const i = t ? lt.indexOf(t) : -1;
      if (i !== -1 && (idx === -1 || i < idx)) idx = i;
    }
  }
  if (idx === -1) return highlight(searchIn.slice(0, 400), terms);

  const start = Math.max(0, idx - window / 2);
  const end = Math.min(searchIn.length, idx + window / 2 + 40);
  const raw =
    (start > 0 ? "…" : "") +
    searchIn.slice(start, end) +
    (end < searchIn.length ? "…" : "");
  return highlight(raw, terms);
}

/** Search a set of documents, returning ranked scored results. */
export function searchDocuments(
  docs: SearchDocument[],
  query: string,
  opts: { limit?: number } = {},
): ScoredResult[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const phrase = normalizeText(query);
  const results: ScoredResult[] = [];

  for (const doc of docs) {
    const { score, matchedFields } = scoreDocument(doc, terms, phrase);
    if (score <= 0) continue;
    results.push({ doc, score, matchedFields, snippet: makeSnippet(doc, terms, phrase) });
  }

  results.sort(
    (a, b) => b.score - a.score || Date.parse(b.doc.updatedAt) - Date.parse(a.doc.updatedAt),
  );
  return results.slice(0, opts.limit ?? 50);
}