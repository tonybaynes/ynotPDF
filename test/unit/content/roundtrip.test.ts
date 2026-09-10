/**
 * The content-stream acceptance test (M50): every fixture page round-trips byte-identical when
 * nothing changed, and the object scan agrees with PDFium's enumeration object for object.
 *
 * The external corpus (pdf.js regression files, fetched in CI) includes encrypted and damaged
 * files that pdf-lib cannot decode or PDFium cannot open without a password. Those have nothing
 * for the parser to prove — the writer never sees a stream pdf-lib could not read — and are
 * reported as skipped rather than failed.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { objectKindsAgree, parse, scanObjects, serialise } from '@engine/content';
import { EngineError, type DocHandle } from '@engine/PdfEngine';
import type { PdfiumEngine } from '@engine/pdfium/PdfiumEngine';
import { engine } from '../engine/helpers';
import { openableFixtures, pageContents } from './helpers';

const fixtures = openableFixtures();

/** Opens a fixture, or returns null for one that needs a password or will not open. */
function tryOpen(pdfium: PdfiumEngine, bytes: Uint8Array): DocHandle | null {
  try {
    return pdfium.openSync(bytes);
  } catch (error) {
    if (error instanceof EngineError) return null;
    throw error;
  }
}

describe('content-stream round trip', () => {
  it('finds fixtures to test', () => {
    expect(fixtures.length).toBeGreaterThan(10);
  });

  for (const f of fixtures) {
    it(`re-serialises every page of ${f.name} byte for byte`, async (ctx) => {
      const pages = await pageContents(f.bytes);
      if (!pages) {
        ctx.skip();
        return;
      }
      for (const content of pages) {
        const stream = parse(content);
        expect(serialise(stream, stream.ops)).toEqual(content);
      }
    });
  }
});

describe('object scan agrees with PDFium', () => {
  let pdfium: PdfiumEngine;
  beforeAll(async () => {
    pdfium = await engine();
  });

  for (const f of fixtures) {
    it(`enumerates the objects of ${f.name} in PDFium's order`, async (ctx) => {
      const pages = await pageContents(f.bytes);
      const doc = pages ? tryOpen(pdfium, f.bytes) : null;
      if (!pages || doc === null) {
        ctx.skip();
        return;
      }
      try {
        const count = await pdfium.pageCount(doc);
        for (let p = 0; p < Math.min(count, pages.length); p++) {
          const content = pages[p];
          if (!content) continue;
          const stream = parse(content);
          const scan = scanObjects(stream.ops);
          const objects = await pdfium.pageObjects(doc, p);
          const kinds = objects.map((o) => o.kind);
          const ours = scan.objects.map((o) => o.kind);
          expect(
            objectKindsAgree(scan.objects, kinds),
            `${f.name} page ${p + 1}: ours ${ours.join(',')} vs PDFium ${kinds.join(',')}`,
          ).toBe(true);
        }
      } finally {
        await pdfium.close(doc);
      }
    });
  }
});
