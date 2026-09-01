// ============================================================================
// API route guards (plan §2, §7)
//
// Two independent credentials reach /api/*:
//   1. Webapp session — HMAC token (scope "session"), issued by
//      POST /api/auth/session after the client holds a real Supabase session.
//   2. Extension sync — opaque zsy_… token, scoped to /api/sync/* only,
//      validated against hashed rows in public.sync_tokens (revocable).
// The PIN never appears here: it is a device gate only (§2 layer 1).
// ============================================================================

import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { tokenAllowsScope, verifySessionToken, type SessionClaims } from "./tokens";
import { SYNC_TOKEN_SCOPE, verifySyncTokenFormat } from "./sync-tokens";

function bearer(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

export type AuthFailure = { ok: false; status: 401 | 403; error: string };

export type SessionAuth =
  | AuthFailure
  | { ok: true; claims: SessionClaims; supabaseUserId: string };

/** Guard for regular /api/* routes: requires a valid, unexpired HMAC session token. */
export function requireSession(request: NextRequest): SessionAuth {
  const token = bearer(request);
  if (!token) {
    return { ok: false, status: 401, error: "Missing Authorization bearer token" };
  }
  const result = verifySessionToken(token);
  if (!result.valid) {
    const status = result.reason === "expired" ? 401 : 403;
    return { ok: false, status, error: `Invalid session token: ${result.reason}` };
  }
  if (result.claims.scope !== "session") {
    return { ok: false, status: 403, error: "Token scope does not permit this endpoint" };
  }
  return { ok: true, claims: result.claims, supabaseUserId: result.claims.sub };
}

export type SyncAuth =
  | AuthFailure
  | { ok: true; supabaseUserId: string };

/**
 * Guard for /api/sync/* routes: requires a valid, non-revoked, non-expired
 * extension token. Returns the Supabase user id the token is bound to; all
 * downstream data access MUST be filtered to that user id.
 */
export async function requireSyncToken(request: NextRequest): Promise<SyncAuth> {
  const token = bearer(request);
  if (!token) {
    return { ok: false, status: 401, error: "Missing Authorization bearer token" };
  }
  if (!verifySyncTokenFormat(token)) {
    return { ok: false, status: 403, error: "Malformed sync token" };
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return { ok: false, status: 403, error: "Server not configured for sync token validation" };
  }

  // Service role is used ONLY to look up the token row by unique hash —
  // data queries in sync routes are still filtered to the resolved user id.
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { createHash } = await import("node:crypto");
  const presentedHash = createHash("sha256").update(token, "utf8").digest("hex");

  const { data, error } = await admin
    .from("sync_tokens")
    .select("user_id, revoked_at, expires_at")
    .eq("token_hash", presentedHash)
    .maybeSingle();

  if (error) {
    return { ok: false, status: 403, error: "Sync token lookup failed" };
  }
  if (!data) {
    return { ok: false, status: 403, error: "Unknown sync token" };
  }
  if (data.revoked_at) {
    return { ok: false, status: 403, error: "Sync token has been revoked" };
  }
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
    return { ok: false, status: 401, error: "Sync token has expired" };
  }

  void SYNC_TOKEN_SCOPE; // scope marker kept for contract clarity
  return { ok: true, supabaseUserId: data.user_id };
}

export { tokenAllowsScope };
