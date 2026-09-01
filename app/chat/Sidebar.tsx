// ============================================================================
// Chat dashboard sidebar (plan §4 /chat): search, nav, and chat history
// grouped by recency (Today / Yesterday / Previous 7 days / Older).
// ============================================================================
"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

export interface SessionSummary {
  id: string;
  title: string;
  latest: number;
}

export type HistoryGroup = "Today" | "Yesterday" | "Previous 7 days" | "Older";

const DAY_MS = 86_400_000;

/** Pure: group a timestamp relative to a fixed "now" (testable). */
export function groupFor(updatedAt: number, now: number): HistoryGroup {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (updatedAt >= startOfToday) return "Today";
  if (updatedAt >= startOfToday - DAY_MS) return "Yesterday";
  if (updatedAt >= startOfToday - 7 * DAY_MS) return "Previous 7 days";
  return "Older";
}

export const GROUP_ORDER: HistoryGroup[] = ["Today", "Yesterday", "Previous 7 days", "Older"];

const NAV = [
  { href: "/", label: "Home", icon: "⌂" },
  { href: "/tasks", label: "Tasks", icon: "✓" },
  { href: "/skills", label: "Skills", icon: "❖" },
  { href: "/memory", label: "Memory", icon: "❥" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

export default function ChatSidebar({
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
  className = "",
}: {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  /** Extra classes merged into the root (<aside>). Use to show/hide per breakpoint. */
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions),
    [sessions, q],
  );
  return (
    <aside
      className={`flex h-full w-72 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 pb-[env(safe-area-inset-bottom,0px)] ${className}`}
    >
      <div className="px-4 pb-2 pt-4">
        <span className="text-sm font-semibold text-neutral-800">Zonaed AI</span>
      </div>
      <div className="px-3 pb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats…"
          className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-400"
        />
      </div>
      <nav className="space-y-0.5 px-2">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-200/70"
          >
            <span className="w-4 text-center text-xs text-neutral-400">{n.icon}</span>
            {n.label}
          </Link>
        ))}
      </nav>
      <div className="mt-4 px-4 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        History
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {filtered.length === 0 && (
          <p className="px-3 py-4 text-xs text-neutral-400">
            {query ? "No matching chats." : "No conversations yet."}
          </p>
        )}
        {GROUP_ORDER.map((group) => {
          const inGroup = filtered.filter((s) => groupFor(s.latest, Date.now()) === group);
          if (inGroup.length === 0) return null;
          return (
            <div key={group} className="mb-2">
              <div className="px-3 pb-1 pt-2 text-[11px] text-neutral-400">{group}</div>
              {inGroup.map((s) => (
                <div
                  key={s.id}
                  className={`group flex items-center rounded-lg px-3 py-1.5 text-sm ${
                    s.id === activeId ? "bg-neutral-200/80 text-neutral-900" : "text-neutral-600 hover:bg-neutral-200/50"
                  }`}
                >
                  <button
                    onClick={() => onSelect(s.id)}
                    className="flex-1 truncate text-left"
                    title={s.title}
                  >
                    {s.title}
                  </button>
                  <button
                    onClick={() => onDelete(s.id)}
                    aria-label="Delete chat"
                    className="ml-1 hidden text-xs text-neutral-400 hover:text-red-500 group-hover:block"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <button
        onClick={onNew}
        className="m-3 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 shadow-sm hover:bg-neutral-100"
      >
        + New chat
      </button>
    </aside>
  );
}
