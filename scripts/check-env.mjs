// Build-time env validation (plan §9 Step 0 / §7):
// "zod-based env var validation so build fails fast on any missing key".
// Runs as a `prebuild` script before `next build`. Mirrors lib/env.ts.
import { readFileSync } from "node:fs";
import { z } from "zod";

// Minimal .env.local loader (KEY=VALUE lines, # comments, quoted values) so we
// don't depend on Node-specific --env-file flag availability.
try {
  const raw = readFileSync(".env.local", "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
} catch {
  // .env.local absent — validation below will report exactly what's missing.
}

const envSchema = z.object({
  // Supabase
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  // AI providers (cloud-only per plan §0). DeepSeek is optional — the
  // failover chain skips providers whose key is absent.
  GROQ_API_KEY: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1),
  // Rate limiting (Upstash Redis) — optional: rate limiting degrades to
  // allow-all with a console warning when these are absent.
  UPSTASH_REDIS_REST_URL: z.url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  // Sync token signing
  SYNC_TOKEN_SECRET: z.string().min(32),
  // Cron
  CRON_SECRET: z.string().min(1),
  // Web Push (plan §4 /push) — VAPID keypair; public half is client-exposed
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().min(1),
  VAPID_PRIVATE_KEY: z.string().min(1),
  VAPID_SUBJECT: z.string().optional(),
  // Optional
  SENTRY_DSN: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("\n\u001b[31mEnvironment validation failed. Missing or invalid env vars:\u001b[0m\n");
  for (const issue of parsed.error.issues) {
    console.error(`  \u001b[31m\u2717\u001b[0m ${issue.path.join(".")}: ${issue.message}`);
  }
  console.error(
    "\nCopy .env.example to .env.local and fill in real values." +
      "\nReal keys live in Vercel env vars; never commit them.\n",
  );
  process.exit(1);
}

console.log("\n\u001b[32m\u2713 Environment variables validated (build-time).\u001b[0m\n");
