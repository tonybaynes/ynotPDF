/**
 * M21 acceptance: the edits a reader makes survive a save and a reopen.
 *
 * The whole pipeline every time — a real `Document` over real PDFium, real commands, the real
 * plan builder, the real writer — and then the file is opened again in the engine and asked what
 * it holds. Nothing is asserted against an intermediate; only against what a reader would see.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Document } from '@core/Document';
import {
  DeletePagesCommand,
  MovePageCommand,
  RotatePagesCommand,
  SetMetadataCommand,
  SetPageBoxCommand,
  SetPageLabelCommand,
} from '@core/commands';
import { WRITE_PHASES, WriteCancelled, type WritePhase } from '@engine/Writer';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import { AddOutlineItemCommand } from '@modules/M21-save/commands';
import { buildWritePlan } from '@modules/M21-save/plan';
import type { PdfEngine } from '@engine/PdfEngine';
import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFPageLeaf } from 'pdf-lib';
import { engine, FIXTURES } from '../engine/helpers';
import { describeDocument } from '../roundtrip';

/** The first page leaf of a document, without the control-flow gymnastics `traverse` invites. */
function firstPageLeaf(pdf: PDFDocument): PDFPageLeaf {
  const leaves: PDFPageLeaf[] = [];
  pdf.catalog.Pages().traverse((node) => {
    if (node instanceof PDFPageLeaf) leaves.push(node);
  });
  const leaf = leaves[0];
  if (!leaf) throw new Error('the document should have a page');
  return leaf;
}

/** One of the five page boxes of page 0, read straight out of the dictionary. */
async function readPageBox(bytes: Uint8Array, name: string): Promise<number[] | null> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const array = firstPageLeaf(pdf).lookupMaybe(PDFName.of(name), PDFArray);
  if (!array) return null;
  return array.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : Number.NaN));
}

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/** Opens a fixture as a `Document` over the shared engine. */
async function open(name: string): Promise<{ doc: Document; eng: PdfEngine }> {
  const eng = await engine();
  const doc = await Document.open(eng, fixture(name));
  return { doc, eng };
}

/** Runs the whole save and hands back the bytes, without touching a disk. */
async function saveToBytes(doc: Document): Promise<Uint8Array> {
  const { plan, warnings } = buildWritePlan(doc);
  expect(warnings).toEqual([]);
  const base = await doc.engine.save(doc.handle);
  const result = await new FullRewriteWriter().write({ bytes: base, plan });
  expect(result.warnings).toEqual([]);
  return result.bytes;
}

/** Opens saved bytes and describes them, then closes the handle. */
async function reopen(eng: PdfEngine, bytes: Uint8Array): ReturnType<typeof describeDocument> {
  const handle = await eng.open(bytes);
  try {
    return await describeDocument(eng, handle);
  } finally {
    await eng.close(handle);
  }
}

describe('rotate, reorder, bookmark and title survive a save', () => {
  it('all four are in the reopened file', async () => {
    const { doc, eng } = await open('multipage.pdf');
    const before = doc.state.pages.map((p) => p.id);
    const [first, second, third] = before;
    if (!first || !second || !third) throw new Error('the fixture should have five pages');

    // Rotate page 1, move page 3 to the front, add a bookmark on it, change the title.
    await doc.apply(new RotatePagesCommand(doc, [first], 90, true));
    await doc.apply(new MovePageCommand(doc, third, 0));
    await doc.apply(
      new AddOutlineItemCommand(doc, { title: 'Chapter One', target: { pageId: third } }),
    );
    await doc.apply(new SetMetadataCommand(doc, { title: 'Saved by ynotPDF' }));

    const saved = await saveToBytes(doc);
    const after = await reopen(eng, saved);
    await doc.close();

    expect(after.pageCount).toBe(5);
    // The moved page is first now, and it is the one that says "Page 3 of 5".
    expect(after.pages[0]?.['text']).toContain('Page 3');
    // The rotated page kept its rotation through the move.
    const rotations = after.pages.map((p) => p['rotation']);
    expect(rotations).toEqual([0, 90, 0, 0, 90]);
    expect(after.metadata['title']).toBe('Saved by ynotPDF');
    expect(after.outline).toHaveLength(1);
    expect(after.outline[0]?.['title']).toBe('Chapter One');
    // The bookmark points at the page it was made on, which is now the first.
    expect(after.outline[0]?.['destPage']).toBe(0);
  });

  it('a deleted page is gone, and so is what pointed at it', async () => {
    const { doc, eng } = await open('outline.pdf');
    const originalOutline = doc.state.outline.length;
    expect(originalOutline).toBeGreaterThan(0);
    const target = doc.state.destinations.find((d) => d.pageId !== null);
    if (!target?.pageId) throw new Error('the fixture should have a destination');

    await doc.apply(new DeletePagesCommand(doc, [target.pageId]));
    const saved = await saveToBytes(doc);
    const after = await reopen(eng, saved);
    const pagesBefore = doc.pageCount;
    await doc.close();

    expect(after.pageCount).toBe(pagesBefore);
    // The bookmarks are still there — a heading the reader wrote is not deleted with a page —
    // but none of them points into nothing.
    expect(after.outline.length).toBe(originalOutline);
    for (const item of after.outline) {
      const page = item['destPage'];
      if (page !== null) expect(page).toBeLessThan(after.pageCount);
    }
  });

  it('page labels round-trip, compressed and uncompressed', async () => {
    const { doc, eng } = await open('multipage.pdf');
    // "1".."3" compress to one decimal range; the last two do not.
    const wanted = ['1', '2', '3', 'Appendix', 'Colophon'];
    for (const [i, label] of wanted.entries()) {
      await doc.apply(new SetPageLabelCommand(doc, doc.page(i).id, label));
    }

    const saved = await saveToBytes(doc);
    const after = await reopen(eng, saved);
    await doc.close();
    expect(after.pages.map((p) => p['label'])).toEqual(['1', '2', '3', 'Appendix', 'Colophon']);
  });

  it('a prefixed run of labels round-trips too', async () => {
    const { doc, eng } = await open('multipage.pdf');
    const wanted = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5'];
    for (const [i, label] of wanted.entries()) {
      await doc.apply(new SetPageLabelCommand(doc, doc.page(i).id, label));
    }
    const after = await reopen(eng, await saveToBytes(doc));
    await doc.close();
    expect(after.pages.map((p) => p['label'])).toEqual(wanted);
  });

  it('the boxes PDFium cannot set are written', async () => {
    const { doc } = await open('blank.pdf');
    const pageId = doc.page(0).id;
    const trim = { x0: 20, y0: 20, x1: 500, y1: 700 };
    await doc.apply(new SetPageBoxCommand(doc, pageId, 'trim', trim));
    expect(doc.state.writeIntents).toContain('page-boxes');
    const saved = await saveToBytes(doc);
    await doc.close();

    // `PdfEngine` reports MediaBox and CropBox only, so the other three are read straight out of
    // the page dictionary — which is also the only way to prove they reached the file at all.
    const box = await readPageBox(saved, 'TrimBox');
    expect(box).toEqual([20, 20, 500, 700]);
    // MediaBox is untouched: the plan named one box and the writer wrote one box.
    expect(await readPageBox(saved, 'BleedBox')).toBeNull();
  });

  it('an added bookmark can be undone, and then is not written', async () => {
    const { doc, eng } = await open('blank.pdf');
    await doc.apply(
      new AddOutlineItemCommand(doc, { title: 'Gone', target: { pageId: doc.page(0).id } }),
    );
    expect(doc.state.outline).toHaveLength(1);
    await doc.undoLast();
    expect(doc.state.outline).toHaveLength(0);
    expect(doc.state.destinations).toHaveLength(0);

    const after = await reopen(eng, await saveToBytes(doc));
    await doc.close();
    expect(after.outline).toHaveLength(0);
  });
});

