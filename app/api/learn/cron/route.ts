// ============================================================================
// GET /api/learn/cron (plan §5.4, Priority 11)
//
// Vercel Cron hits this daily (see vercel.json) with
// Authorization: Bearer <CRON_SECRET>. For every user with the "Learn from my
// chat history" opt-in ON (settings table, server-owned row):
//
//   1. Pick completed UTC days not yet processed (watermark
//      settings[learn_last_day]), oldest first, bounded to a 3-day lookback.
//   2. Pull that day's chat_history rows (filtered by user_id; the service
//      role is only used server-side, never exposed).
//   3. Send a capped transcript through the SAME provider failover stack as
//      /api/chat (plan §5.4) asking for durable-fact candidates as JSON.
//   4. Validate/sanitize (lib/learn/extract), dedupe against existing
//      memory/skills, and insert into learn_suggestions with status 'pending'.
//
// Nothing is ever auto-applied: candidates wait in the /memory review queue
// until the user approves, edits, or discards each one (plan §5.4, §7 #8).
//
// Abuse controls (plan §7): CRON_SECRET gate, ≤10 users per run, one LLM call
// per user per day, 3-day bounded catch-up, 30k-char transcript cap.
// ============================================================================

import { NextResponse, type NextRequest } from "next/server";
import {
  LEARN_SETTING_KEY,
  LEARN_STATE_KEY,
  buildExtractionMessages,
  dedupeCandidates,
  parseSuggestions,
  pendingDays,
  utcDayBounds,
  type LearnChatMessage,
} from "@/lib/learn/extract";
import { completeWithFailover, availableProviders } from "@/lib/ai/providers";
import { pushAdminClient } from "@/lib/push/send";
import { SERVER_SETTINGS_CLIENT_ID } from "@/lib/push/payload";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_USERS_PER_RUN = 10;
const MAX_MESSAGES_PER_DAY = 400;

function authorize(request: NextRequest): boolean {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const presented = header.slice("Bearer ".length).trim();
  if (presented.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= presented.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

interface OptInRow {
  user_id: string;
}
interface StateRow {
  user_id: string;
  value: { day?: unknown } | null;
}
interface ChatRow {
  session_id: string;
  role: string;
  content: string;
  created_at: string;
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = pushAdminClient();
  const providers = availableProviders(process.env as Record<string, string>);
  if (providers.length === 0) {
    return NextResponse.json({ error: "No AI provider configured" }, { status: 503 });
  }

  const nowMs = Date.now();

  // ---------------- opted-in users + watermarks ----------------
  const { data: optIns, error: optErr } = await supabase
    .from("settings")
    .select("user_id")
    .eq("client_id", SERVER_SETTINGS_CLIENT_ID)
    .eq("key", LEARN_SETTING_KEY)
    .is("deleted_at", null);
  if (optErr) {
    return NextResponse.json({ error: `Opt-in query failed: ${optErr.message}` }, { status: 502 });
  }
  const users = ((optIns ?? []) as OptInRow[])
    .map((r) => r.user_id)
    .slice(0, MAX_USERS_PER_RUN);
  if (users.length === 0) {
    return NextResponse.json({ ok: true, usersProcessed: 0, suggestions: 0 });
  }

  const { data: states } = await supabase
    .from("settings")
    .select("user_id, value")
    .eq("client_id", SERVER_SETTINGS_CLIENT_ID)
    .eq("key", LEARN_STATE_KEY)
    .in("user_id", users);
  const watermark = new Map<string, string | null>();
  for (const row of (states ?? []) as StateRow[]) {
    watermark.set(
      row.user_id,
      typeof row.value?.day === "string" ? (row.value.day as string) : null,
    );
  }

  // ---------------- existing knowledge for dedupe ----------------
  const { data: existingMemory } = await supabase
    .from("memory")
    .select("content")
    .in("user_id", users)
    .is("deleted_at", null)
    .limit(2000);
  const { data: existingSkills } = await supabase
    .from("skills")
    .select("content")
    .in("user_id", users)
    .is("deleted_at", null)
    .limit(1000);
  const knownTexts = [
    ...((existingMemory ?? []) as { content: string }[]).map((r) => r.content),
    ...((existingSkills ?? []) as { content: string }[]).map((r) => r.content),
  ];

  let suggestionsCreated = 0;
  const failures: string[] = [];

  for (const userId of users) {
    const days = pendingDays(watermark.get(userId) ?? null, nowMs);
    try {
      for (const day of days) {
        const bounds = utcDayBounds(day);
        const { data: rows, error } = await supabase
          .from("chat_history")
          .select("session_id, role, content, created_at")
          .eq("user_id", userId)
          .is("deleted_at", null)
          .gte("created_at", bounds.start)
          .lt("created_at", bounds.end)
          .order("created_at", { ascending: true })
          .limit(MAX_MESSAGES_PER_DAY);
        if (error) throw new Error(`chat_history query failed: ${error.message}`);

        const messages = (rows ?? []) as ChatRow[];
        if (messages.length === 0) {
          // Nothing to learn from — still stamp the watermark so the day is
          // not rescanned tomorrow.
          await stampDay(supabase, userId, day);
          continue;
        }

        const learned: LearnChatMessage[] = messages.map((m) => ({
          role: m.role,
          content: m.content,
          created_at: m.created_at,
        }));
        const { text } = await completeWithFailover(providers, buildExtractionMessages(learned));
        const candidates = dedupeCandidates(parseSuggestions(text), knownTexts);

        if (candidates.length > 0) {
          const inserts = candidates.map((c) => ({
            user_id: userId,
            target: c.target,
            title: c.title,
            content: c.content,
            category: c.category,
            source_excerpt: c.excerpt,
            day,
          }));
          const { error: insertErr } = await supabase
            .from("learn_suggestions")
            .insert(inserts as unknown as never);
          if (insertErr) throw new Error(`suggestion insert failed: ${insertErr.message}`);
          suggestionsCreated += candidates.length;
          knownTexts.push(...candidates.map((c) => c.content));
        }

        await stampDay(supabase, userId, day);
      }
    } catch (err) {
      // Leave the watermark at the last good day; the next run retries.
      failures.push(`${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return NextResponse.json({
    ok: failures.length === 0,
    usersProcessed: users.length,
    suggestions: suggestionsCreated,
    failures: failures.length > 0 ? failures : undefined,
    serverTime: new Date().toISOString(),
  });
}

/** Watermark upsert — dynamic table, supabase-js types the row as `never`. */
async function stampDay(
  supabase: ReturnType<typeof pushAdminClient>,
  userId: string,
  day: string,
): Promise<void> {
  await supabase.from("settings").upsert(
    {
      user_id: userId,
      client_id: SERVER_SETTINGS_CLIENT_ID,
      key: LEARN_STATE_KEY,
      value: { day, at: new Date().toISOString() },
    } as unknown as never,
    { onConflict: "user_id,client_id,key" },
  );
}

