import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { command } from '@core/Command';
import {
  AddAnnotationCommand,
  COMMAND_ID,
  DeleteAnnotationCommand,
  DeletePagesCommand,
  InsertPagesCommand,
  MovePageCommand,
  RotatePagesCommand,
  SetCustomCommand,
  SetFieldValueCommand,
  SetLayerVisibleCommand,
  SetMetadataCommand,
  SetPageBoxCommand,
  SetPageLabelCommand,
  UpdateAnnotationCommand,
  draftAnnotation,
} from '@core/commands';
import type { Document } from '@core/Document';
import {
  deserialiseCommand,
  hasCommandCodec,
  isReplayable,
  JOURNAL_VERSION,
  parseJournal,
  registerCommandCodec,
  registeredCommandTypes,
  replayJournal,
  serialiseCommand,
  serialiseJournal,
  type JournalEntry,
} from '@core/Journal';
import { PDFIUM_SUPPORT } from './fakeEngine';
import { annotationSource, loadAllAnnotations, must, openFake, RICH_SPEC } from './helpers';

it('does not report a missing lazy annotation target as an applied change', async () => {
  const { doc } = await openFake();
  await loadAllAnnotations(doc);
  const target = must(doc.annotations(doc.page(0).id)[0]);
  await doc.apply(new UpdateAnnotationCommand(doc, target.id, { contents: 'Recovered' }));
  const { doc: fresh } = await openFake();
  const result = await replayJournal(fresh, serialiseJournal(doc).entries);
  expect(result).toEqual({ applied: 0, skipped: 1, skippedTypes: [COMMAND_ID.updateAnnotation] });
  await fresh.loadAnnotations(fresh.page(0).id);
  expect(fresh.annotations(fresh.page(0).id)[0]?.contents).not.toBe('Recovered');
  await fresh.close();
  await doc.close();
});

/** Applies the standard mixed workload used by several tests below. */
async function applyWorkload(doc: Document): Promise<void> {
  await loadAllAnnotations(doc);
  const ids = doc.state.pages.map((p) => p.id);
  const annotationId = must(doc.annotations(must(ids[0]))[0]?.id);
  const steps = [
    new RotatePagesCommand(doc, [must(ids[0])], 90),
    new SetPageBoxCommand(doc, must(ids[1]), 'crop', { x0: 0, y0: 0, x1: 300, y1: 400 }),
    new SetPageLabelCommand(doc, must(ids[2]), 'Appendix'),
    new InsertPagesCommand(doc, 1, 2, { width: 200, height: 200 }),
    new MovePageCommand(doc, must(ids[3]), 0),
    new UpdateAnnotationCommand(doc, annotationId, { contents: 'reviewed' }),
    new DeleteAnnotationCommand(doc, annotationId),
    new AddAnnotationCommand(doc, draftAnnotation(doc, must(ids[1]), annotationSource('Text'))),
    new DeletePagesCommand(doc, [must(ids[2])]),
    new SetFieldValueCommand(doc, must(doc.fieldByName('agree')?.id), 'Yes'),
    new SetMetadataCommand(doc, { title: 'Reviewed', subject: 'M20' }),
    new SetLayerVisibleCommand(doc, must(doc.state.layers[0]?.id), false),
    new SetCustomCommand(doc, 'M30', { tool: 'highlight' }),
  ];
  for (const step of steps) {
    doc.breakMerge();
    await doc.apply(step);
  }
}

