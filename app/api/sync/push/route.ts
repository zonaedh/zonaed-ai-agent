// ============================================================================
// POST /api/sync/push — extension-facing push endpoint (plan §2 layer 3, §7)
//
// Body: { table: string, rows: [{ client_id, updated_at, ...fields }] }
//
// Server-side LWW (plan §3): an incoming row is only applied when it is NEWER
// than the stored row with the same (user_id, client_id); older/equal pushes
// are reported as skipped, never applied. user_id is ALWAYS taken from the
// sync token — a client can never write into another user's rows.
// ============================================================================
import type { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireSyncToken } from "@/lib/auth/guards";
import { isSyncableTable, type SyncableRow } from "@/lib/db/types";

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

function tsMs(value: unknown): number {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

interface PushBody {
  table?: unknown;
  rows?: unknown;
}

export async function POST(request: NextRequest) {
  const auth = await requireSyncToken(request);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: PushBody;
  try {
    body = (await request.json()) as PushBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isSyncableTable(body.table)) {
    return Response.json({ error: "Unknown or missing table" }, { status: 400 });
  }
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return Response.json({ error: "rows must be a non-empty array" }, { status: 400 });
  }
  if (body.rows.length > 500) {
    return Response.json({ error: "rows exceeds 500 per request" }, { status: 413 });
  }
  for (const row of body.rows) {
    if (typeof row !== "object" || row === null) {
      return Response.json({ error: "each row must be an object" }, { status: 400 });
    }
    const r = row as Record<string, unknown>;
    if (typeof r.client_id !== "string" || r.client_id.length === 0) {
      return Response.json({ error: "each row needs a client_id" }, { status: 400 });
    }
    if (typeof r.updated_at !== "string" || Number.isNaN(Date.parse(r.updated_at))) {
      return Response.json({ error: "each row needs an RFC-3339 updated_at" }, { status: 400 });
    }
  }

  const supabase = adminClient();
  const incoming = body.rows as SyncableRow[];
  const clientIds = [...new Set(incoming.map((r) => r.client_id))];

  // Existing rows for the same client_ids, scoped to THIS token's user only.
  const { data: existing, error: selErr } = await supabase
    .from(body.table)
    .select("client_id, updated_at")
    .eq("user_id", auth.supabaseUserId)
    .in("client_id", clientIds);
  if (selErr) {
    return Response.json({ error: `Push failed: ${selErr.message}` }, { status: 502 });
  }

  const existingMap = new Map((existing ?? []).map((r: Record<string, unknown>) => [r.client_id as string, r.updated_at as string]));
  const applicable = incoming.filter((r) => {
    const current = existingMap.get(r.client_id);
    return current === undefined || tsMs(r.updated_at) > tsMs(current);
  });
  const skipped = incoming.length - applicable.length;

  if (applicable.length > 0) {
    const payload = applicable.map((r) => {
      // user_id is forced from the token — never trusted from the payload;
      // dirty is a local-only flag and must not reach the database.
      const row: Record<string, unknown> = { ...r };
      delete row.dirty;
      delete row.user_id;
      row.user_id = auth.supabaseUserId;
      return row;
    });
    const { error: upErr } = await supabase
      .from(body.table as string)
      // Dynamic table name: supabase-js resolves the row type to `never`, so
      // the payload must be force-cast; shape is validated above.
      .upsert(payload as unknown as never, { onConflict: "user_id,client_id" });
    if (upErr) {
      return Response.json({ error: `Push failed: ${upErr.message}` }, { status: 502 });
    }
  }

  return Response.json({
    table: body.table,
    applied: applicable.length,
    skipped, // older/equal rows lost LWW server-side — nothing hard-deleted
    serverTime: new Date().toISOString(),
  });
}
