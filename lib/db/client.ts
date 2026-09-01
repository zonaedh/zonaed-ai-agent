// ============================================================================
// Dexie database (plan §3, §9 Priority 2)
//
// Dexie/IndexedDB is the on-device source of truth; Supabase is the sync/backup
// layer. All UI reads/writes go through lib/db/repo.ts (which stamps
// updated_at + dirty so the sync engine can pick up changes).
//
// client_id is the primary key of every syncable store (unique per user on a
// device; the (user_id, client_id) uniqueness across users lives in Supabase).
// sync_state / conflict_archive are local-only bookkeeping tables.
// ============================================================================
import Dexie, { type EntityTable } from "dexie";
import {
  type ChatMessageRow,
  type ConflictArchiveRow,
  type ExampleRow,
  type KnowledgeRow,
  type MemoryRow,
  type SkillRow,
  type SyncStateRow,
  type TaskRow,
} from "./types";

export interface ZonaedDb extends Dexie {
  tasks: EntityTable<TaskRow, "client_id">;
  memory: EntityTable<MemoryRow, "client_id">;
  knowledge: EntityTable<KnowledgeRow, "client_id">;
  chat_history: EntityTable<ChatMessageRow, "client_id">;
  skills: EntityTable<SkillRow, "client_id">;
  examples: EntityTable<ExampleRow, "client_id">;
  sync_state: EntityTable<SyncStateRow, "table">;
  conflict_archive: EntityTable<ConflictArchiveRow, "seq">;
}

let db: ZonaedDb | null = null;

/**
 * Singleton database handle. Safe in the browser; in Node (tests/scripts)
 * import "fake-indexeddb/auto" first.
 */
export function getDb(): ZonaedDb {
  if (db) return db;
  db = new Dexie("zonaed-ai-agent") as ZonaedDb;
  db.version(1).stores({
    // Indexes only — non-indexed fields are stored as-is.
    tasks: "client_id, updated_at, due_at, session_id, dirty, deleted_at",
    memory: "client_id, updated_at, category, dirty, deleted_at",
    knowledge: "client_id, updated_at, dirty, deleted_at",
    chat_history: "client_id, session_id, created_at, updated_at, dirty, deleted_at",
    skills: "client_id, updated_at, dirty, deleted_at",
    examples: "client_id, updated_at, dirty, deleted_at",
    sync_state: "table",
    conflict_archive: "++seq, table, client_id, resolved_at",
  });
  return db;
}
