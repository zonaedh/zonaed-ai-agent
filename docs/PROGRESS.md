# Build Progress v2 â€” Implementation-Plan Audit & Remaining Work

Created after a full audit of `final_mvp_implementation_plan_v2.md` against the
shipped code (archive of v1: `docs/PROGRESS-v1-archive.md`). Â§9 priorities 0â€“12
are complete and deployed (see the archive). This file tracks what the audit
found missing, plus the not-yet-started Chrome extension repo.

## Audit result (plan vs code)

Already built and verified (v1 archive): auth (PIN + anon session + RLS +
sync tokens), Dexieâ†”Supabase sync (LWW + tombstones), Â§5.1 stack (tone,
anti-clichÃ©, matching, system prompt, providers + failover), /skills Â§5.3,
iOS PWA fixes, /search, /export, recurring tasks, Â§5.2 tools, Web Push
(reminders + digest cron), Â§5.4 daily learning + review queue, voice/calendar/
palette, deploy (Vercel live, cron via GitHub Actions), chat dashboard UI,
model registry with live-verified models, mobile zoom lock, PageNav headers.

Gaps found (each becomes a build item below):

| # | Gap | Plan ref |
|---|-----|----------|
| 1 | `/knowledge` page absent (store + search + export exist, no UI) | Â§4 |
| 2 | `/digest` page absent (push digest exists, no UI) | Â§4 |
| 3 | Conversational auto-learn "Remember thatâ€¦"/"Amar business holoâ€¦" inline capture absent | Â§5.1 |
| 4 | Sheets Export (Markdown table â†’ TSV) clipboard action in /chat absent | Tool split |
| 5 | Sentry not wired (`SENTRY_DSN` optional env exists, no package) | Â§7 |
| 6 | Chrome extension repo empty â€” full build remaining | Repos table |

---

## W1. Conversational auto-learn (Â§5.1) â€” *highest value*

- [x] `lib/ai/auto-learn.ts` â€” pure module: trigger-phrase detection
      ("remember that", "remember:", "note that", "don't forget",
      "amar business holo", "mon e rakho", "à¦®à¦¨à§‡ à¦°à¦¾à¦–à§‹", "à¦®à¦¨à§‡ à¦°à¦¾à¦–à¦¬à§‡à¦¨", â€¦),

## W2. `/knowledge` page (Â§4)

- [x] `app/knowledge/page.tsx` â€” upload `.md` (multi-file, reuses
      `lib/skills/sanitize.ts` â€” Â§7 requires the same validation path),
      title/tags inline edit, list from Dexie (`useLiveQuery`), delete
      (tombstone), PageNav header
- [x] `lib/navigation.ts` + hub + palette entry (Knowledge + Digest added)
- [x] `scripts/verify-v2.mts` + npm `verify:v2` (knowledge+digest+tsv, 11/11) - sanitize
      pipeline reuse, dedupe, store round-trip

## W3. `/digest` page (Â§4)

- [x] `app/digest/page.tsx` â€” daily/weekly summary computed offline from
      Dexie: overdue / due-today / due-this-week / open totals, completed
      count, memory/knowledge/skill counts, last-activity dates;
      Copy-as-Markdown (push digest cadence stays in /settings)
- [x] `lib/navigation.ts` + hub + palette entry (Knowledge + Digest added)
- [x] Verify via `npm run verify:v2` (11/11) — digest buckets/headline/markdown,
      knowledge repo over fake-indexeddb, TSV parser

## W4. Sheets Export â€” Markdown table â†’ TSV (Tool split table)

- [x] `lib/export/tsv.ts` â€” pure `markdownTableToTsv(md)` (parses `| a | b |`
      rows, drops separator rows, unescapes `\|`, tab-safe output)
- [x] Chat action - "Copy table (TSV)" button on the last assistant message
      when it contains a Markdown table â†’ clipboard


## W5. Sentry (Â§7 pre-launch)

- [x] `@sentry/nextjs@10.73.0` installed (Next 16 compatible)
- [x] `instrumentation.ts` — server register() inits Sentry ONLY when
      `SENTRY_DSN` is set (tracesSampleRate 0.1, sendDefaultPii false);
      `export const onRequestError = Sentry.captureRequestError` for Route
      Handler / cron errors
