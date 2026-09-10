/**
 * The writer half of M50's acceptance tests: an object edit reaches the file through the
 * original content stream, so the saved page is the original page plus one `q … Q` — and the
 * render changes only where the object was and where it went.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, rgb } from 'pdf-lib';
import { applyEdits, parse, serialise } from '@engine/content';
import { readPageContent } from '@engine/content/pdf';
import { emptyWritePlan, type PlannedObjects, type WritePlan } from '@engine/Writer';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import type { PdfiumEngine } from '@engine/pdfium/PdfiumEngine';
import type { PageObject } from '@engine/PdfEngine';
import type { PdfRect } from '@shared/pdf';
import { engine, fixture, inkCoverage } from '../engine/helpers';

let pdfium: PdfiumEngine;

beforeAll(async () => {
  pdfium = await engine();
});

const write = (bytes: Uint8Array, plan: WritePlan) =>
  new FullRewriteWriter().write({ bytes, plan, options: { objectStreams: false } });

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** What the renderer records before the first edit on a page. */
function baseline(
  content: Uint8Array,
  objects: ReadonlyArray<PageObject>,
): Omit<PlannedObjects, 'edits'> {
  const textMatrices: Record<string, PageObject['matrix']> = {};
  for (const o of objects) if (o.kind === 'text') textMatrices[String(o.index)] = o.matrix;
  return { original: toBase64(content), kinds: objects.map((o) => o.kind), textMatrices };
}

/** The union of two rects, grown a little for anti-aliasing. */
function around(a: PdfRect, b: PdfRect, pad = 2): PdfRect {
  return {
    x0: Math.min(a.x0, b.x0) - pad,
    y0: Math.min(a.y0, b.y0) - pad,
    x1: Math.max(a.x1, b.x1) + pad,
    y1: Math.max(a.y1, b.y1) + pad,
  };
}

/** Pixels that differ between two renders, outside `rect` (page space). */
function differsOutside(
  a: { rgba: Uint8Array; width: number; height: number },
  b: { rgba: Uint8Array; width: number; height: number },
  rect: PdfRect,
  pageHeight: number,
): number {
  let count = 0;
  for (let y = 0; y < a.height; y++) {
    const py = pageHeight - y;
    for (let x = 0; x < a.width; x++) {
      const inside = x >= rect.x0 && x <= rect.x1 && py >= rect.y0 && py <= rect.y1;
      if (inside) continue;
      const i = (y * a.width + x) * 4;
      if (
        a.rgba[i] !== b.rgba[i] ||
        a.rgba[i + 1] !== b.rgba[i + 1] ||
        a.rgba[i + 2] !== b.rgba[i + 2]
      )
        count++;
    }
  }
  return count;
}

