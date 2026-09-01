# Build Progress — §9 Priority Order

Tracking checklist for `final_mvp_implementation_plan_v2.md` §9. One numbered
priority at a time, verified against §8 before moving on.

## Step 0 — Environment & infra setup

- [x] Base Next.js 16 (App Router) + Tailwind 4 + TypeScript scaffolding
- [x] Zod env-var validation, fail fast on missing keys (`lib/env.ts`)
- [x] Initial Supabase migration: `tasks`, `memory`, `knowledge`,
      `chat_history`, `skills`, `examples`, `settings` — each with
      `client_id`, `updated_at`, `deleted_at`; RLS enabled project-wide
      (`supabase/migrations/0001_initial_schema.sql`)
- [x] CI: build + typecheck + secret-scan (`.github/workflows/ci.yml`)
- [x] `.env.example` documenting all required keys
- [ ] **Manual (account access required):** provision the Supabase project,
      run the migration, enable anonymous auth, set Vercel env vars

## 1. Auth model (PIN gate + Supabase anonymous session + RLS)
- [ ] PIN device gate (hashed, local-only, never sent to providers)
- [ ] Supabase anonymous session; RLS-authorized data access
- [ ] HMAC session tokens with server-side `exp` validation

## 2. Dexie ↔ Supabase sync engine (LWW conflict resolution, soft deletes, sync status UI)

## 3. Intelligence & persona stack port into `/api/chat` (tone-profiler, persona/punctuation, memory-skills injector, anti-cliché filter, chain-of-draft; cloud providers only)

## 4. Skill/Knowledge upload system (§5.3) — `/skills` page, versioned uploads, injection logic

## 5. iOS PWA fixes (viewport-fit=cover, split icon purposes, splash screens)

## 6. Full-text search (chat, memory, knowledge, skills)

## 7. Data export/backup

## 8. Recurring tasks + quick capture shortcut

## 9. Webapp report/analysis tools (§5.2) — `/report`, `/marketing-plan`, `/competitor-spy`, `/outreach`

## 10. Web Push (reminders + digest)

## 11. Day-by-day chat history learning (§5.4) — opt-in job + review queue

## 12. Nice-to-haves (voice input, calendar sync, command palette)

---

**Not in this repo (extension-only, separate repo):** WhatsApp Lead CRM &
Auto-Responder, Inline Ghostwriter Copilot, Form Autofill, Scheduled Page
Watcher, OCR, Structured Scraping, YouTube Repurposing Studio.
