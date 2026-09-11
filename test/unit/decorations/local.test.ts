/**
 * M53 against Tony's own files (`test/fixtures/local/`, git-ignored).
 *
 * Synthetic fixtures are made by the same code that reads them, so they agree with us by
 * construction. These are real files made by other applications: a boarding pass is a small,
 * awkward page with its own fonts and its own idea of a crop box, and a Foxit-made portfolio is
 * the shape this application will meet most often on Tony's machine.
 *
 * The whole block skips when the folder is empty, so CI and other machines are unaffected.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DocHandle } from '@engine/PdfEngine';
import type { PdfiumEngine } from '@engine/pdfium/PdfiumEngine';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { emptyWritePlan, type PlannedDecoration, type WritePlan } from '@engine/Writer';
import { drawDecoration } from '@engine/decorations/draw';
import { detectLinks } from '@engine/decorations/links';
import {
  DEFAULT_MARGINS,
  type HeaderFooterSpec,
  type PageContext,
} from '@engine/decorations/types';
import { engine, ROOT } from '../engine/helpers';

const LOCAL = join(ROOT, 'test', 'fixtures', 'local');

function localFiles(): string[] {
  if (!existsSync(LOCAL)) return [];
  return readdirSync(LOCAL)
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    .map((name) => join(LOCAL, name));
}

const FILES = localFiles();

let pdfium: PdfiumEngine;

beforeAll(async () => {
  if (FILES.length > 0) pdfium = await engine();
});

const HEADER: HeaderFooterSpec = {
  kind: 'header-footer',
  zones: { 'header-right': 'YNOT <<1 of n>>' },
  font: 'Helvetica',
  size: 8,
  colour: 0x000000,
  margins: DEFAULT_MARGINS,
  underline: false,
  shrink: 0,
  startNumber: 1,
  totalOverride: 0,
};

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

describe.skipIf(FILES.length === 0)('Tony’s own files', () => {
  it('takes a header on every page, saves, and gives it back', async () => {
    for (const path of FILES) {
      const bytes = new Uint8Array(readFileSync(path));
      let doc: DocHandle;
      try {
        doc = pdfium.openSync(bytes);
      } catch {
        // An encrypted or portfolio-only file is not this test's business.
        continue;
      }
      try {
        const count = await pdfium.pageCount(doc);
        const originals: Array<{ content: string; resources: string }> = [];
        const planned: PlannedDecoration[][] = [];
        for (let i = 0; i < count; i++) {
          const size = await pdfium.pageSize(doc, i);
          const content = await pdfium.pageContent(doc, i);
          originals.push({ content: toBase64(content.content), resources: content.resources });
          const page: PageContext = {
            index: i,
            ordinal: i + 1,
            rangeCount: count,
            box: size.cropBox,
            rotation: size.rotation,
            document: {
              fileName: path,
              fullPath: path,
              title: '',
              author: '',
              subject: '',
              pageCount: count,
              labels: [],
              now: '2026-09-11T00:00:00.000Z',
            },
          };
          const { draw } = drawDecoration('d1', HEADER, { page });
          planned.push(draw ? [draw] : []);
          await pdfium.setDecorations(doc, i, draw ? [draw] : []);
        }
        for (let i = 0; i < count; i++) {
          const text = (await pdfium.textRuns(doc, i)).map((r) => r.text).join(' ');
          expect(text, `${path} page ${String(i + 1)}`).toContain(
            `YNOT ${String(i + 1)} of ${String(count)}`,
          );
        }
        const base = await pdfium.save(doc);
        const plan: WritePlan = {
          ...emptyWritePlan(count),
          pages: originals.map((original, i) => ({
            source: i,
            decorations: { original, items: planned[i] ?? [] },
          })),
        };
        const written = await new FullRewriteWriter().write({ bytes: base, plan });
        const re = pdfium.openSync(written.bytes);
        try {
          expect(await pdfium.pageCount(re), path).toBe(count);
          for (let i = 0; i < count; i++) {
            expect(await pdfium.decorations(re, i), `${path} page ${String(i + 1)}`).toHaveLength(
              1,
            );
          }
        } finally {
          await pdfium.close(re);
        }
      } finally {
        await pdfium.close(doc);
      }
    }
  }, 120_000);

  it('finds no nonsense addresses in a real page of text', async () => {
    for (const path of FILES) {
      let doc: DocHandle;
      try {
        doc = pdfium.openSync(new Uint8Array(readFileSync(path)));
      } catch {
        continue;
      }
      try {
        const runs = await pdfium.textRuns(doc, 0);
        for (const candidate of detectLinks(0, runs)) {
          // Whatever it found has to be something a browser could actually open.
          expect(candidate.uri, `${path}: ${candidate.text}`).toMatch(/^(https?:\/\/|mailto:)\S+$/);
          expect(candidate.rect.x1).toBeGreaterThan(candidate.rect.x0);
        }
      } finally {
        await pdfium.close(doc);
      }
    }
  }, 60_000);
});
