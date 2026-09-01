// Live smoke test for /api/auth/verify (run while `next start` is serving):
//   node scripts/smoke-verify.mjs
// Proves §7 "server validates expiry, not just client auto-lock" end-to-end.
import assert from "node:assert";
import { readFileSync } from "node:fs";

// minimal .env.local loader (same as scripts/check-env.mjs)
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
  /* absent file: SYNC_TOKEN_SECRET check below reports it */
}

const secret = process.env.SYNC_TOKEN_SECRET;
if (!secret) throw new Error("SYNC_TOKEN_SECRET not set");

const { signSessionToken } = await import("../lib/auth/tokens.ts");
const base = "http://localhost:3000/api/auth/verify";

const { token: valid } = signSessionToken({ sub: "smoke-user", scope: "session" }, 60);
const { token: expired } = signSessionToken({ sub: "smoke-user", scope: "session" }, -10);
const tampered = valid.slice(0, -4) + "zzzz";

async function call(token) {
  const res = await fetch(base, { headers: { Authorization: `Bearer ${token}` } });
  return res.status;
}

assert.equal(await call(valid), 200, "valid token should be accepted");
assert.equal(await call(expired), 401, "expired token must be rejected server-side");
assert.equal(await call(tampered), 403, "tampered token must be rejected");
assert.equal(
  await (async () => (await fetch(base)).status)(),
  401,
  "missing token must be rejected",
);

const body = await (await fetch(base, { headers: { Authorization: `Bearer ${valid}` } })).json();
assert.equal(body.sub, "smoke-user");
assert.equal(body.scope, "session");
assert.ok(typeof body.exp === "number");

console.log("SMOKE PASS: valid=200, expired=401, tampered=403, missing=401");
