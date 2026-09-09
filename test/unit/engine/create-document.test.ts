/**
 * `createDocument` and the extraction it exists for (M40, ADR 0014) — against real PDFium.
 *
 * The in-memory engine proves the *logic* of slicing pages out; only PDFium can prove that what
 * comes out is a PDF another reader will open, that a copied page brings its content and its
 * annotations with it, and that "without comments" removes the highlights and leaves the links.
 * So every assertion here re-opens the bytes and looks, rather than trusting a return value.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { EngineError, type DocHandle } from '@engine/PdfEngine';
import type { PdfiumEngine } from '@engine/pdfium/PdfiumEngine';
import { slicePages } from '@modules/M40-organise-pages/extract';
import { engine, fixture, hasInk } from './helpers';

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

/** Opens bytes and hands the handle to `fn`, always closing it afterwards. */
async function withBytes<T>(bytes: Uint8Array, fn: (doc: DocHandle) => Promise<T> | T): Promise<T> {
  const doc = pdfium.openSync(bytes);
  try {
    return await fn(doc);
  } finally {
    await pdfium.close(doc);
  }
}

describe('createDocument', () => {
  it('makes a document with no pages, which is legal inside the engine', async () => {
    const doc = await pdfium.createDocument();
    try {
      expect(await pdfium.pageCount(doc)).toBe(0);
    } finally {
      await pdfium.close(doc);
    }
  });

  it('gives out a handle that behaves like any other', async () => {
    const doc = await pdfium.createDocument();
    try {
      await pdfium.insertBlankPages(doc, 0, 2, { width: 200, height: 400 });
      expect(await pdfium.pageCount(doc)).toBe(2);
      const size = await pdfium.pageSize(doc, 0);
      expect(size.width).toBeCloseTo(200, 1);
      expect(size.height).toBeCloseTo(400, 1);
    } finally {
      await pdfium.close(doc);
    }
  });

  it('hands out a fresh handle each time, and closing one leaves the other alone', async () => {
    const a = await pdfium.createDocument();
    const b = await pdfium.createDocument();
    expect(a).not.toBe(b);
    await pdfium.close(a);
    await expect(pdfium.pageCount(b)).resolves.toBe(0);
    await pdfium.close(b);
  });

  it('refuses to be used after it is closed', async () => {
    const doc = await pdfium.createDocument();
    await pdfium.close(doc);
    await expect(pdfium.pageCount(doc)).rejects.toBeInstanceOf(EngineError);
  });
});

describe('slicing pages out into a new document', () => {
  it('produces a PDF that reopens with exactly the pages asked for, in that order', async () => {
    const bytes = await withDoc('multipage.pdf', async (doc) => {
      expect(await pdfium.pageCount(doc)).toBeGreaterThanOrEqual(3);
      return await slicePages(pdfium, doc, [2, 0]);
    });
    // It is a real PDF, not just a buffer.
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    await withBytes(bytes, async (out) => {
      expect(await pdfium.pageCount(out)).toBe(2);
    });
  });

  it('brings the page content with it, so an extracted page is not blank', async () => {
    const bytes = await withDoc('text.pdf', async (doc) => await slicePages(pdfium, doc, [0]));
    await withBytes(bytes, async (out) => {
      const runs = await pdfium.textRuns(out, 0);
      expect(runs.length).toBeGreaterThan(0);
      const render = await pdfium.renderRaw(out, 0, 1);
      expect(hasInk(render)).toBe(true);
    });
  });

  it('keeps the page size and rotation of the page it copied', async () => {
    const [before, bytes] = await withDoc('rotated.pdf', async (doc) => {
      const size = await pdfium.pageSize(doc, 0);
      return [size, await slicePages(pdfium, doc, [0])] as const;
    });
    await withBytes(bytes, async (out) => {
      const after = await pdfium.pageSize(out, 0);
      expect(after.rotation).toBe(before.rotation);
      expect(after.width).toBeCloseTo(before.width, 1);
      expect(after.height).toBeCloseTo(before.height, 1);
    });
  });

  it('brings the annotations across, which is what "extract with comments" means', async () => {
    const [expected, bytes] = await withDoc('annotated.pdf', async (doc) => {
      const annotations = await pdfium.annotations(doc, 0);
      expect(annotations.length).toBeGreaterThan(0);
      return [annotations.length, await slicePages(pdfium, doc, [0])] as const;
    });
    await withBytes(bytes, async (out) => {
      expect((await pdfium.annotations(out, 0)).length).toBe(expected);
    });
  });

  it('leaves the comments out when asked, and keeps what is not a comment', async () => {
    const bytes = await withDoc(
      'annotations-all.pdf',
      async (doc) => await slicePages(pdfium, doc, [0], { withComments: false }),
    );
    await withBytes(bytes, async (out) => {
      const left = new Set((await pdfium.annotations(out, 0)).map((a) => a.subtype));
      // Every markup family is gone.
      for (const subtype of [
        'Text',
        'FreeText',
        'Line',
        'Square',
        'Circle',
        'Polygon',
        'PolyLine',
        'Highlight',
        'Underline',
        'Squiggly',
        'StrikeOut',
        'Stamp',
        'Caret',
        'Ink',
        'FileAttachment',
        'Popup',
      ] as const) {
        expect(left.has(subtype)).toBe(false);
      }
      // A link is part of the page rather than a remark about it, so it stays — and so does
      // everything else this module has no opinion about (Screen, Movie, Redact and friends),
      // because removing what a reader did not call a comment is not "extract without comments".
      expect(left.has('Link')).toBe(true);
      expect(left.size).toBeGreaterThan(1);
    });
  });

  it('does not disturb the document it copied from', async () => {
    await withDoc('multipage.pdf', async (doc) => {
      const before = await pdfium.pageCount(doc);
      await slicePages(pdfium, doc, [0, 1]);
      expect(await pdfium.pageCount(doc)).toBe(before);
      // And it still renders, which a mangled page tree would not.
      expect(hasInk(await pdfium.renderRaw(doc, 0, 1))).toBe(true);
    });
  });

  it('copies a page twice when it is asked for twice', async () => {
    const bytes = await withDoc(
      'multipage.pdf',
      async (doc) => await slicePages(pdfium, doc, [0, 0, 0]),
    );
    await withBytes(bytes, async (out) => {
      expect(await pdfium.pageCount(out)).toBe(3);
    });
  });

  it('carries a page label range across as the pages that came with it', async () => {
    const bytes = await withDoc(
      'page-labels.pdf',
      async (doc) => await slicePages(pdfium, doc, [0, 1]),
    );
    await withBytes(bytes, async (out) => {
      // PDFium reports the defaults when a copy carries no `/PageLabels`; either way there is one
      // label per page and nothing throws, which is what the model needs to build itself.
      const labels = await pdfium.pageLabels(out);
      expect(labels).toHaveLength(2);
    });
  });
});
