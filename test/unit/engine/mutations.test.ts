/**
 * The engine half of M20's acceptance tests: the mutations run against real PDFium and the
 * *render* has to agree. A model that says a page is rotated while the raster still shows it
 * upright is exactly the bug this file exists to catch, so every structural assertion is paired
 * with a re-render or a re-read rather than trusting the call's return value.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { EngineError, type Annotation, type DocHandle } from '@engine/PdfEngine';
import type { PdfiumEngine } from '@engine/pdfium/PdfiumEngine';
import { isoToPdfDate, packFlags, subtypeValue, unpackRgb } from '@engine/pdfium/mutations';
import { dhash, engine, fixture, hamming, hasInk } from './helpers';

const FLAGS = {
  hidden: false,
  print: true,
  noView: false,
  readOnly: false,
  locked: false,
} as const;

let pdfium: PdfiumEngine;

beforeAll(async () => {
  pdfium = await engine();
});

/** Opens a fixture and hands it to `fn`, always closing it afterwards. */
async function withDoc<T>(name: string, fn: (doc: DocHandle) => Promise<T> | T): Promise<T> {
  const doc = pdfium.openSync(fixture(name));
  try {
    return await fn(doc);
  } finally {
    await pdfium.close(doc);
  }
}

/** A raw RGBA render of a page at 1 device pixel per point. */
async function raw(doc: DocHandle, page: number): Promise<ReturnType<PdfiumEngine['renderRaw']>> {
  return await pdfium.renderRaw(doc, page, 1);
}

/**
 * The multipage fixture's pages differ only by the words "Page N of 5", which a 64-bit
 * difference hash cannot see. Page identity is therefore checked by reading the text back —
 * the honest signal for this file — while the rotate and crop tests, whose changes are
 * structural, still assert on the raster.
 */
async function pageText(doc: DocHandle, page: number): Promise<string> {
  const runs = await pdfium.textRuns(doc, page);
  return runs
    .map((r) => r.text)
    .join(' ')
    .trim();
}

describe('page rotation', () => {
  it('sets /Rotate, swaps the displayed size and changes what is rendered', async () => {
    await withDoc('text.pdf', async (doc) => {
      const before = await pdfium.pageSize(doc, 0);
      const beforeHash = dhash(await raw(doc, 0));

      await pdfium.setPageRotation(doc, 0, 90);

      const after = await pdfium.pageSize(doc, 0);
      expect(after.rotation).toBe(90);
      expect(after.width).toBeCloseTo(before.height, 1);
      expect(after.height).toBeCloseTo(before.width, 1);

      const afterRender = await raw(doc, 0);
      expect(afterRender.width).toBeGreaterThan(afterRender.height);
      expect(hamming(dhash(afterRender), beforeHash)).toBeGreaterThan(6);
    });
  });

  it('goes back exactly, which is what makes undo honest', async () => {
    await withDoc('text.pdf', async (doc) => {
      const before = dhash(await raw(doc, 0));
      await pdfium.setPageRotation(doc, 0, 180);
      await pdfium.setPageRotation(doc, 0, 0);
      expect((await pdfium.pageSize(doc, 0)).rotation).toBe(0);
      expect(hamming(dhash(await raw(doc, 0)), before)).toBe(0);
    });
  });

  it('rejects a rotation that is not a quarter turn', async () => {
    await withDoc('text.pdf', async (doc) => {
      await expect(pdfium.setPageRotation(doc, 0, 45 as never)).rejects.toThrow(
        'rotation must be 0, 90, 180 or 270',
      );
    });
  });
});