- [x] `instrumentation-client.ts` — browser register() inits ONLY when
      `NEXT_PUBLIC_SENTRY_DSN` is set (only public vars reach the client
      bundle); same sampling/no-PII defaults
- [x] `.env.example`, `lib/env.ts`, `scripts/check-env.mjs` — both DSNs
      documented as optional (blank = Sentry fully disabled)
- [x] Verified: no DSN configured → `next build` exit 0 (no SDK init), tsc 0,
      eslint 0. (Sentry source-map upload stays off until SENTRY_AUTH_TOKEN +
      org/project are added at deploy time.)
---

# Chrome Extension â€” `zonaed-ai-agent-extension` (separate repo)

Repo exists (empty): `https://github.com/zonaedh/zonaed-ai-agent-extension.git`.
Plan scope (extension-only, live-DOM tools): WhatsApp Lead CRM & Auto-Responder,
Inline Ghostwriter Copilot, Form Autofill, Scheduled Page Watcher, OCR,
Structured Scraping (login-protected), YouTube Repurposing Studio. Shares the
webapp's `sync/` API contract + provider keys (env-based, no code sharing).

## E0. Scaffold

- [x] Repo cloned + scaffolded: manifest v3, TypeScript + esbuild build,
      ESLint, CI (typecheck + lint + gitleaks) — mirrors webapp Step-0 hygiene.
      COMMITTED + PUSHED: zonaed-ai-agent-extension@main 283d0a8 (19 files).
- [x] Sync-token client (src/lib/webapp.ts — zsy_ shape check, Bearer attach,
      pull contract) + chrome.storage settings store (src/lib/settings.ts).
- [x] Options page: webapp base URL + sync token + feature toggles;
      "Test connection" probes POST /api/sync/pull with the stored token.

## E1. Sync contract client

- [ ] Pull/push against `/api/sync/pull|push` (watermark + LWW semantics,
      tombstone awareness) â€” proven against the live webapp endpoints
- [ ] Smoke script (node) â€” needs a real token from the deployed app

## E2. WhatsApp Lead CRM & Auto-Responder

- [ ] `web.whatsapp.com` content script: chat-list observer â†’ lead rows,
      notes/tags, respond suggestions via provider routing
- [ ] Manual-send-first (no auto-send without explicit user action)

## E3. Inline Ghostwriter Copilot

- [ ] Floating badge on focused inputs â†’ selection-scoped rewrite/expand/
      shorten via the provider stack; inserts on user approval

## E4. Form Autofill

- [ ] Detect common form fields â†’ fill from the local profile (options page),
      always user-confirmed per form

## E5. Scheduled Page Watcher

- [ ] `chrome.alarms` polling of user-pinned URLs â†’ diff detection â†’
      notification (no server dependency)

## E6. OCR + Structured Scraping + YouTube Repurposing

- [ ] OCR via tesseract.js on captured screenshots
- [ ] Structured scraping recipes (CSS selectors) for login-protected pages
- [ ] YouTube Repurposing: live-watch-page transcript extraction (content
      script) â†’ repurpose prompts (blog/thread/newsletter)

Each E-phase: verify (tsc + eslint + build + unit checks), commit, and only
then move on. The extension never embeds provider keys in content scripts â€”
keys live in the background service worker options storage, and AI calls go
through the webapp API where possible.

- [ ] `@sentry/nextjs` + `instrumentation.ts` (server, `onRequestError`) +
      `instrumentation-client.ts` â€” both no-op unless DSN env is set;
      `lib/env.ts` + `.env.example` updated
- [ ] `next build` green with and without a DSN

## W6. Deploy-close-out (user actions, tracked)

- [ ] Upstash keys in Vercel (rate limiting actually enforcing)
- [ ] GitHub Actions secrets `PROD_URL` + `CRON_SECRET` for the reminders cron
- [ ] Optional: custom domain `agent.thesharkweb.com`

      content extraction (strip the trigger, keep the fact),
      category classification (business/preference/correction/project/general)
      â€” same behaviour contract as the extension, per Â§5.1
- [ ] Chat integration â€” user message matches a trigger â†’ the fact is written
      to the Dexie `memory` store via `putLocal` (source `conversation`),
      sync carries it to Supabase; chat UI shows a "Saved to memory" flash
- [ ] `scripts/verify-autolearn.mts` + npm `verify:autolearn` â€” trigger
      matrix (EN/Banglish/Bengali), extraction, category rules, no-false-positive

