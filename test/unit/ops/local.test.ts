/**
 * M41 against the operator's own files (`test/fixtures/local/`, git-ignored).
 *
 * These are real documents with personal data on them, so nothing here reads their text, prints
 * their contents or commits anything: it measures, straightens, combines and splits them and
 * checks the numbers. Every test skips itself when the folder is empty, which is what CI and
 * every other machine sees.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { combine } from '@engine/ops/combine';
import { detectSkew, deskewPages } from '@engine/ops/deskew';
import { split } from '@engine/ops/split';
import { inkBounds, inkRect, cropPages } from '@engine/ops/crop';
import { effectiveBox } from '@engine/ops/pdfdoc';
import type { OpSource, Raster } from '@engine/ops/types';
import { engine } from '../engine/helpers';
import type { PdfiumEngine } from '@engine/pdfium/PdfiumEngine';

const LOCAL = join(process.cwd(), 'test', 'fixtures', 'local');

/** The operator's PDFs, or nothing at all on a machine that has none. */
function localFiles(): string[] {
  if (!existsSync(LOCAL)) return [];
  return readdirSync(LOCAL)
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    .sort();
}

const files = localFiles();
const has = files.length > 0;

async function raster(e: PdfiumEngine, bytes: Uint8Array, page: number): Promise<Raster> {
  const doc = await e.open(bytes);
  try {
    const raw = await e.renderRaw(doc, page, 1.5, undefined, { grayscale: true });
    return { data: raw.rgba, width: raw.width, height: raw.height };
  } finally {
    await e.close(doc);
  }
}

function source(name: string): OpSource {
  return { name, bytes: new Uint8Array(readFileSync(join(LOCAL, name))) };
}

describe.skipIf(!has)("the operator's own files", () => {
  it('measures every page of every one of them, and says something usable about each', async () => {
    const e = await engine();
    for (const name of files) {
      const bytes = source(name).bytes;
      const doc = await e.open(bytes);
      let pages: number;
      try {
        pages = await e.pageCount(doc);
      } finally {
        await e.close(doc);
      }
      for (let page = 0; page < Math.min(pages, 4); page++) {
        const estimate = detectSkew(await raster(e, bytes, page));
        // Whatever it answers, it answers in words and within the range it promises.
        expect(['clear', 'uncertain', 'none']).toContain(estimate.confidence);
        expect(estimate.reason.length).toBeGreaterThan(4);
        expect(Math.abs(estimate.angle)).toBeLessThanOrEqual(15);
        // A page it is sure about must not be reported as leaning a long way: these are ordinary
        // documents, not scans off a desk.
        if (estimate.confidence === 'clear') expect(Math.abs(estimate.angle)).toBeLessThan(10);
      }
    }
  }, 120_000);

  it('straightening one is idempotent: doing it twice changes nothing the second time', async () => {
    const e = await engine();
    const name = files[0];
    if (name === undefined) return;
    const bytes = source(name).bytes;
    const first = detectSkew(await raster(e, bytes, 0));
    if (first.confidence === 'none') return;

    const straightened = await deskewPages(bytes, { angles: { 0: first.angle } });
    const second = detectSkew(await raster(e, straightened.bytes, 0));
    expect(Math.abs(second.angle)).toBeLessThanOrEqual(Math.abs(first.angle) + 0.2);
    expect(Math.abs(second.angle)).toBeLessThanOrEqual(0.3);
  }, 120_000);

  it('combines them all and splits them back to the same page counts', async () => {
    const sources = files.map(source);
    const originals = await Promise.all(
      sources.map(async (s) => (await PDFDocument.load(s.bytes)).getPageCount()),
    );
    const combined = await combine(sources, { bookmarkPerFile: true, keepBookmarks: false });
    expect(combined.pageCount).toBe(originals.reduce((a, b) => a + b, 0));

    const parts = await split(combined.bytes, { rule: { kind: 'bookmarks' }, baseName: 'local' });
    expect(parts.parts.map((p) => p.pages.length)).toEqual(originals);
  }, 120_000);

  it('finds the ink on the first page of each and crops to it without losing any', async () => {
    const e = await engine();
    for (const name of files) {
      const bytes = source(name).bytes;
      const doc = await e.open(bytes);
      let rect;
      try {
        const raw = await e.renderRaw(doc, 0, 1.5);
        const bounds = inkBounds({ data: raw.rgba, width: raw.width, height: raw.height });
        if (!bounds) continue;
        rect = inkRect(bounds, { width: raw.width, height: raw.height }, raw.rect, 4);
      } finally {
        await e.close(doc);
      }
      const page = await PDFDocument.load(bytes);
      const box = effectiveBox(page.getPage(0).node, 'crop');
      // Inside the page, and not the whole of it — every one of these has margins.
      expect(rect.x0).toBeGreaterThanOrEqual(box.x0 - 0.01);
      expect(rect.x1).toBeLessThanOrEqual(box.x1 + 0.01);
      expect(rect.x1 - rect.x0).toBeGreaterThan(1);

      const cropped = await cropPages(bytes, { box: 'crop', rect, pages: [0] });
      const after = effectiveBox((await PDFDocument.load(cropped.bytes)).getPage(0).node, 'crop');
      expect(after.x0).toBeCloseTo(rect.x0, 2);
    }
  }, 120_000);
});
