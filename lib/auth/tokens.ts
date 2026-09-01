// ============================================================================
// HMAC session tokens (plan §2, §7: "HMAC session tokens carry exp; server
// validates expiry, not just client auto-lock")
//
// Server-issued, HMAC-SHA256-signed tokens with an embedded expiry. Used for
// the webapp's own session authorization of /api/* routes after the PIN gate
// unlocks. The signing secret comes from SYNC_TOKEN_SECRET env var — never
// hardcoded.
// ============================================================================

import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 24h

export type SessionClaims = {
  /** subject — the Supabase user id (auth.uid) this token is bound to */
  sub: string;
  /** issued-at, epoch seconds */
  iat: number;
  /** expiry, epoch seconds — validated server-side on every request */
  exp: number;
  /** scope: "session" (webapp) or "sync" (extension, /api/sync/* only) */
  scope: "session" | "sync";
};

function getSecret(): string {
  const secret = process.env.SYNC_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "SYNC_TOKEN_SECRET is missing or too short (min 32 chars). Set it in the environment.",
    );
  }
  return secret;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signPayload(payloadB64: string): string {
  return createHmac("sha256", getSecret()).update(payloadB64).digest("base64url");
}

export function signSessionToken(
  claims: Omit<SessionClaims, "iat" | "exp">,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): { token: string; expiresAt: Date } {
  const now = Math.floor(Date.now() / 1000);
  const full: SessionClaims = { ...claims, iat: now, exp: now + ttlSeconds };
  const payloadB64 = base64url(JSON.stringify(full));
  const signature = signPayload(payloadB64);
  return { token: `${payloadB64}.${signature}`, expiresAt: new Date(full.exp * 1000) };
}

export type VerifyResult =
  | { valid: true; claims: SessionClaims }
  | { valid: false; reason: "malformed" | "bad-signature" | "expired" };

/**
 * Verify signature AND expiry. An expired token is rejected here on the
 * server — client-side auto-lock is a UX nicety, never the security boundary.
 */
export function verifySessionToken(token: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, reason: "malformed" };
  }
  const [payloadB64, signature] = parts;

  const expected = signPayload(payloadB64);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "bad-signature" };
  }

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as SessionClaims;
  } catch {
    return { valid: false, reason: "malformed" };
  }

  if (typeof claims.exp !== "number" || Math.floor(Date.now() / 1000) >= claims.exp) {
    return { valid: false, reason: "expired" };
  }

  return { valid: true, claims };
}

/** Route guard: does this token authorize the requested scope? */
export function tokenAllowsScope(token: string, required: SessionClaims["scope"]): boolean {
  const result = verifySessionToken(token);
  return result.valid && result.claims.scope === required;
}
