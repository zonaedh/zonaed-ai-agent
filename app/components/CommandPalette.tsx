"use client";

// ============================================================================
// Command palette (Cmd/Ctrl+K) — keyboard-driven navigation + quick actions
// (plan §9 item 12, nice-to-have). Desktop-focused per plan §4.
//
// Mounted once in the root layout. Opens with Ctrl+K / ⌘+K anywhere in the
// app, filters a typeahead over NAV_LINKS + global actions, and navigates with
// Enter / arrow keys. Routes come from lib/navigation.ts (same source as the
// hub), so the palette can never drift from the home grid.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { buildPaletteItems, type PaletteItem } from "@/lib/navigation";

export type { PaletteItem };

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      setQuery("");
      router.push(href);
    },
    [router],
  );

  const items = useMemo(() => buildPaletteItems(go), [go]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => `${item.label} ${item.hint ?? ""}`.toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isToggle = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
      if (isToggle) {
        e.preventDefault();
        setOpen((prev) => !prev);
        setQuery("");
        setActive(0);
        return;
      }
      if (!open) return;
      if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (filtered.length === 0 ? 0 : (a + 1) % filtered.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (filtered.length === 0 ? 0 : (a - 1 + filtered.length) % filtered.length));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        filtered[active]?.action();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, filtered, active]);

  useEffect(() => {
    if (open) {
      // The toggle handler already resets the highlight; just focus the input
      // after the overlay mounts.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-zinc-950/40 p-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          placeholder="Type a command or page…"
          aria-label="Palette search"
          className="w-full border-b border-zinc-200 bg-transparent px-4 py-3 text-sm outline-none dark:border-zinc-700"
        />
        <ul className="max-h-72 overflow-y-auto py-1" role="listbox" aria-label="Commands">
          {filtered.length === 0 ? (
            <li className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">No matches.</li>
          ) : (
            filtered.map((item, index) => (
              <li key={item.id} role="option" aria-selected={index === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(index)}
                  onClick={item.action}
                  className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm ${
                    index === active
                      ? "bg-emerald-600 text-white"
                      : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  }`}
                >
                  <span>{item.label}</span>
                  {item.hint && (
                    <span className={`text-xs ${index === active ? "text-emerald-100" : "text-zinc-400"}`}>
                      {item.hint}
                    </span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="flex items-center justify-between border-t border-zinc-200 px-4 py-1.5 text-[10px] text-zinc-400 dark:border-zinc-700">
          <span>↑↓ navigate · Enter run · Esc close</span>
          <span>Ctrl/⌘ + K</span>
        </div>
      </div>
    </div>
  );
}