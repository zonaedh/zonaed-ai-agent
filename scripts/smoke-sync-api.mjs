// ============================================================================
// Live smoke test: /api/sync/pull + /api/sync/push (extension contract)
//
// Mints a real zsy_ sync token (SHA-256 hash stored via service role), starts
// from a running server (next start / next dev), and exercises:
//   1. push → applied
//   2. stale push (older updated_at) → skipped (server-side LWW)
//   3. pull → returns the pushed row
//   4. missing token → 401, garbage token → 403
//   5. revoked token → 403
// then revokes + cleans up. Exit code 0 = all checks passed.
//
// Usage: node --env-file=.env.local scripts/smoke-sync-api.mjs [baseUrl]
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";

const baseUrl = process.argv[2] ?? "http://localhost:3000";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  console.error("Missing Supabase env vars (need NEXT_PUBLIC_* and SUPABASE_SERVICE_ROLE_KEY)");
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// Sign in anonymously → the user the token will be bound to.
const userClient = createClient(url, anonKey, { auth: { persistSession: false } });
const { data: signed, error: signErr } = await userClient.auth.signInAnonymously();
if (signErr || !signed.session) {
  console.error(`Anonymous sign-in failed: ${signErr?.message}`);
  process.exit(1);
}
const userId = signed.session.user.id;

// Mint + store the sync token (hash at rest, exactly like the app does).
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const token = `zsy_${randomBytes(32).toString("base64url")}`;
const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
const clientId = `smoke-${Date.now()}`;
const { error: tokErr } = await admin
  .from("sync_tokens")
  .insert({ user_id: userId, label: "smoke-test", token_hash: tokenHash });
if (tokErr) {
  console.error(`Token insert failed: ${tokErr.message}`);
  process.exit(1);
}
console.log(`Signed in ${userId}; token minted.\n`);

const authed = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

// 1) push → applied
const now = new Date().toISOString();
const res1 = await fetch(`${baseUrl}/api/sync/push`, {
  method: "POST",
  headers: authed,
  body: JSON.stringify({ table: "tasks", rows: [{ client_id: clientId, title: "from extension", completed: false, updated_at: now }] }),
  });
const body1 = await res1.json();
check("push → 200 applied:1", res1.status === 200 && body1.applied === 1, JSON.stringify(body1));

// 2) stale push → skipped (server-side LWW)
const stale = new Date(Date.parse(now) - 60_000).toISOString();
const res2 = await fetch(`${baseUrl}/api/sync/push`, {
  method: "POST",
  headers: authed,
  body: JSON.stringify({ table: "tasks", rows: [{ client_id: clientId, title: "STALE — must not apply", completed: false, updated_at: stale }] }),
});
const body2 = await res2.json();
check("stale push → applied:0 skipped:1", res2.status === 200 && body2.applied === 0 && body2.skipped === 1, JSON.stringify(body2));

// 3) pull → row visible with winning content
const res3 = await fetch(`${baseUrl}/api/sync/pull?table=tasks`, { headers: authed });
const body3 = await res3.json();
const row = (body3.rows ?? []).find((r) => r.client_id === clientId);
check("pull → 200 with pushed row", res3.status === 200 && row?.title === "from extension", JSON.stringify(body3).slice(0, 200));

// 4) auth failures
const res4 = await fetch(`${baseUrl}/api/sync/pull?table=tasks`);
check("missing token → 401", res4.status === 401, String(res4.status));
const res5 = await fetch(`${baseUrl}/api/sync/pull?table=tasks`, { headers: { Authorization: "Bearer zsy_deadbeef" } });
check("garbage token → 403", res5.status === 403, String(res5.status));

// 5) revocation
await admin.from("sync_tokens").update({ revoked_at: new Date().toISOString() }).eq("token_hash", tokenHash);
const res6 = await fetch(`${baseUrl}/api/sync/pull?table=tasks`, { headers: authed });
check("revoked token → 403", res6.status === 403, String(res6.status));

// Cleanup
await admin.from("tasks").delete().eq("user_id", userId);
await admin.from("sync_tokens").delete().eq("token_hash", tokenHash);
await userClient.auth.signOut();

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