describe('serialising', () => {
  it('has a codec for every built-in command type', () => {
    for (const type of Object.values(COMMAND_ID)) {
      expect(hasCommandCodec(type), `no codec for ${type}`).toBe(true);
    }
    expect(registeredCommandTypes()).toContain(COMMAND_ID.rotatePages);
  });

  it('records every applied command, oldest first', async () => {
    const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    await applyWorkload(doc);
    const file = serialiseJournal(doc);
    expect(file.version).toBe(JOURNAL_VERSION);
    expect(file.documentId).toBe(doc.id);
    expect(file.complete).toBe(true);
    expect(file.entries[0]?.type).toBe(COMMAND_ID.rotatePages);
    expect(file.entries).toHaveLength(doc.undo.state.length);
  });

  it('survives JSON, which is what a recovery file is', async () => {
    const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    await applyWorkload(doc);
    const file = serialiseJournal(doc);
    const text = JSON.stringify(file);
    const parsed = parseJournal(text);
    expect(parsed?.entries).toEqual(file.entries);
    expect(parsed?.complete).toBe(true);
  });

  it('refuses text that is not a journal of this version', () => {
    expect(parseJournal('not json')).toBeNull();
    expect(parseJournal('{"version":99,"entries":[]}')).toBeNull();
    expect(parseJournal('{"version":1}')).toBeNull();
    const ok = parseJournal('{"version":1,"entries":[]}');
    expect(ok?.documentId).toBe('');
    expect(ok?.path).toBeNull();
  });

  it('marks a command that cannot describe itself, instead of dropping it', async () => {
    const { doc } = await openFake();
    await doc.apply(
      command(
        'mystery.thing',
        'Do a mystery',
        () => undefined,
        () => undefined,
      ),
    );
    const file = serialiseJournal(doc);
    expect(file.entries[0]).toEqual({ type: 'mystery.thing', payload: null });
    expect(file.complete).toBe(false);
    expect(isReplayable(must(file.entries[0]))).toBe(false);
  });

  it('marks a command whose type has no codec', () => {
    const entry: JournalEntry = { type: 'nobody.registered.this', payload: { a: 1 } };
    expect(isReplayable(entry)).toBe(false);
  });

  it('serialises a transaction as one entry carrying its children', async () => {
    const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    const ids = doc.state.pages.map((p) => p.id);
    await doc.batch('Tidy up', async () => {
      await doc.apply(new RotatePagesCommand(doc, [must(ids[0])], 90));
      await doc.apply(new SetPageLabelCommand(doc, must(ids[1]), 'Two'));
    });
    const file = serialiseJournal(doc);
    expect(file.entries).toHaveLength(1);
    const entry = must(file.entries[0]);
    expect(entry.type).toBe('core.composite');
    expect((entry.payload as { label: string }).label).toBe('Tidy up');
    expect((entry.payload as { children: unknown[] }).children).toHaveLength(2);
    expect(file.complete).toBe(true);
  });
});

