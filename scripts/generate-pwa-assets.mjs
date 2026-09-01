// ============================================================================
// generate-pwa-assets.mjs
// Zero-dependency PNG asset generator for the PWA (plan section 6 PWA + priority 5:
// "iOS PWA fixes - viewport-fit=cover, split icon purposes, splash screens").
//
// Produces:
//   public/icons/icon-192.png          (manifest, purpose "any")
//   public/icons/icon-512.png          (manifest, purpose "any")
//   public/icons/icon-512-maskable.png (manifest, purpose "maskable" - a
//                                        SEPARATE entry; never combined with
//                                        "any" per plan section 9 rule 3)
//   public/apple-touch-icon.png        (iOS home-screen 180x180, opaque)
//   public/splash/*.png                (iOS apple-touch-startup-image per device)
//   lib/pwa-splash.ts                  (static media-query table for head links)
// ============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ICON_DIR = join(ROOT, "public", "icons");
const SPLASH_DIR = join(ROOT, "public", "splash");
const LIB_DIR = join(ROOT, "lib");

const BG = [15, 23, 42]; // slate-900 #0f172a
const ACCENT = [16, 185, 129]; // emerald-500 #10b981
const ACCENT_WHITE = [52, 211, 153]; // emerald-400 #34d399

// ---------------------------------------------------------------------------
// Minimal PNG encoder (8-bit RGBA, filter 0)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function penChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgba) {
  const buf = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    buf.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, penChunk("IHDR", ihdr), penChunk("IDAT", idat), penChunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Drawing helpers (canvas = { w, h, data: Uint8Array(w*h*4) })
// ---------------------------------------------------------------------------
function makeCanvas(w, h) {
  return { w, h, data: new Uint8Array(w * h * 4) };
}

function setPx(c, x, y, color) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  c.data[i] = color[0];
  c.data[i + 1] = color[1];
  c.data[i + 2] = color[2];
  c.data[i + 3] = color.length > 3 ? color[3] : 255;
}

function fillRect(c, x0, y0, x1, y1, color) {
  for (let y = Math.max(0, y0); y <= Math.min(c.h - 1, y1); y++)
    for (let x = Math.max(0, x0); x <= Math.min(c.w - 1, x1); x++) setPx(c, x, y, color);
}

function fillCircle(c, cx, cy, r, color) {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(c.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(c.h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) setPx(c, x, y, color);
}

function fillRoundedRect(c, x0, y0, x1, y1, radius, color) {
  const r = Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2);
  fillRect(c, x0 + r, y0, x1 - r, y1, color);
  fillRect(c, x0, y0 + r, x1, y1 - r, color);
  fillCircle(c, x0 + r, y0 + r, r, color);
  fillCircle(c, x1 - r, y0 + r, r, color);
  fillCircle(c, x0 + r, y1 - r, r, color);
  fillCircle(c, x1 - r, y1 - r, r, color);
}

function drawLine(c, x0, y0, x1, y1, thickness, color) {
  const r = Math.max(1, Math.round(thickness / 2));
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)) * 2);
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    fillCircle(c, Math.round(x0 + (x1 - x0) * f), Math.round(y0 + (y1 - y0) * f), r, color);
  }
}

/** Draw a clean "Z" monogram centered at (cx, cy), overall square `size`. */
function drawZ(c, cx, cy, size, thickness, color) {
  const half = size / 2, t2 = thickness / 2;
  drawLine(c, cx - half, cy - half + t2, cx + half, cy - half + t2, thickness, color);
  drawLine(c, cx + half, cy - half + t2, cx - half, cy + half - t2, thickness, color);
  drawLine(c, cx - half, cy + half - t2, cx + half, cy + half - t2, thickness, color);
}

// ---------------------------------------------------------------------------
// Icon recipes
// ---------------------------------------------------------------------------
function iconAny(size) {
  const c = makeCanvas(size, size);
  fillRoundedRect(c, 0, 0, size - 1, size - 1, Math.round(size * 0.2), BG);
  const glyph = Math.round(size * 0.52);
  drawZ(c, size / 2 - 0.5, size / 2 - 0.5, glyph, Math.max(6, Math.round(size * 0.09)), ACCENT);
  return encodePng(size, size, c.data);
}

function iconAnyNoRound(size) {
  const c = makeCanvas(size, size);
  fillRect(c, 0, 0, size - 1, size - 1, BG);
  const glyph = Math.round(size * 0.5);
  drawZ(c, size / 2 - 0.5, size / 2 - 0.5, glyph, Math.max(6, Math.round(size * 0.09)), ACCENT_WHITE);
  return encodePng(size, size, c.data);
}

