"use client";

// ============================================================================
// ToolRunner — shared client for the §5.2 tools (/report /marketing-plan
// /competitor-spy /outreach).
//
// Posts { tool, url, notes } to /api/tools/generate via authedFetch, parses
// the SSE stream (meta → deltas → done), and renders the generated Markdown
// with copy/download actions. Each page is a thin wrapper around this.
// ============================================================================

import { useCallback, useRef, useState } from "react";
import { authedFetch } from "@/lib/auth/app-session";
import PageNav, { type PageNavAction } from "./PageNav";

export interface ToolRunnerProps {
  tool: "report" | "marketing-plan" | "competitor-spy" | "outreach";
  title: string;
  description: string;
  urlLabel: string;
  urlPlaceholder: string;
  notesLabel?: string;
  notesPlaceholder?: string;
}

type Phase = "idle" | "crawling" | "generating" | "done" | "error";

interface ToolMeta {
  provider?: string;
  model?: string;
  pages: string[];
  failedPages: string[];
}

interface ToolScan {
  bannedWords: string[];
  dashes: number;
  clean: boolean;
}

function downloadMarkdown(text: string, filename: string): void {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ToolRunner(props: ToolRunnerProps) {
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [meta, setMeta] = useState<ToolMeta | null>(null);
  const [scan, setScan] = useState<ToolScan | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("crawling");
    setError(null);
    setOutput("");
    setMeta(null);
    setScan(null);
    setCopied(false);
    try {
      const res = await authedFetch("/api/tools/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: props.tool, url, notes: notes.trim() || undefined }),
        signal: controller.signal,
      });
      const problem = (await res.clone().json().catch(() => null)) as { error?: string } | null;
      if (!res.ok || !res.body) {
        throw new Error(problem?.error ?? `Request failed with status ${res.status}`);
      }
      setPhase("generating");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.trim();
          if (!line.startsWith("data:")) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (event.type === "meta") {
            setMeta({
              provider: typeof event.provider === "string" ? event.provider : undefined,
              model: typeof event.model === "string" ? event.model : undefined,
              pages: Array.isArray(event.pages) ? (event.pages as string[]) : [],
              failedPages: Array.isArray(event.failedPages) ? (event.failedPages as string[]) : [],
            });
          } else if (event.type === "delta" && typeof event.text === "string") {
            text += event.text;
            setOutput(text);
          } else if (event.type === "done") {
            const rawScan = event.scan as ToolScan | undefined;
            if (rawScan) setScan(rawScan);
            setPhase("done");
          } else if (event.type === "error") {
            throw new Error(typeof event.error === "string" ? event.error : "Generation failed");
          }
        }
      }
      setPhase((p) => (p === "generating" ? "done" : p));
      if (text.length === 0) throw new Error("The provider returned an empty response.");
    } catch (err) {
      if (controller.signal.aborted) {
        setPhase("idle");
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [notes, props.tool, url]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setPhase("idle");
  }, []);

  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [output]);

  const running = phase === "crawling" || phase === "generating";

  // Cross-link the sibling §5.2 tools + the task list so users can hop between
  // related workflows without going back to the hub.
  const TOOL_LINKS: Record<string, { href: string; label: string; icon: string }> = {
    report: { href: "/report", label: "Report", icon: "📋" },
    "marketing-plan": { href: "/marketing-plan", label: "Marketing", icon: "📈" },
    "competitor-spy": { href: "/competitor-spy", label: "Spy", icon: "🕵️" },
    outreach: { href: "/outreach", label: "Outreach", icon: "✉️" },
  };
  const actionLinks: PageNavAction[] = Object.entries(TOOL_LINKS)
    .filter(([id]) => id !== props.tool)
    .map(([, l]) => l);
  actionLinks.push({ href: "/tasks", label: "Tasks", icon: "✅" });

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
      <PageNav title={props.title} actions={actionLinks} />
      <p className="-mt-3 mb-6 text-sm text-zinc-500 dark:text-zinc-400">{props.description}</p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!running) void run();
        }}
        className="grid gap-3"
      >
        <label className="grid gap-1">
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{props.urlLabel}</span>
          <input
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={props.urlPlaceholder}
            className="rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm shadow-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        {props.notesLabel && (
          <label className="grid gap-1">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{props.notesLabel}</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={props.notesPlaceholder}
              rows={3}
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm shadow-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
        )}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={running || url.trim().length === 0}
            className="flex-1 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {phase === "crawling" ? "Fetching page..." : phase === "generating" ? "Generating..." : "Generate"}
          </button>
          {running && (
            <button
              type="button"
              onClick={cancel}
              className="rounded-xl border border-zinc-300 px-4 py-2.5 text-sm font-medium dark:border-zinc-600"
            >
              Stop
            </button>
          )}
        </div>
      </form>

      {error && (
        <p className="mt-4 text-sm text-red-600" aria-live="polite">
          {error}
        </p>
      )}

      {meta && (
        <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
          {meta.pages.length} page{meta.pages.length === 1 ? "" : "s"} fetched
          {meta.provider ? ` via ${meta.provider} (${meta.model})` : ""}
          {meta.failedPages.length > 0 ? `; ${meta.failedPages.length} unreachable` : ""}.
        </p>
      )}

      {output.length > 0 && (
        <section className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Result</h2>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void copy()}
                className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium hover:border-emerald-500 dark:border-zinc-700"
              >
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={() => downloadMarkdown(output, `${props.tool}-${new Date().toISOString().slice(0, 10)}.md`)}
                className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium hover:border-emerald-500 dark:border-zinc-700"
              >
                Download .md
              </button>
            </div>
          </div>
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-xl border border-zinc-200 bg-white p-4 text-sm leading-relaxed dark:border-zinc-700 dark:bg-zinc-900">
            {output}
            {running && <span className="animate-pulse">▍</span>}
          </pre>
          {scan && !scan.clean && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              Style check: {scan.bannedWords.length > 0 ? `banned words: ${scan.bannedWords.join(", ")}. ` : ""}
              {scan.dashes > 0 ? `${scan.dashes} dash(es) to review.` : ""}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
