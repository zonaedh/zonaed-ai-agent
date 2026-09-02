// ============================================================================
// Sentry browser instrumentation. No-op without NEXT_PUBLIC_SENTRY_DSN
// (mirrors the server half in instrumentation.ts — server uses SENTRY_DSN).
// Only NEXT_PUBLIC_* vars reach the browser bundle, hence the public key.
// ============================================================================
import * as Sentry from "@sentry/nextjs";

export function register() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (dsn) {
    Sentry.init({
      dsn,
      tracesSampleRate: 0.1,
      sendDefaultPii: false,
    });
  }
}