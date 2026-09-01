// GET /api/auth/verify — validates the presented HMAC session token server-side.
// Used by the client after unlock to confirm its token is still valid (e.g.
// across resumes) and by tests to prove server-side exp enforcement.

import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = requireSession(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  return NextResponse.json({
    valid: true,
    sub: auth.claims.sub,
    scope: auth.claims.scope,
    exp: auth.claims.exp,
  });
}
