/**
 * `AddOutlineItemCommand` (M21) — the one document command this module adds.
 *
 * It is scaffolding for the writer's outline path and the foundation M12's bookmarks panel will
 * be built on, so it is held to the same standard as M20's own commands: undo puts everything
 * back, the journal replays it to the same model, and a nested bookmark lands in the right place
 * in the flat list.
 */

import { describe, expect, it } from 'vitest';
import { serialiseCommand, deserialiseCommand, replayJournal } from '@core/Journal';
import { AddOutlineItemCommand, M21_COMMAND_ID } from '@modules/M21-save/commands';
import { must, openFake } from '../core/helpers';

describe('adding a bookmark', () => {
  it('adds the item and its destination, and undo removes both', async () => {
    const { doc } = await openFake();
    const before = doc.snapshot();
    const pageId = doc.page(2).id;

    const command = new AddOutlineItemCommand(doc, { title: 'Chapter', target: { pageId } });
    await doc.apply(command);

    const added = must(
      doc.state.outline.find((o) => o.id === command.outlineId),
      'added bookmark',
    );
    expect(added.title).toBe('Chapter');
    expect(added.parentId).toBeNull();
    const dest = must(
      doc.state.destinations.find((d) => d.id === added.destinationId),
      'destination',
    );
    expect(dest.pageId).toBe(pageId);
    // The engine has no outline, so the writer has to emit it.
    expect(doc.state.writeIntents).toContain('outline');

    await doc.undoLast();
    expect(doc.snapshot()).toEqual(before);
    await doc.close();
  });

  it('a bookmark with no target has no destination', async () => {
    const { doc } = await openFake();
    const destinations = doc.state.destinations.length;
    await doc.apply(new AddOutlineItemCommand(doc, { title: 'Just a heading' }));
    expect(doc.state.destinations).toHaveLength(destinations);
    expect(doc.state.outline.at(-1)?.destinationId).toBeNull();
    await doc.close();
  });

  it('a child goes in after its parent, and the parent lists it', async () => {
    const { doc } = await openFake();
    const parent = must(doc.state.outline[0], 'existing bookmark');
    const command = new AddOutlineItemCommand(doc, {
      title: 'Under it',
      parentId: parent.id,
      target: { pageId: doc.page(1).id },
    });
    await doc.apply(command);

    const flat = doc.state.outline;
    const parentAt = flat.findIndex((o) => o.id === parent.id);
    const childAt = flat.findIndex((o) => o.id === command.outlineId);
    expect(childAt).toBeGreaterThan(parentAt);
    // Parents come before their children in the flat list, which `validate()` checks too.
    expect(flat[parentAt]?.childIds).toContain(command.outlineId);
    expect(doc.validate()).toEqual([]);

    await doc.undoLast();
    expect(doc.state.outline.find((o) => o.id === parent.id)?.childIds).not.toContain(
      command.outlineId,
    );
    await doc.close();
  });

  it('redo puts it back where it was', async () => {
    const { doc } = await openFake();
    const command = new AddOutlineItemCommand(doc, {
      title: 'There and back',
      target: { pageId: doc.page(0).id },
    });
    await doc.apply(command);
    const after = doc.snapshot();
    await doc.undoLast();
    await doc.redoLast();
    expect(doc.snapshot()).toEqual(after);
    await doc.close();
  });
});

describe('the journal', () => {
  it('round-trips, and a replay rebuilds the same bookmark rather than a new one', async () => {
    const { doc } = await openFake();
    const pageId = doc.page(3).id;
    await doc.apply(
      new AddOutlineItemCommand(doc, {
        title: 'Recorded',
        target: { pageId, fit: 'fitH', top: 700 },
      }),
    );
    const wanted = doc.snapshot();
    const entries = doc.undo.journal.map(serialiseCommand);
    expect(entries[0]?.type).toBe(M21_COMMAND_ID.addOutlineItem);
    await doc.close();

    const { doc: fresh } = await openFake();
    const result = await replayJournal(fresh, entries);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(0);
    // The same ids, so anything later in a journal that names this bookmark still finds it.
    expect(fresh.snapshot()).toEqual(wanted);
    await fresh.close();
  });

  it('a payload it cannot make sense of rebuilds nothing rather than something wrong', async () => {
    const { doc } = await openFake();
    for (const payload of [null, {}, { title: 'No ids' }, { ids: { item: 'x' } }]) {
      expect(
        deserialiseCommand(doc, { type: M21_COMMAND_ID.addOutlineItem, payload }),
        JSON.stringify(payload),
      ).toBeNull();
    }
    await doc.close();
  });

  it('a bookmark with no target survives the round trip as one with no target', async () => {
    const { doc } = await openFake();
    await doc.apply(new AddOutlineItemCommand(doc, { title: 'Bare' }));
    const wanted = doc.snapshot();
    const entries = doc.undo.journal.map(serialiseCommand);
    await doc.close();

    const { doc: fresh } = await openFake();
    await replayJournal(fresh, entries);
    expect(fresh.snapshot()).toEqual(wanted);
    await fresh.close();
  });
});
