// ============================================================================
// Browser-side Web Push client (plan §4 /push, Priority 10)
//
// Registers /sw.js, drives the permission flow, and syncs the subscription to
// the server via the session-guarded /api/push/* routes (authedFetch handles
// token mint/refresh).
// ============================================================================

import { authedFetch } from "@/lib/auth/app-session";

export type PushPermissionState = "granted" | "denied" | "default" | "unsupported";

export interface PushState {
  permission: PushPermissionState;
  subscribed: boolean;
}

/** The client-safe VAPID public key (exposed at build time by design). */
function vapidPublicKey(): string {
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!key) {
    throw new Error("NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set — push cannot be configured");
  }
  return key;
}

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  // Explicit ArrayBuffer so the result is Uint8Array<ArrayBuffer>, which is
  // what pushManager's BufferSource parameter type accepts.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service workers are not supported in this browser");
  }
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

/** Current permission + subscription state (null-safe on server render). */
export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return { permission: "unsupported", subscribed: false };
  const permission = Notification.permission as PushPermissionState;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = registration
      ? await registration.pushManager.getSubscription()
      : null;
    return { permission, subscribed: Boolean(subscription) };
  } catch {
    return { permission, subscribed: false };
  }
}

/**
 * Full opt-in flow: request permission -> register SW -> subscribe -> POST
 * the subscription to the server. Throws with a user-presentable message on
 * any failure; the subscription is left local-only if the POST fails.
 */
export async function subscribeToPush(): Promise<PushState> {
  if (!pushSupported()) {
    throw new Error("This browser does not support push notifications");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { permission: permission as PushPermissionState, subscribed: false };
  }

  const registration = await registerServiceWorker();
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey()),
    }));

  const json = subscription.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("Browser returned an incomplete push subscription");
  }

  const res = await authedFetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error || `Subscribe failed with status ${res.status}`);
  }

  return { permission: "granted", subscribed: true };
}

/** Unsubscribe locally and remove the server row. */
export async function unsubscribeFromPush(): Promise<PushState> {
  if (!pushSupported()) return { permission: "unsupported", subscribed: false };
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  if (subscription) {
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await authedFetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }).catch(() => undefined); // local unsubscribe must win even if the server row lingers
  }
  return { permission: Notification.permission as PushPermissionState, subscribed: false };
}

export type DigestChoice = "off" | "daily" | "weekly";

/** Persist the digest opt-in server-side. */
export async function setDigestPreference(frequency: DigestChoice): Promise<void> {
  const res = await authedFetch("/api/push/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ frequency }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error || `Preference update failed with status ${res.status}`);
  }
}
