"use client";

// ============================================================================
// /search — full-text search across chat, memory, knowledge, and skills
// (plan §4 module + priority 6). Runs entirely on the local Dexie cache
// (offline-first); results are grouped by source, ranked by the weighted scorer
// in lib/search/engine.ts, and highlight the matched terms.
// ============================================================================
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { listLive } from "@/lib/db/repo";
import type { ChatMessageRow, KnowledgeRow, MemoryRow, SkillRow } from "@/lib/db/types";
import {
  searchDocuments,
  type ScoredResult,
  type SearchDocument,
  type TextSegment,
} from "@/lib/search/engine";
import {
  chatToSearchDoc,
  knowledgeToSearchDoc,
  memoryToSearchDoc,
  skillToSearchDoc,
} from "@/lib/search/adapters";
import PageNav from "@/app/components/PageNav";

const SOURCE_LABEL: Record<string, string> = {
  chat_history: "Chat",
  memory: "Memory",
  knowledge: "Knowledge",
  skills: "Skills",
};

const SOURCE_ORDER = ["chat_history", "memory", "knowledge", "skills"] as const;

/** Pull live (non-deleted) rows from the local stores and adapt them. */
async function loadDocuments(): Promise<SearchDocument[]> {
  const [chats, memories, knowledge, skills] = await Promise.all([
    listLive<ChatMessageRow>("chat_history"),
    listLive<MemoryRow>("memory"),
    listLive<KnowledgeRow>("knowledge"),
    listLive<SkillRow>("skills"),
  ]);
  const docs: SearchDocument[] = [];
  // Cap chat at the most recent 2,000 messages — enough context, bounded cost.
  for (const c of chats.slice(0, 2000)) docs.push(chatToSearchDoc(c));
  for (const m of memories) docs.push(memoryToSearchDoc(m));
  for (const k of knowledge) docs.push(knowledgeToSearchDoc(k));
  for (const s of skills) docs.push(skillToSearchDoc(s));
  return docs;
}

function ResultTitle({ doc }: { doc: SearchDocument }) {
  if (doc.source === "memory" || doc.source === "chat_history") {
    const body = doc.body.split("\n").find(Boolean) ?? doc.body;
    const firstLine = body.slice(0, 120);
    if (doc.source === "chat_history") {
      const role = (doc.row.role as string | undefined) ?? "message";
      return (
        <span>
          <span className="font-medium capitalize text-zinc-500 dark:text-zinc-400">{role}</span>
          <span className="text-zinc-400"> · </span>
          {firstLine}
        </span>
      );
    }
    return <span className="text-zinc-600 dark:text-zinc-300">{firstLine}</span>;
  }
  return <span className="font-semibold text-zinc-800 dark:text-zinc-100">{doc.title}</span>;
}

function Segments({ segments }: { segments: TextSegment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        s.hit ? (
          <mark
            key={i}
            className="rounded bg-amber-200/80 px-0.5 text-inherit dark:bg-amber-500/30"
          >
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ScoredResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);

    // All setState calls live inside the timer callback (keeping React's
    // "no synchronous setState in effect" rule); the empty branch just runs
    // on the next tick instead of the next 180ms.
    timerRef.current = window.setTimeout(() => {
      if (!trimmed) {
        setResults([]);
        setSearched(false);
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      void (async () => {
        try {
          const docs = await loadDocuments();
          const found = searchDocuments(docs, trimmed);
          setResults(found);
          setSearched(true);
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setLoading(false);
        }
      })();
    }, trimmed ? 180 : 0);

    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [query]);

  const groups = useMemo(() => {
    const bySource = new Map<string, ScoredResult[]>();
    for (const r of results) {
      const list = bySource.get(r.doc.source) ?? [];
      list.push(r);
      bySource.set(r.doc.source, list);
    }
    return SOURCE_ORDER.filter((s) => bySource.has(s)).map((s) => ({
      source: s,
      items: bySource.get(s) ?? [],
      count: bySource.get(s)?.length ?? 0,
    }));
  }, [results]);

  const total = results.length;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
      <PageNav
        title="Search"
        actions={[
          { href: "/chat", label: "Chat", icon: "💬" },
          { href: "/tasks", label: "Tasks", icon: "✅" },
          { href: "/memory", label: "Memory", icon: "🧠" },
        ]}
      />
      <p className="-mt-3 mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        Searches your offline synced data — chat, memory, knowledge, and skills.
      </p>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search everything…"
        autoFocus
        aria-label="Search query"
        className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-base shadow-sm outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      />

      {loading && <p className="mt-4 text-sm text-zinc-500">Searching…</p>}
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {!loading && searched && total === 0 && (
        <p className="mt-8 text-center text-sm text-zinc-500">No matches for “{query.trim()}”.</p>
      )}

      {!loading && searched && total > 0 && (
        <p className="mt-4 text-sm text-zinc-500">
          {total} {total === 1 ? "result" : "results"} for “{query.trim()}”.
        </p>
      )}

      {groups.map((g) => (
        <section key={g.source} className="mt-6">
          <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {SOURCE_LABEL[g.source]} <span className="font-normal">({g.count})</span>
          </h2>
          <ul className="divide-y divide-zinc-100 border-y border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
            {g.items.map((r) => (
              <li key={`${r.doc.source}:${r.doc.clientId}`} className="py-3">
                <div className="text-sm">
                  {r.doc.source === "skills" ? (
                    <Link href="/skills" className="hover:underline">
                      <ResultTitle doc={r.doc} />
                    </Link>
                  ) : (
                    <ResultTitle doc={r.doc} />
                  )}
                </div>
                <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
                  <Segments segments={r.snippet} />
                </p>
                {r.matchedFields.length > 0 && (
                  <p className="mt-1 text-xs text-zinc-400">
                    matched: {r.matchedFields.join(" · ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
