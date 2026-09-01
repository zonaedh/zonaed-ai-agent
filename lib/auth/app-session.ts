// ============================================================================
// App session client (plan §2, §9 Priority 1)
//
// Browser-side holder of the HMAC session token minted by
// POST /api/auth/session. Flow: PIN gate unlocks -> ensureSupabaseSession()
// -> exchange the Supabase access token for an HMAC session token -> keep it
// in sessionStorage (per-tab; gone when the tab closes). All /api/* routes
// require this token via Authorization: Bearer (lib/auth/guards.ts).
// The PIN itself never appears here — device gate and data authorization stay
// independent (plan §2).
// ============================================================================

import { ensureSupabaseSession } from "./supabase";

const TOKEN_KEY = "zonaed.session.token";
const EXPIRES_KEY = "zonaed.session.expiresAt";

export type StoredSession = { token: string; expiresAt: number };

/** The stored token, or null when absent/expired. Browser only. */
export function getStoredSession(): StoredSession | null {
  if (typeof sessionStorage === "undefined") return null;
  const token = sessionStorage.getItem(TOKEN_KEY);
  const expiresAt = Number(sessionStorage.getItem(EXPIRES_KEY));
  if (!token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return { token, expiresAt };
}

/**
 * Mint a fresh HMAC session token from the live Supabase session (signing in
 * anonymously on first run) and persist it in sessionStorage.
 */
export async function refreshSessionToken(): Promise<StoredSession> {
  const supabaseAccessToken = await ensureSupabaseSession();
  const res = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ supabaseAccessToken }),
  });
  if (!res.ok) {
    throw new Error(`Session token request failed with status ${res.status}`);
  }
  const body = (await res.json()) as { token?: unknown; expiresAt?: unknown };
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error("Session token response is missing the token");
  }
  if (typeof body.expiresAt !== "string") {
    throw new Error("Session token response is missing expiresAt");
  }
  const expiresAt = Date.parse(body.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new Error("Session token response has an unparseable expiresAt");
  }
  const session: StoredSession = { token: body.token, expiresAt };
  sessionStorage.setItem(TOKEN_KEY, session.token);
  sessionStorage.setItem(EXPIRES_KEY, String(session.expiresAt));
  return session;
}

/** Server-side validity check of the stored token (GET /api/auth/verify). */
export async function validateSessionToken(): Promise<boolean> {
  const session = getStoredSession();
  if (!session) return false;
  const res = await fetch("/api/auth/verify", {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  return res.ok;
}

function withAuth(token: string, init: RequestInit): RequestInit {
  const headers = { ...(init.headers as Record<string, string> | undefined) };
  headers.Authorization = `Bearer ${token}`;
  return { ...init, headers };
}

/**
 * fetch with the session token attached. Mints a token first if none is
 * stored, and on a 401 (expired token) refreshes once and retries — so
 * callers get transparent re-authentication.
 */
export async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let session = getStoredSession();
  if (!session) session = await refreshSessionToken();
  let res = await fetch(url, withAuth(session.token, init));
  if (res.status === 401) {
    session = await refreshSessionToken();
    res = await fetch(url, withAuth(session.token, init));
  }
  return res;
}