// End-to-end verification against the REAL Supabase project (§2 layer 2 + §4 RLS):
// 1. anonymous sign-in returns a session (no email/password)
// 2. that session can write + read its own row (RLS allows auth.uid() owner)
// 3. a SECOND anonymous session cannot see the first user's rows (RLS isolates)
// Run: node scripts/verify-auth-e2e.mjs   (requires real keys in .env.local)
import assert from "node:assert";
import { readFileSync } from "node:fs";

try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
} catch {
  /* handled below */
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
assert.ok(url && !url.includes("placeholder"), "real NEXT_PUBLIC_SUPABASE_URL required");
assert.ok(anonKey && anonKey !== "placeholder", "real NEXT_PUBLIC_SUPABASE_ANON_KEY required");

async function anonSession() {
  const res = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`anon signup failed ${res.status}: ${await res.text()}`);
  const body = await res.json();
  assert.ok(body.access_token, "expected access_token in signup response");
  assert.ok(body.user?.id, "expected user.id in signup response");
  return { token: body.access_token, userId: body.user.id };
}

function rest(token) {
  return {
    apikey: anonKey,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

const a = await anonSession();
const b = await anonSession();
assert.notEqual(a.userId, b.userId, "two anonymous sessions must be distinct users");
console.log("PASS anonymous sign-in (two distinct users, no email/password)");

// user A writes a task
const insRes = await fetch(`${url}/rest/v1/tasks`, {
  method: "POST",
  headers: rest(a.token),
  body: JSON.stringify({ client_id: "e2e-task-1", title: "E2E: owned by A", completed: false }),
});
const insertedBody = await insRes.json();
assert.equal(insRes.status, 201, `insert should succeed: ${JSON.stringify(insertedBody)}`);
const inserted = Array.isArray(insertedBody) ? insertedBody[0] : insertedBody;
assert.equal(inserted.user_id, a.userId, "user_id must be set to the session user");
console.log("PASS RLS sets user_id from auth.uid() on insert");

// user A reads own row
const ownRes = await fetch(
  `${url}/rest/v1/tasks?client_id=eq.e2e-task-1&select=id,title`,
  { headers: rest(a.token) },
);
const ownRows = await ownRes.json();
assert.equal(ownRows.length, 1);
console.log("PASS owner can read own row");

// user B must see nothing
const otherRes = await fetch(`${url}/rest/v1/tasks?select=id`, { headers: rest(b.token) });
const otherRows = await otherRes.json();
assert.equal(otherRows.length, 0, "another user must not see A's rows");
console.log("PASS other anonymous user sees zero rows (RLS isolation)");

// unauthenticated (no JWT) must see nothing
const noAuthRes = await fetch(`${url}/rest/v1/tasks?select=id`, {
  headers: { apikey: anonKey },
});
const noAuthRows = await noAuthRes.json();
assert.equal(noAuthRows.length, 0, "unauthenticated request must see zero rows");
console.log("PASS unauthenticated request sees zero rows");

// cleanup user A's row
await fetch(`${url}/rest/v1/tasks?client_id=eq.e2e-task-1`, {
  method: "DELETE",
  headers: rest(a.token),
});

console.log("\nE2E PASS: anon auth + RLS verified against live project");
