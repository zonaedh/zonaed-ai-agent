# Zonaed AI — Deployment Runbook

Everything needed to take the completed MVP (priorities 0–12, all committed on
`master`) from this repo to a live app on Vercel + Supabase. Supplements the
plan's §7 / Step 0 checklist and `README.md`.

> **Status at time of writing:** code is done and pushed. What remains is
> provisioning (Supabase project, Vercel project, env vars) and the two
> pending migrations. There is no CI or hardcoded secret anywhere — the only
> tracked env file is `.env.example` (verified with `git ls-files`).

---

## 1. Prerequisites

| Account | Why | Do it at |
| --- | --- | --- |
| Supabase | Postgres + Auth (anonymous) + RLS | dashboard.supabase.com |
| Vercel | Hosting + Cron + env vars | vercel.com |
| Upstash | Redis rate limiting (required by build) | upstash.com / console.upstash.com |
| Groq / Gemini / DeepSeek / OpenRouter | AI providers (all four required at build + runtime) | each provider dashboard |

Local tooling: Node 20+, git. The migration script needs no Supabase CLI — it
calls the Management API with a token.

---

## 2. Supabase — provision once

1. **Create the project** (any region; note the `Project Ref`, shown on
   Project Settings → General).
2. **Enable anonymous auth**: Authentication → Providers/Log In → *Anonymous* →
   enable it. (The app mints the real Supabase session the PIN gate relies on;
   RLS keys off `auth.uid()`.)
3. **Capture API keys** from Project Settings → API:
   - `NEXT_PUBLIC_SUPABASE_URL` = Project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = `anon` public key (client-safe)
   - `SUPABASE_SERVICE_ROLE_KEY` = `service_role` key (**server-only**; never
     put this in `NEXT_PUBLIC_*` or commit it)

### 2a. Apply the pending migrations

Two migrations are new and haven't been applied to any project yet:

- `0002_push_subscriptions.sql` — `push_subscriptions` table + `tasks.reminded_at`
- `0003_learn_suggestions.sql` — `learn_suggestions` review queue for §5.4

The others (`0001_initial_schema`, `0002_sync_tokens`, `0003_lww_updated_at`)
were applied manually before the bookkeeping table existed; the script marks
---

## 3. Vercel — import + env vars

### 3a. Import the repo

1. Vercel → **Add New → Project** → import `https://github.com/zonaedh/zonaed-ai-agent`.
2. Framework preset auto-detects **Next.js**; build command `npm run build`
   (the `prebuild` hook runs `scripts/check-env.mjs`, which **fails the build**
   fast on any missing/blank required var — set **all** env vars below first).
3. Output dir stays `.next`.

### 3b. Environment variables (all required unless marked optional)

| Variable | Source | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase API page | public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase API page | public |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase API page | server-only, secret |
| `GROQ_API_KEY` | Groq console | secret |
| `GEMINI_API_KEY` | Google AI Studio | secret |
| `DEEPSEEK_API_KEY` | DeepSeek platform | secret |
| `OPENROUTER_API_KEY` | OpenRouter | secret |
| `UPSTASH_REDIS_REST_URL` | Upstash console | secret |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash console | secret |
| `SYNC_TOKEN_SECRET` | `openssl rand -hex 32` | min 32 chars; signs sync tokens |
| `CRON_SECRET` | `openssl rand -hex 32` | sent as `Authorization: Bearer` by Vercel Cron |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | `npx web-push generate-vapid-keys` | public (sent to browsers) |
| `VAPID_PRIVATE_KEY` | same command | secret |
| `VAPID_SUBJECT` | `mailto:you@…` or your site URL | optional but recommended |
| `SENTRY_DSN` | Sentry | optional |

> The same values live in your local `.env.local` (never committed). The two
> must stay in sync or local smoke checks (`npm run smoke:*`) won't match prod.

### 3c. Cron jobs (in `vercel.json`)

```json
{
  "crons": [
    { "path": "/api/learn/cron", "schedule": "10 0 * * *" },
    { "path": "/api/push/cron",  "schedule": "* * * * *" }
  ]
}
```
---

## 4. Deploy + first-verify checklist

