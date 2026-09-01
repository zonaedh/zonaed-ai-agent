// App hub — entry page linking every module (plan §4, §9 item 12).
// Server component; plain links so it renders instantly, even offline-cached.
// Routes come from lib/navigation.ts so the command palette can't drift.
import Link from "next/link";
import { NAV_LINKS } from "@/lib/navigation";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Zonaed AI</h1>
        <kbd className="hidden rounded-md border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500 sm:inline-block dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          Ctrl/⌘ + K
        </kbd>
      </div>
      <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        Offline-first AI assistant. Local data, synced when online.
      </p>
      <Link
        href="/chat"
        className="mb-5 flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500"
      >
        💬 Start chatting
      </Link>
      <div className="grid gap-3 sm:grid-cols-2">
        {NAV_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="rounded-xl border border-zinc-200 bg-white px-4 py-4 shadow-sm transition hover:border-emerald-500/60 hover:bg-emerald-50/40 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-emerald-500/40 dark:hover:bg-emerald-950/20"
          >
            <h2 className="text-sm font-semibold">{link.title}</h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{link.description}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
