// ============================================================================
// Local CRUD (plan §3, §9 Priority 2)
//
// ALL UI writes go through here — never db.tasks.put() directly — so that:
//   * updated_at is always stamped (LWW arbitration depends on it),
//   * dirty is set (the sync engine's push signal),
//   * "delete" always means soft-delete (deleted_at), never a row removal.
// Rows marked deleted_at stay locally (and remotely) as tombstones; UI queries
// must filter them out (see listLive / getLive).
// ============================================================================
import { getDb, type ZonaedDb } from "./client";
import type { SyncBase, SyncableRow, SyncableTableName } from "./types";

function table(db: ZonaedDb, name: SyncableTableName) {
  return db.table(name);
}

/** Stamp sync bookkeeping onto a row before writing. */
function stamp<T extends SyncBase>(row: T, now: string): T {
  return { ...row, updated_at: now, dirty: 1 };
}

/** Insert or update a row locally (marks it dirty for the next push). */
export async function putLocal<T extends SyncableRow>(tableName: SyncableTableName, row: T): Promise<T> {
  const db = getDb();
  const now = new Date().toISOString();
  const next = stamp(row, now);
  await table(db, tableName).put(next);
  return next;
}

/** Soft-delete: sets deleted_at + dirty. The row is never removed (plan §3). */
export async function softDeleteLocal(tableName: SyncableTableName, clientId: string): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  await table(db, tableName).update(clientId, { deleted_at: now, updated_at: now, dirty: 1 });
}

/** Live (non-deleted) rows, newest update first. Use this in the UI. */
export async function listLive<T extends SyncableRow>(tableName: SyncableTableName): Promise<T[]> {
  const db = getDb();
  const rows = (await table(db, tableName).toArray()) as T[];
  return rows
    .filter((r) => !r.deleted_at)
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

/** Single live row by client_id, or null if missing/soft-deleted. */
export async function getLive<T extends SyncableRow>(
  tableName: SyncableTableName,
  clientId: string,
): Promise<T | null> {
  const db = getDb();
  const row = (await table(db, tableName).get(clientId)) as T | undefined;
  if (!row || row.deleted_at) return null;
  return row;
}

/** Generate a device-unique client_id. */
export function newClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // Non-secure fallback (old browsers): timestamp + random — uniqueness is what matters.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
