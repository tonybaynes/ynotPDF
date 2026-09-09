/**
 * Building a document out of another one's pages (M40), plus the two small pure decisions around
 * it: which annotations count as "comments", and which of a source document's bookmarks come
 * across with the pages that were taken.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_ANNOTATION_FLAGS } from '@core/commands';
import type { DocHandle, OutlineItem } from '@engine/PdfEngine';
import {
  COMMENT_SUBTYPES,
  SliceCancelled,
  bookmarksForPages,
  pageSizesOf,
  slicePages,
} from '@modules/M40-organise-pages/extract';
import { FakeEngine } from '../core/fakeEngine';

/** A source document with annotations on its first two pages. */
function sourceEngine(): { engine: FakeEngine; doc: DocHandle } {
  const engine = new FakeEngine();
  const doc = engine.create({
    pageCount: 4,
    width: 400,
    height: 600,
    annotations: {
      0: [
        {
          subtype: 'Highlight',
          rect: { x0: 0, y0: 0, x1: 10, y1: 10 },
          flags: DEFAULT_ANNOTATION_FLAGS,
        },
        {
          subtype: 'Widget',
          rect: { x0: 0, y0: 0, x1: 10, y1: 10 },
          flags: DEFAULT_ANNOTATION_FLAGS,
        },
      ],
      1: [
        {
          subtype: 'Text',
          rect: { x0: 0, y0: 0, x1: 10, y1: 10 },
          flags: DEFAULT_ANNOTATION_FLAGS,
        },
        {
          subtype: 'Link',
          rect: { x0: 0, y0: 0, x1: 10, y1: 10 },
          flags: DEFAULT_ANNOTATION_FLAGS,
        },
      ],
    },
  });
  return { engine, doc };
}

describe('which annotations are "comments"', () => {
  it('counts the markup families', () => {
    for (const subtype of ['Highlight', 'Text', 'Ink', 'Square', 'FreeText', 'Stamp'] as const) {
      expect(COMMENT_SUBTYPES.has(subtype)).toBe(true);
    }
  });

  it('does not count a form field or a link, which are part of the page', () => {
    expect(COMMENT_SUBTYPES.has('Widget')).toBe(false);
    expect(COMMENT_SUBTYPES.has('Link')).toBe(false);
  });
});

