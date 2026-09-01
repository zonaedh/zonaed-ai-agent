// ============================================================================
// POST /api/push/preferences (plan §4 /push, Priority 10)
//
// Stores the digest opt-in (off / daily / weekly) in the synced settings
// table under the server-owned client_id, where /api/push/cron reads it.
// Body: { frequency: "off" | "daily" | "weekly" }
// ============================================================================

import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/guards";
import { pushAdminClient } from "@/lib/push/send";
import {
  DIGEST_SETTING_KEY,
  SERVER_SETTINGS_CLIENT_ID,
  isDigestFrequency,
} from "@/lib/push/payload";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = requireSession(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: { frequency?: unknown };
  try {
    body = (await request.json()) as { frequency?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isDigestFrequency(body.frequency) && body.frequency !== "off") {
    return NextResponse.json(
      { error: "frequency must be one of: off, daily, weekly" },
      { status: 400 },
    );
  }

  const supabase = pushAdminClient();

  if (body.frequency === "off") {
    const { error } = await supabase
      .from("settings")
      .delete()
      .eq("user_id", auth.supabaseUserId)
      .eq("client_id", SERVER_SETTINGS_CLIENT_ID)
      .eq("key", DIGEST_SETTING_KEY);
    if (error) {
      return NextResponse.json({ error: `Preference update failed: ${error.message}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true, frequency: "off" });
  }

  const value = { frequency: body.frequency, updated_at: new Date().toISOString() };
  const { error } = await supabase.from("settings").upsert(
    {
      user_id: auth.supabaseUserId,
      client_id: SERVER_SETTINGS_CLIENT_ID,
      key: DIGEST_SETTING_KEY,
      value,
    } as unknown as never,
    { onConflict: "user_id,client_id,key" },
  );
  if (error) {
    return NextResponse.json({ error: `Preference update failed: ${error.message}` }, { status: 502 });
  }

  return NextResponse.json({ ok: true, frequency: body.frequency });
}
