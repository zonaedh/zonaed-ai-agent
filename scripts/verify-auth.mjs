// Live check of lib/auth/tokens.ts + lib/auth/sync-tokens.ts (§9 Priority 1):
// sign → verify (valid), tamper → bad-signature, expired token → expired,
// scope enforcement, sync token generate/verify/revocation-shape.
// Run: node scripts/verify-auth.mjs   (Node 24 strips types natively)
import assert from "node:assert";

const tokens = await import("../lib/auth/tokens.ts");
const sync = await import("../lib/auth/sync-tokens.ts");

process.env.SYNC_TOKEN_SECRET = "x".repeat(32); // test-only secret

// 1. sign → verify round-trip
const { token, expiresAt } = tokens.signSessionToken({ sub: "user-123", scope: "session" }, 60);
const ok = tokens.verifySessionToken(token);
assert.ok(ok.valid && ok.claims.sub === "user-123" && ok.claims.scope === "session");
assert.ok(Math.abs(expiresAt.getTime() - Date.now() - 60_000) < 5_000);
console.log("PASS sign/verify round-trip, exp embedded:", new Date(ok.claims.exp * 1000).toISOString());

// 2. tampered payload → bad-signature
const tampered = token.slice(0, -3) + "aaa";
const tamperedResult = tokens.verifySessionToken(tampered);
assert.equal(tamperedResult.valid, false);
assert.equal(tamperedResult.reason, "bad-signature");
console.log("PASS tampered token rejected (bad-signature)");

// 3. expired token → server-side expiry rejection
const { token: expired } = tokens.signSessionToken({ sub: "u", scope: "session" }, -10);
const expiredResult = tokens.verifySessionToken(expired);
assert.equal(expiredResult.valid, false);
assert.equal(expiredResult.reason, "expired");
console.log("PASS expired token rejected server-side");

// 4. scope enforcement: sync-scoped token must not authorize session scope
const { token: syncScoped } = tokens.signSessionToken({ sub: "u", scope: "sync" });
assert.equal(tokens.tokenAllowsScope(syncScoped, "session"), false);
assert.equal(tokens.tokenAllowsScope(syncScoped, "sync"), true);
assert.equal(tokens.tokenAllowsScope(token, "sync"), false);
console.log("PASS scope enforcement (session vs sync)");

// 5. sync tokens: format, hash determinism, mismatch
const { token: zsyToken, tokenHash } = sync.generateSyncToken();
assert.ok(sync.verifySyncTokenFormat(zsyToken));
assert.equal(sync.hashSyncToken(zsyToken), tokenHash);
assert.ok(sync.syncTokenHashMatches(zsyToken, tokenHash));
// deterministic mismatch: flip the final char to a different fixed char
const flipped = zsyToken.slice(0, -1) + (zsyToken.endsWith("A") ? "B" : "A");
assert.notEqual(flipped, zsyToken);
assert.ok(!sync.syncTokenHashMatches(flipped, tokenHash));
assert.ok(!sync.verifySyncTokenFormat("not-a-token"));
console.log("PASS sync token generate/hash/mismatch/format");

console.log("\nAll auth checks passed.");
