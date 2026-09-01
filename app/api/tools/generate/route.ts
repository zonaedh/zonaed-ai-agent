// ============================================================================
// POST /api/tools/generate — §5.2 webapp-native report/analysis tools
//
// Request:  { tool: "report"|"marketing-plan"|"competitor-spy"|"outreach",
//             url: string, notes?: string }
// Response: SSE stream of { type: "meta" | "delta" | "done" | "error" }.
//
// Pipeline:
//   1. requireSession guard (same HMAC session token as /api/chat)
//   2. Rate limit (tighter than chat: each request crawls external sites)
//   3. Validate tool + URL (SSRF guard in normalizeInputUrl)
//   4. Server-side fetch/crawl per the tool's crawlMode
//   5. Stream from the first healthy provider (429/503 auto-failover)
//   6. Post-scan output for banned vocabulary; report in `done`
// ============================================================================
import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { scanOutput } from "@/lib/ai/anti-cliche";
import { availableProviders, streamWithFailover, type ChatMessageInput } from "@/lib/ai/providers";
import { crawlSite, normalizeInputUrl } from "@/lib/tools/crawl";
import { isToolId, TOOLS } from "@/lib/tools/prompts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TOOLS_RATE_LIMIT = 6; // requests per user per minute (crawl + generation is heavy)
const MAX_NOTES_CHARS = 2_000;

interface ToolRequestBody {
  tool?: unknown;
  url?: unknown;
  notes?: unknown;
}

function sseEvent(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: NextRequest): Promise<Response> {
  // 1. Session guard.
  const auth = requireSession(request);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  // 2. Rate limit.
  const limit = await checkRateLimit("tools", auth.supabaseUserId, TOOLS_RATE_LIMIT);
  if (!limit.allowed) {
    return Response.json(
      { error: "Rate limit exceeded. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(Math.max(1, limit.resetSeconds)) } },
    );
  }

  // 3. Validate the payload.
  let body: ToolRequestBody;
  try {
    body = (await request.json()) as ToolRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isToolId(body.tool)) {
    return Response.json(
      { error: `tool must be one of: report, marketing-plan, competitor-spy, outreach` },
      { status: 400 },
    );
  }
  if (typeof body.url !== "string" || body.url.trim().length === 0) {
    return Response.json({ error: "url is required" }, { status: 400 });
  }
  const spec = TOOLS[body.tool];
  let startUrl: URL;
  try {
    startUrl = normalizeInputUrl(body.url);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid URL" },
      { status: 400 },
    );
  }
  const notes = typeof body.notes === "string" ? body.notes.slice(0, MAX_NOTES_CHARS).trim() : "";

  // 4. Crawl.
  const crawl =
    spec.crawlMode === "site"
      ? await crawlSite(startUrl, { maxPages: spec.maxPages })
      : await crawlSite(startUrl, { maxPages: 1 });
  if (crawl.pages.length === 0) {
    return Response.json(
      {
        error:
          "Could not fetch that page. Check the URL, or the site may block automated fetching.",
      },
      { status: 422 },
    );
  }

  // 5. Stream with provider failover.
  const providers = availableProviders(process.env);
  if (providers.length === 0) {
    return Response.json(
      { error: "No AI provider configured. Set at least one provider API key." },
      { status: 503 },
    );
  }
  const messages: ChatMessageInput[] = [
    { role: "system", content: spec.systemPrompt },
    { role: "user", content: spec.userPrompt(crawl.pages, notes) },
  ];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (event: Record<string, unknown>) => controller.enqueue(sseEvent(event));
      try {
        const { stream: deltas, provider } = await streamWithFailover(providers, messages);
        enqueue({
          type: "meta",
          tool: spec.id,
          provider: provider.id,
          model: provider.model,
          pages: crawl.pages.map((p) => p.url),
          failedPages: crawl.failed,
        });

        let full = "";
        for await (const delta of deltas) {
          full += delta;
          enqueue({ type: "delta", text: delta });
        }

        // 6. Post-generation anti-cliché scan (same rules as chat).
        const scan = scanOutput(full);
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