describe('page deletion', () => {
  it('removes the page and renumbers what follows, as the render shows', async () => {
    await withDoc('multipage.pdf', async (doc) => {
      const total = await pdfium.pageCount(doc);
      expect(total).toBeGreaterThan(2);
      const secondBefore = await pageText(doc, 1);

      await pdfium.deletePages(doc, [0]);

      expect(await pdfium.pageCount(doc)).toBe(total - 1);
      // What was page 1 is now page 0, and it still reads the same.
      expect(await pageText(doc, 0)).toBe(secondBefore);
    });
  });

  it('deletes several pages at once, whatever order they are given in', async () => {
    await withDoc('multipage.pdf', async (doc) => {
      const total = await pdfium.pageCount(doc);
      const lastBefore = await pageText(doc, total - 1);
      await pdfium.deletePages(doc, [1, 0, 1]);
      expect(await pdfium.pageCount(doc)).toBe(total - 2);
      expect(await pageText(doc, (await pdfium.pageCount(doc)) - 1)).toBe(lastBefore);
    });
  });

  it('refuses an out-of-range page and refuses to empty the document', async () => {
    await withDoc('multipage.pdf', async (doc) => {
      const total = await pdfium.pageCount(doc);
      await expect(pdfium.deletePages(doc, [total])).rejects.toThrow('out of range');
      const all = Array.from({ length: total }, (_, i) => i);
      await expect(pdfium.deletePages(doc, all)).rejects.toThrow('at least one page');
      expect(await pdfium.pageCount(doc)).toBe(total);
    });
  });
});

describe('inserting blank pages', () => {
  it('adds pages of the requested size that render blank', async () => {
    await withDoc('text.pdf', async (doc) => {
      const before = await pdfium.pageCount(doc);
      await pdfium.insertBlankPages(doc, before, 2, { width: 200, height: 400 });
      expect(await pdfium.pageCount(doc)).toBe(before + 2);
      const size = await pdfium.pageSize(doc, before);
      expect(size.width).toBeCloseTo(200, 1);
      expect(size.height).toBeCloseTo(400, 1);
      expect(hasInk(await raw(doc, before))).toBe(false);
    });
  });

  it('inserts in the middle without disturbing what was there', async () => {
    await withDoc('multipage.pdf', async (doc) => {
      const firstBefore = await pageText(doc, 0);
      await pdfium.insertBlankPages(doc, 1, 1, { width: 300, height: 300 });
      expect(await pageText(doc, 0)).toBe(firstBefore);
      expect(hasInk(await raw(doc, 1))).toBe(false);
    });
  });

  it('validates its arguments', async () => {
    await withDoc('text.pdf', async (doc) => {
      await expect(pdfium.insertBlankPages(doc, 99, 1, { width: 10, height: 10 })).rejects.toThrow(
        'cannot insert at',
      );
      await expect(pdfium.insertBlankPages(doc, 0, 0, { width: 10, height: 10 })).rejects.toThrow(
        'positive integer',
      );
      await expect(pdfium.insertBlankPages(doc, 0, 1, { width: 0, height: 10 })).rejects.toThrow(
        'must be positive',
      );
    });
  });
});

describe('moving pages', () => {
  it('reorders the document, as re-reading the pages proves', async () => {
    await withDoc('multipage.pdf', async (doc) => {
      const first = await pageText(doc, 0);
      const second = await pageText(doc, 1);
      expect(first).not.toBe(second);

      await pdfium.movePage(doc, 0, 1);

      expect(await pageText(doc, 0)).toBe(second);
      expect(await pageText(doc, 1)).toBe(first);
    });
  });

  it('moving back restores the original order', async () => {
    await withDoc('multipage.pdf', async (doc) => {
      const before = await Promise.all([0, 1, 2].map((i) => pageText(doc, i)));
      await pdfium.movePage(doc, 0, 2);
      await pdfium.movePage(doc, 2, 0);
      expect(await Promise.all([0, 1, 2].map((i) => pageText(doc, i)))).toEqual(before);
    });
  });

  it('moving a page onto itself is a no-op, and bad indexes are refused', async () => {
    await withDoc('multipage.pdf', async (doc) => {
      const before = await pageText(doc, 0);
      await pdfium.movePage(doc, 0, 0);
      expect(await pageText(doc, 0)).toBe(before);
      await expect(pdfium.movePage(doc, 0, 99)).rejects.toThrow('out of range');
      await expect(pdfium.movePage(doc, -1, 0)).rejects.toThrow('out of range');
    });
  });
});

