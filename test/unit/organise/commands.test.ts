/**
 * M40's document commands, against the in-memory engine (M20's `FakeEngine`).
 *
 * What these have to prove is what M20's own build log says is easy to get wrong: that undo puts
 * the document back *exactly*, that ids survive, that the engine and the model stay in step, and
 * that a command can describe itself well enough for the journal to replay it into the same
 * document twice over.
 */

import { describe, expect, it } from 'vitest';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import { deserialiseCommand, serialiseCommand } from '@core/Journal';
import { DeletePagesCommand } from '@core/commands';
import {
  ImportPagesCommand,
  PruneOutlineCommand,
  ReorderPagesCommand,
  SetPageLabelsCommand,
  danglingBookmarks,
  fromBase64,
  orderAfterMove,
  orderAfterReverse,
  orderAfterSwap,
  registerOrganiseCodecs,
  toBase64,
} from '@modules/M40-organise-pages/commands';
import type { FakeEngine } from '../core/fakeEngine';
import { must, openFake, pageIds, RICH_SPEC } from '../core/helpers';

registerOrganiseCodecs();

/** A five-page document with plain labels. */
async function open(pageCount = 5): Promise<{ doc: Document; engine: FakeEngine }> {
  return await openFake({ pageCount });
}

/** The page order as labels, which is what a reader would actually see. */
const order = (doc: Document): string[] => doc.state.pages.map((p) => p.label);

describe('the reordering arithmetic', () => {
  const pages = ['a', 'b', 'c', 'd', 'e'] as unknown as ModelId[];

  it('moves one page to the front and to the back', () => {
    expect(orderAfterMove(pages, [must(pages[2])], 0)).toEqual(['c', 'a', 'b', 'd', 'e']);
    expect(orderAfterMove(pages, [must(pages[0])], 5)).toEqual(['b', 'c', 'd', 'e', 'a']);
  });

  it('keeps a multi-selection in its own order, however far it moves', () => {
    expect(orderAfterMove(pages, [must(pages[0]), must(pages[3])], 5)).toEqual([
      'b',
      'c',
      'e',
      'a',
      'd',
    ]);
  });

  it('accounts for the pages that leave from before the insertion point', () => {
    // Moving a and b to "before d" must land them before d, not two places further on.
    expect(orderAfterMove(pages, [must(pages[0]), must(pages[1])], 3)).toEqual([
      'c',
      'a',
      'b',
      'd',
      'e',
    ]);
  });

  it('is a no-op when the pages are already there', () => {
    expect(orderAfterMove(pages, [must(pages[1])], 1)).toEqual([...pages]);
  });

  it('swaps two pages and leaves the rest', () => {
    expect(orderAfterSwap(pages, must(pages[0]), must(pages[4]))).toEqual([
      'e',
      'b',
      'c',
      'd',
      'a',
    ]);
  });

  it('reverses a subset in the slots that subset occupies', () => {
    // Reversing a, c and e puts e where a was, c where c was, a where e was.
    expect(orderAfterReverse(pages, [must(pages[0]), must(pages[2]), must(pages[4])])).toEqual([
      'e',
      'b',
      'c',
      'd',
      'a',
    ]);
  });

  it('reverses the whole document when every page is named', () => {
    expect(orderAfterReverse(pages, pages)).toEqual(['e', 'd', 'c', 'b', 'a']);
  });
});

