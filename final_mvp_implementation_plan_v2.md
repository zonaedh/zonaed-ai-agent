# Zonaed AI Web App — Final MVP Implementation Plan (v2)
### `agent.thesharkweb.com`

Full-stack, offline-first AI assistant web app (PWA) with cloud-synced memory, chat history, task management, knowledge base, personalized skills, and self-learning from chat history. Deployed separately from the Chrome extension, sharing the same Vercel backend and AI routing infrastructure.

**Status:** v2 — supersedes v1. Adds the confirmed webapp/extension tool split (§5.2), the personalized Skill/Knowledge Upload system (§5.3), and Day-by-Day Chat History Learning (§5.4). All other sections (auth, sync, security, build order) carry over from v1 with updates noted inline.

---

## Repositories

| Project | Repo |
| :--- | :--- |
| Web App | `https://github.com/zonaedh/zonaed-ai-agent.git` |
| Chrome Extension | `https://github.com/zonaedh/zonaed-ai-agent-extension.git` |

Two **separate repositories**. Do not merge, copy extension-only code into the webapp repo, or vice versa. The two share only the Vercel backend / AI routing contract described in this document (`sync/` API, provider keys) — not a codebase.

**Project context (confirmed):**
- Both repos are **fresh builds** — extension is not yet live in production, so the `sync/` API and auth token design have **no backward-compatibility constraint**. Build it correctly per §2 from day one.
- **Supabase project is new / from scratch** — Step 0 of implementation must be provisioning the Supabase project, enabling RLS, and running initial migrations (§9, Step 0) before any app code touches it.
- **All AI provider API keys (Groq, Gemini, DeepSeek, OpenRouter) are already available** — wire them for real via Vercel env vars from the start; treat rate-limiting (§7) as required for MVP, not deferred, since real keys mean real cost from day one.

---

## Relationship to Existing Extension System (Gap Analysis)

This webapp is a **companion product**, not a merged codebase, to the existing Chrome extension (`zonaed-ai-agent-extension`, v0.3.0). The two share only the AI-provider infra and the `sync/` API contract.

- **Intelligence stack is the one thing that ports fully** — see §5.1. Tone detection, persona/punctuation rules, memory-skill injection, the anti-cliché filter, and the few-shot example bank all move into the webapp's chat pipeline, same as the extension.
- **Ollama/offline AI does not port.** The extension supports a 100%-offline mode via local Ollama; the webapp is cloud-only per §0 — offline in the webapp means "read cached Dexie data," not "run a local model."
- **Auth is upgraded, not reused.** The extension's single-layer Master PIN + HMAC token becomes two independent layers here (PIN device-gate + Supabase Auth/RLS), plus a new scoped API token specifically for extension↔webapp sync. See §2.
- **Storage gains a sync layer.** The extension's Dexie-only, local-only storage becomes Dexie (still source of truth) + Supabase backup/sync with conflict resolution. See §3.
- **Quota-router failover logic carries over** — the webapp's `/api/chat` reuses the same zero-downtime provider failover behavior as the extension's `quota-router.ts` (429/503 → auto-route to next provider); §6's rate-limiting is a cost guard, not a substitute for failover.

### Tool Split (confirmed this revision)

The decision line is not "desktop vs mobile" — it's **"does this tool need live browser DOM/tab/session access, or can it run from a URL/text input via server-side fetch?"**

**Moves to the webapp** (URL/text input only, no live session needed):

| Tool | Webapp route |
| :--- | :--- |
| Website Audit & Client Proposal/Report | `/report` |
| Marketing Plan Generator (homepage URL → server-side crawl of subpages) | `/marketing-plan` |
| Competitor Ad & Strategy Spy | `/competitor-spy` |
| LinkedIn/Cold Outreach Generator | `/outreach` |
| Sheets Export (Markdown table → TSV) | clipboard action inside `/chat`, no dedicated route needed |

**Stays in the extension** (requires live authenticated tab/DOM access):

