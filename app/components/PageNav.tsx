"use client";

// ============================================================================
// PageNav — consistent top navigation for every non-chat page.
//
// A single back button (← returns home), the page title, and optional one-tap
// links to related modules. Replaces the ad-hoc "← Home" links pages used to
// render, so back navigation and cross-module jumps are identical everywhere.
// ============================================================================

import Link from "next/link";

export interface PageNavAction {
  href: string;
  label: string;
  icon?: string;
}

interface PageNavProps {
  title: string;
  /** Absolute route for the back button; defaults to the hub. */
  backHref?: string;
  /** Optional one-tap links to related modules. */
  actions?: PageNavAction[];
}

export default function PageNav({ title, backHref = "/", actions = [] }: PageNavProps) {
  return (
    <nav className="mb-5 flex min-w-0 items-center gap-2 md:gap-3">
      <Link
        href={backHref}
        aria-label="Back to home"
        title="Back to home"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-base text-zinc-500 shadow-sm transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
      >
        ←
      </Link>
      <h1 className="truncate text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
        {title}
      </h1>
      {actions.length > 0 && (
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {actions.map((a) => (
            <Link
              key={a.href}
              href={a.href}
              className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 shadow-sm transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            >
              {a.icon && <span aria-hidden="true">{a.icon}</span>}
              <span className="max-w-[7rem] truncate sm:max-w-none">{a.label}</span>
            </Link>
          ))}
        </div>
      )}
    </nav>
  );
}