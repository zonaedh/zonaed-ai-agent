// One-off: apply local supabase/migrations/*.sql to the linked remote project
// via the Management API SQL endpoint (token-authenticated, no DB password).
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
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

for (const file of files) {
  const sql = readFileSync(join(dir, file), 'utf8');
  process.stdout.write(`Applying ${file} ... `);
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`FAILED (${res.status})\n${body}`);
    process.exit(1);
  }
  console.log('OK');
}

console.log(`\nApplied ${files.length} migration(s).`);