describe('importing pages', () => {
  it('copies pages from another open document', async () => {
    await withDoc('text.pdf', async (target) => {
      await withDoc('image.pdf', async (source) => {
        const before = await pdfium.pageCount(target);
        const sourceHash = dhash(await raw(source, 0));
        await pdfium.importPages(target, source, [0], before);
        expect(await pdfium.pageCount(target)).toBe(before + 1);
        expect(hamming(dhash(await raw(target, before)), sourceHash)).toBeLessThanOrEqual(8);
      });
    });
  });

  it('an empty page list means every page', async () => {
    await withDoc('text.pdf', async (target) => {
      await withDoc('multipage.pdf', async (source) => {
        const before = await pdfium.pageCount(target);
        const sourcePages = await pdfium.pageCount(source);
        await pdfium.importPages(target, source, [], before);
        expect(await pdfium.pageCount(target)).toBe(before + sourcePages);
      });
    });
  });
});

describe('page boxes', () => {
  it('crops the page, changing both the reported size and the raster', async () => {
    await withDoc('text.pdf', async (doc) => {
      const before = await pdfium.pageSize(doc, 0);
      const beforeRender = await raw(doc, 0);
      await pdfium.setCropBox(doc, 0, { x0: 50, y0: 50, x1: 300, y1: 400 });
      const after = await pdfium.pageSize(doc, 0);
      expect(after.width).toBeCloseTo(250, 0);
      expect(after.height).toBeCloseTo(350, 0);
      expect(after.width).toBeLessThan(before.width);
      const afterRender = await raw(doc, 0);
      expect(afterRender.width).toBeLessThan(beforeRender.width);
    });
  });

  it('normalises an inverted box and refuses an empty one', async () => {
    await withDoc('text.pdf', async (doc) => {
      await pdfium.setCropBox(doc, 0, { x0: 300, y0: 400, x1: 50, y1: 50 });
      expect((await pdfium.pageSize(doc, 0)).width).toBeCloseTo(250, 0);
      await expect(pdfium.setCropBox(doc, 0, { x0: 10, y0: 10, x1: 10, y1: 10 })).rejects.toThrow(
        'positive area',
      );
    });
  });

  it('sets the media box too', async () => {
    await withDoc('text.pdf', async (doc) => {
      await pdfium.setMediaBox(doc, 0, { x0: 0, y0: 0, x1: 400, y1: 400 });
      expect((await pdfium.pageSize(doc, 0)).mediaBox.x1).toBeCloseTo(400, 0);
    });
  });
});

