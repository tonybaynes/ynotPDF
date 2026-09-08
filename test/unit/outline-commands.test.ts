/**
 * M12's first acceptance test: **add / rename / nest / delete / reorder a bookmark, then undo
 * all of it, and the tree equals the original** — plus the tree algebra underneath it and the
 * destination and attachment commands that share the same shape.
 *
 * The tree functions are pure, so they are tested directly; the commands are tested through a
 * real `Document` over `FakeEngine`, which is what M20's own suite does.
 */

import { describe, expect, it } from 'vitest';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import type { ModelOutlineItem } from '@core/model';
import { replayJournal, serialiseJournal } from '@core/Journal';
import {
  AddAttachmentCommand,
  AddBookmarkCommand,
  AddDestinationCommand,
  DeleteAttachmentCommand,
  DeleteBookmarkCommand,
  DeleteDestinationCommand,
  DescribeAttachmentCommand,
  MoveBookmarkCommand,
  RenameBookmarkCommand,
  RenameDestinationCommand,
  SetBookmarkStyleCommand,
  SetBookmarkTargetCommand,
  SetDestinationCommand,
  registerNavigationCodecs,
} from '@modules/M12-navigation-panels/commands';
import {
  childrenOf,
  depthOf,
  expandToLevel,
  indent,
  insert,
  isDescendant,
  maxDepth,
  move,
  outdent,
  positionOf,
  removeSubtree,
  restoreSubtree,
  rootsOf,
  subtreeOf,
  walk,
} from '@modules/M12-navigation-panels/bookmarks/tree';
import { openFake, RICH_SPEC } from './core/helpers';

registerNavigationCodecs();

/** A bookmark node with only the fields a tree test cares about. */
function node(id: string, parentId: string | null, childIds: string[] = []): ModelOutlineItem {
  return {
    id: id as ModelId,
    title: id,
    parentId: parentId as ModelId | null,
    childIds: childIds as ModelId[],
    destinationId: null,
    uri: null,
    open: true,
    bold: false,
    italic: false,
    color: null,
  };
}

/**
 *  a
 *  ├ b
 *  │ └ c
 *  └ d
 *  e
 */
function sample(): ModelOutlineItem[] {
  return [
    node('a', null, ['b', 'd']),
    node('b', 'a', ['c']),
    node('c', 'b'),
    node('d', 'a'),
    node('e', null),
  ];
}

/** The tree as `id:depth` strings, in tree order — a readable shape for an assertion. */
function shape(list: ReadonlyArray<ModelOutlineItem>): string[] {
  return walk(list).map((r) => `${r.item.id}:${String(r.depth)}`);
}

