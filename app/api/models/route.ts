// ============================================================================
// GET /api/models — which AI models the signed-in user can pick in the chat
// dashboard. Returns every live option across all configured providers (ids,
// labels, model names — never keys), in failover order. The client also shows
// an "Auto" option that uses the failover chain.
// ============================================================================
import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/guards";
import { availableModels, availableProviders, PROVIDERS } from "@/lib/ai/providers";

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
  const models = availableModels(process.env).map((m) => ({
    id: m.id,
    providerId: m.providerId,
    label: `${PROVIDERS[m.providerId].label} · ${m.label}`,
    model: m.model,
  }));
  return Response.json({ providers, models });
}
