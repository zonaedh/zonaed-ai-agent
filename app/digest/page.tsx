"use client";

// ============================================================================
// /digest — daily/weekly summary (plan §4 /digest)
//
// Computed entirely offline from the local Dexie snapshot (tasks, chat,
// memory, knowledge, skills). The push-notification digest (§10 cron) is the
// reminder-level nudge; this page is the full in-app view with copy-as-
// Markdown for hand-off into chat or a report.
// ============================================================================
import { useState, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb } from "@/lib/db/client";
import type { KnowledgeRow, MemoryRow, SkillRow, TaskRow } from "@/lib/db/types";
import { buildDigest, digestToMarkdown, type DigestTask } from "@/lib/digest/summary";
import PageNav from "@/app/components/PageNav";

/** Render-safe clock (react-hooks/purity bans Date.now() during render). */
function useNow(): number {
  return useSyncExternalStore(
    () => () => {},
    () => Date.now(),
    () => 0,
  );
}

export default function DigestPage() {
  const now = useNow();
  const [copied, setCopied] = useState(false);

  const snapshot = useLiveQuery(async () => {
    const db = getDb();
    const [tasks, chats, memories, knowledge, skills] = await Promise.all([
      db.tasks.toArray(),
      db.chat_history.toArray(),
      db.memory.toArray(),
      db.knowledge.toArray(),
      db.skills.toArray(),
    ]);
    const live = <T extends { deleted_at?: string | null }>(rows: T[]) => rows.filter((r) => !r.deleted_at);
    const lastChat = live(chats)
      .map((c) => c.updated_at)
      .sort()
      .at(-1);
    return {
      tasks: live(tasks) as TaskRow[],
      counts: {
        memory: live(memories as MemoryRow[]).length,
        knowledge: live(knowledge as KnowledgeRow[]).length,
        skills: live(skills as SkillRow[]).length,
      },
      lastChatAt: lastChat ?? null,
    };
  }, []);

  const digest =
    snapshot && now !== 0
      ? buildDigest({
          tasks: snapshot.tasks,
          counts: snapshot.counts,
          lastChatAt: snapshot.lastChatAt,
          now: new Date(now),
        })
      : null;
  const markdown = digest ? digestToMarkdown(digest) : "";

  const copy = async () => {
    if (!markdown) return;
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const list = (title: string, tasks: DigestTask[]) =>
    tasks && tasks.length > 0 ? (
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{title}</h3>
        <ul className="mt-1.5 space-y-1">
          {tasks.map((t) => (
            <li key={t.client_id} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{t.title}</span>
              {t.due_at && (
                <span className="shrink-0 text-xs text-zinc-400">{new Date(t.due_at).toLocaleDateString()}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
      <PageNav
        title="Digest"
        actions={[
          { href: "/tasks", label: "Tasks", icon: "✅" },
          { href: "/chat", label: "Chat", icon: "💬" },
          { href: "/settings", label: "Settings", icon: "⚙️" },
        ]}
      />
      <p className="-mt-3 mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        Your current standing, computed offline from local data. Push-notification
        digests and their cadence are configured in Settings.
      </p>

      {!digest ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
            <h2 className="text-sm font-semibold">{digest.headline}</h2>
            <div className="mt-4 space-y-4">
              {list("Overdue", digest.overdue)}
              {list("Due today", digest.dueToday)}
              {list("Due this week", digest.dueThisWeek)}
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-2 border-t border-zinc-100 pt-4 text-xs dark:border-zinc-800 sm:grid-cols-4">
              <div>
                <dt className="text-zinc-400">Open total</dt>
                <dd className="text-sm font-semibold">{digest.openTotal}</dd>
              </div>
              <div>
                <dt className="text-zinc-400">Done this week</dt>
                <dd className="text-sm font-semibold">{digest.completedThisWeek}</dd>
              </div>
              <div>
                <dt className="text-zinc-400">Memory / Knowledge</dt>
                <dd className="text-sm font-semibold">
                  {digest.counts.memory} / {digest.counts.knowledge}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-400">Skills</dt>
                <dd className="text-sm font-semibold">{digest.counts.skills}</dd>
              </div>
            </dl>
          </div>
          <button
            type="button"
            onClick={() => void copy()}
            className="mt-4 rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {copied ? "Copied ✓" : "Copy as Markdown"}
          </button>
        </>
      )}
    </main>
  );
}
