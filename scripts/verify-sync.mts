// ============================================================================
// Live E2E sync verification (plan §9 Priority 2)
//
// Runs the REAL sync engine (lib/sync/engine.ts) against the REAL Supabase
// project, with IndexedDB emulated in Node via fake-indexeddb. Exits non-zero
// on any failure. Safe to re-run (uses unique client_ids + cleans up).
//
// Usage: SUPABASE_URL=... SUPABASE_ANON_KEY=... npx tsx scripts/verify-sync.ts
// ============================================================================
import "fake-indexeddb/auto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getDb } from "../lib/db/client";
import { newClientId, putLocal, softDeleteLocal, getLive, listLive } from "../lib/db/repo";
import { syncAll, resolveLww, pullTable } from "../lib/sync/engine";
import type { TaskRow } from "../lib/db/types";

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  console.error("Set SUPABASE_URL and SUPABASE_ANON_KEY");
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const supabase: SupabaseClient = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Distinct anonymous users per run → clean slate, no cross-run interference.
const { data: signed, error: signErr } = await supabase.auth.signInAnonymously();
if (signErr || !signed.session) {
  console.error(`Anonymous sign-in failed: ${signErr?.message}`);
  process.exit(1);
}
const userId = signed.session.user.id;
console.log(`Signed in anonymously: ${userId}\n`);

const db = getDb();

// ---------------------------------------------------------------------------
console.log("1) Push: local insert reaches Supabase with its own updated_at");
// ---------------------------------------------------------------------------
const t1 = newClientId();
const at1 = new Date(Date.now() - 60_000).toISOString();
// putLocal always stamps updated_at = now (real user edits) — capture what was
// actually stored, since that is what the sync engine will push.
const stored1 = await putLocal<TaskRow>("tasks", {
  client_id: t1,
  title: "verify-sync task",
  completed: false,
  updated_at: at1,
  created_at: at1,
});
const storedAt1 = stored1.updated_at;
const r1 = await syncAll(db, supabase, userId);
check("syncAll completed", r1.tables.length === 6);
const pushed = r1.tables.find((t) => t.table === "tasks");
check("task pushed", (pushed?.pushed ?? 0) >= 1, JSON.stringify(pushed));
const { data: remote1 } = await supabase
  .from("tasks")
  .select("*")
  .eq("user_id", userId)
  .eq("client_id", t1)
  .maybeSingle();
check("row exists remotely", !!remote1);
check(
  "remote updated_at preserved (LWW timestamp survived trigger)",
  !!remote1 && Date.parse(remote1.updated_at) === Date.parse(storedAt1),
  `remote=${remote1?.updated_at} local=${storedAt1}`,
);
check("row marked clean after push", (await db.tasks.get(t1))?.dirty === 0);

// ---------------------------------------------------------------------------
console.log("\n2) Pull: remote edit flows back into Dexie");
// ---------------------------------------------------------------------------
// Simulate a second device editing AFTER the local write: wait, then update
// remotely with a real "now" (strictly newer than the local stamp → wins LWW).
await new Promise((r) => setTimeout(r, 1_200));
const at2 = new Date().toISOString();
const { error: upErr } = await supabase
  .from("tasks")
  .update({ title: "edited remotely", updated_at: at2 })
  .eq("user_id", userId)
  .eq("client_id", t1);
check("remote update accepted", !upErr, upErr?.message);
check("remote edit is strictly newer than local write", Date.parse(at2) > Date.parse(storedAt1));
await pullTable(db, supabase, "tasks");
const local1 = (await db.tasks.get(t1)) as TaskRow;
check("local picked up remote edit", local1.title === "edited remotely", local1.title);
// Postgres returns "+00:00" offsets, local produces "Z" — compare epoch ms.
check("local timestamp updated", Date.parse(local1.updated_at) === Date.parse(at2), local1.updated_at);

// ---------------------------------------------------------------------------
console.log("\n3) Conflict: stale local push loses to newer remote (LWW)");
// ---------------------------------------------------------------------------
check("LWW: newer remote wins", resolveLww({ client_id: "a", updated_at: at1 }, { client_id: "a", updated_at: at2 }) === "remote");
check("LWW: newer local wins", resolveLww({ client_id: "a", updated_at: at2 }, { client_id: "a", updated_at: at1 }) === "local");

const t2 = newClientId();
const staleAt = new Date(Date.now() - 120_000).toISOString();
// Must be strictly newer than the last pull watermark (~at2), otherwise the
// pull window won't include it. Use real "now" — later than any prior op.
const freshAt = new Date().toISOString();
// Remote has freshAt; local has a stale dirty edit with staleAt.
const { error: seedErr } = await supabase.from("tasks").upsert(
  { user_id: userId, client_id: t2, title: "remote version", updated_at: freshAt },
  { onConflict: "user_id,client_id" },
);
check("conflict seed row created", !seedErr, seedErr?.message);
await db.tasks.put({
  client_id: t2, title: "stale local edit", completed: false,
  created_at: staleAt, updated_at: staleAt, dirty: 1,
} as TaskRow);
const before = (await db.tasks.get(t2)) as TaskRow;
await pullTable(db, supabase, "tasks");
const after = (await db.tasks.get(t2)) as TaskRow;
check("remote (newer) won the conflict", after.title === "remote version", after.title);
check("stale local row marked clean", after.dirty === 0);
const archived = await db.conflict_archive.where("client_id").equals(t2).toArray();
check("losing version archived, not dropped", archived.length === 1 && (archived[0].losing as { title: string }).title === before.title);
check("archive stores winning payload too", (archived[0]?.winning as { title: string })?.title === "remote version");

// ---------------------------------------------------------------------------
console.log("\n4) Tombstones: soft delete propagates both ways");
// ---------------------------------------------------------------------------
await softDeleteLocal("tasks", t1);
await syncAll(db, supabase, userId);
const { data: remoteDeleted } = await supabase
  .from("tasks")
  .select("deleted_at")
  .eq("user_id", userId)
  .eq("client_id", t1)
  .maybeSingle();
check("tombstone reached remote", !!remoteDeleted?.deleted_at);
check("getLive hides deleted row", (await getLive<TaskRow>("tasks", t1)) === null);
check("listLive hides deleted row", !(await listLive<TaskRow>("tasks")).some((r) => r.client_id === t1));

// ---------------------------------------------------------------------------
console.log("\n5) Cross-user isolation (RLS): another user cannot see these rows");
// ---------------------------------------------------------------------------
const second = createClient(url, anonKey, { auth: { persistSession: false } });
const { data: s2 } = await second.auth.signInAnonymously();
check("second anonymous user signed in", !!s2.session);
const { data: foreign } = await second
  .from("tasks")
  .select("client_id")
  .eq("client_id", t1);
check("second user sees zero of user-1 rows", (foreign ?? []).length === 0);

// ---------------------------------------------------------------------------
console.log("\n6) Cleanup (hard-delete own rows via RLS, then sign out)");
// ---------------------------------------------------------------------------
const { error: delErr } = await supabase.from("tasks").delete().eq("user_id", userId);
check("self-cleanup allowed", !delErr, delErr?.message);
await supabase.auth.signOut();

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
