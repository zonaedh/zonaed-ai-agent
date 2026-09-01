// ============================================================================
// Live smoke test for /api/chat (plan §5.1 pipeline guardrails).
// Starts nothing itself: point it at a running server via BASE (default
// http://localhost:3018). Signs a real session token with the local
// SYNC_TOKEN_SECRET, then exercises the route contract end-to-end.
// ============================================================================
process.env.FORCE_COLOR = "0";

const BASE = process.env.BASE ?? "http://localhost:3018";

const { signSessionToken } = await import("../lib/auth/tokens.ts");

const { token } = signSessionToken({
  sub: "00000000-0000-0000-0000-000000000000",
  scope: "session",
}, 600);

let passed = 0;
const TOTAL = 4;
function ok(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok ${passed} - ${name}`);
  } else {
    console.error(`  FAIL - ${name} ${detail}`);
    process.exit(1);
  }
}

// 1. No token → 401
{
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  ok("no token → 401", res.status === 401, `got ${res.status}`);
}

// 2. Valid token, empty body → 400 with JSON error
{
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  const body = (await res.json().catch(() => ({})));
  ok("empty body → 400 + JSON error", res.status === 400 && typeof body.error === "string", `got ${res.status} ${JSON.stringify(body)}`);
}

// 3. Valid token + messages, no provider keys → 503
{
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const body = (await res.json().catch(() => ({})));
  ok("no providers → 503", res.status === 503 && typeof body.error === "string", `got ${res.status} ${JSON.stringify(body)}`);
}

// 4. chainOfDraft + approvedOutline together → 400 (mutually exclusive)
{
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      chainOfDraft: true,
      approvedOutline: "1. intro",
    }),
  });
  ok("chainOfDraft + approvedOutline → 400", res.status === 400, `got ${res.status}`);
}

console.log(`\n${passed}/${TOTAL} live /api/chat checks passed`);
if (passed !== TOTAL) process.exit(1);