- WhatsApp Lead CRM & Auto-Responder — only possible from the logged-in `web.whatsapp.com` session's DOM, no public API
- Inline Ghostwriter Copilot — live floating badge on any page's input/selection, inherently a browser-injection feature
- Form Autofill — writes directly into a live page's form
- Scheduled Page Watcher — `chrome.alarms`-based persistent background monitoring (candidate to move to a webapp cron job in a future revision, extension-based for MVP)
- OCR — extracts from a live screenshot, extension-only
- Structured Scraping (login-protected/dashboard pages) — extension-only when login is required; public pages could move to the webapp later
- **YouTube Repurposing Studio** — confirmed to stay in the extension. Captions/transcript are extracted via content script from the live watch page rather than a server-side URL fetch, since public caption APIs are unreliable/missing for many videos and live-DOM extraction is more robust.

---

## Instructions for the Build Agent (Antigravity)

You are acting as a **senior full-stack software engineer** implementing this plan against the two repositories above. Hold yourself to production standards, not prototype standards:

1. **Read the whole plan before writing any code.** Understand how everything connects to §2 (Auth), §3 (Sync), and §7 (Security Checklist) before starting — these constrain almost everything else.
2. **Follow the build order in §9 exactly**, top to bottom. Don't skip ahead to a nice-to-have while a higher-priority item is incomplete or untested. If the order should change, stop and explain why before proceeding.
3. **No shortcuts on the fixed issues.** The items in §0 and §2–§4 exist because they were bugs/gaps in a prior version. Do not reintroduce them (no hardcoded PINs, no combined `any` maskable icon purpose, no skipping `viewport-fit=cover`, no hard deletes in sync).
4. **Zero tolerance for known-bug patterns.** Before considering any task done:
   - Run `npm run build` and `npx tsc --noEmit` — both must pass cleanly, no warnings ignored.
   - Re-read the relevant row(s) of §7 Security Checklist and §8 Verification Plan and confirm each applies to what you just built.
   - Don't check off a checklist item without actually verifying it (e.g., don't check "rate limiting" without testing that an over-limit request is actually rejected).
5. **Work incrementally, verify continuously.** Implement one numbered priority from §9 at a time, verify against §8, then move on. Don't batch unrelated features into one large unverified change.
6. **Ask before assuming.** If any requirement is ambiguous, underspecified, or conflicts with something else — especially anything touching auth, data deletion, or money (AI provider API costs) — stop and ask rather than guessing.
7. **Match the two-repo boundary.** Webapp-only code (Next.js app, Supabase schema, PWA assets, `/report` `/marketing-plan` `/competitor-spy` `/outreach`) goes in `zonaed-ai-agent`. Extension-only code (manifest v3, content scripts, extension UI, YouTube Repurposing Studio) goes in `zonaed-ai-agent-extension`. Shared contract = the `sync/` API and env-var-based provider keys — implement both sides consistently, keep the code separate.
8. **No placeholder/TODO code in delivered work.** If something can't be finished (e.g., a provider integration needs a key you don't have), say so explicitly rather than committing a stub that silently fails.

---

## 0. Decisions Locked In (Read First)

| Open Question | Decision |
| :--- | :--- |
| New repo or same repo? | **New repo** — `zonaed-ai-agent`, separate from extension repo |
| Single-user or multi-user? | **Single-user (personal app)** for MVP. Architecture stays multi-tenant-ready (Supabase RLS) for future family/team plan |
| PIN vs Supabase Auth? | **Both, layered** — PIN is a device unlock gate only. Supabase Auth (anonymous or magic-link) issues the real session that RLS depends on. See §2 |
| Local DB vs Cloud DB? | **Local-first.** Dexie.js (IndexedDB) is source of truth on-device; Supabase is the sync/backup layer |
| Local/offline AI (Ollama)? | **Not included in webapp MVP.** Cloud providers only (Groq, Gemini, DeepSeek, OpenRouter). Extension keeps Ollama as its offline fallback — intentional divergence, not an oversight |
| Port the extension's intelligence stack? | **Yes, full port required.** Moves into `/api/chat` pipeline so persona, tone, and style stay consistent across both surfaces. See §5.1 |
| Which extension tools move to the webapp? | **URL/text-input tools only** (Report, Marketing Plan, Competitor Spy, Outreach). Live-DOM tools (WhatsApp CRM, Ghostwriter, Autofill, Page Watcher, OCR, login-gated Scraping, **YouTube Repurposing**) stay in the extension. See "Tool Split" above and §5.2 |
| How does the agent get personalized to Zonaed specifically? | **Skill/Knowledge upload system** — user uploads `.md` files that the agent treats as durable ground-truth context, same pattern as Claude's own skills/memory files. See §5.3 |
| Does the agent learn on its own over time? | **Yes, opt-in day-by-day chat history learning** — a scheduled job reviews each day's chat activity and proposes memory/skill updates for the user to approve. See §5.4 |

