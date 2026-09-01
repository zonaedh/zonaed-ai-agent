// ============================================================================
// GET /api/push/cron (plan §4 /push, Priority 10; §8 check #5)
//
// Vercel Cron hits this every minute with Authorization: Bearer <CRON_SECRET>.
// Two jobs in one pass:
//
//   1. Reminders — every open task with due_at <= now and reminded_at null
//      gets one push per subscribed device; reminded_at is then stamped so it
//      never double-fires. (Recurring tasks spawn fresh rows on completion,
//      which naturally re-arm the reminder.)
//   2. Digests — users with a push_digest preference (daily/weekly) get a
//      summary of open tasks. Interval-based scheduling (>= 20h for daily,
//      >= 6 days for weekly) so server timezone never shifts the cadence;
//      last-sent watermark lives in the settings table, server-owned row.
// ============================================================================

import { NextResponse, type NextRequest } from "next/server";
import {
  DIGEST_SETTING_KEY,
  DIGEST_STATE_KEY,
  SERVER_SETTINGS_CLIENT_ID,
  digestPayload,
  isDigestFrequency,
  reminderPayload,
} from "@/lib/push/payload";
import { pushAdminClient, sendToUser } from "@/lib/push/send";

export const dynamic = "force-dynamic";

const DAILY_MIN_MS = 20 * 3_600_000;
const WEEKLY_MIN_MS = 6 * 86_400_000;
const REMINDER_BATCH = 100;

function authorize(request: NextRequest): boolean {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const presented = header.slice("Bearer ".length).trim();
  // Constant-time-ish compare without allocating beyond the key length.
  if (presented.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= presented.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

interface DueTaskRow {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  completed: boolean;
}

interface DigestSettingRow {
  user_id: string;
  value: { frequency?: unknown } | null;
}

interface DigestStateRow {
  user_id: string;
  value: { sent_at?: unknown } | null;
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = pushAdminClient();
  const nowIso = new Date().toISOString();
  let remindersSent = 0;
  let digestsSent = 0;

  // ---------------- 1. Task reminders ----------------
  const { data: dueTasks, error: dueErr } = await supabase
    .from("tasks")
    .select("id, user_id, title, notes, due_at")
    .eq("completed", false)
    .is("deleted_at", null)
    .is("reminded_at", null)
    .lte("due_at", nowIso)
    .order("due_at", { ascending: true })
    .limit(REMINDER_BATCH);

  if (dueErr) {
    return NextResponse.json({ error: `Reminder query failed: ${dueErr.message}` }, { status: 502 });
  }

  for (const task of (dueTasks ?? []) as DueTaskRow[]) {
    const { sent } = await sendToUser(
      supabase,
      task.user_id,
      reminderPayload({ title: task.title, due_at: task.due_at, notes: task.notes }),
    );
    if (sent > 0) {
      remindersSent += sent;
      // Dynamic table: supabase-js types the row as `never` — shape is fixed.
      await supabase
        .from("tasks")
        .update({ reminded_at: nowIso } as unknown as never)
        .eq("id", task.id);
    }
  }

  // ---------------- 2. Digests ----------------
  const { data: digestSettings, error: digErr } = await supabase
    .from("settings")
    .select("user_id, value")
    .eq("client_id", SERVER_SETTINGS_CLIENT_ID)
    .eq("key", DIGEST_SETTING_KEY)
    .is("deleted_at", null);

  if (digErr) {
    return NextResponse.json({ error: `Digest query failed: ${digErr.message}` }, { status: 502 });
  }

  const optedIn = ((digestSettings ?? []) as DigestSettingRow[]).filter((row) =>
    isDigestFrequency(row.value?.frequency),
  );
  const userIds = optedIn.map((row) => row.user_id);

  const lastSentByUser = new Map<string, number>();
  const tasksByUser = new Map<string, DueTaskRow[]>();
  if (userIds.length > 0) {
    const { data: states } = await supabase
      .from("settings")
      .select("user_id, value")
      .eq("client_id", SERVER_SETTINGS_CLIENT_ID)
      .eq("key", DIGEST_STATE_KEY)
      .in("user_id", userIds);
    for (const row of (states ?? []) as DigestStateRow[]) {
      const sentAt = typeof row.value?.sent_at === "string" ? Date.parse(row.value.sent_at) : NaN;
      if (Number.isFinite(sentAt)) lastSentByUser.set(row.user_id, sentAt);
    }

    const { data: openTasks } = await supabase
      .from("tasks")
      .select("id, user_id, title, notes, due_at, completed")
      .in("user_id", userIds)
      .eq("completed", false)
      .is("deleted_at", null)
      .limit(1000);
    for (const row of (openTasks ?? []) as DueTaskRow[]) {
      const list = tasksByUser.get(row.user_id) ?? [];
      list.push(row);
      tasksByUser.set(row.user_id, list);
    }
  }

  const now = Date.now();
  for (const setting of optedIn) {
    const frequency = setting.value?.frequency as "daily" | "weekly";
    const last = lastSentByUser.get(setting.user_id) ?? 0;
    const minGap = frequency === "daily" ? DAILY_MIN_MS : WEEKLY_MIN_MS;
    if (now - last < minGap) continue;

    const tasks = tasksByUser.get(setting.user_id) ?? [];
    const { sent } = await sendToUser(supabase, setting.user_id, digestPayload(tasks, frequency));
    if (sent > 0) {
      digestsSent += sent;
      await supabase.from("settings").upsert(
        {
          user_id: setting.user_id,
          client_id: SERVER_SETTINGS_CLIENT_ID,
          key: DIGEST_STATE_KEY,
          value: { sent_at: nowIso, frequency },
        } as unknown as never,
        { onConflict: "user_id,client_id,key" },
      );
    }
  }

  return NextResponse.json({
    ok: true,
    remindersSent,
    digestsSent,
    serverTime: nowIso,
  });
}
