/**
 * Regressions found by review after the module was first written. Each one is a way the model
 * and the engine could drift apart, and each cost real data before it was fixed.
 */

import { describe, expect, it } from 'vitest';
import {
  AddAnnotationCommand,
  DeleteAnnotationCommand,
  InsertPagesCommand,
  RotatePagesCommand,
  SetPageLabelCommand,
  UpdateAnnotationCommand,
  draftAnnotation,
} from '@core/commands';
import { replayJournal, serialiseJournal } from '@core/Journal';
import { PDFIUM_SUPPORT } from './fakeEngine';
import { annotationSource, must, openFake, RICH_SPEC } from './helpers';

describe('annotation ids stay bound to the right annotation', () => {
  it('after an annotation is deleted and the deletion undone', async () => {
    const { doc, engine } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    const pageId = doc.page(0).id;
    const list = await doc.loadAnnotations(pageId);
    const highlight = must(list[0], 'highlight');
    const ink = must(list[1], 'ink');
    expect(highlight.subtype).toBe('Highlight');
    expect(ink.subtype).toBe('Ink');

    await doc.apply(new DeleteAnnotationCommand(doc, highlight.id));
    await doc.undoLast();

    // Whatever order the engine ended up in, each model id must name its own annotation.
    for (const id of [highlight.id, ink.id]) {
      const model = must(doc.annotation(id), 'annotation');
      const key = must(doc.idTable.engineKey('annotation', id), 'binding');
      const engineList = await engine.annotations(doc.handle, 0);
      const engineOne = must(
        engineList.find((a) => a.id === key),
        'engine annotation',
      );
      expect(engineOne.subtype, `id ${id} points at the wrong annotation`).toBe(model.subtype);
    }
  });

  it('when an annotation is added to a page whose annotations were never loaded', async () => {
    const { doc, engine } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    const pageId = doc.page(0).id;
    const before = await engine.annotations(doc.handle, 0);
    expect(before).toHaveLength(2);

    // Deliberately no loadAnnotations: a tool may draw on a page the viewer has not read.
    const draft = draftAnnotation(doc, pageId, annotationSource('Square', { contents: 'new' }));
    await doc.apply(new AddAnnotationCommand(doc, draft));
    expect(await engine.annotations(doc.handle, 0)).toHaveLength(3);

    await doc.undoLast();

    // Undo must remove the annotation it added, and only that one.
    const after = await engine.annotations(doc.handle, 0);
    expect(after.map((a) => a.subtype)).toEqual(before.map((a) => a.subtype));
    expect(after.some((a) => a.contents === 'new')).toBe(false);
  });

  it('so editing one annotation never edits another', async () => {
    const { doc, engine } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    const pageId = doc.page(0).id;
    const list = await doc.loadAnnotations(pageId);
    const highlight = must(list[0], 'highlight');
    const ink = must(list[1], 'ink');

    await doc.apply(new DeleteAnnotationCommand(doc, highlight.id));
    await doc.undoLast();
    await doc.apply(new UpdateAnnotationCommand(doc, highlight.id, { contents: 'edited' }));

    const engineList = await engine.annotations(doc.handle, 0);
    const highlightKey = doc.idTable.engineKey('annotation', highlight.id);
    const inkKey = doc.idTable.engineKey('annotation', ink.id);
    expect(engineList.find((a) => a.id === highlightKey)?.contents).toBe('edited');
    expect(engineList.find((a) => a.id === inkKey)?.contents).not.toBe('edited');
  });
});

describe('the journal replays a page insert to the same ids', () => {
  it('so a later command that names an inserted page still finds it', async () => {
    const { doc } = await openFake({ pageCount: 3 }, PDFIUM_SUPPORT);
    // Insert, undo, insert again: the second insert gets fresh ids, which the journal must carry.
    await doc.apply(new InsertPagesCommand(doc, 0, 1, { width: 100, height: 100 }));
    await doc.undoLast();
    doc.breakMerge();
    await doc.apply(new InsertPagesCommand(doc, 0, 1, { width: 100, height: 100 }));
    const inserted = doc.page(0).id;
    doc.breakMerge();
    await doc.apply(new RotatePagesCommand(doc, [inserted], 90));
    const expected = doc.snapshot();

    const file = JSON.parse(JSON.stringify(serialiseJournal(doc))) as ReturnType<
      typeof serialiseJournal
    >;
    const { doc: fresh } = await openFake({ pageCount: 3 }, PDFIUM_SUPPORT);
    const result = await replayJournal(fresh, file.entries);
    expect(result.skipped).toBe(0);
    expect(fresh.snapshot()).toEqual(expected);
  });
});

describe('clearing a value the engine cannot clear', () => {
  it('is recorded for the writer instead of being silently dropped', async () => {
    const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    const pageId = doc.page(0).id;
    const list = await doc.loadAnnotations(pageId);
    const highlight = must(list[0], 'highlight');
    expect(highlight.contents).toBe('first note');

    await doc.apply(new UpdateAnnotationCommand(doc, highlight.id, { contents: null }));

    expect(doc.annotation(highlight.id)?.contents).toBeNull();
    expect(doc.state.writeIntents).toContain('annotations');
  });

  it('but setting a value the engine can write records nothing', async () => {
    const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    const list = await doc.loadAnnotations(doc.page(0).id);
    await doc.apply(
      new UpdateAnnotationCommand(doc, must(list[0], 'annotation').id, { contents: 'changed' }),
    );
    expect(doc.state.writeIntents).toEqual([]);
  });
});

describe('merging keeps the write intents of both commands', () => {
  it('so a renamed page still reaches the writer', async () => {
    const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    const pageId = doc.page(0).id;
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'C'));
    expect(doc.state.writeIntents).toContain('page-labels');
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'Cover'));
    expect(doc.undo.state.length).toBe(1);
    expect(doc.state.writeIntents).toContain('page-labels');
  });
});

describe('shifting bindings past index nine', () => {
  it('keeps every id on its own annotation when a page has more than ten', async () => {
    const { doc, engine } = await openFake({ pageCount: 1 }, PDFIUM_SUPPORT);
    const pageId = doc.page(0).id;
    await doc.loadAnnotations(pageId);
    for (let i = 0; i < 12; i++) {
      await doc.apply(
        new AddAnnotationCommand(
          doc,
          draftAnnotation(doc, pageId, annotationSource('Square', { contents: `note ${i}` })),
        ),
      );
    }
    const all = doc.annotations(pageId);
    expect(all).toHaveLength(12);

    // Remove the second one: everything from index 2 upwards shifts down, past the 9/10 boundary.
    await doc.apply(new DeleteAnnotationCommand(doc, must(all[1], 'annotation').id));

    const engineList = await engine.annotations(doc.handle, 0);
    for (const a of doc.annotations(pageId)) {
      const key = must(doc.idTable.engineKey('annotation', a.id), `binding for ${a.id}`);
      const engineOne = must(
        engineList.find((e) => e.id === key),
        'engine annotation',
      );
      expect(engineOne.contents, `${a.id} points at the wrong annotation`).toBe(a.contents);
    }
  });
});

describe('every declared event is actually emitted', () => {
  it('including writeIntent:added, the first time an intent appears', async () => {
    const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    const seen: string[] = [];
    doc.on('writeIntent:added', (e) => seen.push(e.intent));
    const pageId = doc.page(0).id;

    await doc.apply(new SetPageLabelCommand(doc, pageId, 'Cover'));
    expect(seen).toEqual(['page-labels']);

    // A second command with the same intent does not fire again.
    doc.breakMerge();
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'Front'));
    expect(seen).toEqual(['page-labels']);
  });
});
