// ============================================================================
// verify-nice.mts — Priority 12 checks (plan §9 item 12 nice-to-haves:
// voice input, calendar sync, command palette)
//
// Offline suite: exercises the pure RFC 5545 builder/parser round-trip and
// tolerance, the voice speech detection + transcript cleaning, the command
// palette registry (shared with the hub via lib/navigation.ts), and the
// component/pages/package wiring. Run with: npm run verify:nice
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = process.cwd();

let passed = 0;
const TOTAL = 23;
function check(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok ${passed} - ${name}`);
    } catch (err: unknown) {
      console.error(`FAIL - ${name}:`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  })();
}

// ---------------------------------------------------------------- imports --

const ics = await import("../lib/calendar/ics");
const voice = await import("../lib/voice/speech");
import type { SpeechRecognitionEventLike } from "../lib/voice/speech";

const nav = await import("../lib/navigation");

const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// ------------------------------------------------------------------- run --

console.log("\nNice-to-haves (Priority 12)\n");

// ---- calendar: build --------------------------------------------------------

await check("buildIcs: emits a well-formed VCALENDAR", () => {
  const out = ics.buildIcs([
    { clientId: "a1", title: "Ship MVP", dueAt: new Date(Date.UTC(2026, 0, 5, 9, 30)).toISOString() },
  ]);
  assert.ok(out.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(out.includes("\r\nEND:VCALENDAR\r\n"));
  assert.ok(out.includes("VERSION:2.0"));
  assert.ok(out.includes("PRODID:-//Zonaed AI//Tasks v1//EN"));
  assert.ok(out.includes("BEGIN:VEVENT\r\n"));
  assert.ok(out.includes("\r\nEND:VEVENT"));
});

await check("buildIcs: UID is client_id@zonaed.ai and DTSTART is UTC", () => {
  const out = ics.buildIcs([
    { clientId: "abc-123", title: "T", dueAt: new Date(Date.UTC(2026, 0, 5, 9, 30, 5)).toISOString() },
  ]);
  assert.ok(out.includes("UID:abc-123@zonaed.ai"));
  assert.ok(out.includes("DTSTART:20260105T093005Z"));
});

await check("buildIcs: escapes TEXT (backslash, semicolon, comma, newline)", () => {
  const out = ics.buildIcs([{ clientId: "e1", title: "a\\b;c,d\ne", notes: "line1\nline2" }]);
  assert.ok(out.includes("SUMMARY:a\\\\b\\;c\\,d\\ne"));
  assert.ok(out.includes("DESCRIPTION:line1\\nline2"));
});

await check("buildIcs: completed flag becomes STATUS:COMPLETED; TRANSP transparent", () => {
  const out = ics.buildIcs([{ clientId: "c1", title: "Done", completed: true }]);
  assert.ok(out.includes("STATUS:COMPLETED"));
  assert.ok(out.includes("TRANSP:TRANSPARENT"));
});

await check("buildIcs: folds long lines to the 75-octet limit", () => {
  const out = ics.buildIcs([{ clientId: "f1", title: "x".repeat(160) }]);
  for (const line of out.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, `line too long: ${line.length}`);
  }
  assert.ok(out.includes("\r\n ")); // at least one folded continuation
});
// ---- calendar: round-trip + parse tolerance ---------------------------------

await check("parseIcs: round-trips buildIcs output (title/notes/due/uid/completed)", () => {
  const tasks = [
    { clientId: "r1", title: "Round trip", notes: "with ; semicolon, comma", dueAt: new Date(Date.UTC(2026, 5, 15, 12, 0)).toISOString(), completed: false },
    { clientId: "r2", title: "Finished", dueAt: new Date(Date.UTC(2026, 5, 16, 8)).toISOString(), completed: true },
  ];
  const result = ics.parseIcs(ics.buildIcs(tasks));
  assert.equal(result.errors, 0);
  assert.equal(result.events.length, 2);
  const first = result.events[0];
  assert.equal(first.title, "Round trip");
  assert.equal(first.notes, "with ; semicolon, comma");
  assert.equal(first.dueAt, tasks[0].dueAt);
  assert.equal(first.uid, "r1@zonaed.ai");
  assert.equal(first.completed, false);
  assert.equal(result.events[1].completed, true);
});

await check("parseIcs: accepts LF-only input + DATE and floating DATE-TIME", () => {
  const lf = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "SUMMARY:Date only",
    "DTSTART;VALUE=DATE:20260831",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "SUMMARY:Floating",
    "DTSTART:20260901T140000",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\n");
  const result = ics.parseIcs(lf);
  assert.equal(result.errors, 0);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].dueAt, "2026-08-31T00:00:00.000Z");
  assert.equal(result.events[1].dueAt, "2026-09-01T14:00:00.000Z"); // floating = UTC
});

await check("parseIcs: survives malformed input (empty, garbage, missing SUMMARY)", () => {
  assert.deepEqual(ics.parseIcs(""), { events: [], errors: 0 });
  assert.deepEqual(ics.parseIcs("not a calendar"), { events: [], errors: 0 });
  const noSummary = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "DESCRIPTION:no summary here",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const dropped = ics.parseIcs(noSummary);
  assert.equal(dropped.events.length, 0);
  assert.equal(dropped.errors, 1);
});

await check("parseIcs: unfolds folded lines and unescapes TEXT", () => {
  const folded = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "SUMMARY:Visit client",
    "DESCRIPTION:This is a very long description that will definitely exceed the 75 octet",
    "  limitation and should unfold correctly into a single line",
    "DTSTART:20261010T100000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const result = ics.parseIcs(folded);
  assert.equal(result.events.length, 1);
  assert.equal(
    result.events[0].notes,
    "This is a very long description that will definitely exceed the 75 octet limitation and should unfold correctly into a single line",
  );
});

await check("parseIcs: unescapes third-party \\n and handles comma/semicolon", () => {
  const input = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "SUMMARY:Q3 review",
    "DESCRIPTION:Prepare deck\\nBring data\\; latest numbers, charts",
    "DTSTART:20261120T090000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const result = ics.parseIcs(input);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].notes, "Prepare deck\nBring data; latest numbers, charts");
});
// ---- voice ----------------------------------------------------------------

await check("speech: not supported when window-like is absent (Node)", () => {
  assert.equal(voice.speechSupported(undefined), false);
});

await check("speech: supported when SpeechRecognition or webkit variant exists", () => {
  assert.equal(voice.speechSupported({ SpeechRecognition: class {} }), true);
  assert.equal(voice.speechSupported({ webkitSpeechRecognition: class {} }), true);
});

await check("speech: cleanTranscript collapses whitespace and capitalizes", () => {
  assert.equal(voice.cleanTranscript("  call   john  "), "Call john");
  assert.equal(voice.cleanTranscript(""), "");
  assert.equal(voice.cleanTranscript("   "), "");
});

await check("speech: startListening wires result/end through a fake engine", () => {
  let resultText = "";
  const fake = {
    SpeechRecognition: class {
      lang = "";
      interimResults = false;
      maxAlternatives = 1;
      continuous = false;
      onresult: ((e: SpeechRecognitionEventLike) => void) | null = null;
      onerror: ((e: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        // Fire a final result then end.
        this.onresult?.({
          resultIndex: 0,
          results: {
            length: 1,
            0: { isFinal: true, 0: { transcript: "  call   mike " } },
          },
        } as unknown as SpeechRecognitionEventLike);
        this.onend?.();
      }
      stop() {}
      abort() {}
    },
  } as unknown as Record<string, unknown>;
  const session = voice.startListening(
    { onResult: (t) => { resultText = t; }, lang: "en-US" },
    fake,
  );
  assert.equal(session.supported, true);
  assert.equal(resultText, "Call mike");
});

await check("speech: startListening reports unsupported gracefully without throwing", () => {
  let err = "";
  const session = voice.startListening(
    { onResult: () => {}, onError: (m) => { err = m; } },
    undefined,
  );
  assert.equal(session.supported, false);
  assert.ok(err.includes("not supported"));
});

// ---- wiring ----------------------------------------------------------------

await check("layout mounts CommandPalette once", () => {
  const source = read("app/layout.tsx");
  assert.ok(source.includes("<CommandPalette />"));
  assert.ok(source.includes('import CommandPalette from "./components/CommandPalette"'));
});

await check("hub uses NAV_LINKS (single source) and hints Ctrl/⌘+K", () => {
  const source = read("app/page.tsx");
  assert.ok(source.includes("import { NAV_LINKS } from \"@/lib/navigation\""));
  assert.ok(source.includes("NAV_LINKS.map"));
  assert.ok(source.includes("Ctrl/⌘ + K"));
});

await check("tasks page wires VoiceButton + CalendarTools", () => {
  const source = read("app/tasks/page.tsx");
  assert.ok(source.includes("import VoiceButton from \"@/app/components/VoiceButton\""));
  assert.ok(source.includes("import CalendarTools from \"@/app/components/CalendarTools\""));
  assert.ok(source.includes("<VoiceButton onResult="));
  assert.ok(source.includes("<CalendarTools />"));
});

await check("VoiceButton degrades: disabled + explanatory title when unsupported", () => {
  const source = read("app/components/VoiceButton.tsx");
  assert.ok(source.includes("speechSupported()"));
  assert.ok(source.includes("disabled={disabled || !supported}"));
  assert.ok(source.includes("Voice input not supported in this browser"));
});

await check("CalendarTools export/import uses buildIcs/parseIcs/createTask", () => {
  const source = read("app/components/CalendarTools.tsx");
  assert.ok(source.includes("buildIcs"));
  assert.ok(source.includes("parseIcs"));
  assert.ok(source.includes("createTask"));
  assert.ok(source.includes("accept=\".ics,text/calendar\""));
  assert.ok(source.includes("zonaed-tasks.ics"));
});

await check("package.json registers verify:nice", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.["verify:nice"], "tsx scripts/verify-nice.mts");
});

// ---- command palette -------------------------------------------------------

await check("palette: buildPaletteItems covers every NAV_LINKS route + 2 actions", () => {
  const items = nav.buildPaletteItems((href) => { void href; });
  const navHrefs = items.map((i) => i.hint ?? i.id);
  for (const link of nav.NAV_LINKS) {
    assert.ok(navHrefs.includes(link.href), `palette missing ${link.href}`);
    assert.ok(items.some((i) => i.label === link.title), `palette missing label ${link.title}`);
  }
  assert.equal(items.some((i) => i.id === "new-task"), true);
  assert.equal(items.some((i) => i.id === "home"), true);
  assert.ok(items.length === nav.NAV_LINKS.length + 2);
});

await check("palette: component registers Ctrl/Cmd+K and arrow/enter/escape keys", () => {
  const source = read("app/components/CommandPalette.tsx");
  assert.ok(source.includes("(e.ctrlKey || e.metaKey)"));
  assert.ok(source.includes("e.key.toLowerCase() === \"k\""));
  assert.ok(source.includes("ArrowDown"));
  assert.ok(source.includes("ArrowUp"));
  assert.ok(source.includes("\"Enter\""));
  assert.ok(source.includes("\"Escape\""));
});

// ------------------------------------------------------------------- done --

if (process.exitCode) {
  console.error(`\n${passed}/${TOTAL} nice-to-have checks passed (FAILURES above)`);
} else {
  console.log(`\n${passed}/${TOTAL} nice-to-have checks passed`);
}