// ============================================================================
// POST /api/push/subscribe (plan §4 /push, Priority 10)
//
// Stores a Web Push subscription for the session's user. The user_id comes
// from the HMAC session token only (never the body). Re-subscribing the same
// endpoint upserts — browsers rotate p256dh/auth keys on permission changes.
// ============================================================================

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/guards";
import { pushAdminClient } from "@/lib/push/send";

export const dynamic = "force-dynamic";

const subscriptionSchema = z.object({
  endpoint: z.url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});

export async function POST(request: NextRequest) {
  const auth = requireSession(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = subscriptionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid subscription payload", issues: parsed.error.issues.map((i) => i.path.join(".")) },
      { status: 400 },
    );
  }

  const userAgent = request.headers.get("user-agent")?.slice(0, 300) ?? null;
  const supabase = pushAdminClient();
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: auth.supabaseUserId,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      user_agent: userAgent,
    } as unknown as never,
    { onConflict: "user_id,endpoint" },
  );
  if (error) {
    return NextResponse.json({ error: `Subscribe failed: ${error.message}` }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