---

## 1. Architecture Overview

```
┌───────────────────────────────────────────────────────────────────┐
│                     agent.thesharkweb.com                          │
│                (Next.js 16 App Router, on Vercel)                  │
│                                                                     │
│  /chat  /tasks  /memory  /knowledge  /skills  /search  /settings   │
│  /report  /marketing-plan  /competitor-spy  /outreach              │
│     └────────┴────────┴────────┴────────┴────────┴────────┘        │
│                             │                                      │
│                    app/api/                                       │
│                    ├── auth/        PIN gate + Supabase session   │
│                    ├── chat/        SSE streaming proxy           │
│                    ├── memory/      CRUD + auto-learn             │
│                    ├── tasks/       CRUD + recurrence engine       │
│                    ├── knowledge/   CRUD + .md import              │
│                    ├── skills/      .md upload + skill CRUD        │
│                    ├── learn/       day-by-day chat-history job    │
│                    ├── search/      Full-text search (all sources) │
│                    ├── digest/      Daily/weekly summary generator │
│                    ├── report/      Website audit + proposal       │
│                    ├── marketing-plan/  URL-crawl plan generator   │
│                    ├── competitor-spy/  Competitor URL analysis    │
│                    ├── outreach/    Cold outreach generator         │
│                    ├── sync/        Extension + Dexie↔Supabase sync│
│                    └── push/        Web Push notification sender   │
│                             │                                      │
│                    Supabase: PostgreSQL + Auth + RLS + Storage     │
└───────────────────────────────────────────────────────────────────┘
        ▲                                              ▲
        │ PWA (Dexie local-first, service worker)      │ REST + token
   Mobile / Desktop PWA Shell                    Chrome Extension
                                       (WhatsApp CRM, Ghostwriter, Autofill,
                                        Page Watcher, OCR, login-gated Scraping,
                                        YouTube Repurposing Studio)
```

---

## 2. Auth Model (Fixed)

Two independent layers, not one conflated system:

1. **Device gate — PIN.** Local unlock screen on the PWA shell. Hashed PIN, never stored/committed in plaintext, never sent to any AI provider. Purely a "is this physically the right person's device" check.
2. **Data authorization — Supabase Auth + RLS.** Every read/write to Supabase goes through a real Supabase session (anonymous auth is fine for single-user MVP, upgradeable to magic-link later). Row Level Security policies key off `auth.uid()`, not the PIN.
3. **Extension↔webapp sync — scoped API token.** A separate, revocable token scoped only to `sync/*` endpoints. Not the same credential as the Supabase session and not the PIN.

HMAC session tokens carry `exp`; server validates expiry server-side, not just client auto-lock.

---

## 3. Storage & Sync

- **Dexie.js (IndexedDB)** is the source of truth on-device. All UI reads/writes hit Dexie first for instant, offline-capable UX.
- **Supabase Postgres** is the sync/backup layer. Every syncable table (`tasks`, `memory`, `knowledge`, `chat_history`, `skills`, `examples`) carries `client_id`, `updated_at`, `deleted_at`.
- **Conflict resolution:** last-write-wins by `updated_at`, with the losing record soft-deleted/archived — never hard-deleted, so no silent data loss.
- **No hard deletes anywhere in sync.** Deletion sets `deleted_at`; a separate retention/purge job (out of MVP scope) can hard-delete after a grace period if ever needed.

---

## 4. Core Feature Modules

