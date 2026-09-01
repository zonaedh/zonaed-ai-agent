// ============================================================================
// Scoped extension API tokens (plan §2 layer 3, §7)
//
// A separate, revocable token scoped ONLY to /api/sync/* endpoints. Not the
// same credential as the Supabase session and not the PIN. Stored as a hash
// so a leaked token row cannot be replayed; revocation sets revoked_at.
// ============================================================================

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SYNC_TOKEN_PREFIX = "zsy_";
export const SYNC_TOKEN_SCOPE = "sync" as const;

/** Generate a new opaque extension token. Only the hash is ever persisted. */
export function generateSyncToken(): { token: string; tokenHash: string } {
  const token = SYNC_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSyncToken(token) };
}

export function hashSyncToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifySyncTokenFormat(token: string): boolean {
  return (
    token.startsWith(SYNC_TOKEN_PREFIX) &&
    token.length === SYNC_TOKEN_PREFIX.length + 43 && // 32 bytes base64url
    /^[A-Za-z0-9_-]+$/.test(token.slice(SYNC_TOKEN_PREFIX.length))
  );
}

/** Constant-time comparison of a presented token's hash against a stored hash. */
export function syncTokenHashMatches(presentedToken: string, storedHash: string): boolean {
  const presentedHash = Buffer.from(hashSyncToken(presentedToken), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return presentedHash.length === stored.length && timingSafeEqual(presentedHash, stored);
}
