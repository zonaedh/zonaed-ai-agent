// ============================================================================
// /chat — the main conversational surface (plan §4 /chat).
//
// Client-side half of the §5.1 pipeline:
//   * loads live Dexie rows and builds the preamble with the SAME shared
//     lib/ai/matching.ts logic the server uses for Supabase rows (plan §5.1:
//     "same logic, same results"),
//   * streams the SSE response from POST /api/chat (meta/delta/done/error),
//   * persists both sides of the conversation to chat_history via putLocal so
//     the sync engine carries it to Supabase and the extension.
// ============================================================================
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { listLive, newClientId, putLocal, softDeleteLocal } from "@/lib/db/repo";
import type { ChatMessageRow, ExampleRow, MemoryRow, SkillRow } from "@/lib/db/types";
import { buildPreamble } from "@/lib/ai/matching";
import { authedFetch } from "@/lib/auth/app-session";
import ChatSidebar, { type SessionSummary } from "./Sidebar";

interface ModelInfo {
  id: string;
  providerId?: string;
  label: string;
  model: string;
}

/** Time-of-day greeting without reading the clock during render (SSR-safe). */
function useGreeting(): string {
  return useSyncExternalStore(
    () => () => {},
    () => {
      const h = new Date().getHours();
      return h < 12 ? "Good Morning" : h < 17 ? "Good Afternoon" : "Good Evening";
    },
    () => "",
  );
}

