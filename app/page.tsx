// App hub — entry page linking every module (plan §4).
// Server component; plain links so it renders instantly, even offline-cached.
import Link from "next/link";

const LINKS: { href: string; title: string; description: string }[] = [
  { href: "/tasks", title: "Tasks", description: "CRUD, recurrence, due-date highlighting" },
  { href: "/skills", title: "Skills", description: "Upload .md skills, versioned, injected into chat" },
  { href: "/search", title: "Search", description: "Full-text across chat, memory, knowledge, skills" },
  { href: "/report", title: "Report", description: "Website audit + client proposal from a URL" },
  { href: "/marketing-plan", title: "Marketing plan", description: "Crawl a site, generate a marketing plan" },
  { href: "/competitor-spy", title: "Competitor spy", description: "Analyze a competitor's positioning + gaps" },
  { href: "/outreach", title: "Outreach", description: "LinkedIn + cold outreach from a prospect page" },
  { href: "/export", title: "Export", description: "JSON + Markdown backup of all data" },
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
      <h1 className="mb-1 text-2xl font-bold tracking-tight">Zonaed AI</h1>
      <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        Offline-first AI assistant. Local data, synced when online.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {LINKS.map((link) => (
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