| Module | Purpose |
| :--- | :--- |
| `/chat` | Main conversational surface, SSE streaming, persona/tone pipeline (§5.1) |
| `/tasks` | CRUD + recurrence engine, due-date reminders via `/push` |
| `/memory` | Long-term memory CRUD, auto-learn capture from conversation |
| `/knowledge` | Knowledge base CRUD + `.md` import (documents, references) |
| `/skills` | **New** — personalized skill/knowledge `.md` uploads (§5.3) |
| `/search` | Full-text search across chat, memory, knowledge, skills |
| `/digest` | Daily/weekly summary generator |
| Command palette (Cmd+K) | Desktop-focused keyboard-driven navigation and quick actions |

---

## 5.1 Intelligence & Persona Stack (Ported from Extension)

The Chrome extension's `src/lib/` layer carries real product logic beyond routing. This ports into the webapp's `/api/chat` pipeline so tone, persona, and output quality stay consistent across both surfaces. Cloud-only (no Ollama) per §0, everything else is a full port:

| Extension source | Webapp target | Behavior |
| :--- | :--- | :--- |
| `src/lib/tone-profiler.ts` | `app/api/chat/` pre-processing step | Detects Bengali Unicode / Banglish patterns in the incoming message and switches response language mode in real time |
| `src/lib/system-prompt.ts` | `app/api/chat/` system prompt builder | Persona, spec, and punctuation-rule injection before every completion call |
| `src/lib/memory-skills.ts` | `/api/memory` + `/api/skills` + `/api/chat` preamble builder | Pulls active long-term memories and keyword-triggered custom skills from Supabase/Dexie and injects them ahead of the system prompt |
| Anti-cliché filter (em-dash/en-dash ban, banned word list: "delve", "testament", "tapestry", "embark", "furthermore", "moreover", "beacon", "game-changer") | System prompt builder (shared with above) | Same hard punctuation and vocabulary rules enforced identically on webapp output |
| `src/lib/chain-of-draft.ts` | `/api/chat` (long-form requests) | Outline-first draft, wait for approval, then full generation — same as extension |
| `examples` Dexie table (few-shot bank) | `examples` table in Supabase + Dexie mirror | User-approved golden samples injected as few-shot context, synced per §3 |
| `skills` Dexie table (trigger-based skills) | `skills` table in Supabase + Dexie mirror | Trigger-matching logic; now includes both extension-style keyword skills and uploaded `.md` skill files (§5.3) |

**Conversational auto-learning:** the extension's "Remember that..." / "Amar business holo..." auto-capture into `memories` ports as-is — same trigger phrases, same category classification, now writing to Supabase-synced `memory` instead of extension-only Dexie.

---

## 5.2 Webapp-Native Report & Analysis Tools (New — moved from extension)

These four tools were extension-only (content-script, current-tab based) in v1. Confirmed this revision: they need only a URL or text input, so they move to the webapp as server-side fetch/crawl routes, usable from any device including mobile.

| Route | Input | Behavior |
| :--- | :--- | :--- |
| `/report` | Client website URL | Server-side fetch + audit (performance, SEO basics, structure), generates a client-facing proposal/report document |
| `/marketing-plan` | Homepage URL | Server-side crawl of subpages (replaces the old "current tab" content-script crawl), generates a marketing plan from the crawled content |
| `/competitor-spy` | Competitor landing page URL | Server-side fetch + analysis of competitor positioning/strategy signals |
| `/outreach` | Prospect profile URL or company site URL | Generates LinkedIn/cold outreach copy from the fetched page content |

**Explicitly not moving:** YouTube Repurposing Studio. Confirmed to stay extension-only — captions/transcript come from a content script reading the live watch page DOM, not from a public captions API, because public caption availability is inconsistent across videos. This is a deliberate reliability decision, not a placeholder.

**Build note:** these four routes reuse the same AI-provider routing/failover and rate-limiting infrastructure as `/api/chat` (§6, §7) — they are not a separate cost or auth surface, just different input shapes and prompt templates.

---

## 5.3 Skill / Knowledge Upload System (New — personalization)

Goal: make the agent fully personalized to Zonaed specifically, the same way Claude's own skills/memory files work — durable, user-supplied `.md` context that the agent treats as ground truth rather than something it has to re-infer every conversation.

