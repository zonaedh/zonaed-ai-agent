// ============================================================================
// Rate limiting (plan §7: required for MVP on every AI-provider-calling route)
//
// Upstash Redis REST fixed-window counter, keyed per user per route. When the
// Upstash env vars are missing/placeholder (e.g. local dev), the limiter
// degrades to an allow-all mode with a single console warning — never throws.
// ============================================================================

const WINDOW_SECONDS = 60;

let warned = false;

function upstashConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || url.includes("placeholder") || token.includes("placeholder")) {
    if (!warned) {
      warned = true;
      console.warn("[rate-limit] Upstash not configured; per-user limits are DISABLED (dev mode).");
    }
    return null;
  }
  return { url: url.replace(/\/$/, ""), token };
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

/**
 * Fixed-window limiter. Returns allowed=false with resetSeconds when the user
 * exceeded `limit` requests in the current window.
 */
export async function checkRateLimit(
  route: string,
  userId: string,
  limit: number,
): Promise<RateLimitResult> {
  const cfg = upstashConfig();
  if (!cfg) return { allowed: true, remaining: limit, resetSeconds: 0 };

  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const key = `ratelimit:${route}:${userId}:${window}`;
  const resetSeconds = WINDOW_SECONDS - Math.floor((Date.now() / 1000) % WINDOW_SECONDS);

  try {
    const res = await fetch(`${cfg.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, String(WINDOW_SECONDS), "NX"],
      ]),
    });
    if (!res.ok) throw new Error(`Upstash ${res.status}`);
    const data = (await res.json()) as { result: number }[];
    const count = data[0]?.result ?? 0;
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetSeconds };
  } catch (err) {
    // Fail-open with visibility: availability beats strict limiting for a
    // single-user app, but the error must be observable.
    console.error("[rate-limit] Upstash call failed, allowing request:", err);
    return { allowed: true, remaining: limit, resetSeconds: 0 };
  }
}
