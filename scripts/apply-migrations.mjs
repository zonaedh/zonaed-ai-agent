// Apply local supabase/migrations/*.sql to the linked remote project via the
// Management API SQL endpoint (token-authenticated, no DB password needed).
// Each file runs once; applied files are recorded in public.schema_migrations,
// so the script is safe to re-run (skips already-applied migrations).
// Usage: SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... node scripts/apply-migrations.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!token || !ref) {
  console.error('Missing SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF');
  process.exit(1);
}

const dir = 'supabase/migrations';

async function runSql(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`SQL failed (${res.status})\n${body}`);
  }
  return body;
}

// Bookkeeping table (idempotent).
await runSql(`create table if not exists public.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);`);

const raw = await runSql(`select version from public.schema_migrations order by version;`);
const parsed = JSON.parse(raw);
// The endpoint returns a bare array of row objects.
const applied = new Set(
  (Array.isArray(parsed) ? parsed : (parsed?.rows ?? [])).map((r) => r.version),
);

// Migrations applied before the bookkeeping table existed — never re-run them.
for (const legacy of ['0001_initial_schema.sql', '0002_sync_tokens.sql']) {
  if (!applied.has(legacy)) {
    await runSql(`insert into public.schema_migrations (version) values ('${legacy}');`);
    applied.add(legacy);
    console.log(`Recorded ${legacy} (applied previously)`);
  }
}

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
let ran = 0;

for (const file of files) {
  if (applied.has(file)) {
    console.log(`Skipping ${file} (already applied)`);
    continue;
  }
  process.stdout.write(`Applying ${file} ... `);
  const sql = readFileSync(join(dir, file), 'utf8');
  await runSql(sql);
  await runSql(`insert into public.schema_migrations (version) values ('${file}');`);
  console.log('OK');
  ran += 1;
}

console.log(`\nApplied ${ran} new migration(s); ${applied.size} already applied.`);
