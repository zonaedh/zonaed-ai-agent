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
- [x] PIN unlock UI — `app/components/PinGate.tsx` mounted in the root layout:
      full-screen gate with setup (first run: 4–12 digit PIN + confirm, stored
      as PBKDF2 hash locally) and locked states; children do not render (and
      the sync scheduler does not boot) until unlocked; 5 wrong attempts →
      30s cooldown; offline unlock still opens the app (local-first).
      `lib/auth/pin.ts` lock semantics flipped so a fresh tab session starts
      LOCKED (`zonaed.unlocked` marker). `lib/auth/app-session.ts` (new):
      mints the HMAC session token via `ensureSupabaseSession()` →
      `POST /api/auth/session`, stores it in sessionStorage, `authedFetch`
      attaches `Authorization: Bearer` + refresh-once-on-401 for /api/* calls.
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

- [x] `lib/search/engine.ts` — pure offline FTS: tokenizer (Latin accents NFD-collated,
      Bengali/Banglish safe — Indic combining vowel signs kept via `\p{M}`),
      weighted scoring (multi-word phrase +6/+6 title/+4 tags/+2 body; per-term
      +2 title/+1.5 tags/+1+freq body; 30-day recency bonus only among real
      matches; zero score = no match), deterministic sort (score desc, recency
      desc), `makeSnippet` (window around first hit with ellipses) and
      `highlight` (per-occurrence `{text, hit}` segments). Fully unit-testable.
- [x] `lib/search/adapters.ts` — Dexie row → `SearchDocument` mapping for the
      four target stores (chat content/role, memory, knowledge, skills tags).
- [x] `/search` page (`app/search/page.tsx`) — debounced client search over the
      local Dexie cache (offline-first), grouped by source, weighted ranking,
      hit highlighting via `<mark>`, matched-field badges, empty/loading/error/
      no-results states; skills results link into `/skills`.
- [x] Verification: `npm run verify:search` 15/15 pass (tokenizer incl. Bengali,
      phrase > partial ranking, title > body, tags participate, recency tiebreak,
      snippet ellipses, highlight multiplicity, limit, determinism).
      `tsc` + `eslint` + `next build` clean (`/search` prerendered static).

## 7. Data export/backup

- [x] `lib/export/exporters.ts` — pure builders (tested in Node, run in browser):
      `buildJsonExport` (schema-versioned bundle, `app` marker, `exportedAt`,
      six stores, per-store counts; strips local-only `dirty`, keeps
      `client_id`/timestamps/`deleted_at` tombstones for a future restore),
      `buildMarkdownExport` (per-type sections with `### N.` numbered rows;
      `includeDeleted` flag; `type` full/skills/knowledge), `markdownRow`
      (escapes `|` and newlines), browser download helpers (Blob + object URL)
- [x] `/export` page (`app/export/page.tsx`) — four actions: Full JSON backup,
      Full Markdown, Skills-as-Markdown (re-uploadable to /skills §5.3),
      Knowledge-as-Markdown (re-importable to /knowledge); per-action status
      feedback; snapshots live to include tombstoned rows
- [x] Verification: `npm run verify:export` 12/12 pass (schema marker/version,
      counts, dirty-strip + tombstone-keep, JSON round-trip via stringify/parse,
      empty stores, MD header/sections, includeDeleted, type filters, escaping,
      field spot-checks). `tsc` + `eslint` + `next build` clean.

## 8. Recurring tasks + quick capture shortcut  *(complete)*

- [x] `lib/tasks/recurrence.ts` — pure engine: `RecurrenceRule` validation
      (`isRecurrenceRule`/`parseRecurrence`), `nextOccurrence` (daily / weekly
      with weekday-set / monthly + yearly with end-of-month clamping to Feb 28,
      `interval`, `until` exhaustion, strictly-after semantics; monthly/yearly
      may fire later in the anchor's own month/year),
      `describeRecurrence` (UI labels: "Every 2 weeks on Mon, Fri",
      "Every month on day 15", "Custom" fallback)
- [x] `lib/tasks/repo.ts` — `createTask` (trims title, validates recurrence +
      due date, stamps `dirty`), `completeTask` (one-off completes in place;
      recurring spawns the next occurrence as a NEW row, original kept as
      history; idempotent — no double spawn; no spawn past `until`),
      `rescheduleTask` (set/clear/validate due), `setTaskCompleted` (reopen
      clears `completed_at`), `deleteTask` (tombstone), `listOpenTasks` /
      `listCompletedTasks` (filter + due-date sort)
- [x] `app/tasks/page.tsx` — list (open + completed sections, overdue
      highlight), add form, recurrence picker (none/daily/weekly weekdays/
      monthly/yearly + interval), complete/reopen, reschedule, delete;
      `?capture=1` quick-capture autofocus. Overdue clock uses a
      `useSyncExternalStore` hook (react-hooks/purity bans `Date.now()` in
      render)
- [x] `app/manifest.ts` — Quick Capture shortcut points to `/tasks?capture=1`
- [x] `scripts/verify-tasks.mts` + npm `verify:tasks` — 21/21 checks pass
      (10 recurrence-engine, 11 repo over fake-indexeddb)
- [x] Verification: `tsc --noEmit`, `eslint` (max-warnings 0), `next build`,
      `verify:sync` 22/22, `verify:search` 15/15, `verify:pwa` 10/10,
      `verify:export` 12/12 — all green. Committed.

## 9. Webapp report/analysis tools (§5.2) — `/report`, `/marketing-plan`, `/competitor-spy`, `/outreach`

- [x] `lib/tools/crawl.ts` — server-side fetch + extraction: URL hardening
      (bare-domain https upgrade, http/https-only, SSRF guard rejecting
      localhost/.internal/.local/.local + private/loopback/link-local/CGNAT IP
      literals incl. `169.254.169.254` metadata), 12s timeout + 750 KB byte cap
      streaming read, HTML → text profile (title, meta description, h1–h3,
      entity-decoded whitespace-collapsed 12 KB-capped body text), same-origin
      link discovery (asset extensions skipped, deduped, fragments dropped),
      `crawlSite` (bounded page count, per-page failure tolerated + reported)
- [x] `lib/tools/prompts.ts` — tool registry: report (audit + client proposal,
      single page), marketing-plan (site crawl, 6 pages), competitor-spy
      (positioning + exploitable gaps, single page), outreach (LinkedIn note,
      InMail, cold email, follow-up; single page). All system prompts embed the
      §5.1 anti-cliché rules; user prompts render crawled pages + user notes
- [x] `app/api/tools/generate/route.ts` — POST {tool, url, notes} →
      requireSession → rate limit 6/min (heavy: crawl + generation) →
      validate + crawl → SSE stream via the §5.1 provider failover stack
      (meta with fetched page list → deltas → done with scanOutput report);
      422 when the target page is unfetchable
- [x] `app/components/ToolRunner.tsx` — shared client: URL + optional notes
      form, authedFetch POST, SSE parsing (crawl/generate phases, Stop button),
      live result pane with Copy + Download .md, page/provider meta line,
      anti-cliché warning when the scan is unclean
- [x] Pages: `/report`, `/marketing-plan`, `/competitor-spy`, `/outreach`
      (thin ToolRunner wrappers); `app/page.tsx` replaced the Next.js scaffold
      with an app hub linking all modules
- [x] Verification: `npm run verify:tools` 22/22 (URL hardening incl. SSRF
      rejections, extraction/script-strip/caps, link rules, fetchPage caps,
      crawl tolerance, registry + prompt rules); `tsc --noEmit`, `eslint`
      (max-warnings 0), `next build` (all four routes + API prerendered/
      dynamic), `verify:sync` 22/22, `verify:search` 15/15, `verify:skills`
      12/12, `verify:export` 12/12, `verify:intelligence` 16/16,
      `verify:tasks` 21/21, `verify:pwa` 10/10, `verify:auth` — all green.
      Committed.

## 10. Web Push (reminders + digest)

- [x] `web-push` dependency (+ `@types/web-push`); real VAPID keypair
      generated (`npx web-push generate-vapid-keys`) into `.env.local`;
      `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
      `VAPID_SUBJECT` (optional) added to `.env.example`, `lib/env.ts`,
      `scripts/check-env.mjs` (required — build fails fast without them)
- [x] `supabase/migrations/0002_push_subscriptions.sql` — device-bound
      `push_subscriptions` (unique user_id+endpoint, RLS = own rows,
      not synced so hard-delete applies) + `tasks.reminded_at` column.
      NOTE: needs applying — run `scripts/apply-migrations.mjs` with
      SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF (same step as Vercel env)
- [x] `lib/push/payload.ts` — pure logic: reminder payload (title clamp,
      whitespace cleanup, due-time phrasing), digest payload + summary
      (overdue/today/this-week counts, next-3 titles, empty states),
      `isDigestFrequency`, server settings row ids
- [x] `lib/push/send.ts` — VAPID config guard, `sendToSubscription`
      (24 h TTL, 404/410 → expired), `sendToUser` (all devices per user,
      dead endpoints deleted, service-role client always user-filtered)
- [x] Routes (all `force-dynamic`): `POST /api/push/subscribe` (session
      guard, zod-validated subscription, upsert on user_id+endpoint),
      `POST /api/push/unsubscribe` (hard delete — device-bound data),
      `POST /api/push/preferences` (off/daily/weekly → settings table,
      server-owned client_id), `GET /api/push/cron` (Bearer CRON_SECRET,
      constant-time compare)
- [x] Cron logic: reminders = open tasks due_at ≤ now with reminded_at
      null → one push per device → per-row reminded_at stamp (no double
      fires; recurring tasks re-arm naturally); digests = interval-based
      (≥20 h daily, ≥6 d weekly) so server timezone never shifts cadence,
      watermark in settings `push_digest_last_sent`, sent-count-gated
- [x] `vercel.json` — cron hits `/api/push/cron` every minute
- [x] `public/sw.js` — dependency-free SW: push → notification (icon, tag,
      payload url), click → focus-and-navigate or openWindow; no fetch
      handler (Next.js owns caching); install/activate skipWaiting+claim
- [x] `lib/push/client.ts` — registerServiceWorker, getPushState,
      subscribeToPush (permission → SW → pushManager.subscribe with VAPID
      key → server POST), unsubscribeFromPush (local-first), 
      setDigestPreference; authedFetch handles token mint/refresh
- [x] `/settings` page — permission-state UI (unsupported/denied/off/on),
      enable/disable per device, digest Off/Daily/Weekly selector (gated on
      push being enabled); no permission prompt on page load; hub link added
- [x] Verification: `npm run verify:push` 22/22 (payload/summary logic,
      unconfigured guard, fabricated-endpoint no-throw contract, SW handlers,
      4 route contracts, migration SQL, vercel.json, client flow, settings
      page no-auto-prompt, env wiring, hub, deps); `tsc --noEmit`, `eslint`
      (max-warnings 0), `next build` (all push routes + /settings present),
      full existing suite re-run — all green. Committed.

## 11. Day-by-day chat history learning (§5.4) — opt-in job + review queue

- [x] `lib/learn/extract.ts` — pure logic: setting keys
      (`learn_from_chat`, `learn_last_day`), UTC day keys/bounds,
      `pendingDays` (yesterday-and-back, watermark skip, 3-day bounded
      lookback so a long-offline account can never trigger an LLM burst),
      `capMessages` (120 msgs / 30k chars, chronological, newest kept),
      extraction system prompt (only durable facts, user's own voice,
      category/target vocab), `parseSuggestions` with a string-aware
      salvage parser (whole-batch JSON.parse failure → brace-matching entry
      recovery, so one truncated entry never loses the rest), validation
      (target/category whitelists, length clamps, in-response dedupe),
      `dedupeCandidates` against existing memory/skills text
- [x] `lib/ai/providers.ts` — added non-streaming `completeFromProvider` +
      `completeWithFailover` (temperature 0.2, same 429/503 failover
      semantics as the streaming path) for background jobs with no SSE
      consumer
- [x] `supabase/migrations/0003_learn_suggestions.sql` — server-written
      review queue: `learn_suggestions` (user_id, target [memory|skill],
      title/content/category, status [pending|approved|discarded],
      `approved_*` edit-before-approve originals for the diff,
      `source_excerpt`, `day`, RLS = own rows, set_updated_at trigger).
      Nothing is ever auto-applied — no hard deletes, only status marks.
      NOTE: needs applying via `scripts/apply-migrations.mjs` (same step
      as 0002 + Vercel env)
- [x] `GET /api/learn/preferences` (session guard → settings
      `learn_from_chat` state) / `POST` (opt-in upsert with server-owned
      client_id; opt-out deletes the row so no job ever runs) — off by
      default (plan §5.4 + §7 #8)
- [x] `GET /api/learn/cron` — Vercel Cron daily (see vercel.json), Bearer
      CRON_SECRET constant-time check, ≤10 users/run: watermark →
      `chat_history` for each pending day (user-scoped, deleted_at null,
      capped 400) → provider failover extraction call → validate + dedupe →
      `learn_suggestions` insert; empty days stamp the watermark so they are
      not rescanned; per-user failures leave the watermark untouched for retry
- [x] `/api/learn/suggestions` — GET pending-first review queue; POST
      approve/discard (id-scoped, pending-only, 60/min rate limit).
      Approve writes the REAL row server-side (memory source
      `learn-review`, or skills version 1 active) FIRST, then marks the
      suggestion approved — a failed insert leaves it retryable; the
      device picks the new row up on its next sync pull. Client may edit
      title/content/category before approving (the plan's clear diff)
- [x] `/memory` page — learning review queue (target/category/status
      badges, source-excerpt quote, edit-before-approve, Approve / Edit /
      Discard, live refresh after action) + long-term memory list from
      Dexie (`listLive<MemoryRow>`, soft-delete); load uses the repo's
      async-.then-cancellation pattern (react-hooks/set-state-in-effect)
- [x] `/settings` — "Learn from my chat history" opt-in toggle, off by
      default, per-account (synced server-side, not per-device); hub links
      `/memory` and `/settings`
- [x] `vercel.json` — daily cron hits `/api/learn/cron` (plus existing
      minutely push cron)
- [x] `scripts/verify-learn.mts` + npm `verify:learn` — 27/27 checks pass
      (day window/watermark, prompt build, salvage parser, validation,
      dedupe, provider failover incl. 429, 3 route contracts, migration
      SQL, vercel.json, settings toggle, memory queue, hub, script)
- [x] Verification: `tsc --noEmit`, `eslint` (max-warnings 0), `next build`
      (all learn routes + /memory prerendered), full suite re-run —
      auth, export 12/12, intelligence 16/16, learn 27/27, push 22/22,
      pwa 10/10, search 15/15, skills 12/12, sync 22/22, tasks 21/21,
      tools 22/22 — all green. Committed.

## 12. Nice-to-haves (voice input, calendar sync, command palette)

---

**Not in this repo (extension-only, separate repo):** WhatsApp Lead CRM &
Auto-Responder, Inline Ghostwriter Copilot, Form Autofill, Scheduled Page
Watcher, OCR, Structured Scraping, YouTube Repurposing Studio.