describe('outline tree algebra', () => {
  it('walks parents before children, with depths', () => {
    expect(shape(sample())).toEqual(['a:0', 'b:1', 'c:2', 'd:1', 'e:0']);
    expect(maxDepth(sample())).toBe(2);
    expect(depthOf(sample(), 'c' as ModelId)).toBe(2);
    expect(rootsOf(sample()).map((o) => o.id)).toEqual(['a', 'e']);
    expect(childrenOf(sample(), 'a' as ModelId).map((o) => o.id)).toEqual(['b', 'd']);
  });

  it('shows a node whose parent is missing rather than losing it', () => {
    const broken = [node('a', null, []), node('orphan', 'gone')];
    expect(shape(broken)).toEqual(['a:0', 'orphan:0']);
  });

  it('inserts at a position', () => {
    const list = insert(sample(), node('x', null), { parentId: 'a' as ModelId, index: 1 });
    expect(shape(list)).toEqual(['a:0', 'b:1', 'c:2', 'x:1', 'd:1', 'e:0']);
    const asRoot = insert(sample(), node('y', null), { parentId: null, index: 0 });
    expect(shape(asRoot)).toEqual(['y:0', 'a:0', 'b:1', 'c:2', 'd:1', 'e:0']);
  });

  it('removes a subtree and puts it back exactly', () => {
    const before = sample();
    const { list, removed, at } = removeSubtree(before, 'b' as ModelId);
    expect(shape(list)).toEqual(['a:0', 'd:1', 'e:0']);
    expect(removed.map((o) => o.id)).toEqual(['b', 'c']);
    expect(at).toEqual({ parentId: 'a', index: 0 });
    expect(shape(restoreSubtree(list, removed, at))).toEqual(shape(before));
  });

  it('moves, and refuses to move a node into itself', () => {
    expect(shape(move(sample(), 'b' as ModelId, { parentId: null, index: 0 }))).toEqual([
      'b:0',
      'c:1',
      'a:0',
      'd:1',
      'e:0',
    ]);
    // A drag of `a` into its own grandchild is the drag nobody meant.
    expect(shape(move(sample(), 'a' as ModelId, { parentId: 'c' as ModelId, index: 0 }))).toEqual(
      shape(sample()),
    );
    expect(isDescendant(sample(), 'c' as ModelId, 'a' as ModelId)).toBe(true);
    expect(isDescendant(sample(), 'a' as ModelId, 'c' as ModelId)).toBe(false);
  });

  it('reorders inside one parent by the index after removal', () => {
    expect(shape(move(sample(), 'b' as ModelId, { parentId: 'a' as ModelId, index: 1 }))).toEqual([
      'a:0',
      'd:1',
      'b:1',
      'c:2',
      'e:0',
    ]);
  });

  it('indents under the previous sibling and outdents to after the parent', () => {
    expect(shape(indent(sample(), 'd' as ModelId))).toEqual(['a:0', 'b:1', 'c:2', 'd:2', 'e:0']);
    // The first child of its parent has no previous sibling, so nothing happens.
    expect(shape(indent(sample(), 'b' as ModelId))).toEqual(shape(sample()));
    expect(shape(outdent(sample(), 'c' as ModelId))).toEqual(['a:0', 'b:1', 'c:1', 'd:1', 'e:0']);
    // A root cannot outdent.
    expect(shape(outdent(sample(), 'a' as ModelId))).toEqual(shape(sample()));
  });

  it('expands to a level', () => {
    const open = expandToLevel(sample(), 1);
    expect(open.filter((o) => o.open).map((o) => o.id)).toEqual(['a', 'e']);
    expect(
      expandToLevel(sample(), 2)
        .filter((o) => o.open)
        .map((o) => o.id),
    ).toEqual(['a', 'b', 'd', 'e']);
  });

  it('reports positions and subtrees', () => {
    expect(positionOf(sample(), 'd' as ModelId)).toEqual({ parentId: 'a', index: 1 });
    expect(positionOf(sample(), 'e' as ModelId)).toEqual({ parentId: null, index: 1 });
    expect(positionOf(sample(), 'nope' as ModelId)).toBeNull();
    expect(subtreeOf(sample(), 'a' as ModelId).map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

/** The fixture's outline: "Chapter 1" with one child, "Section 1.1". */
async function withOutline(): Promise<{ doc: Document; chapter: ModelId; section: ModelId }> {
  const { doc } = await openFake(RICH_SPEC);
  const [chapter, section] = doc.state.outline;
  if (!chapter || !section) throw new Error('fixture has no outline');
  return { doc, chapter: chapter.id, section: section.id };
}

describe('bookmark commands', () => {
  it('acceptance: add, rename, nest, reorder and delete, then undo all — the tree is the original', async () => {
    const { doc, chapter, section } = await withOutline();
    const original = JSON.stringify(doc.state.outline);
    const originalDestinations = JSON.stringify(doc.state.destinations);

    const add = new AddBookmarkCommand(doc, {
      title: 'Chapter 2',
      at: { parentId: null, index: 1 },
      destination: {
        pageId: doc.state.pages[2]?.id ?? null,
        fit: 'xyz',
        left: 0,
        top: 700,
        zoom: 1,
        rect: null,
      },
    });
    await doc.apply(add);
    expect(shape(doc.state.outline).length).toBe(3);

    await doc.apply(new RenameBookmarkCommand(doc, add.newId, 'Chapter two'));
    doc.breakMerge();
    expect(doc.outlineItem(add.newId)?.title).toBe('Chapter two');

    // Nest the new chapter under the first one, then move it back out to the end.
    await doc.apply(new MoveBookmarkCommand(doc, add.newId, { parentId: chapter, index: 1 }));
    expect(depthOf(doc.state.outline, add.newId)).toBe(1);
    await doc.apply(new MoveBookmarkCommand(doc, section, { parentId: null, index: 0 }));
    expect(depthOf(doc.state.outline, section)).toBe(0);

    await doc.apply(new SetBookmarkStyleCommand(doc, chapter, { bold: true, color: 0x3392ff }));
    await doc.apply(new DeleteBookmarkCommand(doc, chapter));
    expect(doc.outlineItem(chapter)).toBeNull();

    expect(doc.state.writeIntents).toContain('outline');
    while (doc.undo.state.canUndo) await doc.undoLast();

    expect(JSON.stringify(doc.state.outline)).toBe(original);
    expect(JSON.stringify(doc.state.destinations)).toBe(originalDestinations);
    expect(doc.validate()).toEqual([]);
  });

  it('deleting a parent takes its children and gives them back in order', async () => {
    const { doc, chapter } = await withOutline();
    const before = shape(doc.state.outline);
    const command = new DeleteBookmarkCommand(doc, chapter);
    expect(command.label).toBe('Delete 2 bookmarks');
    await doc.apply(command);
    expect(doc.state.outline).toEqual([]);
    await doc.undoLast();
    expect(shape(doc.state.outline)).toEqual(before);
  });

  it('a bookmark deleted with its own destination gets it back, and a named one is left alone', async () => {
    const { doc, section } = await withOutline();
    const named = doc.state.destinations.filter((d) => d.name !== null).length;
    const before = doc.state.destinations.length;
    await doc.apply(new DeleteBookmarkCommand(doc, section));
    expect(doc.state.destinations.length).toBe(before - 1);
    expect(doc.state.destinations.filter((d) => d.name !== null).length).toBe(named);
    await doc.undoLast();
    expect(doc.state.destinations.length).toBe(before);
  });

  it('renames merge into one undo step and keep the write intent', async () => {
    const { doc, chapter } = await withOutline();
    await doc.apply(new RenameBookmarkCommand(doc, chapter, 'C'));
    await doc.apply(new RenameBookmarkCommand(doc, chapter, 'Ch'));
    await doc.apply(new RenameBookmarkCommand(doc, chapter, 'Cha'));
    expect(doc.undo.state.length).toBe(1);
    expect(doc.state.writeIntents).toContain('outline');
    expect(doc.outlineItem(chapter)?.title).toBe('Cha');
    await doc.undoLast();
    expect(doc.outlineItem(chapter)?.title).toBe('Chapter 1');
  });

  it('sets a destination from the current view, and a URI action, and undoes both', async () => {
    const { doc, chapter } = await withOutline();
    const before = doc.outlineItem(chapter)?.destinationId ?? null;
    await doc.apply(
      new SetBookmarkTargetCommand(doc, chapter, {
        destination: {
          pageId: doc.state.pages[3]?.id ?? null,
          fit: 'xyz',
          left: 10,
          top: 200,
          zoom: 2,
          rect: null,
        },
      }),
    );
    const dest = doc.destination(doc.outlineItem(chapter)?.destinationId ?? ('' as ModelId));
    expect(dest?.top).toBe(200);
    expect(dest?.pageId).toBe(doc.state.pages[3]?.id);

    await doc.apply(
      new SetBookmarkTargetCommand(doc, chapter, { uri: 'https://example.org', destination: null }),
    );
    expect(doc.outlineItem(chapter)?.uri).toBe('https://example.org');
    expect(doc.outlineItem(chapter)?.destinationId).toBeNull();

    await doc.undoLast();
    await doc.undoLast();
    expect(doc.outlineItem(chapter)?.destinationId).toBe(before);
    expect(doc.destination(before ?? ('' as ModelId))?.top).toBe(800);
  });
});

describe('destination commands', () => {
  it('adds, renames, re-aims and deletes a named destination, and undoes each', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const before = JSON.stringify(doc.state.destinations);
    const page = doc.state.pages[1]?.id ?? null;

    const add = new AddDestinationCommand(doc, {
      name: 'chapter-two',
      destination: { pageId: page, fit: 'xyz', left: 0, top: 500, zoom: 1, rect: null },
    });
    await doc.apply(add);
    expect(doc.destination(add.newId)?.name).toBe('chapter-two');
    expect(doc.state.writeIntents).toContain('destinations');

    await doc.apply(new RenameDestinationCommand(doc, add.newId, 'two'));
    doc.breakMerge();
    expect(doc.destination(add.newId)?.name).toBe('two');

    await doc.apply(
      new SetDestinationCommand(doc, add.newId, {
        pageId: page,
        fit: 'fit',
        left: null,
        top: null,
        zoom: null,
        rect: null,
      }),
    );
    expect(doc.destination(add.newId)?.fit).toBe('fit');

    await doc.apply(new DeleteDestinationCommand(doc, add.newId));
    expect(doc.destination(add.newId)).toBeNull();

    while (doc.undo.state.canUndo) await doc.undoLast();
    expect(JSON.stringify(doc.state.destinations)).toBe(before);
  });
});

describe('attachment commands', () => {
  it('adds a file through the engine, describes it and deletes it — each undone exactly', async () => {
    const { doc, engine } = await openFake(RICH_SPEC);
    const before = doc.state.attachments.length;
    const bytes = new TextEncoder().encode('hello');

    const add = new AddAttachmentCommand(doc, {
      name: 'note.txt',
      bytes,
      description: 'A note',
      mimeType: 'text/plain',
    });
    await doc.apply(add);
    expect(engine.calls).toContain('addAttachment');
    expect(doc.attachment(add.newId)?.name).toBe('note.txt');
    expect(doc.state.attachments.length).toBe(before + 1);
    expect(doc.state.writeIntents).toContain('attachments');

    await doc.apply(new DescribeAttachmentCommand(doc, add.newId, 'Edited'));
    doc.breakMerge();
    expect(doc.attachment(add.newId)?.description).toBe('Edited');

    await doc.apply(new DeleteAttachmentCommand(doc, add.newId));
    expect(doc.attachment(add.newId)).toBeNull();
    await doc.undoLast();
    expect(doc.attachment(add.newId)?.name).toBe('note.txt');
    // The bytes came back with it.
    const record = doc.attachment(add.newId);
    expect(record).not.toBeNull();
    if (record) {
      expect(await engine.attachmentData(doc.handle, record.engineId)).toEqual(bytes);
    }

    while (doc.undo.state.canUndo) await doc.undoLast();
    expect(doc.state.attachments.length).toBe(before);
    expect(doc.validate()).toEqual([]);
  });

  it('keeps every attachment id pointing at its own file after a delete renumbers them', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const first = new AddAttachmentCommand(doc, {
      name: 'one.txt',
      bytes: new TextEncoder().encode('one'),
    });
    await doc.apply(first);
    const second = new AddAttachmentCommand(doc, {
      name: 'two.txt',
      bytes: new TextEncoder().encode('two'),
    });
    await doc.apply(second);

    // Deleting the *first* embedded file shifts every engine key after it down by one.
    const original = doc.state.attachments[0];
    if (!original) throw new Error('no attachments');
    await doc.apply(new DeleteAttachmentCommand(doc, original.id));

    for (const attachment of doc.state.attachments) {
      const engineKey = doc.idTable.engineKey('attachment', attachment.id);
      expect(engineKey).toBe(attachment.engineId);
    }
    const bytes = await doc.engine.attachmentData(
      doc.handle,
      doc.attachment(first.newId)?.engineId ?? '',
    );
    expect(new TextDecoder().decode(bytes)).toBe('one');
  });
});

describe('the journal', () => {
  it('round-trips every M12 command through JSON and replays to the same tree', async () => {
    const { doc, chapter } = await withOutline();
    const add = new AddBookmarkCommand(doc, {
      title: 'New',
      at: { parentId: null, index: 0 },
      destination: {
        pageId: doc.state.pages[0]?.id ?? null,
        fit: 'fit',
        left: null,
        top: null,
        zoom: null,
        rect: null,
      },
    });
    await doc.apply(add);
    await doc.apply(new RenameBookmarkCommand(doc, add.newId, 'Renamed'));
    doc.breakMerge();
    await doc.apply(new MoveBookmarkCommand(doc, add.newId, { parentId: chapter, index: 0 }));
    await doc.apply(new SetBookmarkStyleCommand(doc, add.newId, { italic: true }));
    await doc.apply(
      new AddDestinationCommand(doc, {
        name: 'end',
        destination: {
          pageId: doc.state.pages[3]?.id ?? null,
          fit: 'fit',
          left: null,
          top: null,
          zoom: null,
          rect: null,
        },
      }),
    );
    await doc.apply(
      new AddAttachmentCommand(doc, { name: 'x.bin', bytes: new Uint8Array([1, 2, 3]) }),
    );

    const file = JSON.parse(JSON.stringify(serialiseJournal(doc))) as ReturnType<
      typeof serialiseJournal
    >;
    expect(file.complete).toBe(true);

    const { doc: fresh } = await openFake(RICH_SPEC);
    const result = await replayJournal(fresh, file.entries);
    expect(result.skipped).toBe(0);
    expect(shape(fresh.state.outline)).toEqual(shape(doc.state.outline));
    expect(fresh.state.outline.map((o) => o.title)).toEqual(doc.state.outline.map((o) => o.title));
    expect(fresh.state.destinations.map((d) => d.name)).toEqual(
      doc.state.destinations.map((d) => d.name),
    );
    expect(fresh.state.attachments.map((a) => a.name)).toEqual(
      doc.state.attachments.map((a) => a.name),
    );
  });
});
