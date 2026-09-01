// ============================================================================
// Sync scheduler + status store (plan §9 Priority 2 "sync status UI")
//
// Browser-only glue around the pure engine: owns the zustand status store the
// UI reads, runs syncAll against the real Supabase session, and auto-syncs on
// load, on `online`, and on an interval. Never import this from server code.
// ============================================================================
"use client";

import { create } from "zustand";
import { getDb } from "../db/client";
import { getSupabaseBrowserClient, ensureSupabaseSession } from "../auth/supabase";
import { syncAll, type SyncResult } from "./engine";

export type SyncPhase = "idle" | "syncing" | "error" | "offline";

export interface SyncStatusState {
  phase: SyncPhase;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** Rows still awaiting push (aggregate dirty count). */
  pendingPush: number;
  lastResult: SyncResult | null;
  set: (patch: Partial<Omit<SyncStatusState, "set">>) => void;
}

export const useSyncStore = create<SyncStatusState>((set) => ({
  phase: "idle",
  lastSyncedAt: null,
  lastError: null,
  pendingPush: 0,
  lastResult: null,
  set: (patch) => set(patch),
}));

// Module-level lock: a sync run must never overlap itself (interval + manual
// button + online event can all fire close together).
let syncing: Promise<void> | null = null;

async function countPending(): Promise<number> {
  const db = getDb();
  let total = 0;
  for (const t of ["tasks", "memory", "knowledge", "chat_history", "skills", "examples"] as const) {
    total += await db.table(t).where("dirty").equals(1).count();
  }
  return total;
}

/** Run one full sync cycle and update the status store. Safe to call repeatedly. */
export async function syncNow(): Promise<void> {
  if (syncing) return syncing;
  const store = useSyncStore.getState();
  store.set({ phase: "syncing", lastError: null });
  syncing = (async () => {
    try {
      const supabase = getSupabaseBrowserClient();
      // Signs in anonymously on first run; the session lives on the shared
      // browser client (persistSession: true), so the client below is bound.
      await ensureSupabaseSession();
      const { data } = await supabase.auth.getSession();
      const userId = data.session?.user.id;
      if (!userId) throw new Error("No Supabase session available after sign-in");
      const db = getDb();
      const result = await syncAll(db, supabase, userId);
      useSyncStore.getState().set({
        phase: "idle",
        lastSyncedAt: result.syncedAt,
        lastError: null,
        pendingPush: 0,
        lastResult: result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const offline = typeof navigator !== "undefined" && !navigator.onLine;
      const pendingPush = await countPending().catch(() => 0);
      useSyncStore.getState().set({
        phase: offline ? "offline" : "error",
        lastError: offline ? null : message,
        pendingPush,
      });
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/**
 * Kick off auto-sync (idempotent): initial run + every SYNC_INTERVAL_MS +
 * whenever the browser comes back online. Call once from a client component.
 */
const SYNC_INTERVAL_MS = 60_000;
let initialized = false;

export function initAutoSync(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  void syncNow();
  window.setInterval(() => void syncNow(), SYNC_INTERVAL_MS);
  window.addEventListener("online", () => void syncNow());
  window.addEventListener("offline", () => {
    useSyncStore.getState().set({ phase: "offline" });
  });
}
