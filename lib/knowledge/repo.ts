// ============================================================================
// Knowledge repo (plan Â§4 /knowledge: knowledge base CRUD + .md import)
//
// Offline-first: every write lands in the Dexie `knowledge` store via the
// shared putLocal path (stamps updated_at + dirty) and the sync engine carries
// it to Supabase. .md imports reuse the Â§5.3/Â§7 sanitization pipeline
// (lib/skills/sanitize.ts) â€” one validation path, no duplication.
// ============================================================================

import { newClientId, putLocal, softDeleteLocal } from "@/lib/db/repo";
import type { KnowledgeRow } from "@/lib/db/types";
import { sanitizeMarkdown, titleFromFilename } from "@/lib/skills/sanitize";

export interface ImportKnowledgeInput {
  name: string;
  text: string;
  /** Optional tags to attach (lowercased, deduped). */
  tags?: string[];
}

export interface KnowledgeWriteResult {
  ok: boolean;
  doc?: KnowledgeRow;
  /** Sanitizer warning (e.g. HTML stripped, size clamped) when present. */
  warning?: string;
  error?: string;
}

function normalizeTags(tags?: string[]): string[] {
  return [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
}

/** Create/edit a knowledge doc manually (title + content + tags). */
export async function saveKnowledgeDoc(input: {
  clientId?: string;
  title: string;
  content: string;
  tags?: string[];
  source?: string;
}): Promise<KnowledgeWriteResult> {
  const title = input.title.trim();
  const content = input.content.trim();
  if (title.length < 2) return { ok: false, error: "Title must be at least 2 characters" };
  if (content.length < 1) return { ok: false, error: "Content cannot be empty" };

  // Same Â§7 sanitization path as .md uploads â€” content later flows into prompts.
  const clean = sanitizeMarkdown(content);
  if (!clean.ok) return { ok: false, error: clean.error };

  const row: KnowledgeRow = {
    client_id: input.clientId ?? newClientId(),
    title,
    content: clean.content,
    tags: normalizeTags(input.tags),
    source: input.source ?? "manual",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const doc = await putLocal("knowledge", row);
  return { ok: true, doc, warning: clean.modified ? "content sanitized" : undefined };
}

/** Process an uploaded .md file into a knowledge doc (Â§4 .md import). */
export async function importKnowledgeFile(file: { name: string; text: string }, tags?: string[]): Promise<KnowledgeWriteResult> {
  const clean = sanitizeMarkdown(file.text);
  if (!clean.ok) return { ok: false, error: clean.error };
  const row: KnowledgeRow = {
    client_id: newClientId(),
    title: titleFromFilename(file.name),
    content: clean.content,
    tags: normalizeTags(tags),
    source: "md-import",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const doc = await putLocal("knowledge", row);
  return { ok: true, doc, warning: clean.modified ? "content sanitized" : undefined };
}

/** Inline edit (title/content/tags). */
export async function editKnowledgeDoc(
  clientId: string,
  patch: { title?: string; content?: string; tags?: string[] },
): Promise<KnowledgeWriteResult> {
  const db = (await import("@/lib/db/client")).getDb();
  const existing = await db.knowledge.get(clientId);
  if (!existing || existing.deleted_at) return { ok: false, error: "Knowledge doc not found" };

  const title = (patch.title ?? existing.title).trim();
  if (title.length < 2) return { ok: false, error: "Title must be at least 2 characters" };
  const content = (patch.content ?? existing.content).trim();
  if (content.length < 1) return { ok: false, error: "Content cannot be empty" };

  // Only sanitize when content actually changes (edits are user-authored text
  // that later flows into prompts â€” same Â§7 path).
  let cleanText = existing.content;
  let warning: string | undefined;
  if (patch.content !== undefined && patch.content.trim() !== existing.content) {
    const clean = sanitizeMarkdown(content);
    if (!clean.ok) return { ok: false, error: clean.error };
    cleanText = clean.content;
    warning = clean.modified ? "content sanitized" : undefined;
  }

  const doc = await putLocal("knowledge", {
    ...existing,
    title,
    content: cleanText,
    tags: patch.tags !== undefined ? normalizeTags(patch.tags) : existing.tags,
    updated_at: new Date().toISOString(),
  });
  return { ok: true, doc, warning };
}

/** Soft-delete (tombstone) â€” sync propagates; never hard-deleted (plan Â§3). */
export async function deleteKnowledgeDoc(clientId: string): Promise<void> {
  await softDeleteLocal("knowledge", clientId);
}

