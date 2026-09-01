// ============================================================================
// Syncable row types (plan §3, §9 Priority 2)
//
// Every syncable table mirrors its Supabase counterpart 1:1 (snake_case on
// purpose: rows flow to/from PostgREST without mapping). Local rows additionally
// carry `dirty` — set by every local mutation, cleared only after a successful
// push — and use client_id as the primary key (unique per user on-device).
//
// Timestamps are ISO-8601 strings so they are IndexedDB-serializable and
// JSON-safe; ordering MUST be compared via Date.parse() (remote Postgres
// returns "+00:00" offsets, local produces "Z" — never compare lexically).
// ============================================================================

/** Fields shared by every syncable row. */
export interface SyncBase {
  /** Remote row id (uuid). Filled from the server after first pull/push. */
  id?: string;
  /** Owner (auth.uid()). Filled from the session; never user-suppliable. */
  user_id?: string;
  /** Device-generated unique id — the Dexie primary key. */
  client_id: string;
  created_at?: string;
  updated_at: string;
  deleted_at?: string;
  /** Local-only: 1 = changed since last successful push. Not sent to Supabase. */
  dirty?: 0 | 1;
}

export interface TaskRow extends SyncBase {
  title: string;
  notes?: string;
  due_at?: string;
  /** Recurrence rule (RRULE-ish JSON); null = one-off. */
  recurrence?: Record<string, unknown>;
  completed: boolean;
  completed_at?: string;
}

export interface MemoryRow extends SyncBase {
  content: string;
  category: string;
  /** manual | conversation | learn-review */
  source: string;
}

export interface KnowledgeRow extends SyncBase {
  title: string;
  content: string;
  tags: string[];
  /** manual | md-import */
  source: string;
}

export interface ChatMessageRow extends SyncBase {
  session_id: string;
  /** user | assistant | system */
  role: string;
  content: string;
  provider?: string;
  model?: string;
}

export interface SkillRow extends SyncBase {
  title: string;
  /** Sanitized markdown. */
  content: string;
  /** Empty array = always-on skill (plan §5.1/§5.3). */
  trigger_keywords: string[];
  /** trigger | upload */
  source: string;
  /** Re-upload bumps version, never destroys (plan §5.3). */
  version: number;
  active: boolean;
}

export interface ExampleRow extends SyncBase {
  input: string;
  output: string;
  context?: string;
  tags: string[];
}

/** Per-table sync bookkeeping (Dexie-only, never synced). */
export interface SyncStateRow {
  /** Table name — primary key. */
  table: SyncableTableName;
  /** Watermark: only rows with updated_at > this are fetched on pull. */
  last_pulled_at: string | null;
  last_synced_at: string | null;
}

/** Local-only archive of versions that lost an LWW conflict (plan §3: never silently dropped). */
export interface ConflictArchiveRow {
  seq?: number;
  table: SyncableTableName;
  /** The client_id of the row that was overwritten. */
  client_id: string;
  /** The losing row payload exactly as it was locally. */
  losing: Record<string, unknown>;
  /** The winning row payload (the one that took precedence). */
  winning: Record<string, unknown>;
  resolved_at: string;
}

export const SYNCABLE_TABLES = [
  "tasks",
  "memory",
  "knowledge",
  "chat_history",
  "skills",
  "examples",
] as const;

export type SyncableTableName = (typeof SYNCABLE_TABLES)[number];

export function isSyncableTable(value: unknown): value is SyncableTableName {
  return typeof value === "string" && (SYNCABLE_TABLES as readonly string[]).includes(value);
}

export type SyncableRow = TaskRow | MemoryRow | KnowledgeRow | ChatMessageRow | SkillRow | ExampleRow;