describe('ReorderPagesCommand', () => {
  it('puts the pages in the order asked and undoes exactly', async () => {
    const { doc } = await open();
    const before = doc.snapshot();
    const ids = pageIds(doc);
    const reversed = [...ids].reverse();
    const command = new ReorderPagesCommand(doc, reversed, 'Reverse pages');
    await doc.apply(command);
    expect(order(doc)).toEqual(['5', '4', '3', '2', '1']);
    await doc.undoLast();
    expect(doc.snapshot()).toEqual(before);
  });

  it('records the page-order intent, because the engine keeps its own order', async () => {
    const { doc } = await open();
    const command = new ReorderPagesCommand(doc, [...pageIds(doc)].reverse());
    await doc.apply(command);
    expect(doc.state.writeIntents).toContain('page-order');
  });

  it('knows when it would change nothing', async () => {
    const { doc } = await open();
    expect(new ReorderPagesCommand(doc, pageIds(doc)).isNoop).toBe(true);
    expect(new ReorderPagesCommand(doc, [...pageIds(doc)].reverse()).isNoop).toBe(false);
  });

  it('keeps the pages an order forgot to mention, rather than dropping them', async () => {
    const { doc } = await open();
    const ids = pageIds(doc);
    // An order naming only the last two: the other three must survive, in their own order.
    await doc.apply(new ReorderPagesCommand(doc, [must(ids[4]), must(ids[3])]));
    expect(order(doc)).toEqual(['5', '4', '1', '2', '3']);
  });

  it('ignores an order that names a page the document no longer has', async () => {
    const { doc } = await open();
    const ids = pageIds(doc);
    await doc.apply(new DeletePagesCommand(doc, [must(ids[0])]));
    await doc.apply(new ReorderPagesCommand(doc, [must(ids[0]), must(ids[4])]));
    expect(doc.pageCount).toBe(4);
    expect(order(doc)).toEqual(['5', '2', '3', '4']);
  });

  it('redoes what it undid', async () => {
    const { doc } = await open();
    await doc.apply(new ReorderPagesCommand(doc, [...pageIds(doc)].reverse()));
    const after = doc.snapshot();
    await doc.undoLast();
    await doc.redoLast();
    expect(doc.snapshot()).toEqual(after);
  });

  it('carries annotations with the pages they are on', async () => {
    const { doc } = await openFake(RICH_SPEC);
    await doc.loadAnnotations(doc.page(0).id);
    const firstPage = doc.page(0).id;
    const notes = doc.annotations(firstPage).length;
    expect(notes).toBeGreaterThan(0);
    await doc.apply(new ReorderPagesCommand(doc, [...pageIds(doc)].reverse()));
    // The page moved to the end; its annotations are still filed under it.
    expect(doc.pageIndex(firstPage)).toBe(doc.pageCount - 1);
    expect(doc.annotations(firstPage)).toHaveLength(notes);
  });

  it('round-trips through the journal', async () => {
    const { doc } = await open();
    const command = new ReorderPagesCommand(doc, [...pageIds(doc)].reverse(), 'Reverse pages');
    await doc.apply(command);
    const entry = serialiseCommand(command);
    const rebuilt = deserialiseCommand(doc, entry);
    expect(rebuilt?.label).toBe('Reverse pages');
  });
});

