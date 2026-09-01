// ============================================================================
// POST /api/push/unsubscribe (plan §4 /push, Priority 10)
//
// Removes a subscription for the session's user. Subscriptions are
// device-bound (never synced), so a hard delete is correct here — the §3
// soft-delete convention covers synced data only.
// ============================================================================

import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/guards";
import { pushAdminClient } from "@/lib/push/send";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = requireSession(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: { endpoint?: unknown };
  try {
    body = (await request.json()) as { endpoint?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.endpoint !== "string" || body.endpoint.length === 0) {
    return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
  }

  const supabase = pushAdminClient();
  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("user_id", auth.supabaseUserId)
    .eq("endpoint", body.endpoint);
  if (error) {
    return NextResponse.json({ error: `Unsubscribe failed: ${error.message}` }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
