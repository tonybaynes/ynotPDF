/**
 * The content-stream acceptance test (M50): every fixture page round-trips byte-identical when
 * nothing changed, and the object scan agrees with PDFium's enumeration object for object.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { objectKindsAgree, parse, scanObjects, serialise } from '@engine/content';
import type { PdfiumEngine } from '@engine/pdfium/PdfiumEngine';
import { engine } from '../engine/helpers';
import { openableFixtures, pageContents } from './helpers';

const fixtures = openableFixtures();

describe('content-stream round trip', () => {
  it('finds fixtures to test', () => {
    expect(fixtures.length).toBeGreaterThan(10);
  });

  for (const f of fixtures) {
    it(`re-serialises every page of ${f.name} byte for byte`, async () => {
      const pages = await pageContents(f.bytes);
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
    it(`enumerates the objects of ${f.name} in PDFium's order`, async () => {
      const pages = await pageContents(f.bytes);
      const doc = pdfium.openSync(f.bytes);
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