describe('progress and cancellation', () => {
  it('reports every phase it runs, in order, ending at 1', async () => {
    const { doc } = await open('multipage.pdf');
    await doc.apply(new SetMetadataCommand(doc, { title: 'Progress' }));
    const { plan } = buildWritePlan(doc);
    const base = await doc.engine.save(doc.handle);
    const seen: { fraction: number; phase: WritePhase }[] = [];
    const result = await new FullRewriteWriter().write({
      bytes: base,
      plan,
      progress: (fraction, phase) => seen.push({ fraction, phase }),
    });
    await doc.close();

    expect(result.applied).toContain('metadata');
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.at(-1)?.phase).toBe('serialise');
    expect(seen.at(-1)?.fraction).toBeCloseTo(1, 5);
    // Progress never goes backwards, and every phase it names is a real one.
    let last = -1;
    for (const step of seen) {
      expect(WRITE_PHASES).toContain(step.phase);
      expect(step.fraction).toBeGreaterThanOrEqual(last);
      last = step.fraction;
    }
  });

  it('an aborted write rejects with WriteCancelled and produces nothing', async () => {
    const { doc } = await open('multipage.pdf');
    const { plan } = buildWritePlan(doc);
    const base = await doc.engine.save(doc.handle);
    const controller = new AbortController();
    const promise = new FullRewriteWriter().write({
      bytes: base,
      plan,
      signal: controller.signal,
      // The first phase boundary is where a cancel is seen; abort as soon as one is reported.
      progress: () => {
        controller.abort();
      },
    });
    await expect(promise).rejects.toThrow(WriteCancelled);
    await doc.close();
  });

  it('a write aborted before it starts never parses anything', async () => {
    const { doc } = await open('blank.pdf');
    const { plan } = buildWritePlan(doc);
    const base = await doc.engine.save(doc.handle);
    const controller = new AbortController();
    controller.abort();
    await expect(
      new FullRewriteWriter().write({ bytes: base, plan, signal: controller.signal }),
    ).rejects.toThrow(WriteCancelled);
    await doc.close();
  });
});

describe('the writer refuses what it cannot do', () => {
  it('a plan with no pages is refused rather than written empty', async () => {
    const { doc } = await open('blank.pdf');
    const { plan } = buildWritePlan(doc);
    const base = await doc.engine.save(doc.handle);
    await doc.close();
    await expect(
      new FullRewriteWriter().write({ bytes: base, plan: { ...plan, pages: [] } }),
    ).rejects.toThrow(/no pages/i);
  });

  it('a reorder whose pages are all missing is refused, not written kidless', async () => {
    const { doc } = await open('blank.pdf');
    const { plan } = buildWritePlan(doc);
    const base = await doc.engine.save(doc.handle);
    await doc.close();
    await expect(
      new FullRewriteWriter().write({
        bytes: base,
        plan: { ...plan, pagesUnchanged: false, pages: [{ source: 99 }] },
      }),
    ).rejects.toThrow(/none of the planned pages/i);
  });

  it('bytes that are not a PDF are refused with a reason', async () => {
    const { doc } = await open('blank.pdf');
    const { plan } = buildWritePlan(doc);
    await doc.close();
    await expect(
      new FullRewriteWriter().write({ bytes: new TextEncoder().encode('not a pdf'), plan }),
    ).rejects.toMatchObject({ name: 'WriteUnsupported', reason: 'corrupt' });
  });
});