describe('page objects through the writer', () => {
  it('moves an image 10 pt, keeps every other byte, and re-renders only there', async () => {
    const original = fixture('image.pdf');
    const doc = pdfium.openSync(original);
    let objects: ReadonlyArray<PageObject>;
    let content: Uint8Array;
    let before: Awaited<ReturnType<PdfiumEngine['renderRaw']>>;
    let height: number;
    try {
      objects = await pdfium.pageObjects(doc, 0);
      content = await pdfium.pageContent(doc, 0);
      before = await pdfium.renderRaw(doc, 0, 1);
      height = (await pdfium.pageSize(doc, 0)).height;
    } finally {
      await pdfium.close(doc);
    }
    const image = objects.find((o) => o.kind === 'image');
    if (!image) throw new Error('no image');

    const plan: WritePlan = {
      ...emptyWritePlan(1),
      pages: [
        {
          source: 0,
          objects: {
            ...baseline(content, objects),
            edits: [{ kind: 'transform', index: image.index, matrix: [1, 0, 0, 1, 10, 0] }],
          },
        },
      ],
    };
    const result = await write(original, plan);
    expect(result.applied).toContain('objects');
    expect(result.warnings).toEqual([]);

    // The saved content is the original with one q/cm/Q around the image's Do.
    const saved = await readPageContent(result.bytes, 0);
    if (!saved) throw new Error('no content');
    // Reading a page's content joins its streams with a newline, so compare without the tail.
    const trimmed = (b: Uint8Array): string => new TextDecoder('latin1').decode(b).trimEnd();
    const stream = parse(content);
    expect(trimmed(saved)).toBe(
      trimmed(
        serialise(
          stream,
          applyEdits(stream, [
            { kind: 'transform', index: image.index, matrix: [1, 0, 0, 1, 10, 0] },
          ]).ops,
        ),
      ),
    );
    // The image is drawn under a `256 0 0 256 … cm`, so the 10 pt is 10/256 in its own frame.
    expect(trimmed(saved)).toContain('\nq\n1 0 0 1 0.03906 0 cm');
    // Every op the original had is still there, in the same bytes.
    const ops = parse(saved).ops.filter(
      (o) => o.operator !== 'q' && o.operator !== 'Q' && o.operator !== 'cm',
    );
    const originalOps = parse(content).ops.filter(
      (o) => o.operator !== 'q' && o.operator !== 'Q' && o.operator !== 'cm',
    );
    expect(ops.length).toBe(originalOps.length);

    const reopened = pdfium.openSync(result.bytes);
    try {
      const after = await pdfium.pageObjects(reopened, 0);
      const moved = after[image.index];
      expect(moved?.kind).toBe('image');
      expect(moved?.rect.x0).toBeCloseTo(image.rect.x0 + 10, 2);
      expect(moved?.rect.y0).toBeCloseTo(image.rect.y0, 2);
      const render = await pdfium.renderRaw(reopened, 0, 1);
      const region = around(image.rect, moved?.rect ?? image.rect);
      expect(differsOutside(before, render, region, height)).toBe(0);
      expect(
        inkCoverage(render, {
          x: image.rect.x0,
          y: height - image.rect.y1,
          width: 8,
          height: image.rect.y1 - image.rect.y0,
        }),
      ).toBeLessThan(0.05);
    } finally {
      await pdfium.close(reopened);
    }
  });

  it('removes a path and pastes a copied one, both from the original bytes', async () => {
    const original = fixture('multipage.pdf');
    const doc = pdfium.openSync(original);
    let objects: ReadonlyArray<PageObject>;
    let content: Uint8Array;
    let copied: Uint8Array;
    try {
      objects = await pdfium.pageObjects(doc, 0);
      content = await pdfium.pageContent(doc, 0);
      const rect = objects.find((o) => o.kind === 'path');
      if (!rect) throw new Error('no path');
      copied = await pdfium.objectAsPdf(doc, 0, rect.index);
    } finally {
      await pdfium.close(doc);
    }
    const rect = objects.find((o) => o.kind === 'path');
    if (!rect) throw new Error('no path');
    const plan: WritePlan = {
      ...emptyWritePlan(5),
      pages: [
        {
          source: 0,
          objects: {
            ...baseline(content, objects),
            edits: [
              { kind: 'remove', index: rect.index },
              { kind: 'insert', pdf: toBase64(copied), matrix: [1, 0, 0, 1, 100, 100] },
            ],
          },
        },
        { source: 1 },
        { source: 2 },
        { source: 3 },
        { source: 4 },
      ],
    };
    const result = await write(original, plan);
    expect(result.warnings).toEqual([]);
    const reopened = pdfium.openSync(result.bytes);
    try {
      const after = await pdfium.pageObjects(reopened, 0);
      expect(after.length).toBe(objects.length);
      expect(after.map((o) => o.kind)).toEqual([
        ...objects.filter((o) => o.index !== rect.index).map((o) => o.kind),
        'form',
      ]);
      const pasted = after[after.length - 1];
      expect(pasted?.rect.x0).toBeCloseTo(rect.rect.x0 + 100, 1);
      expect(pasted?.rect.y0).toBeCloseTo(rect.rect.y0 + 100, 1);
    } finally {
      await pdfium.close(reopened);
    }
  });

  it('moves a text object and the text is still there to read', async () => {
    const original = fixture('text.pdf');
    const doc = pdfium.openSync(original);
    let objects: ReadonlyArray<PageObject>;
    let content: Uint8Array;
    let text: string;
    try {
      objects = await pdfium.pageObjects(doc, 0);
      content = await pdfium.pageContent(doc, 0);
      text = (await pdfium.textRuns(doc, 0)).map((r) => r.text).join('|');
    } finally {
      await pdfium.close(doc);
    }
    const first = objects.find((o) => o.kind === 'text');
    if (!first) throw new Error('no text');
    const plan: WritePlan = {
      ...emptyWritePlan(1),
      pages: [
        {
          source: 0,
          objects: {
            ...baseline(content, objects),
            edits: [{ kind: 'transform', index: first.index, matrix: [1, 0, 0, 1, 0, -50] }],
          },
        },
      ],
    };
    const result = await write(original, plan);
    expect(result.warnings).toEqual([]);
    const reopened = pdfium.openSync(result.bytes);
    try {
      const after = await pdfium.pageObjects(reopened, 0);
      expect(after[first.index]?.rect.y0).toBeCloseTo(first.rect.y0 - 50, 1);
      // Every other object is where it was.
      objects.forEach((o, i) => {
        if (i === first.index) return;
        expect(after[i]?.rect.x0).toBeCloseTo(o.rect.x0, 1);
        expect(after[i]?.rect.y0).toBeCloseTo(o.rect.y0, 1);
      });
      // PDFium's text page may add a synthetic space run where the gap changed; no glyph is lost.
      const runs = (await pdfium.textRuns(reopened, 0)).map((r) => r.text).join('|');
      expect(runs.replace(/[\s|]+/g, '')).toBe(text.replace(/[\s|]+/g, ''));
    } finally {
      await pdfium.close(reopened);
    }
  });

  it('leaves a page alone, with a warning, when the recorded objects do not match', async () => {
    const original = fixture('multipage.pdf');
    const doc = pdfium.openSync(original);
    let objects: ReadonlyArray<PageObject>;
    let content: Uint8Array;
    try {
      objects = await pdfium.pageObjects(doc, 0);
      content = await pdfium.pageContent(doc, 0);
    } finally {
      await pdfium.close(doc);
    }
    const plan: WritePlan = {
      ...emptyWritePlan(5),
      pages: [
        {
          source: 0,
          objects: {
            ...baseline(content, objects),
            kinds: [...objects.map((o) => o.kind), 'image'],
            edits: [{ kind: 'remove', index: 0 }],
          },
        },
        { source: 1 },
        { source: 2 },
        { source: 3 },
        { source: 4 },
      ],
    };
    const result = await write(original, plan);
    expect(result.applied).not.toContain('objects');
    expect(result.warnings.join(' ')).toContain('no longer match');
    const saved = await readPageContent(result.bytes, 0);
    expect(saved && serialise(parse(saved), parse(saved).ops)).toEqual(content);
  });

  it('refuses a broken paste and an edit it cannot apply, and says so', async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const page = pdf.addPage([200, 200]);
    page.drawRectangle({ x: 10, y: 10, width: 50, height: 50, color: rgb(0, 0, 0) });
    const original = await pdf.save({ useObjectStreams: false });
    const doc = pdfium.openSync(original);
    let objects: ReadonlyArray<PageObject>;
    let content: Uint8Array;
    try {
      objects = await pdfium.pageObjects(doc, 0);
      content = await pdfium.pageContent(doc, 0);
    } finally {
      await pdfium.close(doc);
    }
    const bad = await write(original, {
      ...emptyWritePlan(1),
      pages: [
        {
          source: 0,
          objects: {
            ...baseline(content, objects),
            edits: [
              {
                kind: 'insert',
                pdf: toBase64(new Uint8Array([1, 2, 3])),
                matrix: [1, 0, 0, 1, 0, 0],
              },
            ],
          },
        },
      ],
    });
    expect(bad.warnings.join(' ')).toContain('could not be embedded');
    const missing = await write(original, {
      ...emptyWritePlan(1),
      pages: [
        {
          source: 0,
          objects: { ...baseline(content, objects), edits: [{ kind: 'remove', index: 7 }] },
        },
      ],
    });
    expect(missing.warnings.join(' ')).toContain('no object 7');
    expect(missing.applied).not.toContain('objects');
  });
});
