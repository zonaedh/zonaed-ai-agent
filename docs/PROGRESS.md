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
- [x] **Provisioned live project:** `zonaed-ai-agent` (ref `pdgsuwcyxmocloulevvm`,
      ap-south-1, `ACTIVE_HEALTHY`); anonymous auth enabled; migrations applied
      via `scripts/apply-migrations.mjs` (Management API SQL endpoint); real
      keys in `.env.local`. Vercel env vars still pending (deploy step).
      Note: `supabase db push` pooler auth fails with the stored DB password —
      use `scripts/apply-migrations.mjs` for future migration pushes.

## 1. Auth model (PIN gate + Supabase anonymous session + RLS)
- [x] PIN device gate module (PBKDF2-SHA256, salted, local-only, never leaves
      the device) — `lib/auth/pin.ts`
- [x] Supabase client bootstrap + anonymous session (`ensureSupabaseSession`)
      — `lib/auth/supabase.ts`
- [x] HMAC session tokens with server-side `exp` validation
      (`lib/auth/tokens.ts`, `POST /api/auth/session`, `GET /api/auth/verify`,
      guard in `lib/auth/guards.ts`) — verified live: expired → 401,
      tampered → 403
- [x] Scoped revocable extension sync tokens (`zsy_…`, SHA-256-hashed at
      rest) + `sync_tokens` migration (`0002_sync_tokens.sql`) +
      `requireSyncToken` guard for `/api/sync/*`
- [x] Token logic checks: `node scripts/verify-auth.mjs` (5/5 pass);
      live HTTP smoke: `node scripts/smoke-verify.mjs` (4/4 pass)
- [ ] PIN unlock UI (client component wiring setPin/verifyPin + session fetch)
- [x] End-to-end verification against the live Supabase project:
      `node scripts/verify-auth-e2e.mjs` — anonymous sign-in (2 distinct
      users), RLS sets `user_id` from `auth.uid()`, owner read, cross-user
      isolation (0 rows), unauthenticated 0 rows

## 2. Dexie ↔ Supabase sync engine (LWW conflict resolution, soft deletes, sync status UI)
- [x] Dexie schema — `client_id`-keyed syncable stores + `sync_state` watermarks
      + `conflict_archive` (`lib/db/client.ts`, types in `lib/db/types.ts`)
- [x] CRUD repo: every write stamps `updated_at` + `dirty`; deletes are always
      tombstones (`lib/db/repo.ts`)
- [x] Pure sync engine: pull (watermark + 2s overlap), push (batched upsert on
      `user_id,client_id`), LWW by `updated_at`, losing versions archived to
      `conflict_archive` — never dropped (`lib/sync/engine.ts`)
- [x] Migration `0003_lww_updated_at.sql`: trigger preserves client-supplied
      `updated_at` (LWW precondition); verified live via SQL round-trip
- [x] Scheduler + zustand status store: auto-sync on load/online/60s interval,
      non-overlapping runs (`lib/sync/scheduler.ts`)
- [x] Sync status UI: fixed status pill, click = sync now, pending counter,
      offline/error states (`app/components/SyncIndicator.tsx`, mounted in layout)
- [x] Extension sync API: `GET /api/sync/pull`, `POST /api/sync/push` —
      `requireSyncToken`-scoped, user_id forced from token, server-side LWW
      (older/equal pushes reported as `skipped`, never applied)
- [x] Live E2E vs real Supabase (`npm run verify:sync`, fake-indexeddb + tsx):
      22/22 pass — push preserves LWW timestamps, pull applies remote edits,
      stale local edit loses + archived, tombstones propagate, getLive/listLive
      hide deleted, cross-user RLS isolation, cleanup
- [x] Migration runner upgrade: `schema_migrations` bookkeeping, idempotent
      re-runs, legacy 0001/0002 recorded
- [x] Live API smoke (`npm run smoke:sync`, needs running server):
      push → applied:1, stale push → skipped (server-side LWW), pull returns
      row, missing token → 401, garbage token → 403, revoked token → 403
      (6/6 pass). Service-role key provisioned into `.env.local`.

## 3. Intelligence & persona stack port into `/api/chat` (tone-profiler, persona/punctuation, memory-skills injector, anti-cliché filter, chain-of-draft; cloud providers only)

- [x] `lib/ai/tone.ts` — Bengali Unicode + Banglish (transliteration) detection,
      three language modes: `english` / `banglish` / `bengali`; per-message,
      no user setting needed (§5.1 `tone-profiler` port)
- [x] `lib/ai/anti-cliche.ts` — em/en-dash ban + sanitize, banned word list
      (delve, testament, tapestry, embark, furthermore, moreover, beacon,
      game-changer) with word-boundary matching; `scanOutput` post-generation
      check reported in the SSE `done` event (§5.1 filter port)