/** Maskable: full-bleed background, glyph inside the 80% "safe zone" circle. */
function iconMaskable(size) {
  const c = makeCanvas(size, size);
  fillRect(c, 0, 0, size - 1, size - 1, BG);
  const safe = size * 0.8; // safe-zone diameter
  const glyph = Math.round(safe * 0.55);
  drawZ(c, size / 2 - 0.5, size / 2 - 0.5, glyph, Math.max(8, Math.round(glyph * 0.17)), ACCENT_WHITE);
  return encodePng(size, size, c.data);
}

function splash(w, h) {
  const c = makeCanvas(w, h);
  fillRect(c, 0, 0, w - 1, h - 1, BG);
  const glyph = Math.round(Math.min(w, h) * 0.22);
  drawZ(c, w / 2 - 0.5, h / 2 - 0.5, glyph, Math.max(12, Math.round(glyph * 0.16)), ACCENT_WHITE);
  return encodePng(w, h, c.data);
}

// ---------------------------------------------------------------------------
// Splash device table: [pixelW, pixelH, deviceWidthPx, deviceHeightPx, scale]
// The media query uses CSS px device-width/height + -webkit-device-pixel-ratio.
// ---------------------------------------------------------------------------
const SPLASHES = [
  [640, 1136, 320, 568, 2], // iPhone SE (1st gen)
  [750, 1334, 375, 667, 2], // iPhone 8 / SE (2nd/3rd gen)
  [828, 1792, 414, 896, 2], // iPhone XR / 11
  [1125, 2436, 375, 812, 3], // iPhone X / XS / 11 Pro
  [1242, 2688, 414, 896, 3], // iPhone XS Max / 11 Pro Max
  [1170, 2532, 390, 844, 3], // iPhone 12 / 12 Pro / 13 / 13 Pro / 14
  [1284, 2778, 428, 926, 3], // iPhone 12 Pro Max / 13 Pro Max / 14 Plus
  [1179, 2556, 393, 852, 3], // iPhone 14 Pro
  [1284, 2796, 430, 932, 3], // iPhone 14 Pro Max
  [1536, 2048, 768, 1024, 2], // iPad 3rd-4th gen / Air / mini 2-4
  [1668, 2224, 834, 1112, 2], // iPad Pro 10.5" / Air (3rd gen)
  [1668, 2388, 834, 1194, 2], // iPad Pro 11" (1st-4th gen)
  [2048, 2732, 1024, 1366, 2], // iPad Pro 12.9" (1st-6th gen)
  [1620, 2160, 810, 1080, 2], // iPad 10.2" (7th-9th gen) / 10.9" (10th gen)
  [1640, 2360, 820, 1180, 2], // iPad Air 4/5 / 10.9"
  [1488, 2266, 744, 1133, 2], // iPad mini 6
];

function mediaFor(row) {
  return `(device-width: ${row[2]}px) and (device-height: ${row[3]}px) and (-webkit-device-pixel-ratio: ${row[4]})`;
}

// ---------------------------------------------------------------------------
// Build everything
// ---------------------------------------------------------------------------
function build() {
  mkdirSync(ICON_DIR, { recursive: true });
  mkdirSync(SPLASH_DIR, { recursive: true });
  mkdirSync(LIB_DIR, { recursive: true });

  writeFileSync(join(ICON_DIR, "icon-192.png"), iconAny(192));
  writeFileSync(join(ICON_DIR, "icon-512.png"), iconAny(512));
  writeFileSync(join(ICON_DIR, "icon-512-maskable.png"), iconMaskable(512));
  writeFileSync(join(ROOT, "public", "apple-touch-icon.png"), iconAnyNoRound(180));

  const splashRows = [];
  for (const row of SPLASHES) {
    const name = `splash-${row[0]}x${row[1]}.png`;
    writeFileSync(join(SPLASH_DIR, name), splash(row[0], row[1]));
    splashRows.push({ href: `/splash/${name}`, media: mediaFor(row) });
  }

  // Static table the app head imports (keeps generator <-> markup in sync).
  const ts = [
    "// Generated by scripts/generate-pwa-assets.mjs - do not edit by hand.",
    "// iOS apple-touch-startup-image media-query table (portrait launch screens).",
    "export type SplashEntry = { href: string; media: string };",
    `export const SPLASHES: SplashEntry[] = ${JSON.stringify(splashRows, null, 2)};`,
    "",
  ].join("\n");
  writeFileSync(join(LIB_DIR, "pwa-splash.ts"), ts);

  console.log(`Generated ${SPLASHES.length} splash screens, 4 icons, and lib/pwa-splash.ts`);
}

build();