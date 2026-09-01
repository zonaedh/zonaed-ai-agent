"use client";

// ============================================================================
// SyncIndicator (plan §9 Priority 2 "sync status UI")
//
// Fixed bottom-right pill showing sync phase; click = sync now. Mounted once
// in the root layout; it also boots the auto-sync scheduler on first render.
// ============================================================================
import { useEffect } from "react";
import { initAutoSync, syncNow, useSyncStore } from "@/lib/sync/scheduler";

const LABEL: Record<string, string> = {
  idle: "Synced",
  syncing: "Syncing…",
  error: "Sync error",
  offline: "Offline",
};

const DOT: Record<string, string> = {
  idle: "bg-emerald-500",
  syncing: "bg-amber-400 animate-pulse",
  error: "bg-red-500",
  offline: "bg-zinc-400",
};

export default function SyncIndicator() {
  const phase = useSyncStore((s) => s.phase);
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt);
  const lastError = useSyncStore((s) => s.lastError);
  const pendingPush = useSyncStore((s) => s.pendingPush);

  useEffect(() => {
    initAutoSync();
  }, []);

  const label = LABEL[phase] ?? phase;
  const title =
    phase === "error"
      ? `Sync error: ${lastError ?? "unknown"}`
      : lastSyncedAt
        ? `Last synced ${new Date(lastSyncedAt).toLocaleTimeString()} — click to sync now`
        : "Click to sync now";

  return (
    <button
      type="button"
      onClick={() => void syncNow()}
      title={title}
      aria-live="polite"
      className="fixed right-3 z-50 flex items-center gap-2 rounded-full border border-zinc-200 bg-white/90 px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-sm backdrop-blur transition hover:bg-white dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-300 dark:hover:bg-zinc-900 ios-safe-bottom-float"
    >
      <span aria-hidden className={`h-2 w-2 rounded-full ${DOT[phase] ?? "bg-zinc-400"}`} />
      <span>{label}</span>
      {pendingPush > 0 && phase !== "syncing" && (
        <span className="rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
          {pendingPush} pending
        </span>
      )}
    </button>
  );
}
