"use client";

// ============================================================================
// /skills — Skill/Knowledge upload system (plan §5.3)
//
// Upload .md files the agent treats as durable ground truth (business info,
// SOPs, writing style, pricing). Local-first: writes land in Dexie, the sync
// engine carries them to Supabase, and /api/chat injects matched skills via
// lib/ai/matching.ts. Re-upload with the same title = new version (§5.3).
// ============================================================================
import { useCallback, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb } from "@/lib/db/client";
import { softDeleteLocal } from "@/lib/db/repo";
import type { SkillRow } from "@/lib/db/types";
import { editSkill, setSkillActive, uploadSkillFile } from "@/lib/skills/upload";
import PageNav from "@/app/components/PageNav";

function StatusBadge({ skill }: { skill: SkillRow }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
        skill.active
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200"
          : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
      }`}
    >
      {skill.active ? "active" : "paused"}
    </span>
  );
}

function TriggerList({ skill }: { skill: SkillRow }) {
  if (!skill.trigger_keywords || skill.trigger_keywords.length === 0) {
    return <span className="text-[10px] text-blue-700 dark:text-blue-300">always-on</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {skill.trigger_keywords.map((k) => (
        <span key={k} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          {k}
        </span>
      ))}
    </span>
  );
}

export default function SkillsPage() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [feedback, setFeedback] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [keywordInput, setKeywordInput] = useState("");
  const [uploadKeywords, setUploadKeywords] = useState<string[]>([]);

  const skills = useLiveQuery(async () => {
    const rows = await getDb().skills.orderBy("updated_at").reverse().toArray();
    return rows.filter((s) => !s.deleted_at);
  }, []);

  const onUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const results: string[] = [];
      for (const file of Array.from(files)) {
        const text = await file.text();
        const outcome = await uploadSkillFile({ name: file.name, text }, { triggerKeywords: uploadKeywords });
        if (outcome.ok) {
          results.push(
            `${outcome.skill?.title} v${outcome.skill?.version} saved` +
              (outcome.replacedVersion ? ` (replaced v${outcome.replacedVersion})` : "") +
              (outcome.warning ? ` — ${outcome.warning}` : ""),
          );
        } else {
          results.push(`${file.name}: ${outcome.error}`);
        }
      }
      const failed = results.some((r) => r.includes(": "));
      setFeedback({ tone: failed ? "err" : "ok", text: results.join(" • ") });
      setUploadKeywords([]);
      if (fileInput.current) fileInput.current.value = "";
    },
    [uploadKeywords],
  );

  const addUploadKeyword = useCallback(() => {
    const kw = keywordInput.trim().toLowerCase();
    if (kw && !uploadKeywords.includes(kw)) setUploadKeywords((prev) => [...prev, kw]);
    setKeywordInput("");
  }, [keywordInput, uploadKeywords]);

  const saveEdit = async (clientId: string) => {
    await editSkill(clientId, { content: editText });
    setEditingId(null);
    setFeedback({ tone: "ok", text: "Skill content updated" });
  };

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-16 pt-8">
      <PageNav
        title="Skills"
        actions={[
          { href: "/chat", label: "Chat", icon: "💬" },
          { href: "/memory", label: "Memory", icon: "🧠" },
          { href: "/tasks", label: "Tasks", icon: "✅" },
        ]}
      />
      <p className="-mt-3 text-sm text-zinc-500 dark:text-zinc-400">
        Upload <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">.md</code> files the agent
        treats as ground truth. Skills with trigger keywords inject only when a message matches;
        skills with no keywords are always on. Re-uploading the same title creates a new version.
      </p>

      {/* Upload panel */}
      <section className="mt-6 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <input
          ref={fileInput}
          type="file"
          accept=".md,.markdown,text/markdown,text/plain"
          multiple
          onChange={(e) => void onUpload(e.target.files)}
          className="block w-full text-sm text-zinc-600 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white dark:text-zinc-300 dark:file:bg-zinc-100 dark:file:text-zinc-900"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Triggers for this upload:</span>
          {uploadKeywords.map((k) => (
            <span key={k} className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-800 dark:bg-blue-900/40 dark:text-blue-200">
              {k}
            </span>
          ))}
          {uploadKeywords.length === 0 && (
            <span className="text-[10px] text-blue-700 dark:text-blue-300">none → always-on</span>
          )}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addUploadKeyword();
              }
            }}
            placeholder="e.g. pricing, web design (Enter to add)"
            className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700"
          />
          <button
            type="button"
            onClick={addUploadKeyword}
            className="shrink-0 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Add
          </button>
        </div>
        {feedback && (
          <p className={`mt-3 text-xs ${feedback.tone === "ok" ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
            {feedback.text}
          </p>
        )}
      </section>

      {/* Skill list */}
      <section className="mt-6 space-y-3">
        {skills === undefined && <p className="text-sm text-zinc-500">Loading…</p>}
        {skills?.length === 0 && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No skills yet. Upload your first .md file above.</p>
        )}
        {skills?.map((skill) => (
          <SkillCard
            key={skill.client_id}
            skill={skill}
            editing={editingId === skill.client_id}
            editText={editText}
            onEditText={setEditText}
            onStartEdit={() => {
              setEditingId(skill.client_id);
              setEditText(skill.content);
            }}
            onCancelEdit={() => setEditingId(null)}
            onSaveEdit={() => void saveEdit(skill.client_id)}
            onToggle={() => void setSkillActive(skill.client_id, !skill.active)}
            onDelete={() => void softDeleteLocal("skills", skill.client_id)}
          />
        ))}
      </section>
    </main>
  );
}

function SkillCard({
  skill,
  editing,
  editText,
  onEditText,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onToggle,
  onDelete,
}: {
  skill: SkillRow;
  editing: boolean;
  editText: string;
  onEditText: (v: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{skill.title}</h2>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            v{skill.version}
          </span>
          <StatusBadge skill={skill} />
        </div>
        <div className="flex gap-1.5 text-xs">
          <button
            type="button"
            onClick={onToggle}
            className="rounded-lg border border-zinc-300 px-2 py-1 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            {skill.active ? "Pause" : "Activate"}
          </button>
          <button type="button" onClick={onStartEdit} className="rounded-lg border border-zinc-300 px-2 py-1 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg border border-red-200 px-2 py-1 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
          >
            Delete
          </button>
        </div>
      </header>
      <div className="mt-2">
        <TriggerList skill={skill} />
      </div>
      {editing ? (
        <div className="mt-3">
          <textarea
            value={editText}
            onChange={(e) => onEditText(e.target.value)}
            rows={10}
            className="w-full rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-xs outline-none focus:border-zinc-500 dark:border-zinc-700"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={onSaveEdit}
              className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
            >
              Save
            </button>
            <button type="button" onClick={onCancelEdit} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs dark:border-zinc-700">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          {skill.content.length > 600 ? `${skill.content.slice(0, 600)}…` : skill.content}
        </pre>
      )}
    </article>
  );
}

