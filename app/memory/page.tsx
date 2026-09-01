"use client";

// ============================================================================
// /memory — long-term memory + §5.4 learning review queue (Priority 11)
//
// Two sections:
//   1. Learning review — suggestions the daily /api/learn job proposed from
//      chat history. NOTHING is auto-applied (plan §5.4): each card can be
//      edited before approving; approval writes the real memory/skill row
//      server-side, and sync carries it to this device.
//   2. Long-term memory — live Dexie rows (manual + conversation + approved
//      learn suggestions), deletable (soft-delete; sync propagates).
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { authedFetch } from "@/lib/auth/app-session";
import { listLive, softDeleteLocal } from "@/lib/db/repo";
import type { MemoryRow } from "@/lib/db/types";
import PageNav from "@/app/components/PageNav";

interface Suggestion {
  id: string;
  target: "memory" | "skill";
  title: string;
  content: string;
  category: string;
  status: "pending" | "approved" | "discarded";
  approved_content: string | null;
  source_excerpt: string | null;
  day: string;
  created_at: string;
}

const CATEGORY_STYLES: Record<string, string> = {
  business: "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-200",
  preference: "bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-200",
  correction: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
  project: "bg-cyan-100 text-cyan-800 dark:bg-cyan-950/60 dark:text-cyan-200",
  general: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

function SuggestionCard({
  suggestion,
  onResolve,
  busy,
}: {
  suggestion: Suggestion;
  onResolve: (
    id: string,
    action: "approve" | "discard",
    edit?: { title: string; content: string },
  ) => void;
  busy: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(suggestion.title);
  const [content, setContent] = useState(suggestion.content);
  const pending = suggestion.status === "pending";

  return (
    <div
      className={`rounded-xl border p-4 shadow-sm ${
        pending
          ? "border-emerald-300 bg-emerald-50/40 dark:border-emerald-500/40 dark:bg-emerald-950/20"
          : "border-zinc-200 bg-white opacity-70 dark:border-zinc-700 dark:bg-zinc-900"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
            suggestion.target === "skill"
              ? "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-200"
              : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200"
          }`}
        >
          {suggestion.target}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            CATEGORY_STYLES[suggestion.category] ?? CATEGORY_STYLES.general
          }`}
        >
          {suggestion.category}
        </span>
        {pending ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
            awaiting review
          </span>
        ) : (
          <span className="text-[10px] text-zinc-500 dark:text-zinc-400">{suggestion.status}</span>
        )}
        <span className="text-[10px] text-zinc-400">{suggestion.day}</span>
      </div>

      {pending && editing ? (
        <div className="mt-2 space-y-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            aria-label="Suggestion title"
            className="w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-800"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
            maxLength={2000}
            aria-label="Suggestion content"
            className="w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-800"
          />
        </div>
      ) : (
        <>
          {pending ? <h3 className="mt-2 text-sm font-semibold">{suggestion.title}</h3> : null}
          <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-200">
            {suggestion.status === "approved" && suggestion.approved_content
              ? suggestion.approved_content
              : suggestion.content}
          </p>
        </>
      )}

      {suggestion.source_excerpt ? (
        <p className="mt-2 border-l-2 border-zinc-300 pl-2 text-xs italic text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">
          &ldquo;{suggestion.source_excerpt}&rdquo;
        </p>
      ) : null}

      {pending ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {editing ? (
            <>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  onResolve(suggestion.id, "approve", { title, content });
                  setEditing(false);
                }}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy === suggestion.id ? "Saving…" : "Save & approve"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setTitle(suggestion.title);
                  setContent(suggestion.content);
                }}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-600 dark:border-zinc-600 dark:text-zinc-300"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => onResolve(suggestion.id, "approve")}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy === suggestion.id ? "Approving…" : "Approve"}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => setEditing(true)}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-700 transition hover:border-emerald-400 dark:border-zinc-600 dark:text-zinc-200"
              >
                Edit
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => onResolve(suggestion.id, "discard")}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-500 transition hover:border-red-400 hover:text-red-600 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-400"
              >
                Discard
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function MemoryPage() {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const memories = useLiveQuery(() => listLive<MemoryRow>("memory"), []);
  const pendingCount = suggestions?.filter((s) => s.status === "pending").length ?? 0;

  const loadSuggestions = useCallback(async (): Promise<Suggestion[] | null> => {
    const res = await authedFetch("/api/learn/suggestions");
    if (res.ok) {
      const json = (await res.json()) as { suggestions: Suggestion[] };
      return json.suggestions;
    }
    return null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadSuggestions().then((rows) => {
      if (cancelled) return;
      if (rows) {
        setSuggestions(rows);
        setLoadError(null);
      } else {
        setLoadError("Could not load suggestions (are you unlocked?).");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadSuggestions]);

  const resolve = useCallback(
    async (
      id: string,
      action: "approve" | "discard",
      edit?: { title: string; content: string },
    ) => {
      setBusy(id);
      try {
        const res = await authedFetch("/api/learn/suggestions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, action, ...edit }),
        });
        if (res.ok) {
          setFlash(action === "approve" ? "Approved — added to your agent." : "Discarded.");
          const rows = await loadSuggestions();
          if (rows) setSuggestions(rows);
        } else {
          const json = (await res.json().catch(() => ({}))) as { error?: string };
          setFlash(json.error ?? "Action failed.");
        }
      } finally {
        setBusy(null);
        setTimeout(() => setFlash(null), 2500);
      }
    },
    [loadSuggestions],
  );

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-4 pb-16 pt-8">
      <PageNav
        title="Memory"
        actions={[
          { href: "/chat", label: "Chat", icon: "💬" },
          { href: "/skills", label: "Skills", icon: "📚" },
          { href: "/search", label: "Search", icon: "🔍" },
        ]}
      />

      {flash ? (
        <p className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-200">
          {flash}
        </p>
      ) : null}

      {/* ------------------------------------------------ review queue -- */}
      <section aria-labelledby="learn-heading" className="mb-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2
            id="learn-heading"
            className="text-sm font-bold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
          >
            Learning review
          </h2>
          <span className="text-xs text-zinc-400">
            {pendingCount > 0 ? `${pendingCount} awaiting review` : "all caught up"}
          </span>
        </div>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          Candidates the daily job mined from your chat history (opt-in in{" "}
          <Link href="/settings" className="underline hover:text-zinc-700 dark:hover:text-zinc-200">
            Settings
          </Link>
          ). Nothing is added until you approve it.
        </p>

        {loadError ? (
          <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200">
            {loadError}
          </p>
        ) : suggestions === null ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : suggestions.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No suggestions yet. Chat for a day with learning enabled and candidates will appear here.
          </p>
        ) : (
          <div className="space-y-3">
            {suggestions.map((s) => (
              <SuggestionCard key={s.id} suggestion={s} onResolve={resolve} busy={busy} />
            ))}
          </div>
        )}
      </section>

      {/* --------------------------------------------- long-term memory -- */}
      <section aria-labelledby="memory-heading">
        <h2
          id="memory-heading"
          className="mb-2 text-sm font-bold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
        >
          Long-term memory
        </h2>
        {memories === undefined ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : memories.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No memories yet. Use &ldquo;Remember that…&rdquo; in chat or approve a suggestion above.
          </p>
        ) : (
          <ul className="space-y-2">
            {memories.map((m: MemoryRow) => (
              <li
                key={m.client_id}
                className="flex items-start justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900"
              >
                <div className="min-w-0">
                  <p className="break-words text-sm">{m.content}</p>
                  <span className="text-[10px] uppercase tracking-wide text-zinc-400">
                    {m.category} · {m.source}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void softDeleteLocal("memory", m.client_id)}
                  aria-label={`Delete memory: ${m.content.slice(0, 40)}`}
                  className="shrink-0 rounded-lg border border-zinc-300 px-2 py-1 text-xs text-zinc-500 transition hover:border-red-400 hover:text-red-600 dark:border-zinc-600 dark:text-zinc-400"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}