1. **Deploy** (Vercel auto-deploys `master`; re-deploy manually if needed).
2. **Migration double-check** — run §2a again; it should print
   "Skipping … (already applied)" for all files.
3. **Manual smoke** (plan §8):
   - Open the site → PIN setup screen shows → set a PIN → app unlocks.
   - Add a task, complete one, add a memory, upload a skill `.md` — all
     persist across reload (Dexie) and sync (check the SyncIndicator flips to
     "Synced").
   - `/report`, `/marketing-plan`, `/competitor-spy`, `/outreach` each take a
     URL and stream a result (proves crawl + AI keys + Upstash).
   - Push: enable notifications in `/settings` (per-device), Grant on the
     browser, set a task due in 2 minutes → expect a reminder. Digest = daily/
     weekly per the selector.
   - Learning: leave "Learn from my chat history" **off** on `/settings`;
     tomorrow's `/api/learn/cron` must not create suggestions. Turn it on and
     chat a bit → next cron pass puts candidates in `/memory` as *pending*
     (never auto-applied).
   - `Ctrl/⌘+K` opens the command palette on desktop.
4. **Install as PWA** on iOS + Android (plan §8 item 1) and check the Quick
   Capture shortcut.
5. **Offline test**: Airplane mode → app loads from Dexie → edit → reconnect →
   syncs.

---

## 5. Troubleshooting quick ref

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `next build` fails "Environment validation failed" | missing/blank env var in Vercel | add it and re-deploy (§3b) |
| 401 on `/api/sync/*`, `/api/push/*` | no Supabase session / anonymous auth off | enable Anonymous in Supabase Auth |
| 503 "No AI provider configured" | all 4 provider keys blank | set at least one (§3b) |
| Push never arrives | VAPID keys mismatch / Hobby cron | compare `NEXT_PUBLIC_VAPID_PUBLIC_KEY` to local; check cron tier (§3c) |
| 502 "…lookup failed" on settings | migration 0002/0003 not applied | run §2a |
| Cron 401 | `CRON_SECRET` mismatch or not set | set it; Vercel sends it as Bearer automatically |

Local smoke scripts (need `.env.local`, not Vercel): `npm run smoke:auth`,
`npm run smoke:sync`, `npm run smoke:chat`, then `npm run verify:*` (12 suites).

---

## 6. The extension repo (separate)

`zonaed-ai-agent-extension` is **not** this repo and is not present on this
machine — it must be imported as a second Vercel project if you want the
extension to share this backend. The shared contract is only:

- the `/api/sync/*` API (reachable at the URL this app deploys to),
- env-var-based provider keys decided at deploy time.

After both sides are live, run a real extension↔webapp sync (push a row from
the extension, see it appear on `/tasks`/`/memory` here) to close plan §8's
cross-repo contract check.

- `/api/learn/cron` — daily §5.4 learning job (checks `CRON_SECRET`).
- `/api/push/cron` — every-minute task-reminder scanner + digest sender
  (checks `CRON_SECRET`).

**Plan-tier caveat:** the `* * * * *` cron (every minute) is a **Vercel Pro**
capability. On the **Hobby** plan crons are limited (fewer invocations / longer
min interval), so either upgrade to Pro or relax the push cron to e.g.
`*/5 * * * *` (reminders may fire up to 5 min late — acceptable slack given
the 24h TTL in `lib/push/send.ts`).
them as already-applied so they are never re-run.

```bash
# From the repo root. Windows PowerShell / bash both fine.
set SUPABASE_ACCESS_TOKEN=sbp_xxxxxxxxxxxx        # Supabase dashboard → Account → Access Tokens
set SUPABASE_PROJECT_REF=xxxxxxx                  # Project Settings → General → Project Ref
node scripts/apply-migrations.mjs
# Expect: "Recorded 0001… (applied previously)", "Applying 0002_push_subscriptions.sql … OK",
#          "Applying 0003_learn_suggestions.sql … OK". Re-run is safe (idempotent).
```

> **Security note:** the `service_role` key can bypass RLS. It is only ever
> used by our server routes (`/api/sync/*`, `/api/push/*`, `/api/learn/*`,
> `/api/auth/*`) via `lib/push/send.ts → pushAdminClient()`. Never expose it
> client-side — the client uses the anon key + session.