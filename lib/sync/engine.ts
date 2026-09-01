// ============================================================================
// Sync engine (plan §3, §9 Priority 2)
//
// Direction:  Dexie (source of truth)  ⇄  Supabase Postgres (sync/backup)
//
// Rules enforced here:
//   * LWW by updated_at (compared as epoch ms — never lexically, remote
//     Postgres timestamps carry "+00:00" while local ones carry "Z").
//   * A local row that loses a conflict is ARCHIVED into conflict_archive
//     before being overwritten — losing versions are never silently dropped.
//   * Deletion is a tombstone (deleted_at) in both directions; no hard deletes.
//   * Pull uses a watermark with a 2s re-fetch overlap; LWW makes the overlap
//     idempotent, so no update can be missed by a boundary race.
//
// This module is pure (db + supabase client injected) so it runs identically in
// the browser and in Node-based verification scripts. lib/sync/scheduler.ts
// wraps it with the status store + auto-sync timers.
// ============================================================================
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ZonaedDb } from "../db/client";
import {
  SYNCABLE_TABLES,
  type SyncBase,
  type SyncableRow,
  type SyncableTableName,
} from "../db/types";

const PAGE_SIZE = 500;
/** Re-fetch window on every pull; LWW makes duplicates harmless. */
const PULL_OVERLAP_MS = 2_000;

export type TableResult = { table: SyncableTableName; pulled: number; pushed: number };

export type SyncResult = {
  tables: TableResult[];
  archivedConflicts: number;
  syncedAt: string;
};

// ---------------------------------------------------------------------------
// LWW
// ---------------------------------------------------------------------------

/** Milliseconds for an ISO timestamp (Date.parse; NaN-safe guard for garbage). */
function tsMs(value: string | undefined | null): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

export type LwwWinner = "local" | "remote";

/**
 * Last-write-wins by updated_at. Ties go to the row with the later tombstone
 * state (deletions are real writes) and finally to remote, so both devices
 * converge on the same value.
 */
export function resolveLww(local: SyncBase, remote: SyncBase): LwwWinner {
  const l = tsMs(local.updated_at);
  const r = tsMs(remote.updated_at);
  if (l !== r) return l > r ? "local" : "remote";
  const lDeleted = local.deleted_at ? 1 : 0;
  const rDeleted = remote.deleted_at ? 1 : 0;
  if (lDeleted !== rDeleted) return lDeleted > rDeleted ? "local" : "remote";
  return "remote";
}

