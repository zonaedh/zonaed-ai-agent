// ============================================================================
// GET /api/models — which AI models the signed-in user can pick in the chat
// dashboard. Returns only ids/labels/model names (never keys), in failover
// order. The client also shows an "Auto" option that uses the same order.
// ============================================================================
import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/guards";
import { availableProviders } from "@/lib/ai/providers";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = requireSession(request);
  if (!session.ok) {
    return Response.json({ error: session.error }, { status: session.status });
  }
  const providers = availableProviders(process.env).map((p) => ({
    id: p.id,
    label: p.label,
    model: p.model,
  }));
  return Response.json({ providers });
}
