// ============================================================================
// /api/learn/suggestions (plan §5.4, Priority 11) — the review queue API
//
// GET   → the user's suggestions (pending first, then recently resolved).
// POST  → resolve one suggestion:
//   { id, action: "approve", title?, content?, category? }
//     — marks it approved and writes the REAL row server-side:
//         target "memory" → public.memory (source 'learn-review')
//         target "skill"  → public.skills (always-on, version 1, active)
//       The device picks the new row up on its next sync pull.
//   { id, action: "discard" }
//     — marks it discarded. Rows are never hard-deleted.
//
// The client may edit title/content/category before approving (the plan's
// "clear diff" — the original stays on the suggestion row).
// ============================================================================

import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { pushAdminClient } from "@/lib/push/send";

export const dynamic = "force-dynamic";

const MAX_TITLE = 120;
const MAX_CONTENT = 2_000;
const MAX_CATEGORY = 40;

interface SuggestionRow {
  id: string;
  target: string;
  title: string;
  content: string;
  category: string;
  status: string;
  approved_content: string | null;
  approved_title: string | null;
  source_excerpt: string | null;
  day: string;
  created_at: string;
  updated_at: string;
}

function clean(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

export async function GET(request: NextRequest) {
  const auth = requireSession(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const supabase = pushAdminClient();
  const { data, error } = await supabase
    .from("learn_suggestions")
    .select(
      "id, target, title, content, category, status, approved_content, approved_title, source_excerpt, day, created_at, updated_at",
    )
    .eq("user_id", auth.supabaseUserId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: `Suggestion query failed: ${error.message}` }, { status: 502 });
  }

  // The queue wants pending first, then recently resolved, newest on top.
  const rank: Record<string, number> = { pending: 0, approved: 1, discarded: 2 };
  const rows = ((data ?? []) as SuggestionRow[]).sort(
    (a, b) =>
      (rank[a.status] ?? 3) - (rank[b.status] ?? 3) ||
      Date.parse(b.created_at) - Date.parse(a.created_at),
  );
  return NextResponse.json({ suggestions: rows });
}

export async function POST(request: NextRequest) {
  const auth = requireSession(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const limit = await checkRateLimit("learn-review", auth.supabaseUserId, 60);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many review actions — try again shortly." },
      { status: 429 },
    );
  }

  let body: {
    id?: unknown;
    action?: unknown;
    title?: unknown;
    content?: unknown;
    category?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.id !== "string" || body.id.length === 0) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  if (body.action !== "approve" && body.action !== "discard") {
    return NextResponse.json({ error: "action must be approve or discard" }, { status: 400 });
  }

  const supabase = pushAdminClient();

  if (body.action === "discard") {
    const { error } = await supabase
      .from("learn_suggestions")
      .update({ status: "discarded" } as unknown as never)
      .eq("id", body.id)
      .eq("user_id", auth.supabaseUserId)
      .eq("status", "pending");
    if (error) {
      return NextResponse.json({ error: `Discard failed: ${error.message}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true, status: "discarded" });
  }

  // ---------------- approve ----------------
  const { data: found, error: findErr } = await supabase
    .from("learn_suggestions")
    .select("id, target, title, content, category")
    .eq("id", body.id)
    .eq("user_id", auth.supabaseUserId)
    .eq("status", "pending")
    .maybeSingle();
  if (findErr) {
    return NextResponse.json({ error: `Suggestion lookup failed: ${findErr.message}` }, { status: 502 });
  }
  const suggestion = found as
    | { id: string; target: string; title: string; content: string; category: string }
    | null;
  if (!suggestion) {
    return NextResponse.json(
      { error: "Suggestion not found or already resolved" },
      { status: 404 },
    );
  }

  const finalTitle =
    typeof body.title === "string" && body.title.trim() ? clean(body.title, MAX_TITLE) : suggestion.title;
  const finalContent =
    typeof body.content === "string" && body.content.trim()
      ? clean(body.content, MAX_CONTENT)
      : suggestion.content;
  const finalCategory =
    typeof body.category === "string" && body.category.trim()
      ? clean(body.category, MAX_CATEGORY).toLowerCase()
      : suggestion.category;

  // Write the real row first; only mark the suggestion approved on success so
  // a failed insert leaves it pending (retryable, never silently lost).
  if (suggestion.target === "memory") {
    const { error } = await supabase.from("memory").insert({
      user_id: auth.supabaseUserId,
      client_id: crypto.randomUUID(),
      content: finalContent,
      category: finalCategory,
      source: "learn-review",
    } as unknown as never);
    if (error) {
      return NextResponse.json({ error: `Memory write failed: ${error.message}` }, { status: 502 });
    }
  } else {
    const { error } = await supabase.from("skills").insert({
      user_id: auth.supabaseUserId,
      client_id: crypto.randomUUID(),
      title: finalTitle,
      content: finalContent,
      trigger_keywords: [],
      source: "upload",
      version: 1,
      active: true,
    } as unknown as never);
    if (error) {
      return NextResponse.json({ error: `Skill write failed: ${error.message}` }, { status: 502 });
    }
  }

  const { error: updateErr } = await supabase
    .from("learn_suggestions")
    .update(
      {
        status: "approved",
        approved_title: finalTitle,
        approved_content: finalContent,
      } as unknown as never,
    )
    .eq("id", suggestion.id)
    .eq("user_id", auth.supabaseUserId);
  if (updateErr) {
    // The real row exists; only the bookkeeping failed. Non-fatal for the user.
    console.error("[learn] approve bookkeeping failed:", updateErr.message);
  }

  return NextResponse.json({ ok: true, status: "approved", target: suggestion.target });
}

