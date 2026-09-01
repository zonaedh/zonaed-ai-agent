// ============================================================================
// Tasks verification (plan §4 /tasks + §9 priority 8)
//   1. Pure recurrence engine — deterministic UTC dates, no I/O.
//   2. Task repo over Dexie — fake-indexeddb (same trick as verify-sync).
// Run: npm run verify:tasks
// ============================================================================
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  describeRecurrence,
  isRecurrenceRule,
  nextOccurrence,
  parseRecurrence,
  type RecurrenceRule,
} from "../lib/tasks/recurrence";

let passed = 0;
const TOTAL = 21;

// Sequential chain — repo checks share one fake-indexeddb, order matters.
let chain: Promise<void> = Promise.resolve();
function check(name: string, fn: () => void | Promise<void>): void {
  chain = chain.then(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok ${passed} - ${name}`);
    } catch (err: unknown) {
      console.error(`  FAIL - ${name}:`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });
}

/** Deterministic UTC anchor. */
const utc = (isoStr: string) => new Date(isoStr);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

// ---------------------------------------------------------------------------
// 1. Recurrence engine (pure)
// ---------------------------------------------------------------------------
check("rule: validation accepts good shapes, rejects bad", () => {
  assert.ok(isRecurrenceRule({ freq: "daily" }));
  assert.ok(isRecurrenceRule({ freq: "weekly", weekdays: [1, 3], interval: 2 }));
  assert.ok(isRecurrenceRule({ freq: "monthly", dayOfMonth: 31 }));
  assert.ok(isRecurrenceRule({ freq: "yearly", month: 2, dayOfMonth: 29, until: "2030-01-01T00:00:00.000Z" }));
  assert.ok(!isRecurrenceRule({ freq: "hourly" }));
  assert.ok(!isRecurrenceRule({ freq: "daily", interval: 0 }));
  assert.ok(!isRecurrenceRule({ freq: "daily", weekdays: [1] })); // weekdays are weekly-only
  assert.ok(!isRecurrenceRule({ freq: "weekly", weekdays: [] }));
  assert.ok(!isRecurrenceRule({ freq: "weekly", weekdays: [7] }));
  assert.ok(!isRecurrenceRule({ freq: "monthly", dayOfMonth: 32 }));
  assert.ok(!isRecurrenceRule({ freq: "daily", until: "not-a-date" }));
  assert.ok(!isRecurrenceRule(null));
  assert.equal(parseRecurrence("junk"), null);
  assert.ok(parseRecurrence({ freq: "daily" }));
});

check("daily: next day, same time of day", () => {
  assert.equal(iso(nextOccurrence({ freq: "daily" }, utc("2026-09-01T10:00:00.000Z"))), "2026-09-02T10:00:00.000Z");
});

check("daily interval=2 + strictly-after anchor on occurrence", () => {
  assert.equal(
    iso(nextOccurrence({ freq: "daily", interval: 2 }, utc("2026-09-01T10:00:00.000Z"))),
    "2026-09-03T10:00:00.000Z",
  );
  const next = nextOccurrence({ freq: "daily" }, utc("2026-09-01T10:00:00.000Z")) as Date;
  assert.notEqual(iso(next), "2026-09-01T10:00:00.000Z", "must never return the anchor itself");
  assert.ok(next.getTime() > utc("2026-09-01T10:00:00.000Z").getTime());
});

check("weekly without weekdays: +7 days per interval", () => {
  assert.equal(iso(nextOccurrence({ freq: "weekly" }, utc("2026-09-01T09:30:00.000Z"))), "2026-09-08T09:30:00.000Z");
  assert.equal(
    iso(nextOccurrence({ freq: "weekly", interval: 2 }, utc("2026-09-01T09:30:00.000Z"))),
    "2026-09-15T09:30:00.000Z",
  );
});

check("weekly weekdays [Mon,Wed,Fri]: Fri -> Mon, same-day anchor -> next week", () => {
  const next = nextOccurrence({ freq: "weekly", weekdays: [1, 3, 5] }, utc("2026-09-04T16:00:00.000Z")); // Friday
  assert.equal((next as Date).getUTCDay(), 1, "next must be Monday");
  assert.equal(iso(next), "2026-09-07T16:00:00.000Z");
  assert.equal(
    iso(nextOccurrence({ freq: "weekly", weekdays: [2] }, utc("2026-09-01T10:00:00.000Z"))), // Tuesday
    "2026-09-08T10:00:00.000Z",
  );
});

check("monthly dayOfMonth=31: clamps to Feb 28 (2026), then Mar 31", () => {
  const rule: RecurrenceRule = { freq: "monthly", dayOfMonth: 31 };
  assert.equal(iso(nextOccurrence(rule, utc("2026-01-31T12:00:00.000Z"))), "2026-02-28T12:00:00.000Z");
  assert.equal(iso(nextOccurrence(rule, utc("2026-02-28T12:00:00.000Z"))), "2026-03-31T12:00:00.000Z");
});

check("monthly default day = anchor day; interval=3 crosses months", () => {
  assert.equal(iso(nextOccurrence({ freq: "monthly" }, utc("2026-02-10T08:00:00.000Z"))), "2026-03-10T08:00:00.000Z");
  assert.equal(
    iso(nextOccurrence({ freq: "monthly", interval: 3 }, utc("2026-01-15T08:00:00.000Z"))),
    "2026-04-15T08:00:00.000Z",
  );
});

check("yearly: leap-day anchor clamps to Feb 28 in common years", () => {
  assert.equal(iso(nextOccurrence({ freq: "yearly" }, utc("2024-02-29T00:00:00.000Z"))), "2025-02-28T00:00:00.000Z");
  assert.equal(
    iso(nextOccurrence({ freq: "yearly", month: 7, dayOfMonth: 4 }, utc("2026-01-01T00:00:00.000Z"))),
    "2026-07-04T00:00:00.000Z",
  );
});

check("until: schedule exhausts to null", () => {
  assert.equal(
    iso(nextOccurrence({ freq: "daily", until: "2026-09-02T00:00:00.000Z" }, utc("2026-09-01T10:00:00.000Z"))),
    null,
    "next day is past until",
  );
  assert.equal(
    iso(nextOccurrence({ freq: "daily", until: "2026-09-02T12:00:00.000Z" }, utc("2026-09-01T10:00:00.000Z"))),
    "2026-09-02T10:00:00.000Z",
  );
});

check("engine: bad anchor / bad rule -> null, never throws", () => {
  assert.equal(nextOccurrence({ freq: "daily" }, "garbage"), null);
  assert.equal(nextOccurrence(undefined as unknown as RecurrenceRule, utc("2026-09-01T10:00:00.000Z")), null);
});

check("describeRecurrence: human labels", () => {
  assert.equal(describeRecurrence({ freq: "daily" }), "Every day");
  assert.equal(describeRecurrence({ freq: "weekly", interval: 2, weekdays: [1, 5] }), "Every 2 weeks on Mon, Fri");
  assert.equal(describeRecurrence({ freq: "monthly", dayOfMonth: 15 }), "Every month on day 15");
  assert.equal(describeRecurrence({ freq: "yearly", month: 2, dayOfMonth: 29 }), "Every year on 2/29");
  assert.equal(describeRecurrence("junk" as unknown as RecurrenceRule), "Custom");
});

// ---------------------------------------------------------------------------
// 2. Task repo over fake-indexeddb
// ---------------------------------------------------------------------------
import { getDb } from "../lib/db/client";
import { getLive } from "../lib/db/repo";
import {
  completeTask,
  createTask,
  deleteTask,
  listCompletedTasks,
  listOpenTasks,
  rescheduleTask,
  setTaskCompleted,
} from "../lib/tasks/repo";

const DAY_MS = 86_400_000;

check("repo: createTask stores fields, stamps dirty, stays open", async () => {
  await getDb().tasks.clear();
  const row = await createTask({
    title: "  Client follow-up  ",
    notes: "Send the proposal",
    dueAt: "2026-09-05T10:00:00.000Z",
    recurrence: { freq: "weekly", weekdays: [5] },
  });
  assert.equal(row.title, "Client follow-up");
  assert.equal(row.completed, false);
  assert.equal(row.dirty, 1);
  assert.ok(row.client_id);
  assert.equal(row.recurrence?.freq, "weekly");
  const stored = await getDb().tasks.get(row.client_id);
  assert.ok(stored, "persisted to Dexie");
});

check("repo: createTask rejects empty title, bad recurrence, bad due date", async () => {
  await assert.rejects(createTask({ title: "   " }), /title/i);
  await assert.rejects(createTask({ title: "x", recurrence: { freq: "hourly" } as never }), /recurrence/i);
  await assert.rejects(createTask({ title: "x", dueAt: "not-a-date" }), /due/i);
});

check("repo: completeTask one-off — completes, never spawns", async () => {
  const t = await createTask({ title: "One-off" });
  const before = await getDb().tasks.count();
  const result = await completeTask(t.client_id);
  assert.equal(result.completed.completed, true);
  assert.ok(result.completed.completed_at);
  assert.equal(result.next, undefined);
  assert.equal(await getDb().tasks.count(), before, "no spawn for one-off");
});

check("repo: completeTask recurring — spawns next occurrence as a NEW row", async () => {
  const due = new Date(Date.now() + 10 * DAY_MS); // future due -> anchors the spawn
  const t = await createTask({ title: "Daily report", dueAt: due.toISOString(), recurrence: { freq: "daily" } });
  const result = await completeTask(t.client_id);
  assert.ok(result.next, "recurring completion must spawn");
  const next = result.next!;
  assert.notEqual(next.client_id, t.client_id);
  assert.equal(next.completed, false);
  assert.equal(next.recurrence?.freq, "daily");
  assert.equal(next.title, "Daily report");
  const expected = due.getTime() + DAY_MS;
  assert.ok(Math.abs(Date.parse(next.due_at as string) - expected) < 2000, "spawn due = old due + 1 day");
  const original = await getDb().tasks.get(t.client_id);
  assert.equal(original?.completed, true, "finished occurrence kept as history");
});

check("repo: completeTask is idempotent — no double spawn", async () => {
  const t = await createTask({ title: "Twice-safe", dueAt: new Date(Date.now() + DAY_MS).toISOString(), recurrence: { freq: "daily" } });
  await completeTask(t.client_id);
  const count = await getDb().tasks.count();
  await completeTask(t.client_id); // completing again must not spawn again
  assert.equal(await getDb().tasks.count(), count);
});

check("repo: completeTask with exhausted until — stays completed, no spawn", async () => {
  const t = await createTask({
    title: "Ended series",
    recurrence: { freq: "daily", until: "2000-01-01T00:00:00.000Z" },
  });
  const count = await getDb().tasks.count();
  const result = await completeTask(t.client_id);
  assert.equal(result.next, undefined);
  assert.equal(await getDb().tasks.count(), count);
  const row = await getDb().tasks.get(t.client_id);
  assert.equal(row?.completed, true);
});

check("repo: rescheduleTask sets/clears due_at and stamps dirty", async () => {
  const t = await createTask({ title: "Flexible" });
  const moved = await rescheduleTask(t.client_id, "2026-10-01T09:00:00.000Z");
  assert.equal(moved.due_at, "2026-10-01T09:00:00.000Z");
  assert.equal(moved.dirty, 1);
  const cleared = await rescheduleTask(t.client_id, null);
  assert.equal(cleared.due_at, undefined);
  assert.equal(cleared.dirty, 1);
  await assert.rejects(rescheduleTask(t.client_id, "junk"), /due/i);
});

check("repo: setTaskCompleted(false) reopens and clears completed_at", async () => {
  const t = await createTask({ title: "Reopenable" });
  await setTaskCompleted(t.client_id, true);
  const reopened = await setTaskCompleted(t.client_id, false);
  assert.equal(reopened.completed, false);
  assert.equal(reopened.completed_at, undefined);
});

check("repo: deleteTask tombstones — getLive null, row survives", async () => {
  const t = await createTask({ title: "Doomed" });
  await deleteTask(t.client_id);
  assert.equal(await getLive("tasks", t.client_id), null);
  const raw = await getDb().tasks.get(t.client_id);
  assert.ok(raw?.deleted_at, "tombstone kept locally (plan §3)");
});

check("repo: listOpenTasks/listCompletedTasks filter + sort", async () => {
  await getDb().tasks.clear();
  await createTask({ title: "Past due", dueAt: "2026-01-01T00:00:00.000Z" });
  await createTask({ title: "Future due", dueAt: new Date(Date.now() + 30 * DAY_MS).toISOString() });
  await createTask({ title: "No due" });
  const doneOne = await createTask({ title: "Finished" });
  await setTaskCompleted(doneOne.client_id, true);
  await createTask({ title: "Deleted one", dueAt: "2025-06-01T00:00:00.000Z" }).then((t) => deleteTask(t.client_id));

  const open = await listOpenTasks();
  assert.ok(!open.some((t) => t.completed || t.deleted_at), "open excludes completed/deleted");
  assert.ok(!open.some((t) => t.title === "Deleted one"), "tombstoned row must not appear");
  assert.ok(open.some((t) => t.title === "Past due"), "past-due still open until completed");
  const dated = open.filter((t) => t.due_at);
  for (let i = 1; i < dated.length; i++) {
    assert.ok(Date.parse(dated[i - 1].due_at as string) <= Date.parse(dated[i].due_at as string), "open sorted by due");
  }
  const done = await listCompletedTasks();
  assert.deepEqual(done.map((t) => t.title), ["Finished"]);
});

// ---------------------------------------------------------------------------
await chain;
console.log(`\n${passed}/${TOTAL} tasks checks passed`);
if (passed !== TOTAL) process.exit(1);