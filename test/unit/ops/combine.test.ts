/**
 * Combine (M41). The acceptance line is "combine the whole fixture corpus → page count equals
 * sum; bookmarks per file present"; the rest of this file is the arithmetic that line depends on
 * and the behaviours a corpus-wide count would not notice — page ranges, page-size normalisation
 * and what happens when one of forty files is rubbish.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { bookmarkTitle, combine } from '@engine/ops/combine';
import { effectiveBox, readOutline } from '@engine/ops/pdfdoc';
import { OpCancelled, OpFailed, type OpSource } from '@engine/ops/types';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

function fixture(name: string): OpSource {
  return { name, bytes: new Uint8Array(readFileSync(join(FIXTURES, name))) };
}

async function pageCountOf(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
}

/** Fixtures whose catalog structures the page-copy combine implementation preserves. */
const CORPUS = [
  'blank.pdf',
  'multipage.pdf',
  'text.pdf',
  'image.pdf',
  'annotated.pdf',
  'outline.pdf',
  'rotated.pdf',
  'mixed-boxes.pdf',
  'page-labels.pdf',
  'links.pdf',
  'annotations-all.pdf',
  'cjk-rtl.pdf',
  'scanned.pdf',
  'skewed.pdf',
];

describe('bookmarkTitle', () => {
  it('is the file name without its folder or its extension', () => {
    expect(bookmarkTitle('C:\\Reports\\Q3 summary.pdf')).toBe('Q3 summary');
    expect(bookmarkTitle('/home/tony/notes.PDF')).toBe('notes');
    expect(bookmarkTitle('plain')).toBe('plain');
  });

  it('keeps a name that is nothing but an extension, rather than becoming empty', () => {
    expect(bookmarkTitle('.gitignore')).toBe('.gitignore');
  });
});

describe('combine', () => {
  it.each([
    'form.pdf',
    'layers.pdf',
    'attachments.pdf',
    'forms-all.pdf',
    'javascript.pdf',
    'xfa.pdf',
    'pdfa-1b.pdf',
  ])('refuses catalogue loss from %s', async (name) => {
    await expect(combine([fixture(name)])).rejects.toThrow(/Cannot safely combine/);
  });
  it('adds up: the corpus combined has as many pages as the corpus', async () => {
    const sources = CORPUS.map(fixture);
    const expected = (
      await Promise.all(sources.map(async (s) => await pageCountOf(s.bytes)))
    ).reduce((a, b) => a + b, 0);
    const result = await combine(sources);
    expect(result.pageCount).toBe(expected);
    expect(await pageCountOf(result.bytes)).toBe(expected);
    expect(result.warnings).toEqual([]);
  });

  it('gives every source file a bookmark of its own, in order', async () => {
    const sources = CORPUS.map(fixture);
    const result = await combine(sources, { keepBookmarks: false });
    const outline = readOutline(await PDFDocument.load(result.bytes));
    const top = outline.filter((item) => item.parent === null);
    expect(top.map((item) => item.title)).toEqual(CORPUS.map(bookmarkTitle));
    // Each one points at the first page that file contributed.
    expect(top.map((item) => item.page)).toEqual(result.startPages.filter((p) => p >= 0));
  });

  it("nests a source's own bookmarks under its file bookmark", async () => {
    const result = await combine([fixture('blank.pdf'), fixture('outline.pdf')]);
    const outline = readOutline(await PDFDocument.load(result.bytes));
    const titles = outline.map((i) => i.title);
    expect(titles).toContain('outline');
    const fileIndex = titles.indexOf('outline');
    const nested = outline.filter((i) => i.parent === fileIndex);
    expect(nested.length).toBeGreaterThan(0);
    // outline.pdf's own bookmarks land on the pages it contributed, not on page 0.
    for (const item of nested) expect(item.page).toBeGreaterThanOrEqual(1);
  });

  it('takes only the pages a source asks for, in the order asked', async () => {
    const multi = fixture('multipage.pdf');
    const result = await combine([{ ...multi, pages: [4, 0, 2] }]);
    expect(result.pageCount).toBe(3);
  });

  it('ignores page numbers a source does not have rather than failing', async () => {
    const result = await combine([{ ...fixture('blank.pdf'), pages: [0, 7, -1] }]);
    expect(result.pageCount).toBe(1);
  });

  it('reports a file it could not read and combines the rest', async () => {
    const result = await combine([
      fixture('blank.pdf'),
      fixture('corrupt.pdf'),
      fixture('text.pdf'),
    ]);
    expect(result.pageCount).toBe(2);
    expect(result.warnings.join(' ')).toContain('corrupt.pdf');
  });

  it('refuses, in words, when nothing at all could be read', async () => {
    await expect(combine([fixture('corrupt.pdf')])).rejects.toBeInstanceOf(OpFailed);
  });

  it('refuses an empty list', async () => {
    await expect(combine([])).rejects.toBeInstanceOf(OpFailed);
  });

  it('will not silently rewrite an encrypted file as plain text', async () => {
    await expect(combine([fixture('encrypted.pdf')])).rejects.toThrow(/password-protected/);
  });

  describe('page size', () => {
    it('leaves every page as it was by default', async () => {
      const result = await combine([fixture('multipage.pdf')]);
      const doc = await PDFDocument.load(result.bytes);
      const widths = doc.getPages().map((p) => Math.round(effectiveBox(p.node, 'crop').x1));
      expect(new Set(widths).size).toBeGreaterThan(1);
    });

    it('re-boxes onto the first page and centres the content', async () => {
      const result = await combine([fixture('multipage.pdf')], { pageSize: { kind: 'first' } });
      const doc = await PDFDocument.load(result.bytes);
      const first = effectiveBox(doc.getPage(0).node, 'crop');
      for (const page of doc.getPages()) {
        const box = effectiveBox(page.node, 'crop');
        const rotated = page.getRotation().angle % 180 !== 0;
        const width = rotated ? box.y1 - box.y0 : box.x1 - box.x0;
        const height = rotated ? box.x1 - box.x0 : box.y1 - box.y0;
        expect(width).toBeCloseTo(first.x1 - first.x0, 2);
        expect(height).toBeCloseTo(first.y1 - first.y0, 2);
      }
    });

    it('re-boxes onto a fixed size', async () => {
      const result = await combine([fixture('blank.pdf'), fixture('rotated.pdf')], {
        pageSize: { kind: 'fixed', width: 612, height: 792 },
      });
      const doc = await PDFDocument.load(result.bytes);
      const box = effectiveBox(doc.getPage(0).node, 'crop');
      expect(box.x1 - box.x0).toBeCloseTo(612, 2);
      expect(box.y1 - box.y0).toBeCloseTo(792, 2);
    });

    it('refuses a nonsense fixed size', async () => {
      await expect(
        combine([fixture('blank.pdf')], { pageSize: { kind: 'fixed', width: 0, height: 100 } }),
      ).rejects.toBeInstanceOf(OpFailed);
    });
  });

  it('stops when the signal says so, without producing anything', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      combine([fixture('blank.pdf')], {}, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(OpCancelled);
  });

  it('reports progress that only ever moves forward', async () => {
    const seen: number[] = [];
    await combine(
      [fixture('blank.pdf'), fixture('text.pdf')],
      {},
      {
        progress: (fraction) => {
          if (fraction !== null) seen.push(fraction);
        },
      },
    );
    expect(seen.length).toBeGreaterThan(0);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen[seen.length - 1]).toBe(1);
  });
});
