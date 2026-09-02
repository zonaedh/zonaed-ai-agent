// ============================================================================
// Sentry instrumentation (plan §7: "Sentry (or equivalent) wired up before
// launch"). Next 16 App Router:
//   * instrumentation.ts   — server side (register + onRequestError)
//   * instrumentation-client.ts — browser side
//
// Both are no-ops unless SENTRY_DSN is configured, so local dev / preview
// builds without a DSN never initialize the SDK or send events.
// ============================================================================
import * as Sentry from "@sentry/nextjs";

export async function register() {
  const dsn = process.env.SENTRY_DSN;
  if (dsn) {
    Sentry.init({
      dsn,
      // Session-traces + errors, no replays (keeps payloads lean for a PWA).
      tracesSampleRate: 0.1,
      // Never send user PII by default; the app stores user data locally.
      sendDefaultPii: false,
    });
  }
}

export const onRequestError = Sentry.captureRequestError;