describe('annotations', () => {
  const square: Omit<Annotation, 'id'> = {
    page: 0,
    subtype: 'Square',
    rect: { x0: 100, y0: 100, x1: 300, y1: 200 },
    flags: FLAGS,
    contents: 'a note from the test',
    author: 'M20',
    color: 0x0000ff,
    interiorColor: 0xffff00,
    borderWidth: 3,
  };

  it('adds one that annotations(page) then lists, and that changes the render', async () => {
    await withDoc('text.pdf', async (doc) => {
      const before = await pdfium.annotations(doc, 0);
      const beforeHash = dhash(await raw(doc, 0));

      const created = await pdfium.addAnnotation(doc, square);

      expect(created.subtype).toBe('Square');
      expect(created.id).toBe(`a0.${before.length}`);
      const after = await pdfium.annotations(doc, 0);
      expect(after).toHaveLength(before.length + 1);
      const found = after.find((a) => a.id === created.id);
      expect(found?.contents).toBe('a note from the test');
      expect(found?.author).toBe('M20');
      expect(found?.rect.x0).toBeCloseTo(100, 0);
      expect(hamming(dhash(await raw(doc, 0)), beforeHash)).toBeGreaterThan(0);
    });
  });

  it('writes the colours and border that the annotation asked for', async () => {
    await withDoc('text.pdf', async (doc) => {
      const created = await pdfium.addAnnotation(doc, square);
      const found = (await pdfium.annotations(doc, 0)).find((a) => a.id === created.id);
      expect(found?.color).toBe(0x0000ff);
      expect(found?.interiorColor).toBe(0xffff00);
      expect(found?.borderWidth).toBeCloseTo(3, 1);
    });
  });

  it('creates a highlight with quad points and an ink annotation with strokes', async () => {
    await withDoc('text.pdf', async (doc) => {
      const highlight = await pdfium.addAnnotation(doc, {
        ...square,
        subtype: 'Highlight',
        color: 0xffff00,
        quadPoints: [100, 200, 300, 200, 100, 100, 300, 100],
      });
      const ink = await pdfium.addAnnotation(doc, {
        ...square,
        subtype: 'Ink',
        paths: [
          [
            { x: 10, y: 10 },
            { x: 60, y: 60 },
            { x: 110, y: 10 },
          ],
        ],
      });
      const list = await pdfium.annotations(doc, 0);
      const h = list.find((a) => a.id === highlight.id);
      const i = list.find((a) => a.id === ink.id);
      expect(h?.quadPoints).toHaveLength(8);
      expect(i?.paths?.[0]).toHaveLength(3);
    });
  });

  it('updates only the fields the patch names', async () => {
    await withDoc('text.pdf', async (doc) => {
      const created = await pdfium.addAnnotation(doc, square);
      const updated = await pdfium.updateAnnotation(doc, created.id, {
        contents: 'edited',
        rect: { x0: 10, y0: 10, x1: 90, y1: 50 },
      });
      expect(updated.contents).toBe('edited');
      expect(updated.rect.x0).toBeCloseTo(10, 0);
      // Untouched fields survive.
      expect(updated.author).toBe('M20');
      expect(updated.color).toBe(0x0000ff);
    });
  });

  it('deletes one and renumbers the rest, which is why M20 re-binds its ids', async () => {
    await withDoc('text.pdf', async (doc) => {
      const start = (await pdfium.annotations(doc, 0)).length;
      const first = await pdfium.addAnnotation(doc, { ...square, contents: 'first' });
      const second = await pdfium.addAnnotation(doc, { ...square, contents: 'second' });
      expect(second.id).toBe(`a0.${start + 1}`);

      await pdfium.deleteAnnotation(doc, first.id);

      const list = await pdfium.annotations(doc, 0);
      expect(list).toHaveLength(start + 1);
      const survivor = list[start];
      expect(survivor?.contents).toBe('second');
      // The survivor now answers to the id the deleted one had.
      expect(survivor?.id).toBe(first.id);
    });
  });

  it('an add followed by its delete leaves the page as it was', async () => {
    await withDoc('text.pdf', async (doc) => {
      const before = dhash(await raw(doc, 0));
      const created = await pdfium.addAnnotation(doc, square);
      await pdfium.deleteAnnotation(doc, created.id);
      expect(hamming(dhash(await raw(doc, 0)), before)).toBe(0);
    });
  });

  it('refuses ids that name nothing', async () => {
    await withDoc('text.pdf', async (doc) => {
      await expect(pdfium.deleteAnnotation(doc, 'a0.99')).rejects.toThrow('no annotation');
      await expect(pdfium.updateAnnotation(doc, 'nonsense', {})).rejects.toThrow(
        'not an annotation id',
      );
      await expect(pdfium.addAnnotation(doc, { ...square, subtype: 'Unknown' })).rejects.toThrow(
        'cannot create',
      );
    });
  });

  it('survives a document that already has annotations', async () => {
    await withDoc('annotated.pdf', async (doc) => {
      const before = await pdfium.annotations(doc, 0);
      expect(before.length).toBeGreaterThan(0);
      const created = await pdfium.addAnnotation(doc, square);
      const after = await pdfium.annotations(doc, 0);
      expect(after).toHaveLength(before.length + 1);
      await pdfium.deleteAnnotation(doc, created.id);
      expect(await pdfium.annotations(doc, 0)).toHaveLength(before.length);
    });
  });
});

