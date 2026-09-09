/**
 * The pdf-lib odd jobs every op in `src/engine/ops/` leans on (M41).
 *
 * Two of them are worth their own tests. **Boxes** because the spec's fallback chain — Trim falls
 * back to Crop, Crop to Media, Media to Letter — is what every crop in the app is measured
 * against, and it is not the same question as "what does the file say". **Outlines** because
 * `/Dest` has three legal spellings and `/A /GoTo` a fourth, and combine and split both have to
 * follow all four or they lose bookmarks silently.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import {
  createPdf,
  effectiveBox,
  loadPdf,
  pageLeaves,
  readBox,
  pick,
  readOutline,
  readRotation,
  savePdf,
  writeBoxes,
} from '@engine/ops/pdfdoc';
import { OpFailed } from '@engine/ops/types';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

describe('loadPdf', () => {
  it('refuses an encrypted file in words rather than rewriting it as plain text', async () => {
    await expect(loadPdf(fixture('encrypted.pdf'), 'Report.pdf')).rejects.toThrow(
      /Report\.pdf is password-protected/,
    );
  });

  it('names the file when it cannot be read at all', async () => {
    await expect(loadPdf(fixture('corrupt.pdf'), 'Rubbish.pdf')).rejects.toBeInstanceOf(OpFailed);
    await expect(loadPdf(fixture('corrupt.pdf'), 'Rubbish.pdf')).rejects.toThrow(/Rubbish\.pdf/);
  });

  it('reads a file whose xref is wrong, because pdf-lib rebuilds it', async () => {
    const doc = await loadPdf(fixture('broken-xref.pdf'), 'broken.pdf');
    expect(doc.getPageCount()).toBe(1);
  });
});

describe('createPdf and savePdf', () => {
  it('makes an empty document that says ynotPDF made it', async () => {
    const doc = await createPdf();
    expect(doc.getProducer()).toBe('ynotPDF');
    expect(doc.getCreator()).toBe('ynotPDF');
    // Saving one adds no page of its own — pdf-lib offers to, and it must not.
    const bytes = await savePdf(doc);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(0);
  });
});

describe('boxes', () => {
  it('reads only the boxes a page really carries', async () => {
    const doc = await loadPdf(fixture('mixed-boxes.pdf'), 'mixed');
    const leaves = pageLeaves(doc);
    const first = leaves[0]?.leaf;
    const fourth = leaves[3]?.leaf;
    expect(first).toBeDefined();
    expect(fourth).toBeDefined();
    if (!first || !fourth) return;
    expect(readBox(first, 'trim')).toBeNull();
    expect(readBox(fourth, 'trim')).not.toBeNull();
    expect(readBox(fourth, 'crop')).toBeNull();
  });

  it('applies the spec’s fallbacks: trim → crop → media', async () => {
    const doc = await loadPdf(fixture('mixed-boxes.pdf'), 'mixed');
    const fourth = pageLeaves(doc)[3]?.leaf;
    expect(fourth).toBeDefined();
    if (!fourth) return;
    // The page has no CropBox, so its crop *is* its media box…
    expect(effectiveBox(fourth, 'crop')).toEqual(effectiveBox(fourth, 'media'));
    // …but it does have a TrimBox of its own, so that is not the fallback.
    expect(effectiveBox(fourth, 'trim')).not.toEqual(effectiveBox(fourth, 'crop'));
  });

  it('falls back to Letter for a page with no usable MediaBox', async () => {
    const doc = await createPdf();
    const page = doc.addPage();
    page.node.delete(PDFName.of('MediaBox'));
    expect(effectiveBox(page.node, 'media')).toEqual({ x0: 0, y0: 0, x1: 612, y1: 792 });
  });

  it('writes a box, removes one with null, and leaves an absent one alone', async () => {
    const doc = await loadPdf(fixture('mixed-boxes.pdf'), 'mixed');
    const fourth = pageLeaves(doc)[3]?.leaf;
    expect(fourth).toBeDefined();
    if (!fourth) return;
    writeBoxes(fourth, { trim: null, art: { x0: 1, y0: 2, x1: 3, y1: 4 } });
    expect(readBox(fourth, 'trim')).toBeNull();
    expect(readBox(fourth, 'art')).toEqual({ x0: 1, y0: 2, x1: 3, y1: 4 });
    expect(readBox(fourth, 'bleed')).not.toBeNull();
  });

  it('treats a zero-area box as no box at all', async () => {
    const doc = await createPdf();
    const page = doc.addPage([200, 200]);
    writeBoxes(page.node, { trim: { x0: 5, y0: 5, x1: 5, y1: 5 } });
    expect(readBox(page.node, 'trim')).toBeNull();
  });
});

describe('readRotation', () => {
  it('normalises whatever the file says into 0, 90, 180 or 270', async () => {
    const doc = await loadPdf(fixture('rotated.pdf'), 'rotated');
    expect(pageLeaves(doc).map((p) => readRotation(p.leaf))).toEqual([0, 90, 180, 270]);
  });

  it('reads a negative or over-turned angle the way a viewer does', async () => {
    const doc = await createPdf();
    const page = doc.addPage([100, 100]);
    page.node.set(PDFName.of('Rotate'), doc.context.obj(-90));
    expect(readRotation(page.node)).toBe(270);
    page.node.set(PDFName.of('Rotate'), doc.context.obj(450));
    expect(readRotation(page.node)).toBe(90);
  });
});

describe('readOutline', () => {
  it('flattens a nested outline, keeping the parents', async () => {
    const doc = await loadPdf(fixture('outline.pdf'), 'outline');
    const items = readOutline(doc);
    expect(items.length).toBeGreaterThan(1);
    expect(items.filter((i) => i.parent === null).length).toBeGreaterThan(0);
    expect(items.some((i) => i.parent !== null)).toBe(true);
    for (const item of items) expect(item.title).not.toBe('');
  });

  it('resolves every item to a page of this document', async () => {
    const doc = await loadPdf(fixture('outline.pdf'), 'outline');
    for (const item of readOutline(doc)) {
      if (item.page === null) continue;
      expect(item.page).toBeGreaterThanOrEqual(0);
      expect(item.page).toBeLessThan(doc.getPageCount());
    }
  });

  it('answers nothing for a document with no outline', async () => {
    expect(readOutline(await loadPdf(fixture('blank.pdf'), 'blank'))).toEqual([]);
  });

  it('follows a named destination and an /A /GoTo action', async () => {
    const doc = await createPdf();
    const pages = [doc.addPage([100, 100]), doc.addPage([100, 100])];
    const ctx = doc.context;
    // A named destination in the modern `/Names /Dests` tree…
    const dest = ctx.obj([pages[1]?.ref, 'Fit']);
    const names = ctx.obj({ Names: ctx.obj([PDFString.of('chapter'), dest]) });
    doc.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: names }));
    // …reached by name from one item, and by a GoTo action from another.
    // `ctx.obj('x')` makes a *name*, which is what `/Dest` wants here and not what `/Title`
    // wants — a title is a text string.
    const byName = ctx.register(ctx.obj({ Title: PDFString.of('By name'), Dest: 'chapter' }));
    const byAction = ctx.register(
      ctx.obj({
        Title: PDFString.of('By action'),
        A: ctx.obj({ S: 'GoTo', D: ctx.obj([pages[0]?.ref, 'Fit']) }),
      }),
    );
    const first = pick(ctx, byName, PDFDict);
    first?.set(PDFName.of('Next'), byAction);
    doc.catalog.set(
      PDFName.of('Outlines'),
      ctx.obj({ Type: 'Outlines', First: byName, Last: byAction, Count: 2 }),
    );
    const items = readOutline(doc);
    expect(items.map((i) => i.title)).toEqual(['By name', 'By action']);
    expect(items.map((i) => i.page)).toEqual([1, 0]);
  });

  it('keeps a heading whose destination cannot be followed, with no page', async () => {
    const doc = await createPdf();
    doc.addPage([100, 100]);
    const ctx = doc.context;
    const item = ctx.register(ctx.obj({ Title: PDFString.of('Nowhere'), Dest: 'missing' }));
    doc.catalog.set(
      PDFName.of('Outlines'),
      ctx.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 }),
    );
    expect(readOutline(doc)).toEqual([
      {
        title: 'Nowhere',
        page: null,
        parent: null,
        bold: false,
        italic: false,
        color: null,
        open: false,
      },
    ]);
  });
});
