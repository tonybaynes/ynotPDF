/**
 * Engine benchmarks (M10, ADR 0006). Runs only with `YNOT_BENCH=1` (`npm run bench`); the
 * documents are generated on the fly with pdf-lib so nothing large is committed.
 *
 * Targets from the M10 brief: a 300-dpi A4 scan page and a vector-heavy CAD page must render
 * their 1× DPR tile set (512-px tiles) in < 150 ms; `textRuns` on a 500-page text document must
 * average < 30 ms per page.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { PdfiumEngine } from '@engine/pdfium/PdfiumEngine';
import { engine } from './helpers';

const RUN = process.env['YNOT_BENCH'] === '1';
const A4: [number, number] = [595.28, 841.89];

function grayPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number,
): Uint8Array {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = pixel(x, y);
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
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 6 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

async function scanDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const w = 2480;
  const h = 3508;
  let seed = 3;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const rows: Array<{ y: number; words: Array<[number, number]> }> = [];
  for (let y = 300; y < h - 300; y += 70) {
    const words: Array<[number, number]> = [];
    let x = 250;
    while (x < w - 300) {
      const len = 60 + Math.floor(rnd() * 220);
      words.push([x, x + len]);
      x += len + 36;
    }
    rows.push({ y, words });
  }
  const png = grayPng(w, h, (x, y) => {
    for (const row of rows) {
      if (y >= row.y && y < row.y + 28) {
        for (const [x0, x1] of row.words)
          if (x >= x0 && x < x1) return (x * 3 + y) % 11 === 0 ? 60 : 20;
      }
    }
    return (x * 7 + y * 13) % 53 === 0 ? 215 : 246;
  });
  const img = await doc.embedPng(png);
  doc.addPage(A4).drawImage(img, { x: 0, y: 0, width: A4[0], height: A4[1] });
  return doc.save({ useObjectStreams: false });
}

async function cadDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  let seed = 11;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 20000; i++) {
    const x = 20 + rnd() * (A4[0] - 40);
    const y = 20 + rnd() * (A4[1] - 40);
    page.drawLine({
      start: { x, y },
      end: { x: x + (rnd() - 0.5) * 60, y: y + (rnd() - 0.5) * 60 },
      thickness: 0.3 + rnd() * 1.2,
      color: rgb(rnd() * 0.3, rnd() * 0.3, rnd() * 0.6),
    });
  }
  for (let i = 0; i < 400; i++) {
    page.drawCircle({ x: rnd() * A4[0], y: rnd() * A4[1], size: 2 + rnd() * 30, borderWidth: 0.5 });
  }
  return doc.save({ useObjectStreams: false });
}

async function textDoc(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const para =
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut ' +
    'labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco ' +
    'laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in ' +
    'voluptate velit esse cillum dolore eu fugiat nulla pariatur.';
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage(A4);
    page.drawText(`Chapter ${Math.floor(p / 10) + 1} · Page ${p + 1}`, {
      x: 72,
      y: 780,
      size: 16,
      font: bold,
    });
    let y = 740;
    for (let i = 0; i < 6 && y > 80; i++) {
      page.drawText(para, { x: 72, y, size: 10.5, font, maxWidth: A4[0] - 144, lineHeight: 13 });
      y -= 13 * 8 + 10;
    }
  }
  return doc.save({ useObjectStreams: false });
}

interface Timing {
  readonly name: string;
  readonly ms: number;
  readonly target?: number;
  readonly detail?: string;
}

async function tileSet(
  e: PdfiumEngine,
  doc: Parameters<PdfiumEngine['renderRaw']>[0],
): Promise<number> {
  // 512-px tiles at scale 1 covering the page, like M11's tiler will request them.
  const size = e.pageSizeSync(doc, 0);
  const geo = e.pageGeometry(doc, 0);
  const t0 = performance.now();
  for (let ty = 0; ty < Math.ceil(size.height / 512); ty++) {
    for (let tx = 0; tx < Math.ceil(size.width / 512); tx++) {
      const rect = geo.rectToPage({ x: tx * 512, y: ty * 512, width: 512, height: 512 }, 1);
      await e.renderRaw(doc, 0, 1, rect);
    }
  }
  return performance.now() - t0;
}

async function median(n: number, fn: () => Promise<number>): Promise<number> {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(await fn());
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)] ?? 0;
}

describe.skipIf(!RUN)('engine benchmarks', () => {
  it('records render and text-extraction timings', async () => {
    const e = await engine();
    const timings: Timing[] = [];

    const scanBytes = await scanDoc();
    let t0 = performance.now();
    const scan = e.openSync(scanBytes);
    timings.push({
      name: 'open 300-dpi scan',
      ms: performance.now() - t0,
      detail: `${scanBytes.byteLength} bytes`,
    });
    await e.renderRaw(scan, 0, 1); // warm (image decode is cached by PDFium)
    timings.push({
      name: 'scan: 1× tile set (4 × 512 px)',
      ms: await median(5, () => tileSet(e, scan)),
      target: 150,
    });
    t0 = performance.now();
    await e.renderRaw(scan, 0, 2);
    timings.push({ name: 'scan: full page at 2×', ms: performance.now() - t0 });
    await e.close(scan);

    const cadBytes = await cadDoc();
    t0 = performance.now();
    const cad = e.openSync(cadBytes);
    timings.push({
      name: 'open CAD page (20k lines)',
      ms: performance.now() - t0,
      detail: `${cadBytes.byteLength} bytes`,
    });
    await e.renderRaw(cad, 0, 1);
    timings.push({
      name: 'CAD: 1× tile set (4 × 512 px)',
      ms: await median(5, () => tileSet(e, cad)),
      target: 150,
    });
    t0 = performance.now();
    const objs = await e.pageObjects(cad, 0);
    timings.push({
      name: 'CAD: pageObjects',
      ms: performance.now() - t0,
      detail: `${objs.length} objects`,
    });
    await e.close(cad);

    const textBytes = await textDoc(500);
    t0 = performance.now();
    const text = e.openSync(textBytes);
    timings.push({
      name: 'open 500-page text doc',
      ms: performance.now() - t0,
      detail: `${textBytes.byteLength} bytes`,
    });
    t0 = performance.now();
    let runs = 0;
    for (let p = 0; p < 500; p++) runs += e.textRunsSync(text, p).length;
    const perPage = (performance.now() - t0) / 500;
    timings.push({
      name: 'textRuns per page (500-page avg)',
      ms: perPage,
      target: 30,
      detail: `${runs} runs`,
    });
    t0 = performance.now();
    await e.renderRaw(text, 250, 1);
    timings.push({ name: 'text page: full page at 1×', ms: performance.now() - t0 });
    t0 = performance.now();
    await e.pageLabels(text);
    timings.push({ name: 'pageLabels (500 pages)', ms: performance.now() - t0 });
    await e.close(text);

    const lines = timings.map(
      (t) =>
        `| ${t.name} | ${t.ms.toFixed(1)} ms | ${t.target ? `< ${t.target} ms ${t.ms < t.target ? '✓' : '✗'}` : ''} | ${t.detail ?? ''} |`,
    );
    const table = ['| Measurement | Result | Target | Notes |', '|---|---|---|---|', ...lines].join(
      '\n',
    );
    console.info(
      `\nEngine benchmark (${process.platform} ${process.arch}, node ${process.version}, fonts: ${e.fontCount})\n${table}\n`,
    );
    const outDir = join(process.cwd(), 'docs', 'bench');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, `engine-${process.platform}-${process.arch}.json`),
      `${JSON.stringify({ date: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, fonts: e.fontCount, timings }, null, 2)}\n`,
    );
    for (const t of timings) if (t.target) expect(t.ms, t.name).toBeLessThan(t.target);
  }, 300_000);
});
