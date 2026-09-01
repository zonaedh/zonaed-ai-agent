// ============================================================================
// /api/learn/preferences (plan §5.4, Priority 11)
//
// GET  → { enabled: boolean } — state of the "Learn from my chat history"
//        opt-in (off by default; plan §5.4 + §7 #8).
// POST { enabled } — writes/removes the server-owned settings row that
//        /api/learn/cron reads. Per-account (synced), not per-device.
// ============================================================================

import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/guards";
import { pushAdminClient } from "@/lib/push/send";
import { SERVER_SETTINGS_CLIENT_ID } from "@/lib/push/payload";
import { LEARN_SETTING_KEY } from "@/lib/learn/extract";

export const dynamic = "force-dynamic";

interface LearnSettingRow {
  value: { enabled?: unknown } | null;
}

export async function GET(request: NextRequest) {
  const auth = requireSession(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const supabase = pushAdminClient();
  const { data, error } = await supabase
    .from("settings")
    .select("value")
    .eq("user_id", auth.supabaseUserId)
    .eq("client_id", SERVER_SETTINGS_CLIENT_ID)
    .eq("key", LEARN_SETTING_KEY)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: `Preference lookup failed: ${error.message}` }, { status: 502 });
  }
  const enabled = Boolean((data as LearnSettingRow | null)?.value?.enabled);
  return NextResponse.json({ enabled });
}

export async function POST(request: NextRequest) {
  const auth = requireSession(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: { enabled?: unknown };
  try {
    body = (await request.json()) as { enabled?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  const supabase = pushAdminClient();

  if (!body.enabled) {
    // Opt-out removes the row entirely (plan §8 #9: toggle off → no job runs).
    const { error } = await supabase
      .from("settings")
      .delete()
      .eq("user_id", auth.supabaseUserId)
      .eq("client_id", SERVER_SETTINGS_CLIENT_ID)
      .eq("key", LEARN_SETTING_KEY);
    if (error) {
      return NextResponse.json({ error: `Preference update failed: ${error.message}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true, enabled: false });
  }

  const { error } = await supabase.from("settings").upsert(
    {
      user_id: auth.supabaseUserId,
      client_id: SERVER_SETTINGS_CLIENT_ID,
      key: LEARN_SETTING_KEY,
      value: { enabled: true, updated_at: new Date().toISOString() },
    } as unknown as never,
    { onConflict: "user_id,client_id,key" },
  );
  if (error) {
    return NextResponse.json({ error: `Preference update failed: ${error.message}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true, enabled: true });
}