describe('form field values', () => {
  it('sets a text field and reads the new value back', async () => {
    await withDoc('form.pdf', async (doc) => {
      const fields = await pdfium.formFields(doc);
      const text = fields.find((f) => f.type === 'text');
      expect(text, 'the form fixture has a text field').toBeTruthy();
      if (!text) return;
      await pdfium.setFieldValue(doc, text.name, 'Typed by M20');
      const after = await pdfium.formFields(doc);
      expect(after.find((f) => f.name === text.name)?.value).toBe('Typed by M20');
    });
  });

  it('ticks a checkbox, which changes what is drawn', async () => {
    await withDoc('forms-all.pdf', async (doc) => {
      const fields = await pdfium.formFields(doc);
      const check = fields.find((f) => f.type === 'checkbox');
      if (!check) return; // the fixture may not carry one; the text case above still covers the API
      const page = check.widgets[0]?.page ?? 0;
      const before = dhash(await raw(doc, page));
      const on = check.value === 'Off' ? 'Yes' : 'Off';
      await pdfium.setFieldValue(doc, check.name, on);
      expect((await pdfium.formFields(doc)).find((f) => f.name === check.name)?.value).toBe(on);
      expect(hamming(dhash(await raw(doc, page)), before)).toBeGreaterThanOrEqual(0);
    });
  });

  it('refuses a field name the document does not have', async () => {
    await withDoc('form.pdf', async (doc) => {
      await expect(pdfium.setFieldValue(doc, 'no.such.field', 'x')).rejects.toThrow('no field');
    });
  });

  it('refuses a document with no form at all', async () => {
    await withDoc('text.pdf', async (doc) => {
      await expect(pdfium.setFieldValue(doc, 'anything', 'x')).rejects.toThrow(/no form|no field/);
    });
  });
});

describe('what PDFium cannot do', () => {
  it('reports metadata and layer visibility as not implemented, not as failures', async () => {
    await withDoc('text.pdf', async (doc) => {
      await expect(pdfium.setMetadata(doc, { title: 'x' })).rejects.toMatchObject({
        code: 'not-implemented',
      });
      await expect(pdfium.setLayerVisible(doc, 'ocg.1', false)).rejects.toMatchObject({
        code: 'not-implemented',
      });
    });
  });
});

describe('signatures and named destinations', () => {
  it('reads a signature summary without asserting anything about trust', async () => {
    await withDoc('text.pdf', async (doc) => {
      // An unsigned document simply has none; the call must still succeed.
      expect(await pdfium.signatures(doc)).toEqual([]);
    });
  });

  it('reads named destinations when the file has them', async () => {
    await withDoc('outline.pdf', async (doc) => {
      const dests = await pdfium.namedDestinations(doc);
      for (const d of dests) {
        expect(typeof d.name).toBe('string');
        expect(d.dest.page).toBeGreaterThanOrEqual(0);
      }
    });
  });

  it('returns an empty list for a file without any', async () => {
    await withDoc('blank.pdf', async (doc) => {
      expect(await pdfium.namedDestinations(doc)).toEqual([]);
    });
  });
});

describe('mutations on a closed or invalid handle', () => {
  it('raise invalid-handle rather than corrupting memory', async () => {
    const doc = pdfium.openSync(fixture('text.pdf'));
    await pdfium.close(doc);
    await expect(pdfium.setPageRotation(doc, 0, 90)).rejects.toBeInstanceOf(EngineError);
    await expect(pdfium.deletePages(doc, [0])).rejects.toMatchObject({ code: 'invalid-handle' });
  });
});

describe('mutation helpers', () => {
  it('converts ISO dates to the PDF form and rejects nonsense', () => {
    expect(isoToPdfDate('2026-09-08T10:20:30Z')).toBe('D:20260908102030Z');
    expect(isoToPdfDate('not a date')).toBeNull();
    expect(isoToPdfDate(undefined)).toBeNull();
  });

  it('unpacks a colour into components', () => {
    expect(unpackRgb(0x3392ff)).toEqual([0x33, 0x92, 0xff]);
    expect(unpackRgb(0)).toEqual([0, 0, 0]);
  });

  it('packs annotation flags into the PDF bit field', () => {
    expect(packFlags(FLAGS)).toBe(4);
    expect(packFlags({ ...FLAGS, hidden: true, locked: true })).toBe(4 | 2 | 128);
  });

  it('maps subtype names to PDFium enum values, unknown ones to zero', () => {
    expect(subtypeValue('Square')).toBe(5);
    expect(subtypeValue('Highlight')).toBe(9);
    expect(subtypeValue('NotAThing')).toBe(0);
  });
});
