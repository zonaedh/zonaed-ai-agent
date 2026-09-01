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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { listLive, newClientId, putLocal } from "@/lib/db/repo";
import type { ChatMessageRow, ExampleRow, MemoryRow, SkillRow } from "@/lib/db/types";
import { buildPreamble } from "@/lib/ai/matching";

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
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

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
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: payloadMessages, preamble }),
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
    [busy, activeId, sessions],
  );

  const newChat = useCallback(() => {
    setSessionId(newClientId());
    setError(null);
  }, []);

  return (
    <main className="mx-auto flex h-dvh max-w-3xl flex-col px-4">
      <header className="flex items-center justify-between py-4">
        <Link href="/" className="text-sm text-neutral-400 hover:text-white">
          ← Home
        </Link>
        <div className="flex items-center gap-2">
          {sessions.length > 1 && (
            <select
              value={activeId ?? ""}
              onChange={(e) => setSessionId(e.target.value)}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300"
            >
              {sessions.map((s, i) => (
                <option key={s.id} value={s.id}>
                  {i === 0 ? "Latest chat" : `Chat ${sessions.length - i}`}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={newChat}
            className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
          >
            + New chat
          </button>
        </div>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto pb-4">
        {messages.length === 0 && !stream && (
          <p className="mt-16 text-center text-sm text-neutral-500">
            Say something — the assistant answers in your language
            (English / বাংলা / Banglish), remembers what you tell it, and follows
            your uploaded skills.
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.client_id}
            className={
              m.role === "user"
                ? "ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-sky-900/60 px-4 py-2 text-sm"
                : "mr-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-neutral-800 px-4 py-2 text-sm"
            }
          >
            {m.content}
          </div>
        ))}
        {stream && (
          <div className="mr-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-neutral-800 px-4 py-2 text-sm">
            {stream.text || "…"}
            {stream.provider && (
              <span className="ml-2 align-middle text-[10px] text-neutral-500">{stream.provider}</span>
            )}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-red-900 bg-red-950/60 px-4 py-2 text-sm text-red-300">{error}</div>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="flex items-end gap-2 border-t border-neutral-800 py-3"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          rows={1}
          placeholder="Type a message…  (Enter to send, Shift+Enter for a new line)"
          className="max-h-40 flex-1 resize-y rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            className="rounded-xl bg-red-900/70 px-4 py-2 text-sm text-red-100 hover:bg-red-800"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            className="rounded-xl bg-sky-700 px-4 py-2 text-sm text-white hover:bg-sky-600 disabled:opacity-40"
          >
            Send
          </button>
        )}
      </form>
    </main>
  );
}
