/**
 * Generates a PLACEHOLDER app icon (`resources/build/icon.png`, 512x512) so installers build
 * on every OS (WiX refuses an MSI without one). electron-builder derives `.ico` and `.icns`
 * from this PNG. Replace with the operator's real logo (PLAN.md §10.1) — M131.
 *
 * Design: dark rounded square, a light document sheet with a folded corner, and a bold
 * accent-blue "Y". Colours here are icon pixels, not UI chrome, so the theme-token rule does
 * not apply. Usage: `node scripts/make-icon.ts`
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

type Rgba = [number, number, number, number];

const SIZE = 512;
const BG: Rgba = [0x23, 0x23, 0x26, 255];
const SHEET: Rgba = [0xf2, 0xf2, 0xf2, 255];
const FOLD: Rgba = [0xc8, 0xc8, 0xcc, 255];
const ACCENT: Rgba = [0x4d, 0xa3, 0xff, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

const px = new Uint8Array(SIZE * SIZE * 4);

function set(x: number, y: number, c: Rgba): void {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const o = (y * SIZE + x) * 4;
  px[o] = c[0];
  px[o + 1] = c[1];
  px[o + 2] = c[2];
  px[o + 3] = c[3];
}

function fill(test: (x: number, y: number) => boolean, c: Rgba): void {
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (test(x, y)) set(x, y, c);
}

/** Rounded rectangle membership. */
function inRoundRect(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
): boolean {
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  const cx = x < x0 + r ? x0 + r : x >= x1 - r ? x1 - r - 1 : x;
  const cy = y < y0 + r ? y0 + r : y >= y1 - r ? y1 - r - 1 : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Distance from point to segment, for thick strokes. */
function segDist(px0: number, py0: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px0 - ax) * dx + (py0 - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px0 - (ax + t * dx), py0 - (ay + t * dy));
}

// 1. transparent canvas, dark rounded square
fill(() => true, CLEAR);
fill((x, y) => inRoundRect(x, y, 16, 16, SIZE - 16, SIZE - 16, 96), BG);

// 2. document sheet with folded top-right corner
const sx0 = 136;
const sy0 = 88;
const sx1 = 376;
const sy1 = 424;
const foldSize = 64;
fill(
  (x, y) =>
    inRoundRect(x, y, sx0, sy0, sx1, sy1, 12) &&
    !(x >= sx1 - foldSize && y < sy0 + foldSize && x - (sx1 - foldSize) > y - sy0),
  SHEET,
);
fill(
  (x, y) =>
    x >= sx1 - foldSize &&
    x < sx1 &&
    y >= sy0 &&
    y < sy0 + foldSize &&
    x - (sx1 - foldSize) <= y - sy0 &&
    y - sy0 <= foldSize - 1 &&
    x - (sx1 - foldSize) >= 0 &&
    x - (sx1 - foldSize) > y - sy0 - foldSize,
  FOLD,
);

// 3. bold "Y"
const stroke = 30;
const cxm = (sx0 + sx1) / 2;
const top = 150;
const mid = 268;
const bottom = 372;
fill(
  (x, y) =>
    segDist(x, y, cxm - 66, top, cxm, mid) <= stroke ||
    segDist(x, y, cxm + 66, top, cxm, mid) <= stroke ||
    segDist(x, y, cxm, mid, cxm, bottom) <= stroke,
  ACCENT,
);

// 4. encode PNG (RGBA, 8-bit)
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  px.subarray(y * SIZE * 4, (y + 1) * SIZE * 4).forEach((v, i) => {
    raw[y * (SIZE * 4 + 1) + 1 + i] = v;
  });
}
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
const crc32 = (buf: Buffer): number => {
  let c = -1;
  for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = join(process.cwd(), 'resources', 'build');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'icon.png');
writeFileSync(out, png);
console.info(`make-icon: wrote ${out} (${png.length} bytes)`);
