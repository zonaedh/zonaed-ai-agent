"use client";

// ============================================================================
// /knowledge — knowledge base CRUD + .md import (plan §4 /knowledge)
//
// Same offline-first pattern as /skills: writes land in the Dexie `knowledge`
// store via lib/knowledge/repo.ts (shared §7 sanitization path), and the sync
// engine carries them to Supabase. Docs flow into chat context through
// lib/ai/matching.ts via the search adapters.
// ============================================================================
import { useCallback, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb } from "@/lib/db/client";
import {
  deleteKnowledgeDoc,
  editKnowledgeDoc,
  importKnowledgeFile,
  saveKnowledgeDoc,
} from "@/lib/knowledge/repo";
import PageNav from "@/app/components/PageNav";

export default function KnowledgePage() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editText, setEditText] = useState("");
  const [feedback, setFeedback] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addContent, setAddContent] = useState("");
  const [addTags, setAddTags] = useState("");

  const docs = useLiveQuery(async () => {
    const rows = await getDb().knowledge.orderBy("updated_at").reverse().toArray();
    return rows.filter((d) => !d.deleted_at);
  }, []);

  const onUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const results: string[] = [];
    for (const file of Array.from(files)) {
      const text = await file.text();
      const outcome = await importKnowledgeFile({ name: file.name, text });
      results.push(
        outcome.ok
          ? `${outcome.doc?.title} saved${outcome.warning ? ` — ${outcome.warning}` : ""}`
          : `${file.name}: ${outcome.error}`,
      );
    }
    const failed = results.some((r) => r.includes(": "));
    setFeedback({ tone: failed ? "err" : "ok", text: results.join(" • ") });
    if (fileInput.current) fileInput.current.value = "";
  }, []);

  const onAdd = useCallback(async () => {
    const tags = addTags.split(",").map((t) => t.trim()).filter(Boolean);
    const outcome = await saveKnowledgeDoc({ title: addTitle, content: addContent, tags });
    if (outcome.ok) {
      setFeedback({ tone: "ok", text: `“${outcome.doc?.title}” saved to knowledge` });
      setAddTitle("");
      setAddContent("");
      setAddTags("");
      setShowAdd(false);
    } else {
      setFeedback({ tone: "err", text: outcome.error ?? "Could not save" });
    }
  }, [addTitle, addContent, addTags]);

  const saveEdit = useCallback(
    async (clientId: string) => {
      const outcome = await editKnowledgeDoc(clientId, { title: editTitle, content: editText });
      if (outcome.ok) {
        setEditingId(null);
        setFeedback({ tone: "ok", text: "Knowledge doc updated" });
      } else {
        setFeedback({ tone: "err", text: outcome.error ?? "Could not update" });
      }
    },
    [editTitle, editText],
  );

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-16 pt-8">
      <PageNav
        title="Knowledge"
        actions={[
          { href: "/chat", label: "Chat", icon: "💬" },
          { href: "/skills", label: "Skills", icon: "📚" },
          { href: "/search", label: "Search", icon: "🔍" },
        ]}
      />
      <p className="-mt-3 text-sm text-zinc-500 dark:text-zinc-400">
        Reference documents the agent treats as ground truth — client briefs, SOPs,
        pricing, specs. Upload <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">.md</code> files
        or add entries manually; matching docs are injected into chat context.
      </p>

      {/* Import + add panel */}
      <section className="mt-6 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <input
          ref={fileInput}
          type="file"
          accept=".md,.markdown,text/markdown,text/plain"
          multiple
          onChange={(e) => void onUpload(e.target.files)}
          className="block w-full text-sm text-zinc-600 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white dark:text-zinc-300 dark:file:bg-zinc-100 dark:file:text-zinc-900"
        />
        {!showAdd ? (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="mt-3 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            + Add manually
          </button>
        ) : (
          <div className="mt-3 grid gap-2">
            <input
              value={addTitle}
              onChange={(e) => setAddTitle(e.target.value)}
              placeholder="Title (e.g. Pricing policy)"
              aria-label="Knowledge title"
              className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700"
            />
            <textarea
              value={addContent}
              onChange={(e) => setAddContent(e.target.value)}
              placeholder="Content (markdown)…"
              rows={5}
              aria-label="Knowledge content"
              className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700"
            />
            <input
              value={addTags}
              onChange={(e) => setAddTags(e.target.value)}
              placeholder="Tags, comma separated (e.g. pricing, client)"
              aria-label="Knowledge tags"
              className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700"
            />
            <div className="flex gap-2">
              <button type="button" onClick={() => void onAdd()} className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900">
                Save
              </button>
              <button type="button" onClick={() => setShowAdd(false)} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
                Cancel
              </button>
            </div>
          </div>
        )}
        {feedback && (
          <p className={`mt-3 text-xs ${feedback.tone === "ok" ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
            {feedback.text}
          </p>
        )}
      </section>

      {/* Doc list */}
      <section className="mt-6 space-y-3">
        {docs === undefined && <p className="text-sm text-zinc-500">Loading…</p>}
        {docs?.length === 0 && (
          <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No knowledge docs yet. Upload a .md file or add one manually above.
          </p>
        )}
        {docs?.map((doc) => (
          <article key={doc.client_id} className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
            {editingId === doc.client_id ? (
              <div className="grid gap-2">
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  aria-label="Edit title"
                  className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700"
                />
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={6}
                  aria-label="Edit content"
                  className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700"
                />
                <div className="flex gap-2">
                  <button type="button" onClick={() => void saveEdit(doc.client_id)} className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900">
                    Save
                  </button>
                  <button type="button" onClick={() => setEditingId(null)} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold">{doc.title}</h2>
                    {doc.tags.length > 0 && (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {doc.tags.map((t) => (
                          <span key={t} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                            {t}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-[10px] text-zinc-400">{doc.source}</span>
                </div>
                <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-zinc-500 dark:text-zinc-400">
                  {doc.content}
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(doc.client_id);
                      setEditTitle(doc.title);
                      setEditText(doc.content);
                    }}
                    className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteKnowledgeDoc(doc.client_id)}
                    className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:border-red-400 dark:border-zinc-700"
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}

