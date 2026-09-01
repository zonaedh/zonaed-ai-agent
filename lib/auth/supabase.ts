// ============================================================================
// Supabase clients (plan §2 layer 2, §9 Priority 1)
//
// Every read/write to Supabase goes through a real Supabase session so RLS
// (keyed off auth.uid()) applies. Anonymous auth is used for the single-user
// MVP; upgradeable to magic-link later without schema changes.
// ============================================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Read the client-safe values directly (NOT via lib/env.ts — that module
// validates server-only vars too and must never be imported into the browser
// bundle).
function publicConfig(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. " +
        "Copy .env.example to .env.local and fill them in.",
    );
  }
  return { url, anonKey };
}

let browserClient: SupabaseClient | null = null;

/** Client-safe singleton for browser code (RLS-scoped, anon key only). */
export function getSupabaseBrowserClient(): SupabaseClient {
  if (!browserClient) {
    const { url, anonKey } = publicConfig();
    browserClient = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }
  return browserClient;
}

/**
 * Server-side client bound to the caller's Supabase session (from their JWT),
 * so every query is RLS-filtered. Used by /api/* routes that act on behalf of
 * the authenticated user.
 */
export function getSupabaseServerClient(accessToken: string): SupabaseClient {
  const { url, anonKey } = publicConfig();
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Ensure the device has a Supabase session: signs in anonymously on first run,
 * returns the existing session otherwise. This is the data-authorization
 * identity — independent of the local PIN gate.
 */
export async function ensureSupabaseSession(): Promise<string> {
  const supabase = getSupabaseBrowserClient();
  const { data: existing } = await supabase.auth.getSession();
  if (existing.session) return existing.session.access_token;

  const { data: signedIn, error } = await supabase.auth.signInAnonymously();
  if (error || !signedIn.session) {
    throw new Error(
      `Supabase anonymous sign-in failed: ${error?.message ?? "no session returned"}`,
    );
  }
  return signedIn.session.access_token;
}