describe('ImportPagesCommand', () => {
  /** `FakeEngine.open` makes a document with `bytes[0]` pages, which is all these tests need. */
  const sourceBytes = (pages: number): Uint8Array => Uint8Array.from([pages, 0, 0]);

  it('inserts the pages at the position asked, and undo removes exactly them', async () => {
    const { doc } = await open();
    const before = doc.snapshot();
    const command = new ImportPagesCommand(doc, {
      bytes: sourceBytes(3),
      pages: [0, 1, 2],
      at: 2,
      sizes: [
        { width: 100, height: 200 },
        { width: 100, height: 200 },
        { width: 100, height: 200 },
      ],
    });
    await doc.apply(command);
    expect(doc.pageCount).toBe(8);
    expect(command.pageIds).toHaveLength(3);
    // They went in at index 2, so the original page 3 is now page 6.
    expect(doc.pageIndex(must(command.pageIds[0]))).toBe(2);
    await doc.undoLast();
    expect(doc.snapshot()).toEqual(before);
  });

  it('gives the inserted pages the sizes they came with', async () => {
    const { doc } = await open();
    const command = new ImportPagesCommand(doc, {
      bytes: sourceBytes(1),
      pages: [0],
      at: 0,
      sizes: [{ width: 111, height: 222 }],
    });
    await doc.apply(command);
    const size = must(doc.pageSize(must(command.pageIds[0])));
    expect(size.width).toBe(111);
    expect(size.height).toBe(222);
  });

  it('binds the new pages to the engine so a render can reach them', async () => {
    const { doc, engine } = await open();
    const command = new ImportPagesCommand(doc, {
      bytes: sourceBytes(2),
      pages: [0, 1],
      at: 0,
      sizes: [
        { width: 100, height: 200 },
        { width: 100, height: 200 },
      ],
    });
    await doc.apply(command);
    expect(engine.calls).toContain('importPages');
    for (const id of command.pageIds) expect(doc.enginePage(id)).toBeTypeOf('number');
  });

  it('keeps the same model ids through undo and redo', async () => {
    const { doc } = await open();
    const command = new ImportPagesCommand(doc, {
      bytes: sourceBytes(2),
      pages: [0, 1],
      at: 1,
      sizes: [
        { width: 10, height: 10 },
        { width: 10, height: 10 },
      ],
    });
    await doc.apply(command);
    const ids = [...command.pageIds];
    await doc.undoLast();
    await doc.redoLast();
    expect([...command.pageIds]).toEqual(ids);
    for (const id of ids) expect(doc.pageById(id)).not.toBeNull();
  });

  it('grafts the source bookmarks onto the pages they came with', async () => {
    const { doc } = await open();
    const command = new ImportPagesCommand(doc, {
      bytes: sourceBytes(2),
      pages: [0, 1],
      at: 0,
      sizes: [
        { width: 10, height: 10 },
        { width: 10, height: 10 },
      ],
      bookmarks: [
        { title: 'Imported chapter', page: 0, parent: null },
        { title: 'Its section', page: 1, parent: 0 },
      ],
    });
    await doc.apply(command);
    const chapter = must(doc.state.outline.find((o) => o.title === 'Imported chapter'));
    const section = must(doc.state.outline.find((o) => o.title === 'Its section'));
    expect(chapter.childIds).toContain(section.id);
    // Each points at the page it arrived with.
    const dest = must(doc.destination(must(chapter.destinationId)));
    expect(dest.pageId).toBe(command.pageIds[0]);
    await doc.undoLast();
    expect(doc.state.outline.some((o) => o.title === 'Imported chapter')).toBe(false);
    expect(doc.state.destinations.some((d) => d.pageId === command.pageIds[0])).toBe(false);
  });

  it('keeps its own copy of the bytes, so a redo still has something to import', async () => {
    const { doc } = await open();
    const bytes = sourceBytes(1);
    const command = new ImportPagesCommand(doc, {
      bytes,
      pages: [0],
      at: 0,
      sizes: [{ width: 10, height: 10 }],
    });
    // The engine transfers a Uint8Array into its worker, which detaches the caller's buffer —
    // the bug M12 met with attachments. The command must not be looking at the caller's array.
    bytes.fill(0);
    await doc.apply(command);
    expect(doc.pageCount).toBe(6);
  });

  it('round-trips through the journal, ids and all', async () => {
    const { doc } = await open();
    const command = new ImportPagesCommand(doc, {
      bytes: sourceBytes(2),
      pages: [0, 1],
      at: 1,
      sizes: [
        { width: 10, height: 10 },
        { width: 10, height: 10 },
      ],
      labels: ['x', 'y'],
      bookmarks: [{ title: 'Chapter', page: 0, parent: null }],
    });
    await doc.apply(command);
    const ids = [...command.pageIds];
    const entry = serialiseCommand(command);
    expect(entry.payload).toBeTruthy();

    // Replay into a fresh document: the same ids must come back, or a later entry naming one of
    // them would silently do nothing while reporting success (M20's bug).
    const { doc: replayed } = await open();
    const rebuilt = must(deserialiseCommand(replayed, entry));
    await replayed.apply(rebuilt);
    expect(replayed.pageCount).toBe(7);
    for (const id of ids) expect(replayed.pageById(id)).not.toBeNull();
    expect(replayed.state.pages.map((p) => p.label)).toContain('x');
    expect(replayed.state.outline.some((o) => o.title === 'Chapter')).toBe(true);
  });

  it('does nothing at all when asked for no pages', async () => {
    const { doc } = await open();
    const before = doc.snapshot();
    await doc.apply(
      new ImportPagesCommand(doc, { bytes: sourceBytes(1), pages: [], at: 0, sizes: [] }),
    );
    expect(doc.snapshot()).toEqual(before);
  });
});

describe('base64, which is how the journal carries an inserted document', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = Uint8Array.from({ length: 512 }, (_, i) => (i * 37) % 256);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });

  it('round-trips an empty array', () => {
    expect(fromBase64(toBase64(new Uint8Array(0)))).toHaveLength(0);
  });

  it('round-trips bytes above 127, which a naive string conversion mangles', () => {
    const bytes = Uint8Array.from([0, 127, 128, 200, 255]);
    expect([...fromBase64(toBase64(bytes))]).toEqual([0, 127, 128, 200, 255]);
  });
});

