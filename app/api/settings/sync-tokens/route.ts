// ============================================================================
// /api/settings/sync-tokens — extension token management (plan §2 layer 3)
//
// The webapp is the ONLY issuer of zsy_… sync tokens. Tokens are stored as
// SHA-256 hashes; the plaintext is returned exactly once (at mint time) and
// never again. Revocation sets revoked_at (soft, auditable — no hard delete).
//
//   GET    → list the user's tokens (id, label, created/revoked — never the hash)
//   POST   → mint a new token  { label } → { id, token }  (plaintext, once)
//   DELETE → revoke           { id }    → { revoked: true }
// ============================================================================
import type { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireSession } from "@/lib/auth/guards";
import { generateSyncToken } from "@/lib/auth/sync-tokens";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

function adminClient(): ReturnType<typeof createClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Server not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function GET(request: NextRequest) {
  const auth = requireSession(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const supabase = adminClient();
  const { data, error } = await supabase
    .from("sync_tokens")
    .select("id, label, created_at, revoked_at")
    .eq("user_id", auth.claims.sub)
    .order("created_at", { ascending: false });
  if (error) return Response.json({ error: `List failed: ${error.message}` }, { status: 502 });

  return Response.json({ tokens: data ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = requireSession(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const limit = await checkRateLimit("sync-tokens", auth.claims.sub, 10);
  if (!limit.allowed) {
    return Response.json(
      { error: "Too many token requests — try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.resetSeconds || 60) } },
    );
  }

  let label = "extension";
  try {
    const body = (await request.json()) as { label?: unknown };
    if (typeof body.label === "string" && body.label.trim().length > 0) {
      label = body.label.trim().slice(0, 60);
    }
  } catch {
    // no body → default label
  }

  const { token, tokenHash } = generateSyncToken();
  const supabase = adminClient();
  // sync_tokens isn't in generated row types — shape is ours, cast through.
  const insertPayload = { user_id: auth.claims.sub, label, token_hash: tokenHash };
  const { data, error } = await supabase
    .from("sync_tokens")
    .insert(insertPayload as unknown as never)
    .select("id, label, created_at")
    .single();
  if (error) return Response.json({ error: `Mint failed: ${error.message}` }, { status: 502 });

  const minted = data as unknown as { id: string; label: string; created_at: string };
  // Plaintext leaves the server exactly once, here. Store it in the extension
  // options page immediately — it cannot be recovered later.
  return Response.json({ token, id: minted.id, label: minted.label, created_at: minted.created_at });
}

export async function DELETE(request: NextRequest) {
  const auth = requireSession(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let id: unknown;
  try {
    ({ id } = (await request.json()) as { id?: unknown });
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof id !== "string" || id.length === 0) {
    return Response.json({ error: "id is required" }, { status: 400 });
  }

  const supabase = adminClient();
  const { error } = await supabase
    .from("sync_tokens")
    .update({ revoked_at: new Date().toISOString() } as unknown as never)
    .eq("id", id)
    .eq("user_id", auth.claims.sub) // scope: only own tokens
    .is("revoked_at", null);
  if (error) return Response.json({ error: `Revoke failed: ${error.message}` }, { status: 502 });

  return Response.json({ revoked: true });
}