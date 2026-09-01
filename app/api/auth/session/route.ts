// ============================================================================
// POST /api/auth/session (plan §2, §9 Priority 1)
//
// Exchanges a real Supabase access token (obtained client-side via anonymous
// sign-in — never the PIN) for a server-issued HMAC session token with an
// embedded `exp`. The server validates that Supabase token is live before
// issuing, and the HMAC token is then what all /api/* routes require.
// ============================================================================

import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { signSessionToken } from "@/lib/auth/tokens";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: { supabaseAccessToken?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const supabaseAccessToken =
    typeof body.supabaseAccessToken === "string" ? body.supabaseAccessToken : null;
  if (!supabaseAccessToken) {
    return NextResponse.json(
      { error: "supabaseAccessToken is required" },
      { status: 400 },
    );
  }

  // Validate the Supabase token is live and get its user — the HMAC token is
  // bound to that auth.uid so downstream RLS matches.
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${supabaseAccessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser(supabaseAccessToken);
  if (error || !data.user) {
    return NextResponse.json({ error: "Supabase session is not valid" }, { status: 401 });
  }

  const { token, expiresAt } = signSessionToken({
    sub: data.user.id,
    scope: "session",
  });

  return NextResponse.json({ token, expiresAt: expiresAt.toISOString() });
}
