// Runtime env validation (plan §7: "Env var validation at build time (zod
// schema) — fail fast on missing keys").
//
// The build-time half lives in scripts/check-env.mjs (runs as `prebuild`).
// This module validates at runtime the moment any server route imports it, so
// a missing key can never silently degrade a handler. Keep both schemas in
// sync.
import { z } from "zod";

export const envSchema = z.object({
  // Supabase
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  // AI providers (cloud-only per plan §0)
  GROQ_API_KEY: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  DEEPSEEK_API_KEY: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  // Rate limiting (Upstash Redis)
  UPSTASH_REDIS_REST_URL: z.url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  // Sync token signing
  SYNC_TOKEN_SECRET: z.string().min(32),
  // Cron
  CRON_SECRET: z.string().min(1),
  // Optional
  SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => i.path.join("."))
      .join(", ");
    throw new Error(
      `Environment validation failed (missing or invalid: ${missing}). ` +
        "Copy .env.example to .env.local and fill in real values.",
    );
  }
  return parsed.data;
}

/** Validated server environment. Throws immediately on first access if any required var is missing. */
export const env: Env = parseEnv();

// Re-export only the client-safe values; everything else must never reach the
// browser bundle.
export const publicEnv = {
  supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
  supabaseAnonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
} as const;
