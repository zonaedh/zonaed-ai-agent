// ============================================================================
// POST /api/chat — main conversational surface (plan §4 /chat, §5.1 pipeline)
//
// Request:  { messages, preamble?, chainOfDraft?, approvedOutline? }
// Response: SSE stream of { type: "meta" | "delta" | "done" | "error" } events.
//
// Pipeline (plan §5.1, in order):
//   1. requireSession guard (HMAC session token, server-validated)
//   2. Rate limit (Upstash fixed window, fail-open in dev)
//   3. Tone profile the latest user message → language mode
//   4. Build the system prompt: persona → language rules → anti-cliché rules
//      → memory/skill/example preamble → chain-of-draft instructions
//   5. Stream from the first healthy provider (429/503 auto-failover)
//   6. Post-scan the full output for banned vocabulary; report in `done`
//
// Preamble is supplied by the client, assembled from Dexie (source of truth,
// works offline) with the shared lib/ai/matching.ts logic.
// ============================================================================
import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { detectLanguageMode } from "@/lib/ai/tone";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { scanOutput, type OutputScan } from "@/lib/ai/anti-cliche";
import { availableProviders, streamWithFailover, type ChatMessageInput } from "@/lib/ai/providers";
import type { PreambleShape } from "@/lib/ai/validate";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CHAT_RATE_LIMIT = 20; // requests per user per minute

interface ChatRequestBody {
  messages?: unknown;
  preamble?: unknown;
  chainOfDraft?: unknown;
  approvedOutline?: unknown;
}

function sseEvent(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function validatePreamble(raw: unknown): PreambleShape {
  const p = (raw ?? {}) as Partial<PreambleShape>;
  const clean: PreambleShape = { skills: [], memories: [], examples: [] };
  if (Array.isArray(p.skills)) {
    clean.skills = p.skills
      .filter((s) => typeof s === "object" && s !== null)
      .slice(0, 10)
      .map((s) => ({ title: String((s as { title: unknown }).title ?? "").slice(0, 200), content: String((s as { content: unknown }).content ?? "").slice(0, 20_000) }))
      .filter((s) => s.content.length > 0);
  }
  if (Array.isArray(p.memories)) {
    clean.memories = p.memories
      .filter((m) => typeof m === "object" && m !== null)
      .slice(0, 12)
      .map((m) => ({ category: String((m as { category: unknown }).category ?? "general").slice(0, 100), content: String((m as { content: unknown }).content ?? "").slice(0, 2_000) }))
      .filter((m) => m.content.length > 0);
  }
  if (Array.isArray(p.examples)) {
    clean.examples = p.examples
      .filter((e) => typeof e === "object" && e !== null)
      .slice(0, 5)
      .map((e) => ({ input: String((e as { input: unknown }).input ?? "").slice(0, 4_000), output: String((e as { output: unknown }).output ?? "").slice(0, 4_000) }))
      .filter((e) => e.input.length > 0 && e.output.length > 0);
  }
  return clean;
}

function validateMessages(raw: unknown): ChatMessageInput[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: ChatMessageInput[] = [];
  for (const m of raw.slice(-40)) {
    if (typeof m !== "object" || m === null) return null;
    const role = (m as { role: unknown }).role;
    const content = (m as { content: unknown }).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    out.push({ role, content: content.slice(0, 32_000) });
  }
  return out.some((m) => m.role === "user") ? out : null;
}

export async function POST(request: NextRequest) {
  // 1. Session guard (plan §2/§7: HMAC token with server-validated exp).
  const auth = requireSession(request);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  // 2. Rate limit (plan §7: all AI-provider-calling routes).
  const limit = await checkRateLimit("chat", auth.supabaseUserId, CHAT_RATE_LIMIT);
  if (!limit.allowed) {
    return Response.json(
      { error: "Rate limit exceeded. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(Math.max(1, limit.resetSeconds)) } },
    );
  }

  // 3. Validate the payload.
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const messages = validateMessages(body.messages);
  if (!messages) {
    return Response.json(
      { error: "messages must be an array of {role: 'user'|'assistant', content} with at least one user message" },
      { status: 400 },
    );
  }
  const preamble = validatePreamble(body.preamble);
  const chainOfDraft = body.chainOfDraft === true;
  const approvedOutline = typeof body.approvedOutline === "string" ? body.approvedOutline.slice(0, 16_000) : null;
  if (chainOfDraft && approvedOutline) {
    return Response.json(
      { error: "Send chainOfDraft to get an outline, or approvedOutline to generate the final piece, not both" },
      { status: 400 },
    );
  }

  // 4. Tone profile + system prompt (plan §5.1 order: persona → language →
  //    anti-cliché → preamble → chain-of-draft instructions).
  const latestUser = [...messages].reverse().find((m) => m.role === "user")!;
  const languageMode = detectLanguageMode(latestUser.content);
  const systemPrompt = buildSystemPrompt({
    languageMode,
    preamble,
    outlineOnly: chainOfDraft,
  });

  const finalMessages: ChatMessageInput[] = [{ role: "system", content: systemPrompt }, ...messages];
  if (approvedOutline) {
    finalMessages.push({
      role: "user",
      content: `Approved outline:\n${approvedOutline}\n\nNow write the full piece following this outline exactly. Apply all system rules (no em/en dashes, no banned words).`,
    });
  }

  // 5. Stream with provider failover.
  const providers = availableProviders(process.env);
  if (providers.length === 0) {
    return Response.json(
      { error: "No AI provider configured. Set at least one provider API key." },
      { status: 503 },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (event: Record<string, unknown>) => controller.enqueue(sseEvent(event));
      try {
        const { stream: deltas, provider } = await streamWithFailover(providers, finalMessages);
        enqueue({
          type: "meta",
          provider: provider.id,
          model: provider.model,
          languageMode,
          stage: chainOfDraft ? "outline" : "final",
        });

        let full = "";
        for await (const delta of deltas) {
          full += delta;
          enqueue({ type: "delta", text: delta });
        }

        // 6. Post-generation anti-cliché scan (plan §5.1 enforcement).
        const scan: OutputScan = scanOutput(full);
        enqueue({
          type: "done",
          scan: { bannedWords: scan.bannedWords, dashes: scan.dashes, clean: scan.clean },
        });
      } catch (err) {
        enqueue({ type: "error", error: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

