"use client";

// ============================================================================
// /settings — notifications & digest opt-in (plan §4 /push, Priority 10)
//
// Client-side only: Web Push APIs don't exist during SSR, so state is read
// in an effect and every action is user-initiated (no permission prompt on
// page load — plan §7 UX hygiene).
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  getPushState,
  setDigestPreference,
  subscribeToPush,
  unsubscribeFromPush,
  type DigestChoice,
  type PushState,
} from "@/lib/push/client";

const DIGEST_OPTIONS: { value: DigestChoice; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "No digest" },
  { value: "daily", label: "Daily", hint: "Once a day" },
  { value: "weekly", label: "Weekly", hint: "Once a week" },
];

export default function SettingsPage() {
  const [state, setState] = useState<PushState | null>(null);
  const [digest, setDigest] = useState<DigestChoice>("off");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const refresh = useCallback(async () => {
    setState(await getPushState());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getPushState().then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(action: string, fn: () => Promise<void>) {
    setBusy(action);
    setError(null);
    try {
      await fn();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  const enabled = state?.subscribed ?? false;
  const unsupported = state?.permission === "unsupported";
  const denied = state?.permission === "denied";


  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
      <Link href="/" className="text-sm text-zinc-500 hover:text-emerald-600 dark:text-zinc-400">
         ← Home
      </Link>
      <h1 className="mt-2 text-2xl font-bold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Notifications are device-specific — enable them on each device you want reminders on.
      </p>

      {/* ------------------------------------------------ notifications -- */}
      <section className="mt-6 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Push notifications</h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              {unsupported
                ? "This browser doesn't support push notifications."
                : denied
                  ? "Permission was denied — re-enable notifications for this site in browser settings."
                  : enabled
                    ? "On — task reminders will fire at due time."
                    : "Off — enable to receive task reminders and digests."}
            </p>
          </div>
          <span
            className={`ml-3 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
              enabled
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"
                : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
          >
            {enabled ? "On" : "Off"}
          </span>
        </div>

        {!unsupported && !denied && (
          <div className="mt-4 flex gap-2">
            {!enabled ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run("enable", async () => {
                  await subscribeToPush();
                  await refresh();
                })}
                className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy === "enable" ? "Enabling…" : "Enable notifications"}
              </button>
            ) : (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run("disable", async () => {
                  await unsubscribeFromPush();
                  await refresh();
                })}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:border-red-400 hover:text-red-600 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-200"
              >
                {busy === "disable" ? "Disabling…" : "Disable on this device"}
              </button>
            )}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------- digest -- */}
      <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold">Digest</h2>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          A summary of open tasks — overdue, due today, and what&apos;s next. Requires notifications.
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Digest frequency">
          {DIGEST_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={digest === opt.value}
              disabled={busy !== null || !enabled}
              onClick={() => run("digest", async () => {
                await setDigestPreference(opt.value);
                setDigest(opt.value);
                setSavedFlash(true);
                setTimeout(() => setSavedFlash(false), 1500);
              })}
              className={`rounded-lg border px-2 py-2 text-xs font-semibold transition disabled:opacity-40 ${
                digest === opt.value
                  ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/40 dark:text-emerald-300"
                  : "border-zinc-200 text-zinc-600 hover:border-emerald-400 dark:border-zinc-700 dark:text-zinc-300"
              }`}
            >
              {opt.label}
              <span className="mt-0.5 block text-[10px] font-normal text-zinc-500 dark:text-zinc-400">
                {opt.hint}
              </span>
            </button>
          ))}
        </div>
        {!enabled && (
          <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
            Enable notifications first to pick a digest frequency.
          </p>
        )}
        {savedFlash && (
          <p className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400">Digest preference saved.</p>
        )}
      </section>

      {error && (
        <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
    </main>
  );
}
