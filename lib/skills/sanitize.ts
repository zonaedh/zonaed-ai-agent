// ============================================================================
// Markdown upload sanitization (plan §5.3 + §7: ".md upload: file size limit
// + content sanitization before storage/render — applies to both /knowledge
// imports and /skills uploads")
//
// Uploaded skill/knowledge files are user-supplied text that later flows into
// AI prompts and is rendered in the UI, so it is sanitized to plain markdown:
//   * no scripts/HTML (XSS via rendered markdown),
//   * no control characters / zero-width tricks (prompt-injection hygiene),
//   * hard byte cap so one upload can't bloat the synced row or the prompt.
// ============================================================================

/** 200 KB per file — generous for a skill/SOP doc, small enough to sync well. */
export const MAX_UPLOAD_BYTES = 200 * 1024;

/** Title cap; anything longer is useless in a list UI or prompt header. */
export const MAX_TITLE_LENGTH = 200;

export interface SanitizeResult {
  ok: boolean;
  /** Sanitized content (only meaningful when ok). */
  content: string;
  /** Rejected-file reason (only meaningful when !ok). */
  error?: string;
  /** True when bytes/characters were modified during sanitization. */
  modified: boolean;
}

/** Characters that must never survive into stored markdown. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** Zero-width and bidi-override characters (invisible prompt-injection vectors). */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/**
 * Strip HTML/script payloads from markdown, keeping the text content.
 * Handles paired tags, self-closing tags, comments, and the raw `<script>` /
 * `<iframe>` family (dropped together with their inner content).
 */
export function stripHtml(markdown: string): string {
  let out = markdown;
  // Dangerous containers: drop the whole element including its content.
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  out = out.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, "");
  out = out.replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, "");
  out = out.replace(/<embed\b[^>]*>[\s\S]*?<\/embed\s*>/gi, "");
  // Inline event handlers (on*)
  out = out.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // javascript:/vbscript: URLs in markdown link/image syntax and raw attributes
  out = out.replace(/(href|src)\s*=\s*("\s*(javascript|vbscript|data):[^"]*"|'\s*(javascript|vbscript|data):[^']*'|\s*(javascript|vbscript|data):[^\s>]*)/gi, "");
  out = out.replace(/\]\(\s*(javascript|vbscript|data):[^)]*\)/gi, "]()");
  // Remaining tags → remove the tag, keep the inner text
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  return out;
}

/** Sanitize an uploaded markdown payload end-to-end. */
export function sanitizeMarkdown(raw: string, maxBytes = MAX_UPLOAD_BYTES): SanitizeResult {
  if (typeof raw !== "string") {
    return { ok: false, content: "", error: "File content must be text", modified: false };
  }
  const byteLength = new TextEncoder().encode(raw).length;
  if (byteLength === 0) {
    return { ok: false, content: "", error: "File is empty", modified: false };
  }
  if (byteLength > maxBytes) {
    return {
      ok: false,
      content: "",
      error: `File is ${(byteLength / 1024).toFixed(0)} KB; the limit is ${(maxBytes / 1024).toFixed(0)} KB`,
      modified: false,
    };
  }

  const cleaned = stripHtml(raw)
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_CHARS, "")
    .replace(/\r\n/g, "\n")
    .trimEnd();

  return { ok: true, content: cleaned, modified: cleaned !== raw.replace(/\r\n/g, "\n").trimEnd() };
}

/** Derive a display title from a filename ("my-sop.md" → "My Sop") or content H1. */
export function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
  const title = base.slice(0, MAX_TITLE_LENGTH);
  return title.length > 0 ? title.charAt(0).toUpperCase() + title.slice(1) : "Untitled skill";
}