describe('replaying', () => {
  it('replays to exactly the state the journal was taken from', async () => {
    const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    await applyWorkload(doc);
    const expected = doc.snapshot();
    const file = JSON.parse(JSON.stringify(serialiseJournal(doc))) as ReturnType<
      typeof serialiseJournal
    >;

    const { doc: fresh } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    await loadAllAnnotations(fresh);
    const result = await replayJournal(fresh, file.entries);
    expect(result.skipped).toBe(0);
    expect(result.applied).toBe(file.entries.length);
    expect(fresh.snapshot()).toEqual(expected);
    expect(fresh.validate()).toEqual([]);
  });

  it('leaves the replayed document with the same undo history', async () => {
    const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    await applyWorkload(doc);
    const before = doc.undo.state.length;
    const file = serialiseJournal(doc);

    const { doc: fresh } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    await loadAllAnnotations(fresh);
    const original = fresh.snapshot();
    await replayJournal(fresh, file.entries);
    expect(fresh.undo.state.length).toBe(before);
    while (fresh.undo.canUndo) await fresh.undoLast();
    expect(fresh.snapshot()).toEqual(original);
  });

  it('replays a transaction as one undo step', async () => {
    const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    const ids = doc.state.pages.map((p) => p.id);
    await doc.batch('Tidy up', async () => {
      await doc.apply(new RotatePagesCommand(doc, [must(ids[0])], 90));
      await doc.apply(new SetPageLabelCommand(doc, must(ids[1]), 'Two'));
    });
    const expected = doc.snapshot();
    const file = serialiseJournal(doc);

    const { doc: fresh } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    await replayJournal(fresh, file.entries);
    expect(fresh.undo.state.length).toBe(1);
    expect(fresh.undo.state.undoLabel).toBe('Tidy up');
    expect(fresh.snapshot()).toEqual(expected);
  });

  it('counts what it had to skip rather than pretending it succeeded', async () => {
    const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    const entries: JournalEntry[] = [
      { type: COMMAND_ID.rotatePages, payload: { pageIds: [doc.page(0).id], rotation: 90 } },
      { type: 'from.a.future.version', payload: { anything: true } },
      { type: 'from.a.future.version', payload: { more: true } },
    ];
    const result = await replayJournal(doc, entries);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.skippedTypes).toEqual(['from.a.future.version']);
    expect(doc.page(0).rotation).toBe(90);
  });

  it('skips an entry whose payload is the wrong shape', async () => {
    const { doc } = await openFake();
    for (const entry of [
      { type: COMMAND_ID.rotatePages, payload: { rotation: 90 } },
      { type: COMMAND_ID.rotatePages, payload: { pageIds: [1, 2] } },
      { type: COMMAND_ID.movePage, payload: { pageId: 'pg-1' } },
      { type: COMMAND_ID.setPageBox, payload: { pageId: 'pg-1', box: 'crop', rect: {} } },
      { type: COMMAND_ID.insertPages, payload: { at: 0, count: 1, size: { width: 'wide' } } },
      { type: COMMAND_ID.addAnnotation, payload: { annotation: 'not an object' } },
      { type: COMMAND_ID.updateAnnotation, payload: { annotationId: 'an-1' } },
      { type: COMMAND_ID.setFieldValue, payload: { fieldId: 'fl-1' } },
      { type: COMMAND_ID.setMetadata, payload: {} },
      { type: COMMAND_ID.setLayerVisible, payload: { layerId: 'ly-1', visible: 'yes' } },
      { type: COMMAND_ID.setCustom, payload: { namespace: 'M30' } },
      { type: COMMAND_ID.setPageLabel, payload: { pageId: 'pg-1' } },
      { type: COMMAND_ID.deletePages, payload: {} },
      { type: COMMAND_ID.deleteAnnotation, payload: {} },
    ] satisfies JournalEntry[]) {
      expect(deserialiseCommand(doc, entry), entry.type).toBeNull();
    }
  });

  it('skips a composite whose children cannot all be rebuilt', async () => {
    const { doc } = await openFake();
    expect(
      deserialiseCommand(doc, {
        type: 'core.composite',
        payload: { id: 'g', label: 'L', children: [null] },
      }),
    ).toBeNull();
    expect(
      deserialiseCommand(doc, { type: 'core.composite', payload: { id: 'g', label: 'L' } }),
    ).toBeNull();
    expect(
      isReplayable({
        type: 'core.composite',
        payload: { children: [{ type: 'x', payload: null }] },
      }),
    ).toBe(false);
  });

  it('a codec that throws is treated as a skip, not a crash', async () => {
    const { doc } = await openFake();
    registerCommandCodec('test.explodes', () => {
      throw new Error('bad payload');
    });
    expect(deserialiseCommand(doc, { type: 'test.explodes', payload: {} })).toBeNull();
    const result = await replayJournal(doc, [{ type: 'test.explodes', payload: {} }]);
    expect(result.skipped).toBe(1);
  });

  it('reserves replayed annotation ids so later allocations cannot collide', async () => {
    const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
    const pageId = doc.page(0).id;
    const draft = { ...draftAnnotation(doc, pageId, annotationSource('Square')), id: 'an-500' };
    await replayJournal(doc, [
      { type: COMMAND_ID.addAnnotation, payload: { annotation: draft, index: null } },
    ]);
    const next = draftAnnotation(doc, pageId, annotationSource('Square'));
    expect(next.id).toBe('an-501');
  });

  it('an empty journal is a no-op', async () => {
    const { doc } = await openFake();
    const before = doc.snapshot();
    const result = await replayJournal(doc, []);
    expect(result).toEqual({ applied: 0, skipped: 0, skippedTypes: [] });
    expect(doc.snapshot()).toEqual(before);
  });
});