/** Strip local-only fields and undefined values before sending a row to Supabase. */
function toRemote(row: SyncableRow, userId: string): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...row };
  delete rest.dirty;
  const cleaned: Record<string, unknown> = { user_id: userId };
  for (const [key, value] of Object.entries(rest)) {
    // undefined must NOT be sent: PostgREST would treat it as an explicit NULL,
    // which breaks not-null defaults (e.g. id) on locally-created rows.
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

/** Archive a losing local version (plan §3: never silently drop data). */
async function archiveLoser(
  db: ZonaedDb,
  tableName: SyncableTableName,
  local: SyncableRow,
  winning: Record<string, unknown>,
): Promise<void> {
  await db.conflict_archive.add({
    table: tableName,
    client_id: local.client_id,
    losing: local as unknown as Record<string, unknown>,
    winning,
    resolved_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

async function fetchRemotePages(
  supabase: SupabaseClient,
  tableName: SyncableTableName,
  since: string | null,
): Promise<SyncableRow[]> {
  const rows: SyncableRow[] = [];
  let offset = 0;
  for (;;) {
    let query = supabase.from(tableName).select("*").order("updated_at").order("client_id");
    if (since) query = query.gt("updated_at", since);
    query = query.range(offset, offset + PAGE_SIZE - 1);
    const { data, error } = await query;
    if (error) throw new Error(`Pull ${tableName} failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as SyncableRow[]));
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

/**
 * Fetch remote changes for one table and merge them into Dexie under LWW.
 * Returns the number of remote rows applied into the local store.
 */
export async function pullTable(
  db: ZonaedDb,
  supabase: SupabaseClient,
  tableName: SyncableTableName,
): Promise<number> {
  const state =
    (await db.sync_state.get(tableName)) ??
    { table: tableName, last_pulled_at: null, last_synced_at: null };
  const since = state.last_pulled_at
    ? new Date(tsMs(state.last_pulled_at) - PULL_OVERLAP_MS).toISOString()
    : null;

  const remoteRows = await fetchRemotePages(supabase, tableName, since);
  let applied = 0;

  for (const remote of remoteRows) {
    const local = await db.table(tableName).get(remote.client_id);
    if (!local) {
      // New on the server → store as clean (already synced).
      await db.table(tableName).put({ ...remote, dirty: 0 } as SyncableRow);
      applied += 1;
      continue;
    }
    const winner = resolveLww(local as SyncBase, remote as SyncBase);
    if (winner === "remote") {
      if ((local as SyncBase).dirty === 1) {
        // Local had unsynced changes that just lost — archive before overwriting.
        await archiveLoser(db, tableName, local as SyncableRow, remote as unknown as Record<string, unknown>);
      }
      await db.table(tableName).put({ ...remote, dirty: 0 } as SyncableRow);
      applied += 1;
    } else if ((local as SyncBase).dirty !== 1) {
      // Local wins but is not marked dirty (e.g. watermark overlap) → it must
      // push, otherwise the remote row would keep shadowing it.
      await db.table(tableName).update(local.client_id, { dirty: 1 });
    }
    // equal → keep the local row exactly as-is (idempotent overlap).
  }

  const maxSeen = remoteRows.reduce<string | null>(
    (max, r) => (max === null || tsMs(r.updated_at) > tsMs(max) ? r.updated_at : max),
    null,
  );
  if (maxSeen && (!state.last_pulled_at || tsMs(maxSeen) > tsMs(state.last_pulled_at))) {
    state.last_pulled_at = maxSeen;
  }
  state.last_synced_at = new Date().toISOString();
  await db.sync_state.put(state);
  return applied;
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/**
 * Send local dirty rows for one table to Supabase (upsert on
 * (user_id, client_id)), carrying their local updated_at for LWW arbitration.
 * Rows are marked clean only after a successful upsert.
 */
export async function pushTable(
  db: ZonaedDb,
  supabase: SupabaseClient,
  tableName: SyncableTableName,
  userId: string,
): Promise<number> {
  const dirtyRows = (await db.table(tableName).where("dirty").equals(1).toArray()) as SyncableRow[];
  if (dirtyRows.length === 0) return 0;

  let pushed = 0;
  for (let i = 0; i < dirtyRows.length; i += PAGE_SIZE) {
    const chunk = dirtyRows.slice(i, i + PAGE_SIZE).map((r) => toRemote(r, userId));
    const { error } = await supabase.from(tableName).upsert(chunk, { onConflict: "user_id,client_id" });
    if (error) throw new Error(`Push ${tableName} failed: ${error.message}`);
    pushed += chunk.length;
  }

  // Mark clean — but only if the row was not edited again while the request
  // was in flight (its updated_at would then be newer than what we pushed).
  for (const row of dirtyRows) {
    const fresh = (await db.table(tableName).get(row.client_id)) as SyncableRow | undefined;
    if (fresh && tsMs(fresh.updated_at) === tsMs(row.updated_at)) {
      await db.table(tableName).update(row.client_id, { dirty: 0 });
    }
  }
  return pushed;
}

// ---------------------------------------------------------------------------
// Full sync
// ---------------------------------------------------------------------------

/** Pull + push every syncable table. Throws on the first failure (caller decides retry policy). */
export async function syncAll(db: ZonaedDb, supabase: SupabaseClient, userId: string): Promise<SyncResult> {
  const results: TableResult[] = [];

  for (const tableName of SYNCABLE_TABLES) {
    const pulled = await pullTable(db, supabase, tableName);
    const pushed = await pushTable(db, supabase, tableName, userId);
    results.push({ table: tableName, pulled, pushed });
  }

  const archivedConflicts = await db.conflict_archive.count();
  const syncedAt = new Date().toISOString();
  return { tables: results, archivedConflicts, syncedAt };
}

