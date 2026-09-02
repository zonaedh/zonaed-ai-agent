// ============================================================================
// Navigation registry — the single source of truth for app routes.
//
// Used by BOTH the home grid (app/page.tsx) and the command palette
// (app/components/CommandPalette.tsx) so the palette cannot drift from the
// hub. Routes listed here must have a matching page in app/.
// ============================================================================

export interface NavLink {
  href: string;
  title: string;
  description: string;
}

export const NAV_LINKS: NavLink[] = [
  { href: "/chat", title: "Chat", description: "Talk to the AI — streams, remembers, follows your skills" },
  { href: "/tasks", title: "Tasks", description: "CRUD, recurrence, due-date highlighting" },
  { href: "/memory", title: "Memory", description: "Long-term memory + chat-learning review queue" },
  { href: "/knowledge", title: "Knowledge", description: "Reference docs + .md imports injected into chat" },
  { href: "/skills", title: "Skills", description: "Upload .md skills, versioned, injected into chat" },
  { href: "/digest", title: "Digest", description: "Daily/weekly summary of tasks and activity" },
  { href: "/search", title: "Search", description: "Full-text across chat, memory, knowledge, skills" },
  { href: "/report", title: "Report", description: "Website audit + client proposal from a URL" },
  { href: "/marketing-plan", title: "Marketing plan", description: "Crawl a site, generate a marketing plan" },
  { href: "/competitor-spy", title: "Competitor spy", description: "Analyze a competitor's positioning + gaps" },
  { href: "/outreach", title: "Outreach", description: "LinkedIn + cold outreach from a prospect page" },
  { href: "/export", title: "Export", description: "JSON + Markdown backup of all data" },
  { href: "/settings", title: "Settings", description: "Push notifications, reminders, digest, learning" },
];

// ---------------------------------------------------------------------------
// Command palette items — shared with app/components/CommandPalette.tsx so the
// palette list is testable offline and always matches the hub.
// ---------------------------------------------------------------------------

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  action: () => void;
}

/** Navigation + global quick actions, nav section reading NAV_LINKS. */
export function buildPaletteItems(go: (href: string) => void): PaletteItem[] {
  const actions: PaletteItem[] = [
    {
      id: "new-task",
      label: "New task (quick capture)",
      hint: "/tasks?capture=1",
      action: () => go("/tasks?capture=1"),
    },
    { id: "home", label: "Back to home", hint: "/", action: () => go("/") },
  ];
  const nav: PaletteItem[] = NAV_LINKS.map((link) => ({
    id: link.href,
    label: link.title,
    hint: link.href,
    action: () => go(link.href),
  }));
  return [...actions, ...nav];
}