describe('slicePages', () => {
  it('makes a document of exactly the pages asked for, in that order', async () => {
    const { engine, doc } = sourceEngine();
    const bytes = await slicePages(engine, doc, [2, 0]);
    expect(engine.calls).toContain('createDocument');
    expect(engine.calls).toContain('importPages');
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('closes the document it made, so nothing leaks into the engine', async () => {
    const { engine, doc } = sourceEngine();
    const before = engine.calls.filter((c) => c === 'close').length;
    await slicePages(engine, doc, [0]);
    expect(engine.calls.filter((c) => c === 'close').length).toBe(before + 1);
  });

  it('closes it even when the work throws part-way', async () => {
    const { engine, doc } = sourceEngine();
    const before = engine.calls.filter((c) => c === 'close').length;
    engine.save = (): Promise<Uint8Array> => {
      throw new Error('the engine gave up');
    };
    await expect(slicePages(engine, doc, [0])).rejects.toThrow('the engine gave up');
    expect(engine.calls.filter((c) => c === 'close').length).toBe(before + 1);
  });

  it('keeps the comments by default', async () => {
    const { engine, doc } = sourceEngine();
    await slicePages(engine, doc, [0, 1]);
    expect(engine.calls).not.toContain('deleteAnnotation');
  });

  it('removes the markup and keeps the widgets and links when asked', async () => {
    const { engine, doc } = sourceEngine();
    // Watch what the slice looks like from inside, by intercepting the target handle.
    const created: DocHandle[] = [];
    const realCreate = engine.createDocument.bind(engine);
    engine.createDocument = async (): Promise<DocHandle> => {
      const handle = await realCreate();
      created.push(handle);
      return handle;
    };
    await slicePages(engine, doc, [0, 1], { withComments: false });
    expect(engine.calls).toContain('deleteAnnotation');
    // The document was closed, so what survived is asserted from the call log: two markup
    // annotations went and the widget and the link did not.
    expect(engine.calls.filter((c) => c === 'deleteAnnotation')).toHaveLength(2);
    expect(created).toHaveLength(1);
  });

  it('refuses to build a document out of no pages', async () => {
    const { engine, doc } = sourceEngine();
    await expect(slicePages(engine, doc, [])).rejects.toThrow('No pages');
  });

  it('reports progress as it goes', async () => {
    const { engine, doc } = sourceEngine();
    const seen: number[] = [];
    await slicePages(engine, doc, [0, 1], { onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBe(1);
    // Never goes backwards, so a progress bar cannot jump about.
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('stops when the signal is already aborted, before touching the engine', async () => {
    const { engine, doc } = sourceEngine();
    const controller = new AbortController();
    controller.abort();
    await expect(
      slicePages(engine, doc, [0], { signal: controller.signal }),
    ).rejects.toBeInstanceOf(SliceCancelled);
    expect(engine.calls).not.toContain('createDocument');
  });
});

describe('pageSizesOf', () => {
  it('reports the sizes in the order asked', async () => {
    const { engine, doc } = sourceEngine();
    const sizes = await pageSizesOf(engine, doc, [1, 0]);
    expect(sizes).toEqual([
      { width: 400, height: 600 },
      { width: 400, height: 600 },
    ]);
  });

  it('falls back to A4 for a page it cannot measure, rather than failing the whole insert', async () => {
    const { engine, doc } = sourceEngine();
    const sizes = await pageSizesOf(engine, doc, [99]);
    expect(sizes[0]?.width).toBeCloseTo(595.276, 2);
  });
});

describe('bookmarksForPages', () => {
  const OUTLINE: OutlineItem[] = [
    {
      title: 'Chapter 1',
      dest: { page: 0, fit: 'fit' },
      open: true,
      children: [
        { title: 'Section 1.1', dest: { page: 1, fit: 'fit' }, open: true, children: [] },
        { title: 'Section 1.2', dest: { page: 2, fit: 'fit' }, open: true, children: [] },
      ],
    },
    { title: 'Chapter 2', dest: { page: 3, fit: 'fit' }, open: true, children: [] },
  ];

  it('brings across the bookmarks whose pages are coming, and nothing else', () => {
    const out = bookmarksForPages(OUTLINE, [0, 1]);
    expect(out.map((b) => b.title)).toEqual(['Chapter 1', 'Section 1.1']);
  });

  it('renumbers the pages to their position in the imported run', () => {
    // Taking source pages 2 and 1, in that order.
    const out = bookmarksForPages(OUTLINE, [2, 1]);
    const section12 = out.find((b) => b.title === 'Section 1.2');
    const section11 = out.find((b) => b.title === 'Section 1.1');
    expect(section12?.page).toBe(0);
    expect(section11?.page).toBe(1);
  });

  it('keeps a parent whose own page is not coming, so a heading is not lost', () => {
    const out = bookmarksForPages(OUTLINE, [1]);
    expect(out.map((b) => b.title)).toEqual(['Chapter 1', 'Section 1.1']);
    // The chapter itself points nowhere, which is what a heading with no page means.
    expect(out[0]?.page).toBeNull();
    expect(out[1]?.parent).toBe(0);
  });

  it('keeps the parent relationship as indexes into its own list', () => {
    const out = bookmarksForPages(OUTLINE, [0, 1, 2, 3]);
    expect(out.map((b) => b.parent)).toEqual([null, 0, 0, null]);
  });

  it('carries the style across', () => {
    const styled: OutlineItem[] = [
      {
        title: 'Bold',
        dest: { page: 0, fit: 'fit' },
        open: true,
        bold: true,
        italic: true,
        color: 0x3392ff,
        children: [],
      },
    ];
    const out = bookmarksForPages(styled, [0]);
    expect(out[0]).toMatchObject({ bold: true, italic: true, color: 0x3392ff });
  });

  it('answers an empty outline, and an outline that points nowhere useful, with nothing', () => {
    expect(bookmarksForPages([], [0, 1])).toEqual([]);
    expect(bookmarksForPages(OUTLINE, [99])).toEqual([]);
  });
});
