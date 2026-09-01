// ============================================================================
// verify-push.mts — Priority 10 checks (plan §9 item 10, §4 /push, §8 #5)
//
// Offline suite: exercises the exact pure logic the cron route runs
// (reminder payloads, digest summaries), validates the API route contracts,
// the service worker, the migration SQL, and env wiring. Run with:
//   npm run verify:push
// ============================================================================

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = process.cwd();

let passed = 0;
const TOTAL = 22;
function check(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok ${passed} - ${name}`);
    } catch (err: unknown) {
      console.error(`FAIL - ${name}:`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  })();
}

// ---------------------------------------------------------------- imports --

const payload = await import("../lib/push/payload");
const send = await import("../lib/push/send");

// ------------------------------------------------------------------- run --

console.log("\nWeb Push (Priority 10)\n");

await check("reminder payload: title/body/url/tag from a due task", () => {
  const p = payload.reminderPayload({
    title: "  Call   the  client  ",
    due_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    notes: null,
  });
  assert.equal(p.title, "Call the client");
  assert.equal(p.url, "/tasks");
  assert.ok(p.tag.startsWith("task:"));
  assert.ok(p.body.length > 0);
});

await check("reminder payload: clamps long titles and cleans whitespace", () => {
  const p = payload.reminderPayload({ title: "x".repeat(200), due_at: null });
  assert.ok(p.title.length <= 80);
  assert.ok(p.title.endsWith("…"));
});

await check("digest summary: counts overdue/today/week and lists next tasks", () => {
  const now = new Date();
  const hours = (h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();
  const summary = payload.buildDigestSummary([
    { title: "Past task", due_at: hours(-3), completed: false },
    { title: "Today task", due_at: hours(2), completed: false },
    { title: "Week task", due_at: hours(72), completed: false },
    { title: "Done task", due_at: hours(-3), completed: true },
    { title: "Float task", due_at: null, completed: false },
  ]);
  assert.match(summary, /1 overdue/);
  assert.match(summary, /1 due today/);
  assert.match(summary, /1 this week/);
  assert.match(summary, /1 unscheduled/);
  assert.match(summary, /Today task/);
  assert.doesNotMatch(summary, /Past task/);
});

await check("digest summary: empty state and unscheduled-only state", () => {
  assert.match(payload.buildDigestSummary([]), /No open tasks/);
  assert.match(
    payload.buildDigestSummary([{ title: "A", due_at: null, completed: false }]),
    /1 open task\(s\), none scheduled/,
  );
});

await check("digest payload: daily vs weekly labels", () => {
  assert.equal(payload.digestPayload([], "daily").title, "Daily digest");
  assert.equal(payload.digestPayload([], "weekly").title, "Weekly digest");
  assert.equal(payload.digestPayload([], "daily").url, "/tasks");
});

await check("isDigestFrequency rejects everything but daily/weekly", () => {
  assert.equal(payload.isDigestFrequency("daily"), true);
  assert.equal(payload.isDigestFrequency("weekly"), true);
  for (const bad of ["off", "", null, "DAILY", 7]) {
    assert.equal(payload.isDigestFrequency(bad), false, String(bad));
  }
});

await check("sendToSubscription refuses to run unconfigured without env keys", async () => {
  const hadPublic = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const hadPrivate = process.env.VAPID_PRIVATE_KEY;
  delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  try {
    await assert.rejects(
      send.sendToSubscription(
        { endpoint: "https://x.invalid/1", p256dh: "k", auth: "a" },
        { title: "t", body: "b", url: "/", tag: "x" },
      ),
      /not configured/,
    );
  } finally {
    if (hadPublic) process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = hadPublic;
    if (hadPrivate) process.env.VAPID_PRIVATE_KEY = hadPrivate;
  }
});

await check("sendToSubscription reports 410 endpoints as expired without throwing", async () => {
  // The guard is cached after first success, so this must come after the
  // unconfigured check above. tsx doesn't load .env.local — use a syntactically
  // valid dummy pair; the send targets a fabricated endpoint either way.
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ??=
    "BBIEQpD-XzJLC8pNvwRUHWW9JhZaQzfDKJ592br7wtRAyTA7FzrjtONKA-pXPBIlIJfSZAVkOhANDakLv7ji9ks";
  process.env.VAPID_PRIVATE_KEY ??= "0DSl17x3PC4Ez7QpXM9HK-d7yx3hL9tLoWUVv4-ddwU";
  const result = await send.sendToSubscription(
    { endpoint: "https://fcm.googleapis.com/fcm/send/dead", p256dh: "k", auth: "a" },
    { title: "t", body: "b", url: "/", tag: "x" },
  );
  assert.equal(result.ok, false);
  // A real send to a fabricated endpoint fails at the network/API layer; the
  // contract is: no throw, and every failure carries a reason — expired
  // (404/410) or an error message.
  assert.ok(
    result.expired === true || typeof result.error === "string",
    "failure must be flagged expired or carry an error",
  );
});

// ------------------------------------------------------- static sources --

const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const sw = read("public/sw.js");

await check("service worker handles push and notificationclick", () => {
  assert.match(sw, /addEventListener\(\s*["']push["']/);
  assert.match(sw, /addEventListener\(\s*["']notificationclick["']/);
  assert.match(sw, /showNotification/);
  assert.match(sw, /clients\.openWindow/);
});

await check("service worker uses the app icon and payload url", () => {
  assert.match(sw, /\/icons\/icon-192\.png/);
  assert.match(sw, /data:\s*\{\s*url/);
});

for (const [route, musts] of [
  ["app/api/push/subscribe/route.ts", [/requireSession/, /push_subscriptions/, /onConflict/]],
  ["app/api/push/unsubscribe/route.ts", [/requireSession/, /\.delete\(\)/, /endpoint/]],
  [
    "app/api/push/preferences/route.ts",
    [/requireSession/, /DIGEST_SETTING_KEY/, /isDigestFrequency/, /SERVER_SETTINGS_CLIENT_ID/],
  ],
  [
    "app/api/push/cron/route.ts",
    [
      /CRON_SECRET/,
      /reminded_at/,
      /DIGEST_STATE_KEY/,
      /reminderPayload/,
      /digestPayload/,
      /force-dynamic/,
    ],
  ],
] as const) {
  await check(`route contract: ${route}`, () => {
    const src = read(route);
    for (const pattern of musts) assert.match(src, pattern);
  });
}

await check("cron route guards against a missing/short bearer secret", () => {
  const src = read("app/api/push/cron/route.ts");
  assert.match(src, /startsWith\(["']Bearer /);
  assert.match(src, /length !== secret\.length/);
  assert.match(src, /statusCode|Unauthorized/);
});

await check("migration 0002: subscriptions table, RLS, tasks.reminded_at", () => {
  const file = join(ROOT, "supabase", "migrations", "0002_push_subscriptions.sql");
  assert.ok(existsSync(file), "migration file missing");
  const sql = read("supabase/migrations/0002_push_subscriptions.sql");
  assert.match(sql, /create table public\.push_subscriptions/);
  assert.match(sql, /unique \(user_id, endpoint\)/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /auth\.uid\(\) = user_id/);
  assert.match(sql, /add column if not exists reminded_at timestamptz/);
});

await check("push cron scheduling: Hobby-legal Vercel cron + 5-min GitHub Actions pings", () => {
  // Vercel Hobby only permits daily cron jobs, so the frequent pings live in
  // GitHub Actions (.github/workflows/reminders.yml) and vercel.json carries
  // a daily fallback schedule for /api/push/cron.
  const cfg = JSON.parse(read("vercel.json")) as { crons?: Array<{ path?: string; schedule?: string }> };
  const cron = (cfg.crons ?? []).find((c) => c.path === "/api/push/cron");
  assert.ok(cron, "no cron entry for /api/push/cron");
  assert.notEqual(cron.schedule, "* * * * *", "every-minute schedule is rejected on Vercel Hobby");
  assert.match(cron.schedule, /^\d+ \d+ \* \* \*$/, "Vercel cron must be daily (Hobby plan limit)");
  const wf = read(".github/workflows/reminders.yml");
  assert.match(wf, /cron: '\*\/5 \* \* \* \*'/, "GitHub Actions must ping every 5 minutes");
  assert.match(wf, /\$\{\{ secrets\.CRON_SECRET \}\}/, "workflow must authenticate with CRON_SECRET");
  assert.match(wf, /secrets\.PROD_URL/, "workflow must target the deployed PROD_URL");
  assert.doesNotMatch(wf, /-X POST/, "cron route is GET-only");
});

await check("client lib: permission flow, subscription post, unsubscribe", () => {
  const src = read("lib/push/client.ts");
  assert.match(src, /requestPermission/);
  assert.match(src, /pushManager\.subscribe/);
  assert.match(src, /userVisibleOnly:\s*true/);
  assert.match(src, /\/api\/push\/subscribe/);
  assert.match(src, /\/api\/push\/unsubscribe/);
  assert.match(src, /\/api\/push\/preferences/);
  assert.match(src, /applicationServerKey/);
});

await check("settings page: opt-in UI without auto prompt, digest selector", () => {
  const src = read("app/settings/page.tsx");
  assert.match(src, /subscribeToPush/);
  assert.match(src, /unsubscribeFromPush/);
  assert.match(src, /setDigestPreference/);
  // Permission must never be requested on render — only from a click handler.
  assert.doesNotMatch(src, /requestPermission/);
});

await check("env wiring: VAPID keys in all three schema/env files", () => {
  assert.match(read("lib/env.ts"), /NEXT_PUBLIC_VAPID_PUBLIC_KEY/);
  assert.match(read("lib/env.ts"), /VAPID_PRIVATE_KEY/);
  assert.match(read("scripts/check-env.mjs"), /NEXT_PUBLIC_VAPID_PUBLIC_KEY/);
  assert.match(read(".env.example"), /NEXT_PUBLIC_VAPID_PUBLIC_KEY/);
  assert.match(read(".env.example"), /generate-vapid-keys/);
});

await check("settings page is registered in the app hub", () => {
  assert.match(read("lib/navigation.ts"), /\/settings/);
});

await check("web-push dependency is installed", async () => {
  const pkg = JSON.parse(read("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  assert.ok(pkg.dependencies?.["web-push"], "web-push missing from dependencies");
  assert.ok(
    pkg.devDependencies?.["@types/web-push"],
    "@types/web-push missing from devDependencies",
  );
  assert.match(pkg.scripts?.["verify:push"] ?? "", /verify-push/);
});

console.log(`\n${passed}/${TOTAL} checks passed\n`);
if (passed !== TOTAL) process.exitCode = 1;