describe('SetPageLabelsCommand', () => {
  it('renumbers several pages as one undo entry', async () => {
    const { doc } = await open();
    const ids = pageIds(doc);
    await doc.apply(
      new SetPageLabelsCommand(doc, [
        { pageId: must(ids[0]), label: 'i' },
        { pageId: must(ids[1]), label: 'ii' },
      ]),
    );
    expect(order(doc)).toEqual(['i', 'ii', '3', '4', '5']);
    expect(doc.undo.state.length).toBe(1);
    await doc.undoLast();
    expect(order(doc)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('records the page-labels intent, since PDFium has no setter for them', async () => {
    const { doc } = await open();
    await doc.apply(new SetPageLabelsCommand(doc, [{ pageId: must(pageIds(doc)[0]), label: 'i' }]));
    expect(doc.state.writeIntents).toContain('page-labels');
  });

  it('names itself by how many pages it changed', async () => {
    const { doc } = await open();
    const ids = pageIds(doc);
    expect(new SetPageLabelsCommand(doc, [{ pageId: must(ids[0]), label: 'i' }]).label).toBe(
      'Renumber page',
    );
    expect(
      new SetPageLabelsCommand(doc, [
        { pageId: must(ids[0]), label: 'i' },
        { pageId: must(ids[1]), label: 'ii' },
      ]).label,
    ).toBe('Renumber 2 pages');
  });

  it('round-trips through the journal', async () => {
    const { doc } = await open();
    const command = new SetPageLabelsCommand(doc, [
      { pageId: must(pageIds(doc)[0]), label: 'A-1' },
    ]);
    await doc.apply(command);
    const { doc: replayed } = await open();
    const rebuilt = must(deserialiseCommand(replayed, serialiseCommand(command)));
    await replayed.apply(rebuilt);
    expect(replayed.state.pages.map((p) => p.label)).toContain('A-1');
  });
});

describe('dangling bookmarks and PruneOutlineCommand', () => {
  it('finds the bookmarks aimed at pages that are about to go', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const goingPage = doc.page(0).id;
    const dangling = danglingBookmarks(doc, new Set<string>([goingPage]));
    expect(dangling).toHaveLength(1);
    expect(must(doc.outlineItem(must(dangling[0]))).title).toBe('Chapter 1');
  });

  it('lists the deepest first, so removing a parent cannot orphan the next id', async () => {
    const { doc } = await openFake(RICH_SPEC);
    // Both pages go, so both the chapter and its section dangle.
    const going = new Set<string>([doc.page(0).id, doc.page(1).id]);
    const dangling = danglingBookmarks(doc, going);
    expect(dangling).toHaveLength(2);
    const first = must(doc.outlineItem(must(dangling[0])));
    expect(first.title).toBe('Section 1.1');
  });

  it('removes a bookmark with everything under it, and undo puts the subtree back', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const before = doc.snapshot();
    const chapter = must(doc.state.outline.find((o) => o.title === 'Chapter 1'));
    await doc.apply(new PruneOutlineCommand(doc, [chapter.id]));
    expect(doc.state.outline).toHaveLength(0);
    await doc.undoLast();
    expect(doc.snapshot()).toEqual(before);
  });

  it('restores several removed subtrees in the right places', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const before = doc.snapshot();
    const going = new Set<string>([doc.page(0).id, doc.page(1).id]);
    await doc.apply(new PruneOutlineCommand(doc, danglingBookmarks(doc, going)));
    expect(doc.state.outline).toHaveLength(0);
    await doc.undoLast();
    expect(doc.snapshot()).toEqual(before);
  });

  it('does nothing, and records nothing, when no bookmark dangles', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const command = new PruneOutlineCommand(doc, []);
    await doc.apply(command);
    expect(command.writeIntents).toHaveLength(0);
    expect(doc.state.outline).toHaveLength(2);
  });

  it('deletes the page and its bookmark in one undo entry, as the module wires it', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const before = doc.snapshot();
    const going = doc.page(0).id;
    const dangling = danglingBookmarks(doc, new Set<string>([going]));
    await doc.batch('Delete page', async () => {
      await doc.apply(new DeletePagesCommand(doc, [going]));
      await doc.apply(new PruneOutlineCommand(doc, dangling));
    });
    expect(doc.pageCount).toBe(3);
    expect(doc.state.outline.some((o) => o.title === 'Chapter 1')).toBe(false);
    // One Ctrl+Z, both back.
    expect(doc.undo.state.length).toBe(1);
    await doc.undoLast();
    expect(doc.snapshot()).toEqual(before);
  });
});
