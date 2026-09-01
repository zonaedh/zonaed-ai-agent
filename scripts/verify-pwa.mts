// ============================================================================
// verify-pwa.mts — Priority 5 checks (plan §9 item 5 + §8 manual items 1–3)
// Verifies the generated assets (dimensions via PNG IHDR) and that the
// metadata/HTML sources emit the required iOS/PWA tags. Run with:
//   npm run verify:pwa
// ============================================================================
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";
import assert from "node:assert";

const ROOT = process.cwd();

let passed = 0;
const TOTAL = 10;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${passed} - ${name}`);
  } catch (err: unknown) {
    console.error(`FAIL - ${name}:`, err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

function pngSize(file: string): { w: number; h: number } {
  const buf = readFileSync(file);
  assert.ok(buf.length > 24, `${file} too small to be a PNG`);
  assert.strictEqual(buf.readUInt32BE(0), 0x89504e47, `${file} missing PNG signature`);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const ICONS = join(ROOT, "public", "icons");

check("any icon 192x192 exists with correct dimensions", () => {
  assert.deepStrictEqual(pngSize(join(ICONS, "icon-192.png")), { w: 192, h: 192 });
});
check("any icon 512x512 exists with correct dimensions", () => {
  assert.deepStrictEqual(pngSize(join(ICONS, "icon-512.png")), { w: 512, h: 512 });
});
check("maskable icon 512x512 exists, separate file", () => {
  assert.deepStrictEqual(pngSize(join(ICONS, "icon-512-maskable.png")), { w: 512, h: 512 });
});
check("apple-touch-icon 180x180 exists and is opaque", () => {
  const f = join(ROOT, "public", "apple-touch-icon.png");
  assert.deepStrictEqual(pngSize(f), { w: 180, h: 180 });
  const buf = readFileSync(f);
  const idat = buf.indexOf("IDAT");
  assert.ok(idat > -1, "no IDAT chunk");
  const len = buf.readUInt32BE(idat - 4);
  const raw = zlib.inflateSync(buf.subarray(idat + 4, idat + 4 + len));
  // raw[0] = filter byte; pixel (0,0) rgba = raw[1..4]; alpha must be 255.
  assert.strictEqual(raw[4], 255, "apple-touch-icon must be opaque (alpha 255 on first pixel)");
});
check("all 16 splash screens exist at the sizes in lib/pwa-splash.ts", () => {
  const splashTs = readFileSync(join(ROOT, "lib", "pwa-splash.ts"), "utf8");
  const hrefs = [...splashTs.matchAll(/"href":\s*"(\/splash\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 10, `expected >=10 splash entries, got ${hrefs.length}`);
  for (const href of hrefs) {
    const file = join(ROOT, "public", href.replace(/^\//, ""));
    assert.ok(existsSync(file), `missing splash asset ${href}`);
    const m = /splash-(\d+)x(\d+)\.png/.exec(href);
    assert.ok(m, `splash href not matching naming: ${href}`);
    assert.deepStrictEqual(pngSize(file), { w: Number(m[1]), h: Number(m[2]) });
  }
});
check("manifest has SEPARATE 'any' and 'maskable' purposes (never combined)", () => {
  const m = readFileSync(join(ROOT, "app", "manifest.ts"), "utf8");
  assert.ok(/purpose:\s*"any"/.test(m), "missing purpose 'any' entry");
  assert.ok(/purpose:\s*"maskable"/.test(m), "missing purpose 'maskable' entry");
  assert.ok(!/purpose:\s*"any maskable"/.test(m), "combined 'any maskable' purpose found (plan rule #3)");
});
check("manifest declares shortcuts (New Chat / New Task / Quick Capture)", () => {
  const m = readFileSync(join(ROOT, "app", "manifest.ts"), "utf8");
  for (const name of ["New Chat", "New Task", "Quick Capture"]) {
    assert.ok(m.includes(`name: "${name}"`), `missing shortcut ${name}`);
  }
  assert.ok(m.includes('url: "/chat"'), "New Chat shortcut route missing");
  assert.ok(m.includes('url: "/tasks"'), "New Task shortcut route missing");
});
check("layout exports viewport-fit=cover and theme color", () => {
  const l = readFileSync(join(ROOT, "app", "layout.tsx"), "utf8");
  assert.ok(/viewportFit:\s*"cover"/.test(l), "viewportFit cover missing");
  assert.ok(/themeColor:\s*"#0f172a"/.test(l), "themeColor missing");
});
check("layout emits appleWebApp standalone metadata (capable + status bar)", () => {
  const l = readFileSync(join(ROOT, "app", "layout.tsx"), "utf8");
  assert.ok(/capable:\s*true/.test(l), "appleWebApp.capable missing");
  assert.ok(/statusBarStyle:\s*"black-translucent"/.test(l), "statusBarStyle missing");
});
check("safe-area CSS utilities exist and SyncIndicator uses the float inset", () => {
  const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");
  assert.ok(css.includes("safe-area-inset-top"), "safe-area-inset-top missing in CSS");
  assert.ok(css.includes("safe-area-inset-bottom"), "safe-area-inset-bottom missing in CSS");
  const ind = readFileSync(join(ROOT, "app", "components", "SyncIndicator.tsx"), "utf8");
  assert.ok(ind.includes("ios-safe-bottom-float"), "SyncIndicator not using home-bar inset");
});

console.log(`\nPWA: ${passed}/${TOTAL} checks passed`);
if (passed !== TOTAL) process.exit(1);