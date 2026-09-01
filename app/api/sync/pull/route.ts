// ============================================================================
// GET /api/sync/pull  — extension-facing pull endpoint (plan §2 layer 3, §7)
//
// Shared sync contract: the extension authenticates with its scoped zsy_…
// token (requireSyncToken), never with the webapp session or the PIN. Data
// access is filtered to the token's resolved Supabase user id.
//
//   GET /api/sync/pull?table=tasks&since=2026-01-01T00:00:00Z
//   → { table, rows: [...], serverTime }
// ============================================================================
import type { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireSyncToken } from "@/lib/auth/guards";
import { isSyncableTable } from "@/lib/db/types";

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
  const auth = await requireSyncToken(request);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const tableParam = request.nextUrl.searchParams.get("table");
  if (!isSyncableTable(tableParam)) {
    return Response.json({ error: `Unknown or missing table; expected one of the syncable tables` }, { status: 400 });
  }
  // `since` is an RFC-3339 timestamp; PostgREST compares it against updated_at.
  const since = request.nextUrl.searchParams.get("since");
  if (since !== null && Number.isNaN(Date.parse(since))) {
    return Response.json({ error: "since must be an RFC-3339 timestamp" }, { status: 400 });
  }

  const supabase = adminClient();
  let query = supabase
    .from(tableParam)
    .select("*")
    .eq("user_id", auth.supabaseUserId) // mandatory: token → user scoping
    .order("updated_at")
    .order("client_id")
    .limit(500);
  if (since) query = query.gt("updated_at", since);

  const { data, error } = await query;
  if (error) {
    return Response.json({ error: `Pull failed: ${error.message}` }, { status: 502 });
  }

  return Response.json({
    table: tableParam,
    rows: data ?? [],
    serverTime: new Date().toISOString(),
  });
}
