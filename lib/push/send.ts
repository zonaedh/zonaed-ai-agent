// ============================================================================
// Server-side Web Push sender (plan §4 /push, Priority 10)
//
// Wraps the `web-push` library with the VAPID keys from env, and owns
// endpoint hygiene: 404/410 responses mean the subscription is dead (browser
// rotated keys, user cleared site data, endpoint expired) and the row is
// deleted so the cron stops retrying it forever.
// ============================================================================

import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";
import type { PushPayload } from "./payload";

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

let configured: boolean | null = null;

function ensureVapidConfigured(): void {
  if (configured) return;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    throw new Error("Web Push is not configured (NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)");
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:push@zonaed-ai.local",
    publicKey,
    privateKey,
  );
  configured = true;
}

/** Service-role client for cron/sender use — always filter by user_id. */
export function pushAdminClient(): ReturnType<typeof createClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Server not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface SendResult {
  ok: boolean;
  /** true when the endpoint is permanently gone and the row was removed. */
  expired?: boolean;
  error?: string;
}

export async function sendToSubscription(
  subscription: PushSubscriptionRow,
  payload: PushPayload,
): Promise<SendResult> {
  ensureVapidConfigured();
  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      { TTL: 24 * 60 * 60 },
    );
    return { ok: true };
  } catch (err: unknown) {
    const statusCode =
      typeof err === "object" && err !== null && "statusCode" in err
        ? Number((err as { statusCode: unknown }).statusCode)
        : NaN;
    if (statusCode === 404 || statusCode === 410) {
      return { ok: false, expired: true, error: `endpoint ${statusCode}` };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "push send failed",
    };
  }
}

/**
 * Send a payload to every subscription of one user, deleting dead endpoints.
 * Returns how many sends were attempted/accepted.
 */
export async function sendToUser(
  supabase: ReturnType<typeof pushAdminClient>,
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; removed: number }> {
  const { data: subs, error } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_id", userId);
  if (error || !subs || subs.length === 0) return { sent: 0, removed: 0 };

  let sent = 0;
  const dead: string[] = [];
  await Promise.all(
    (subs as PushSubscriptionRow[]).map(async (sub) => {
      const result = await sendToSubscription(sub, payload);
      if (result.ok) sent += 1;
      if (result.expired) dead.push(sub.endpoint);
    }),
  );
  if (dead.length > 0) {
    await supabase
      .from("push_subscriptions")
      .delete()
      .eq("user_id", userId)
      .in("endpoint", dead);
  }
  return { sent, removed: dead.length };
}
