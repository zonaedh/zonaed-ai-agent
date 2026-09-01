// ============================================================================
// Skill upload pipeline (plan §5.3)
//
// Local-first: Dexie is the source of truth, so uploads are validated +
// sanitized + written client-side; the §3 sync engine carries them to Supabase
// (and the extension reads them via /api/sync/pull). The chat preamble builder
// (lib/ai/matching.ts) picks them up for injection on the next message.
//
// Versioning rule (§5.3): re-uploading a file with the same title creates a
// NEW version (version+1) rather than destroying the previous content — the
// old text is archived into the sync engine's conflict_archive first, so the
// "no silent overwrite / no hard deletes" posture holds end-to-end.
// ============================================================================
import { getDb } from "../db/client";
import { listLive, newClientId, putLocal } from "../db/repo";
import type { SkillRow } from "../db/types";
import { MAX_TITLE_LENGTH, sanitizeMarkdown, titleFromFilename } from "./sanitize";

export interface UploadOutcome {
  ok: boolean;
  skill?: SkillRow;
  /** Which previous version (if any) this upload superseded. */
  replacedVersion?: number;
  error?: string;
  warning?: string;
}

/**
 * Process an uploaded .md file into a (possibly versioned) skill row.
 * Returns the stored row; callers can then rely on the scheduler to sync it.
 */
export async function uploadSkillFile(
  file: { name: string; text: string },
  options: { triggerKeywords?: string[]; active?: boolean } = {},
): Promise<UploadOutcome> {
  const sanitized = sanitizeMarkdown(file.text);
  if (!sanitized.ok) {
    return { ok: false, error: sanitized.error };
  }

  const db = getDb();
  const title = titleFromFilename(file.name).slice(0, MAX_TITLE_LENGTH);

  // §5.3: same title → bump version on the existing row, keep client_id stable
  // (so the same remote row is versioned up), archive the old body first.
  const existing = (await listLive<SkillRow>("skills")).find(
    (s) => s.title.toLowerCase() === title.toLowerCase(),
  );

  let replacedVersion: number | undefined;
  if (existing) {
    replacedVersion = existing.version;
    await db.conflict_archive.add({
      table: "skills",
      client_id: existing.client_id,
      losing: existing as unknown as Record<string, unknown>,
      winning: { note: "superseded by re-upload (§5.3 versioning)" },
      resolved_at: new Date().toISOString(),
    });
  }

  const now = new Date().toISOString();
  const row: SkillRow = {
    client_id: existing?.client_id ?? newClientId(),
    title,
    content: sanitized.content,
    trigger_keywords: options.triggerKeywords ?? existing?.trigger_keywords ?? [],
    source: "upload",
    version: (existing?.version ?? 0) + 1,
    active: options.active ?? existing?.active ?? true,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };

  const stored = await putLocal("skills", row);
  return {
    ok: true,
    skill: stored,
    replacedVersion,
    warning: sanitized.modified ? "Sanitized: scripts/HTML or invisible characters were removed" : undefined,
  };
}

/** Toggle a skill on/off without a version bump (activation is not a content change). */
export async function setSkillActive(clientId: string, active: boolean): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  await db.table("skills").update(clientId, { active, updated_at: now, dirty: 1 });
}

/** Edit a skill's content/keywords — does NOT bump version (explicit edit, not re-upload). */
export async function editSkill(
  clientId: string,
  patch: { content?: string; trigger_keywords?: string[] },
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  await db.table("skills").update(clientId, { ...patch, updated_at: now, dirty: 1 });
}