export default function ChatPage() {
  const all = useLiveQuery(async () => listLive<ChatMessageRow>("chat_history"), [], []);

  // Latest session by the newest message wins; a fresh session id starts a new chat.
  const sessions = useMemo(() => {
    const bySession = new Map<string, ChatMessageRow[]>();
    for (const m of all ?? []) {
      const list = bySession.get(m.session_id) ?? [];
      list.push(m);
      bySession.set(m.session_id, list);
    }
    return [...bySession.entries()]
      .map(([id, msgs]) => ({
        id,
        msgs: msgs.sort((a, b) => Date.parse(a.created_at ?? a.updated_at) - Date.parse(b.created_at ?? b.updated_at)),
        latest: Math.max(...msgs.map((m) => Date.parse(m.updated_at))),
      }))
      .sort((a, b) => b.latest - a.latest);
  }, [all]);

  // Active session: the explicitly chosen one, else the most recent, else null
  // (a brand-new chat whose id is assigned lazily on the first send — never
  // during render, which React's purity rules forbid).
  const [sessionId, setSessionId] = useState<string | null>(null);
  const activeId = sessionId ?? sessions[0]?.id ?? null;

  const [input, setInput] = useState("");
  const [stream, setStream] = useState<{ text: string; provider?: string; model?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selected, setSelected] = useState<string>(
    typeof window !== "undefined" ? (localStorage.getItem("chat.model") ?? "auto") : "auto",
  );
  const [deepDraft, setDeepDraft] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Available models for the selector (session-guarded endpoint, keys never leave the server).
  useEffect(() => {
    let cancelled = false;
    void authedFetch("/api/models")
      .then((r) => (r.ok ? r.json() : { providers: [], models: [] }))
      .then((d: { providers?: ModelInfo[]; models?: ModelInfo[] }) => {
        if (cancelled) return;
        const list = d.models ?? d.providers ?? [];
        setModels(list);
        // A saved selection (localStorage) that is stale — e.g. pre-model-registry
        // ids like "groq" — falls back to Auto Route. Runs in the async callback
        // (not synchronously inside the effect body) to satisfy react-hooks/purity.
        setSelected((prev) =>
          prev !== "auto" && list.length > 0 && !list.some((m) => m.id === prev) ? "auto" : prev,
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const pickModel = useCallback((id: string) => {
    setSelected(id);
    try {
      localStorage.setItem("chat.model", id);
    } catch {
      /* private mode — selection just won't persist */
    }
  }, []);

  const messages = useMemo(
    () => sessions.find((s) => s.id === activeId)?.msgs ?? [],
    [sessions, activeId],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, stream?.text.length]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busy) return;
      // Assign the session id lazily on the first message of a brand-new chat.
      let sid = activeId;
      if (sid === null) {
        sid = newClientId();
        setSessionId(sid);
      }
      setError(null);
      setBusy(true);
      setInput("");

      await putLocal("chat_history", {
        client_id: newClientId(),
        session_id: sid,
        role: "user",
        content: text,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Preamble from Dexie (source of truth, works offline) via shared logic.
      const [skills, memories, examples] = await Promise.all([
        listLive<SkillRow>("skills"),
        listLive<MemoryRow>("memory"),
        listLive<ExampleRow>("examples"),
      ]);
      const preamble = buildPreamble(text, skills, memories, examples);

      const history = sessions.find((s) => s.id === sid)?.msgs ?? [];
      const payloadMessages = [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: text },
      ].filter((m) => m.role === "user" || m.role === "assistant");

      const controller = new AbortController();
      abortRef.current = controller;
      setStream({ text: "" });
      let meta: { provider?: string; model?: string } = {};
      let full = "";
      const persistAssistant = async () => {
        if (!full) return;
        await putLocal("chat_history", {
          client_id: newClientId(),
          session_id: sid,
          role: "assistant",
          content: full,
          provider: meta.provider,
          model: meta.model,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      };
      try {
        const res = await authedFetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: payloadMessages,
            preamble,
            // "auto" = failover chain; only send an explicit model when pinned.
            model: selected === "auto" ? undefined : selected,
            chainOfDraft: deepDraft || undefined,
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const info = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error?: string };
          throw new Error(info.error ?? `HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let sawDone = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
            if (event.type === "meta") {
              meta = { provider: String(event.provider ?? ""), model: String(event.model ?? "") };
              setStream({ text: full, ...meta });
            } else if (event.type === "delta") {
              full += String(event.text ?? "");
              setStream({ text: full, ...meta });
            } else if (event.type === "error") {
              throw new Error(String(event.error ?? "Generation failed"));
            } else if (event.type === "done") {
              sawDone = true;
              await persistAssistant();
              setStream(null);
            }
          }
        }
        if (!sawDone && full) await persistAssistant(); // stream cut short — keep what arrived
        setStream(null);
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          await persistAssistant(); // keep the partial answer on Stop
          setStream(null);
        } else {
          setError(err instanceof Error ? err.message : String(err));
          setStream(null);
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [busy, activeId, selected, deepDraft, sessions],
  );

  /** Soft-delete every message of a session (tombstones sync to Supabase). */
  const deleteSession = useCallback(
    async (id: string) => {
      const msgs = all?.filter((m) => m.session_id === id) ?? [];
      for (const m of msgs) await softDeleteLocal("chat_history", m.client_id);
      if (id === sessionId) setSessionId(null); // fall back to the latest remaining
    },
    [all, sessionId],
  );

  const summaries: SessionSummary[] = useMemo(
    () =>
      sessions.map((s) => ({
        id: s.id,
        title: s.msgs.find((m) => m.role === "user")?.content.slice(0, 60) ?? "New chat",
        latest: s.latest,
      })),
    [sessions],
  );

  const newChat = useCallback(() => {
    setSessionId(newClientId());
    setError(null);
  }, []);

  const greeting = useGreeting();
  const activeModel = models.find((m) => m.id === selected);

  return (
    <div className="relative flex h-screen overflow-hidden bg-white text-neutral-800 supports-[height:100dvh]:h-dvh">
      {/* Desktop sidebar — always visible from md up. */}
      <div className="hidden h-full md:block">
        <ChatSidebar
          sessions={summaries}
          activeId={activeId}
          onSelect={(id) => setSessionId(id)}
          onNew={newChat}
          onDelete={(id) => void deleteSession(id)}
        />
      </div>

      {/* Mobile drawer — off-canvas, overlaps the chat; opened via the ☰ button. */}
      {menuOpen && (
        <div
          className="absolute inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
        />
      )}
      <div
        className={`absolute inset-y-0 left-0 z-40 transition-transform duration-200 md:hidden ${
          menuOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"
        }`}
      >
        <ChatSidebar
          sessions={summaries}
          activeId={activeId}
          onSelect={(id) => {
            setSessionId(id);
            setMenuOpen(false);
          }}
          onNew={() => {
            newChat();
            setMenuOpen(false);
          }}
          onDelete={(id) => void deleteSession(id)}
        />
      </div>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-w-0 items-center gap-2 px-3 py-2 md:gap-3 md:px-6 md:py-3">
          <button
            onClick={() => setMenuOpen(true)}
            aria-label="Open chat history"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xl text-neutral-500 hover:bg-neutral-100 md:hidden"
          >
            ☰
          </button>
          <div className="relative min-w-0 flex-1 overflow-hidden sm:flex-none">
            <select
              value={selected}
              onChange={(e) => pickModel(e.target.value)}
              title={
                selected === "auto"
                  ? "Auto Route — fails over to the next available model"
                  : (activeModel ? `${activeModel.label} · ${activeModel.model}` : selected)
              }
              className="w-full max-w-[44vw] appearance-none rounded-xl border border-neutral-200 bg-white py-1.5 pl-9 pr-7 text-sm font-medium shadow-sm outline-none hover:border-neutral-300 sm:max-w-[13rem] md:max-w-sm md:pr-8"
            >
              <option value="auto">⚡ Auto Route</option>
              {["groq", "gemini", "deepseek", "openrouter"].map((pid) => {
                const group = models.filter((m) => (m.providerId ?? m.id) === pid);
                if (group.length === 0) return null;
                const label = group[0].label.split(" · ")[0] ?? pid;
                return (
                  <optgroup key={pid} label={label}>
                    {group.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} · {m.model}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
            <span className="pointer-events-none absolute left-3 top-1.5 text-sm">🤖</span>
            <span className="pointer-events-none absolute right-2.5 top-2 text-xs text-neutral-400 sm:right-3">▾</span>
          </div>
          <div className="flex shrink-0 items-center gap-2 md:gap-3">
            <span className="hidden max-w-[15rem] truncate text-xs text-neutral-400 md:block">
              {selected === "auto"
                ? `fails over: ${
                    [...new Set(models.map((m) => m.providerId ?? m.id))]
                      .map((pid) => pid[0].toUpperCase() + pid.slice(1))
                      .join(" → ") || "no providers"
                  }`
                : activeModel
                  ? `${activeModel.label} (${activeModel.model})`
                  : ""}
            </span>
            <button
              onClick={newChat}
              className="shrink-0 whitespace-nowrap rounded-xl bg-neutral-900 px-2.5 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-neutral-700 md:px-4"
            >
              + New Chat
            </button>
          </div>
        </header>

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-y-auto">
        {messages.length === 0 && !stream && (
          <div className="flex flex-1 flex-col items-center justify-center px-4 pb-16 pt-8">
            <div className="mb-5 h-12 w-12 rounded-full bg-gradient-to-br from-indigo-400 via-sky-300 to-emerald-200 shadow-lg shadow-indigo-100 md:h-14 md:w-14" />
            <h1 className="text-center text-xl font-semibold text-neutral-900 md:text-2xl">
              {greeting ? `${greeting}, Zonaed` : "Welcome, Zonaed"}
            </h1>
            <p className="mt-1 text-center text-sm text-neutral-500">
              How can I assist you today?
            </p>
            {/* One-tap navigation to the report tools + daily tasks (chat landing). */}
            <div className="mt-7 flex flex-wrap items-center justify-center gap-2 px-4">
              {(
                [
                  ["Competitor Spy", "/competitor-spy", "🔍"],
                  ["Marketing Plan", "/marketing-plan", "📈"],
                  ["Outreach", "/outreach", "✉️"],
                  ["Daily Tasks", "/tasks", "✅"],
                ] as const
              ).map(([label, href, icon]) => (
                <Link
                  key={href}
                  href={href}
                  className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3.5 py-2 text-sm font-medium text-neutral-600 shadow-sm transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600"
                >
                  <span aria-hidden="true">{icon}</span>
                  {label}
                </Link>
              ))}
            </div>
          </div>
        )}
        {messages.length > 0 && (
          <div className="mx-auto w-full max-w-3xl space-y-3 px-3 pb-4 md:px-6">
            {messages.map((m) => (
              <div
                key={m.client_id}
                className={
                  m.role === "user"
                    ? "ml-auto max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-indigo-600 px-3.5 py-2 text-sm text-white md:max-w-[85%] md:px-4"
                    : "mr-auto max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2 text-sm text-neutral-800 md:max-w-[85%] md:px-4"
                }
              >
                {m.content}
              </div>
            ))}
            {stream && (
              <div className="mr-auto max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2 text-sm text-neutral-800 md:max-w-[85%] md:px-4">
                {stream.text || "…"}
                {stream.provider && (
                  <span className="ml-2 align-middle text-[10px] text-neutral-400">{stream.provider}</span>
                )}
              </div>
            )}
            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-600">{error}</div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
        {messages.length === 0 && !stream && error && (
          <div className="mx-auto w-full max-w-3xl px-6 pb-2">
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-600">{error}</div>
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="mx-auto w-full max-w-3xl px-3 pb-[max(env(safe-area-inset-bottom,0px),0.75rem)] pt-2 md:px-6 md:pb-5"
      >
        <div className="rounded-2xl border border-neutral-200 bg-white shadow-lg shadow-neutral-100">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={2}
            placeholder="Initiate a query or send a command to the AI…  (Enter to send)"
            className="max-h-40 w-full resize-y rounded-t-2xl bg-transparent px-4 pb-1 pt-3 text-sm outline-none placeholder:text-neutral-400"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setDeepDraft((v) => !v)}
                title="Plan an outline first, then draft from it (§5.1 chain-of-draft)"
                className={`rounded-full border px-3 py-1 text-xs transition ${
                  deepDraft
                    ? "border-indigo-300 bg-indigo-50 text-indigo-600"
                    : "border-neutral-200 bg-white text-neutral-500 hover:bg-neutral-50"
                }`}
              >
                ✦ Deep Draft
              </button>
              <span className="hidden rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-400 sm:block">
                Memory on
              </span>
            </div>
            {busy ? (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500 text-white hover:bg-red-600"
                aria-label="Stop"
              >
                ■
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-30"
                aria-label="Send"
              >
                ➤
              </button>
            )}
          </div>
        </div>
      </form>
      </main>
    </div>
  );
}