- [x] `lib/ai/matching.ts` — shared preamble builder: keyword-triggered +
      always-on skills, relevance-scored memories (not a blind dump), few-shot
      examples (§5.1 `memory-skills.ts` port; §5.3 injection reuses it)
- [x] `lib/ai/system-prompt.ts` — persona → language-mode rules → anti-cliché
      rules → preamble → chain-of-draft instructions (§5.1 `system-prompt` port)
- [x] `lib/ai/providers.ts` — cloud-only provider layer (Groq, Gemini, DeepSeek,
      OpenRouter): OpenAI-compatible + Gemini stream parsing, 429/503/network
      failover (extension `quota-router` behavior), fail-fast when a provider
      key is missing, aggregated error when all fail. Keys are placeholders —
      wiring real keys is a deploy step, not a code step
- [x] `app/api/chat/route.ts` — SSE streaming pipeline in plan §5.1 order:
      requireSession guard → rate limit (Upstash fixed window, fail-open,
      `lib/rate-limit.ts`) → tone profile → system prompt → provider stream →
      post-scan. Client sends `preamble` (assembled from Dexie via matching.ts,
      works offline), optional `chainOfDraft` / `approvedOutline` (mutually
      exclusive, enforced)
- [x] Verification: `npm run verify:intelligence` 16/16 (tone, anti-cliché,
      matching, system prompt, provider failover + SSE parsing on mock streams);
      `npm run smoke:chat` 4/4 live (401 / 400 / 503 / mutually-exclusive 400).
      tsc + eslint + build clean

## 4. Skill/Knowledge upload system (§5.3) — `/skills` page, versioned uploads, injection logic

- [x] `lib/skills/sanitize.ts` — upload guardrail per §7: 200 KB size cap, strips
      `<script>/<style>/<iframe>/<object>/<embed>` + content, event-handler
      attrs, `javascript:`/`vbscript:`/`data:` URLs, control chars, zero-width /
      bidi-override chars; normalizes line endings; reports `modified`
- [x] `lib/skills/upload.ts` — local-first upload pipeline: sanitize →
      title-from-filename → re-upload with same title bumps `version` on the
      existing `client_id` (keeps remote row identity), archives the superseded
      body into `conflict_archive` first (§5.3 "no silent overwrite"); toggle
      active / edit without version bump
- [x] `/skills` page (`app/skills/page.tsx`) — upload (`.md`, drag/file picker),
      list/read/activate/deactivate/delete (tombstone via repo), version badge,
      sanitization warnings; writes flow through the §3 sync to Supabase
- [x] Injection reuse: §5.1 `lib/ai/matching.ts` `buildPreamble` consumes the
      same `skills` Dexie store → uploads are injected into `/api/chat`
      (always-on or by `trigger_keywords`) with no extra code
- [x] Verification: `npm run verify:skills` 12/12 pass (sanitizer XSS/control/
      size cases, filename→title, versioning bump + archive, keyword injection
      incl. always-on / disabled, active toggle). tsc + eslint clean.
      Chat preamble E2E re-verified with a real upload.

## 5. iOS PWA fixes (viewport-fit=cover, split icon purposes, splash screens)

- [x] `app/manifest.ts` — name/short_name/start_url/standalone/colors/categories;
      icon purposes SPLIT (`any` 192+512, separate `maskable` 512 — never
      combined, plan §9 #3); shortcuts New Chat `/chat`, New Task `/tasks`,
      Quick Capture `/skills?capture=1` (active when those pages land later)
- [x] `scripts/generate-pwa-assets.mjs` — zero-dependency PNG generator
      (brand `Z` monogram on slate-900): `public/icons/icon-192.png`,
      `icon-512.png`, `icon-512-maskable.png`, `public/apple-touch-icon.png`
      (180, opaque), and 16 `public/splash/*.png` launch screens covering
      iPhone SE→15 Pro Max + iPad mini→12.9" (exact pixel sizes + media
      queries); emits `lib/pwa-splash.ts` so markup can't drift from assets
- [x] `app/components/PwaLinks.tsx` — `apple-touch-startup-image` `<link>` tags
      (iOS ignores the manifest for launch images) hoisted in the root layout
- [x] Layout: `viewport-fit=cover` + themeColor (`app/layout.tsx` Viewport
      export), `appleWebApp { capable, statusBarStyle: black-translucent }`
      + apple-touch-icon metadata
- [x] Safe area: `.ios-safe-top/bottom/left/right` + `.ios-safe-bottom-float`
      utilities in `globals.css`; body pads the notch inset; SyncIndicator
      floats above the home indicator
- [x] Verification: `npm run verify:pwa` 10/10 (PNG IHDR dimensions + opacity,
      split purposes rule, shortcuts, viewport-fit, appleWebApp, safe-area);
      live server: `/manifest.webmanifest` serves split purposes, head emits
      viewport-fit=cover + `apple-mobile-web-app-*` + 16 startup links,
      icons/splash return 200 image/png; `next build` ✓

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
