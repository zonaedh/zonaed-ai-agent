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
import { authedFetch } from "@/lib/auth/app-session";
import {
  getPushState,
  setDigestPreference,
  subscribeToPush,
  unsubscribeFromPush,
  type DigestChoice,
  type PushState,
} from "@/lib/push/client";
import PageNav from "@/app/components/PageNav";

const DIGEST_OPTIONS: { value: DigestChoice; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "No digest" },
  { value: "daily", label: "Daily", hint: "Once a day" },
  { value: "weekly", label: "Weekly", hint: "Once a week" },
];

interface TokenInfo {
  id: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
}

async function mintToken(
  label: string,
  setFresh: (t: string) => void,
  reload: () => Promise<void>,
): Promise<void> {
  const res = await authedFetch("/api/settings/sync-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  const json = (await res.json()) as { token?: string; error?: string };
  if (!res.ok || !json.token) throw new Error(json.error ?? `HTTP ${res.status}`);
  setFresh(json.token);
  await reload();
}

async function revokeToken(
  id: string,
  reload: () => Promise<void>,
): Promise<void> {
  const res = await authedFetch("/api/settings/sync-tokens", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(json?.error ?? `HTTP ${res.status}`);
  }
  await reload();
}

export default function SettingsPage() {
  const [state, setState] = useState<PushState | null>(null);
  const [digest, setDigest] = useState<DigestChoice>("off");
  const [learnEnabled, setLearnEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [learnFlash, setLearnFlash] = useState(false);
  // Extension sync tokens (E1): list + mint + revoke.
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [tokenLabel, setTokenLabel] = useState("");
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);

  const refresh = useCallback(async () => {
    setState(await getPushState());
  }, []);

  const loadTokens = useCallback(async () => {
    try {
      const res = await authedFetch("/api/settings/sync-tokens");
      if (!res.ok) return;
      const json = (await res.json()) as { tokens?: TokenInfo[] };
      setTokens(json.tokens ?? []);
    } catch {
      /* offline / unauthenticated — section just stays empty */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getPushState().then((s) => {
      if (!cancelled) setState(s);
    });
    // Learning opt-in lives server-side (synced, per-account).
    void authedFetch("/api/learn/preferences").then(async (res) => {
      if (cancelled || !res.ok) return;
      const json = (await res.json()) as { enabled: boolean };
      if (!cancelled) setLearnEnabled(json.enabled);
    });
    // Extension sync tokens list (E1) — async-.then pattern (no sync setState).
    void authedFetch("/api/settings/sync-tokens").then(async (res) => {
      if (cancelled || !res.ok) return;
      const json = (await res.json()) as { tokens?: TokenInfo[] };
      if (!cancelled) setTokens(json.tokens ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleLearn() {
    if (learnEnabled === null) return;
    await run("learn", async () => {
      const res = await authedFetch("/api/learn/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !learnEnabled }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? "Could not update learning preference");
      }
      setLearnEnabled(!learnEnabled);
      setLearnFlash(true);
      setTimeout(() => setLearnFlash(false), 1500);
    });
  }


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
      <PageNav
        title="Settings"
        actions={[
          { href: "/chat", label: "Chat", icon: "💬" },
          { href: "/tasks", label: "Tasks", icon: "✅" },
          { href: "/skills", label: "Skills", icon: "📚" },
        ]}
      />
      <p className="-mt-3 text-sm text-zinc-500 dark:text-zinc-400">
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

      {/* ------------------------------------------------------ learning -- */}
      <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Learn from my chat history</h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              A daily job reviews prior-day chats and proposes durable facts to remember.
              Suggestions appear in{" "}
              <Link href="/memory" className="underline hover:text-emerald-600">
                Memory
              </Link>{" "}
              for review — nothing is ever added automatically.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={learnEnabled === true}
            disabled={busy !== null || learnEnabled === null}
            onClick={() => void toggleLearn()}
            className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-40 ${
              learnEnabled
                ? "bg-emerald-600"
                : "bg-zinc-300 dark:bg-zinc-600"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                learnEnabled ? "left-[22px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
        {learnEnabled === null ? (
          <p className="mt-2 text-[11px] text-zinc-400">Checking preference…</p>
        ) : learnFlash ? (
          <p className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400">
            Learning preference saved.
          </p>
        ) : (
          <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
            {learnEnabled
              ? "On — the daily job will run (off by default, plan §5.4)."
              : "Off — no learning job runs until you enable it."}
          </p>
        )}
      </section>

      {/* -------------------------------------------- extension tokens -- */}
      <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold">Extension sync tokens</h2>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          A <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">zsy_…</code> token lets the
          Chrome extension sync with this account. The token is shown once — paste it into the
          extension options immediately.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            value={tokenLabel}
            onChange={(e) => setTokenLabel(e.target.value)}
            placeholder="Label (e.g. work laptop)"
            aria-label="Token label"
            className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700"
          />
          <button
            type="button"
            disabled={tokenBusy}
            onClick={() => {
              setTokenBusy(true);
              setError(null);
              mintToken(tokenLabel || "extension", setFreshToken, loadTokens)
                .then(() => setTokenLabel(""))
                .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                .finally(() => setTokenBusy(false));
            }}
            className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50"
          >
            {tokenBusy ? "Creating…" : "Create token"}
          </button>
        </div>
        {freshToken && (
          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-950/30">
            <p className="text-[11px] font-medium text-amber-800 dark:text-amber-200">
              Copy this now — it will never be shown again:
            </p>
            <code className="mt-1 block break-all rounded bg-white px-2 py-1.5 text-[11px] text-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
              {freshToken}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(freshToken);
                setSavedFlash(true);
                setTimeout(() => setSavedFlash(false), 1500);
              }}
              className="mt-2 rounded-lg border border-amber-400 px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100 dark:text-amber-200"
            >
              {savedFlash ? "Copied ✓" : "Copy token"}
            </button>
          </div>
        )}
        <ul className="mt-3 space-y-1.5">
          {tokens === null && <li className="text-[11px] text-zinc-400">Loading…</li>}
          {tokens?.length === 0 && (
            <li className="text-[11px] text-zinc-500 dark:text-zinc-400">No tokens yet.</li>
          )}
          {tokens?.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
              <div className="min-w-0">
                <span className="block truncate text-xs font-medium">{t.label}</span>
                <span className="text-[10px] text-zinc-400">
                  created {new Date(t.created_at).toLocaleDateString()}
                  {t.revoked_at ? " · revoked" : ""}
                </span>
              </div>
              {!t.revoked_at && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    revokeToken(t.id, loadTokens)
                      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
                  }}
                  className="shrink-0 rounded-lg border border-zinc-300 px-2 py-1 text-[11px] font-medium text-red-600 hover:border-red-400 dark:border-zinc-700"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {error && (
        <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
    </main>
  );
}