describe('journal round-trip, for any sequence', () => {
  it('replays to the same state whatever the commands were', async () => {
    const pageIndex = fc.nat(3);
    const stepArb = fc.oneof(
      fc.record({ kind: fc.constant('rotate' as const), page: pageIndex }),
      fc.record({
        kind: fc.constant('label' as const),
        page: pageIndex,
        text: fc.string({ maxLength: 5 }),
      }),
      fc.record({ kind: fc.constant('insert' as const), at: pageIndex }),
      fc.record({ kind: fc.constant('delete' as const), page: pageIndex }),
      fc.record({ kind: fc.constant('move' as const), page: pageIndex, to: pageIndex }),
      fc.record({ kind: fc.constant('metadata' as const), title: fc.string({ maxLength: 8 }) }),
      fc.record({ kind: fc.constant('annotation' as const), page: pageIndex }),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 25 }), async (steps) => {
        let actualChanges = 0;
        const build = async (doc: Document): Promise<void> => {
          for (const step of steps) {
            const pages = doc.state.pages;
            const page =
              pages[step.kind === 'insert' ? 0 : (step as { page: number }).page % pages.length];
            if (!page) continue;
            const before = JSON.stringify({ ...doc.state, revision: 0, writeIntents: [] });
            doc.breakMerge();
            switch (step.kind) {
              case 'rotate':
                await doc.apply(new RotatePagesCommand(doc, [page.id], 90, true));
                break;
              case 'label':
                await doc.apply(new SetPageLabelCommand(doc, page.id, step.text));
                break;
              case 'insert':
                await doc.apply(
                  new InsertPagesCommand(doc, step.at % (pages.length + 1), 1, {
                    width: 100,
                    height: 100,
                  }),
                );
                break;
              case 'delete':
                if (pages.length > 1) await doc.apply(new DeletePagesCommand(doc, [page.id]));
                break;
              case 'move':
                await doc.apply(new MovePageCommand(doc, page.id, step.to % pages.length));
                break;
              case 'metadata':
                await doc.apply(new SetMetadataCommand(doc, { title: step.title }));
                break;
              case 'annotation':
                await doc.apply(
                  new AddAnnotationCommand(
                    doc,
                    draftAnnotation(doc, page.id, annotationSource('Square')),
                  ),
                );
                break;
            }
            if (before !== JSON.stringify({ ...doc.state, revision: 0, writeIntents: [] }))
              actualChanges++;
          }
        };

        const { doc } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
        await loadAllAnnotations(doc);
        await build(doc);
        const expected = doc.snapshot();
        const file = JSON.parse(JSON.stringify(serialiseJournal(doc))) as ReturnType<
          typeof serialiseJournal
        >;
        expect(file.complete).toBe(true);

        const { doc: fresh } = await openFake(RICH_SPEC, PDFIUM_SUPPORT);
        await loadAllAnnotations(fresh);
        const result = await replayJournal(fresh, file.entries);
        expect(result.applied).toBe(actualChanges);
        expect(result.skipped).toBe(file.entries.length - actualChanges);
        expect(fresh.snapshot()).toEqual(expected);
      }),
      { numRuns: 40 },
    );
  });
});

describe('serialiseCommand', () => {
  it('uses the command id when there is no toJSON', () => {
    const c = command(
      'plain.thing',
      'Plain',
      () => undefined,
      () => undefined,
    );
    expect(serialiseCommand(c)).toEqual({ type: 'plain.thing', payload: null });
  });
});