- **New `/skills` page** in the webapp: upload, view, edit, and delete `.md` files (business info, service offerings, writing style guides, client SOPs, personal facts, pricing sheets, whatever Zonaed wants the agent to always know).
- **New `skills` table** in Supabase (mirrored in Dexie per §3): stores file title, raw `.md` content, an optional keyword-trigger list (so a skill only injects when relevant, keeping the system prompt lean), `updated_at`, `deleted_at`.
- **Injection logic:** `/api/skills` + `/api/chat` preamble builder (shared with §5.1's `memory-skills.ts` port) matches the incoming message against each skill's trigger keywords (or injects always-on skills unconditionally) and prepends the matched `.md` content to the system prompt before the persona/punctuation rules.
- **File handling:** size limit + content sanitization on upload (same requirement as the existing knowledge-base `.md` import in §7's checklist — this system reuses that validation path, doesn't duplicate it).
- **No silent overwrite:** re-uploading a file with the same title creates a new version (`updated_at` bump) rather than destroying the previous content, consistent with the "no hard deletes" rule in §3.

---

## 5.4 Day-by-Day Chat History Learning (New — opt-in)

Goal: the agent gets smarter about Zonaed over time without him having to manually write every skill file himself.

- **Toggle in `/settings`:** "Learn from my chat history" — off by default, opt-in.
- **New `/api/learn` scheduled job** (daily, e.g. via Vercel Cron): reviews the prior day's `chat_history` entries, extracts candidate durable facts/patterns (recurring topics, corrections the user made, preferences stated in passing) using the same LLM pipeline as `/api/chat`.
- **Never auto-writes silently.** Candidates are surfaced as a review queue in `/memory` or `/skills` (matching where they best fit) with a clear diff — the user approves, edits, or discards each suggestion. This mirrors the existing memory-write review pattern already used for conversational auto-learning in §5.1, just running as a scheduled batch instead of inline per-message.
- **Scope guardrails:** the job only reads `chat_history` it already has RLS access to (single-user MVP, so this is just "the user's own history"); it does not reach into `/knowledge` or `/skills` uploads to "learn" from those — those are already durable, user-authored ground truth and don't need re-derivation.
- **Rate/cost control:** this job is a single batched daily run per user, not a per-message background call, so it fits inside the same rate-limiting/cost-guard posture required by §7 for all AI-provider-calling routes.

---

## 6. Tech Stack

| Layer | Technology |
| :--- | :--- |
| Framework | Next.js 16 (App Router) |
| Styling | Tailwind CSS 4 |
| PWA | Web App Manifest + Serwist Service Worker + iOS Web Clip + Shortcuts |
| Local DB | Dexie.js (IndexedDB) — source of truth |
| Cloud DB | Supabase PostgreSQL + Auth (anonymous) + RLS + Storage |
| Auth | PIN device-gate + Supabase session + scoped extension API tokens |
| AI Streaming | SSE Route Handler (`/api/chat`) |
| State | Zustand |
| Rate limiting | Upstash Redis (or Vercel Edge Config) |
| Push | Web Push API + `web-push` library |
| Scheduled jobs | Vercel Cron (daily learning job §5.4) |
| Monitoring | Sentry (error tracking) |
| Migrations | Supabase CLI migrations |
| Deployment | Vercel |

---

## 7. Security Checklist

- [ ] No PIN or secrets committed to repo (CI secret-scan enabled)
- [ ] PIN = device gate only; Supabase Auth session = actual data authorization via RLS
- [ ] HMAC session tokens carry `exp`; server validates expiry, not just client auto-lock
- [ ] Extension uses separate revocable API token, scoped to `sync/*`
- [ ] Rate limiting on all AI-provider-calling routes, including `/report`, `/marketing-plan`, `/competitor-spy`, `/outreach`, and the `/api/learn` daily job
- [ ] `.md` upload: file size limit + content sanitization before storage/render — applies to both `/knowledge` imports and `/skills` uploads (§5.3)
- [ ] Chat-history learning (§5.4) is opt-in, off by default, and never writes memory/skill entries without explicit user approval
- [ ] Env var validation at build time (zod schema) — fail fast on missing keys
- [ ] Sentry (or equivalent) wired up before launch

---

## 8. Verification Plan

### Automated
- `npm run build` — production build completes without errors
- `npx tsc --noEmit` — no TypeScript errors
- CI secret-scan passes (no hardcoded PIN/keys)

### Manual
1. **PWA Install**
   - iOS Safari → Share → Add to Home Screen → custom icon appears, opens full-screen, no URL bar
   - Android Chrome → "Install app" prompt works
   - Long-press icon → shortcuts (New Chat / New Task / Quick Capture) appear and work
2. **Safe Area** — notch + home indicator spacing correct on iPhone with Dynamic Island
3. **Offline**
   - Airplane mode → open PWA → chat history, memory, tasks, knowledge base, skills all load from Dexie
   - Make edits offline → reconnect → sync status shows pending count → resolves to "Synced"
   - Force a conflicting edit on two devices → verify last-write-wins resolves without data loss of the losing record (soft-deleted/archived, not hard-deleted)
4. **Search** — query returns matching results across chat, memory, knowledge, and skills sources
5. **Push** — task reminder notification fires at due time; daily digest delivered on schedule
6. **Export** — export produces valid JSON + Markdown containing all current chat/memory/task/knowledge/skill data
7. **Skills (§5.3)** — upload a `.md` skill file, confirm it injects into a matching chat response and stays out of an unrelated one; confirm re-upload versions instead of destroying the previous file
8. **Report/Plan/Spy/Outreach tools (§5.2)** — submit a URL to each of `/report`, `/marketing-plan`, `/competitor-spy`, `/outreach` and confirm a completed output is generated without requiring the extension
9. **Chat-history learning (§5.4)** — with the toggle off, confirm no learning job runs; with it on, confirm the next day's suggestions appear as a reviewable queue, not auto-applied

---

## 9. Priority Order for Build

0. **Environment & infra setup** (do first, before any feature code):
   - Provision new Supabase project; enable RLS project-wide by default
   - Run initial schema migration: `tasks`, `memory`, `knowledge`, `chat_history`, `skills`, `examples` — each with `client_id`, `updated_at`, `deleted_at` per §3; `skills` table supports both §5.1's trigger-based skills and §5.3's uploaded `.md` skill files
   - Set all Vercel env vars: Groq, Gemini, DeepSeek, OpenRouter keys + Supabase URL/anon key/service role key + PIN hash + rate-limit store (Upstash) credentials
   - Add zod-based env var validation so build fails fast on any missing key
   - Initialize both repos (`zonaed-ai-agent`, `zonaed-ai-agent-extension`) with base Next.js / extension scaffolding and CI (build + typecheck + secret-scan)
1. Auth model (PIN gate + Supabase anonymous session + RLS)
2. Dexie ↔ Supabase sync engine with conflict resolution + sync status UI
3. Intelligence & persona stack port into `/api/chat` — tone-profiler, persona/punctuation engine, memory-skills injector, anti-cliché filter, chain-of-draft (§5.1); no Ollama/offline-model path, cloud providers only per §0
4. **Skill/Knowledge upload system (§5.3)** — `/skills` page, upload/versioning, injection logic wired into the §5.1 preamble builder
5. iOS PWA fixes (viewport-fit, split icon purposes, splash screens)
6. Full-text search (now spanning chat, memory, knowledge, and skills)
7. Data export/backup
8. Recurring tasks + quick capture shortcut
9. **Webapp report/analysis tools (§5.2)** — `/report`, `/marketing-plan`, `/competitor-spy`, `/outreach`
10. Web Push (reminders + digest)
11. **Day-by-day chat history learning (§5.4)** — opt-in scheduled job + review queue
12. Remaining nice-to-haves (voice input, calendar sync, command palette)

**Extension-side (separate repo, tracked against its own doc, not this one):** WhatsApp Lead CRM & Auto-Responder, Inline Ghostwriter Copilot, Form Autofill, Scheduled Page Watcher, OCR, Structured Scraping (login-protected pages), YouTube Repurposing Studio.
