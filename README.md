# Zonaed AI Web App

Full-stack, offline-first AI assistant PWA (`agent.thesharkweb.com`) with
cloud-synced memory, chat history, task management, knowledge base,
personalized skills, and opt-in self-learning from chat history.

> Implementation target: `final_mvp_implementation_plan_v2.md`. Build progress
> is tracked in [`docs/PROGRESS.md`](docs/PROGRESS.md) against plan §9.

## Stack

Next.js 16 (App Router) · Tailwind CSS 4 · Dexie.js (local-first source of
truth) · Supabase Postgres + Auth + RLS (sync/backup layer) · Zustand ·
Upstash Redis (rate limiting) · Vercel

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env.local
   # fill in: Supabase URL/keys, AI provider keys (Groq, Gemini, DeepSeek,
   # OpenRouter), Upstash Redis, SYNC_TOKEN_SECRET (openssl rand -hex 32),
   # CRON_SECRET
   ```

   Env validation is zod-based and **fails fast**: `npm run build` runs
   `scripts/check-env.mjs` first, and server code validates again at runtime
   via `lib/env.ts`. Real keys live only in Vercel env vars — never commit
   them (CI runs a gitleaks secret scan).

3. **Provision Supabase** (manual, one-time — requires dashboard access)

   - Create the Supabase project; enable anonymous auth
     (Auth → Providers → Anonymous).
   - Apply the initial migration (creates `tasks`, `memory`, `knowledge`,
     `chat_history`, `skills`, `examples`, `settings` with
     `client_id` / `updated_at` / `deleted_at` sync columns, triggers, and
     project-wide RLS keyed off `auth.uid()`):

     ```bash
     supabase link --project-ref <ref>
     supabase db push
     ```

     or paste `supabase/migrations/0001_initial_schema.sql` into the
     dashboard SQL editor and run it.

4. **Run**

   ```bash
   npm run dev      # development
   npm run build    # production build (env-validated)
   npx tsc --noEmit # typecheck
   ```

## Repository boundaries

This repo is **webapp-only** (Next.js app, Supabase schema, PWA assets,
`/report` `/marketing-plan` `/competitor-spy` `/outreach`). Live-DOM extension
features (WhatsApp CRM, Ghostwriter, Autofill, Page Watcher, OCR, Structured
Scraping, YouTube Repurposing Studio) live in the separate
`zonaed-ai-agent-extension` repo. The shared contract between the two is the
`/api/sync/*` API and env-var-based provider keys — nothing else is shared.
