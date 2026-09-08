import { describe, expect, it, vi } from 'vitest';
import { EngineError } from '@engine/PdfEngine';
import {
  AddAnnotationCommand,
  DEFAULT_ANNOTATION_FLAGS,
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
  defaultPageSize,
  draftAnnotation,
} from '@core/commands';
import type { ModelId } from '@core/Ids';
import {
  annotationSource,
  loadAllAnnotations,
  must,
  openFake,
  pageIds,
  RICH_SPEC,
} from './helpers';

describe('RotatePagesCommand', () => {
  it('rotates absolutely and restores the previous value', async () => {
    const { doc, engine } = await openFake();
    const pageId = doc.page(0).id;
    await doc.apply(new RotatePagesCommand(doc, [pageId], 180));
    expect(doc.page(0).rotation).toBe(180);
    expect(engine.calls).toContain('setPageRotation');
    await doc.undoLast();
    expect(doc.page(0).rotation).toBe(0);
  });

  it('rotates relatively and wraps at 360', async () => {
    const { doc } = await openFake();
    const pageId = doc.page(0).id;
    await doc.apply(new RotatePagesCommand(doc, [pageId], 270, true));
    expect(doc.page(0).rotation).toBe(270);
    await doc.apply(new RotatePagesCommand(doc, [pageId], 90, true));
    expect(doc.page(0).rotation).toBe(0);
  });

  it('rotates several pages and names them in the label', async () => {
    const { doc } = await openFake();
    const ids = pageIds(doc).slice(0, 3);
    const cmd = new RotatePagesCommand(doc, ids, 90);
    expect(cmd.label).toBe('Rotate 3 pages');
    await doc.apply(cmd);
    expect(doc.state.pages.map((p) => p.rotation)).toEqual([90, 90, 90, 0]);
    await doc.undoLast();
    expect(doc.state.pages.map((p) => p.rotation)).toEqual([0, 0, 0, 0]);
  });

  it('ignores a page id that is not in the document', async () => {
    const { doc } = await openFake();
    await doc.apply(new RotatePagesCommand(doc, ['pg-99' as ModelId], 90));
    expect(doc.state.pages.every((p) => p.rotation === 0)).toBe(true);
  });

  it('records a write intent when the engine cannot rotate', async () => {
    const { doc } = await openFake(RICH_SPEC, { setPageRotation: false });
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90));
    expect(doc.page(0).rotation).toBe(90);
    expect(doc.state.writeIntents).toContain('page-boxes');
  });

  it('lets a real engine failure through instead of calling it unsupported', async () => {
    const { doc, engine } = await openFake();
    vi.spyOn(engine, 'setPageRotation').mockRejectedValue(
      new EngineError('internal', 'disk on fire'),
    );
    await expect(doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90))).rejects.toThrow(
      'disk on fire',
    );
  });
});

describe('InsertPagesCommand', () => {
  it('inserts at a visual index while the engine appends, then undoes both', async () => {
    const { doc, engine } = await openFake();
    const before = pageIds(doc);
    await doc.apply(new InsertPagesCommand(doc, 1, 2, { width: 200, height: 300 }));
    expect(doc.pageCount).toBe(6);
    expect(pageIds(doc)[0]).toBe(before[0]);
    expect(doc.page(1).mediaBox).toEqual({ x0: 0, y0: 0, x1: 200, y1: 300 });
    expect(await engine.pageCount(doc.handle)).toBe(6);
    await doc.undoLast();
    expect(pageIds(doc)).toEqual(before);
    expect(await engine.pageCount(doc.handle)).toBe(4);
  });

  it('keeps the same page ids across undo and redo', async () => {
    const { doc } = await openFake();
    await doc.apply(new InsertPagesCommand(doc, 0, 1, defaultPageSize(doc)));
    const inserted = doc.page(0).id;
    await doc.undoLast();
    await doc.redoLast();
    expect(doc.page(0).id).toBe(inserted);
  });

  it('records a write intent when the engine cannot insert', async () => {
    const { doc } = await openFake(RICH_SPEC, { insertBlankPages: false });
    await doc.apply(new InsertPagesCommand(doc, 0, 1, { width: 10, height: 10 }));
    expect(doc.pageCount).toBe(5);
    expect(doc.state.writeIntents).toContain('page-order');
  });

  it('defaults its size to the first page', async () => {
    const { doc } = await openFake();
    expect(defaultPageSize(doc)).toEqual({ width: 600, height: 800 });
  });
});

describe('DeletePagesCommand', () => {
  it('removes pages from the model and leaves the engine alone', async () => {
    const { doc, engine } = await openFake();
    const [first, second] = pageIds(doc);
    await doc.apply(new DeletePagesCommand(doc, [must(first), must(second)]));
    expect(doc.pageCount).toBe(2);
    expect(await engine.pageCount(doc.handle)).toBe(4);
    expect(engine.calls).not.toContain('deletePages');
    expect(doc.state.writeIntents).toContain('page-order');
  });

  it('restores deleted pages where they were', async () => {
    const { doc } = await openFake();
    const before = pageIds(doc);
    await doc.apply(new DeletePagesCommand(doc, [must(before[1]), must(before[3])]));
    expect(pageIds(doc)).toEqual([before[0], before[2]]);
    await doc.undoLast();
    expect(pageIds(doc)).toEqual(before);
  });

  it('still renders a surviving page, because the engine index is unchanged', async () => {
    const { doc } = await openFake();
    const ids = pageIds(doc);
    await doc.apply(new DeletePagesCommand(doc, [must(ids[0])]));
    expect(doc.enginePage(doc.page(0).id)).toBe(1);
  });
});

describe('MovePageCommand', () => {
  it('reorders the model and puts the page back on undo', async () => {
    const { doc } = await openFake();
    const before = pageIds(doc);
    await doc.apply(new MovePageCommand(doc, must(before[3]), 0));
    expect(pageIds(doc)).toEqual([before[3], before[0], before[1], before[2]]);
    await doc.undoLast();
    expect(pageIds(doc)).toEqual(before);
  });

  it('does nothing for a page that is not in the document', async () => {
    const { doc } = await openFake();
    const before = pageIds(doc);
    await doc.apply(new MovePageCommand(doc, 'pg-99' as ModelId, 0));
    expect(pageIds(doc)).toEqual(before);
  });
});

describe('SetPageBoxCommand', () => {
  it('crops through the engine and restores the old box', async () => {
    const { doc, engine } = await openFake();
    const pageId = doc.page(0).id;
    const crop = { x0: 10, y0: 10, x1: 500, y1: 700 };
    await doc.apply(new SetPageBoxCommand(doc, pageId, 'crop', crop));
    expect(doc.page(0).cropBox).toEqual(crop);
    expect(engine.calls).toContain('setCropBox');
    await doc.undoLast();
    expect(doc.page(0).cropBox).toEqual({ x0: 0, y0: 0, x1: 600, y1: 800 });
  });

  it('normalises an inverted rectangle', async () => {
    const { doc } = await openFake();
    await doc.apply(
      new SetPageBoxCommand(doc, doc.page(0).id, 'crop', { x0: 500, y0: 700, x1: 10, y1: 10 }),
    );
    expect(doc.page(0).cropBox).toEqual({ x0: 10, y0: 10, x1: 500, y1: 700 });
  });

  it('keeps the other boxes in the model only, and clears them again on undo', async () => {
    const { doc } = await openFake();
    const pageId = doc.page(0).id;
    const trim = { x0: 5, y0: 5, x1: 595, y1: 795 };
    await doc.apply(new SetPageBoxCommand(doc, pageId, 'trim', trim));
    expect(doc.page(0).trimBox).toEqual(trim);
    expect(doc.state.writeIntents).toContain('page-boxes');
    await doc.undoLast();
    expect(doc.page(0).trimBox).toBeNull();
  });
});

describe('SetPageLabelCommand', () => {
  it('renames a page and restores the old label', async () => {
    const { doc } = await openFake();
    const pageId = doc.page(0).id;
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'Cover'));
    expect(doc.page(0).label).toBe('Cover');
    expect(doc.state.writeIntents).toContain('page-labels');
    await doc.undoLast();
    expect(doc.page(0).label).toBe('i');
  });

  it('merges consecutive renames into one undo step', async () => {
    const { doc } = await openFake();
    const pageId = doc.page(0).id;
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'C'));
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'Co'));
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'Cover'));
    expect(doc.undo.state.length).toBe(1);
    await doc.undoLast();
    expect(doc.page(0).label).toBe('i');
  });

  it('does not merge across pages', async () => {
    const { doc } = await openFake();
    await doc.apply(new SetPageLabelCommand(doc, doc.page(0).id, 'a'));
    await doc.apply(new SetPageLabelCommand(doc, doc.page(1).id, 'b'));
    expect(doc.undo.state.length).toBe(2);
  });

  it('does not merge across a break', async () => {
    const { doc } = await openFake();
    const pageId = doc.page(0).id;
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'a'));
    doc.breakMerge();
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'ab'));
    expect(doc.undo.state.length).toBe(2);
  });
});

describe('annotation commands', () => {
  it('adds an annotation to the model and the engine, and removes it on undo', async () => {
    const { doc, engine } = await openFake();
    const pageId = doc.page(1).id;
    await doc.loadAnnotations(pageId);
    const draft = draftAnnotation(doc, pageId, annotationSource('Square'));
    await doc.apply(new AddAnnotationCommand(doc, draft));
    expect(doc.annotations(pageId)).toHaveLength(1);
    expect(await engine.annotations(doc.handle, 1)).toHaveLength(1);
    await doc.undoLast();
    expect(doc.annotations(pageId)).toHaveLength(0);
    expect(await engine.annotations(doc.handle, 1)).toHaveLength(0);
  });

  it('keeps the model id across undo and redo, so a comment thread survives', async () => {
    const { doc } = await openFake();
    const pageId = doc.page(1).id;
    await doc.loadAnnotations(pageId);
    const draft = draftAnnotation(doc, pageId, annotationSource('Text'));
    const cmd = new AddAnnotationCommand(doc, draft);
    await doc.apply(cmd);
    await doc.undoLast();
    await doc.redoLast();
    expect(doc.annotations(pageId)[0]?.id).toBe(cmd.annotationId);
  });

  it('re-binds the engine ids of the survivors after a delete', async () => {
    const { doc } = await openFake();
    const pageId = doc.page(0).id;
    const list = await doc.loadAnnotations(pageId);
    const [first, second] = list;
    await doc.apply(new DeleteAnnotationCommand(doc, must(first?.id)));
    expect(doc.annotations(pageId)).toHaveLength(1);
    // The remaining annotation moved from index 1 to index 0 inside the engine.
    expect(doc.idTable.engineKey('annotation', must(second?.id))).toBe('a0.0');
    await doc.undoLast();
    expect(doc.annotations(pageId).map((a) => a.id)).toEqual([first?.id, second?.id]);
  });

  it('updates properties and restores the whole annotation on undo', async () => {
    const { doc } = await openFake();
    const pageId = doc.page(0).id;
    const list = await doc.loadAnnotations(pageId);
    const id = must(list[0]?.id);
    await doc.apply(new UpdateAnnotationCommand(doc, id, { contents: 'edited', color: 0xff0000 }));
    expect(doc.annotation(id)?.contents).toBe('edited');
    expect(doc.annotation(id)?.color).toBe(0xff0000);
    await doc.undoLast();
    expect(doc.annotation(id)?.contents).toBe('first note');
    expect(doc.annotation(id)?.color).toBeNull();
  });

  it('merges a drag into one undo entry that returns to the starting rectangle', async () => {
    const { doc } = await openFake();
    const pageId = doc.page(0).id;
    const list = await doc.loadAnnotations(pageId);
    const id = must(list[0]?.id);
    const start = list[0]?.rect;
    for (let x = 1; x <= 5; x++) {
      await doc.apply(
        new UpdateAnnotationCommand(doc, id, { rect: { x0: x, y0: x, x1: x + 90, y1: x + 20 } }),
      );
    }
    expect(doc.undo.state.length).toBe(1);
    await doc.undoLast();
    expect(doc.annotation(id)?.rect).toEqual(start);
  });

  it('does not merge updates of different annotations', async () => {
    const { doc } = await openFake();
    const list = await doc.loadAnnotations(doc.page(0).id);
    await doc.apply(new UpdateAnnotationCommand(doc, must(list[0]?.id), { contents: 'a' }));
    await doc.apply(new UpdateAnnotationCommand(doc, must(list[1]?.id), { contents: 'b' }));
    expect(doc.undo.state.length).toBe(2);
  });

  it('does nothing for an annotation that is not there', async () => {
    const { doc } = await openFake();
    await doc.apply(new UpdateAnnotationCommand(doc, 'an-99' as ModelId, { contents: 'x' }));
    await doc.apply(new DeleteAnnotationCommand(doc, 'an-99' as ModelId));
    expect(doc.validate()).toEqual([]);
  });

  it('falls back to the model when the engine has no annotation support', async () => {
    const { doc } = await openFake(RICH_SPEC, { annotations: false });
    const pageId = doc.page(1).id;
    const draft = draftAnnotation(doc, pageId, annotationSource('Ink'));
    await doc.apply(new AddAnnotationCommand(doc, draft));
    expect(doc.annotations(pageId)).toHaveLength(1);
    expect(doc.state.writeIntents).toContain('annotations');
    await doc.undoLast();
    expect(doc.annotations(pageId)).toHaveLength(0);
  });
});

describe('SetFieldValueCommand', () => {
  it('sets a value through the engine and restores it on undo', async () => {
    const { doc, engine } = await openFake();
    const field = doc.fieldByName('address.city');
    await doc.apply(new SetFieldValueCommand(doc, must(field?.id), 'Leeds'));
    expect(doc.fieldByName('address.city')?.value).toBe('Leeds');
    expect(engine.calls).toContain('setFieldValue');
    await doc.undoLast();
    expect(doc.fieldByName('address.city')?.value).toBe('York');
  });

  it('merges typing into one undo step', async () => {
    const { doc } = await openFake();
    const id = must(doc.fieldByName('address.city')?.id);
    for (const value of ['L', 'Le', 'Lee', 'Leeds']) {
      await doc.apply(new SetFieldValueCommand(doc, id, value));
    }
    expect(doc.undo.state.length).toBe(1);
    await doc.undoLast();
    expect(doc.fieldByName('address.city')?.value).toBe('York');
  });

  it('records a write intent when the engine refuses', async () => {
    const { doc } = await openFake(RICH_SPEC, { setFieldValue: false });
    const id = must(doc.fieldByName('agree')?.id);
    await doc.apply(new SetFieldValueCommand(doc, id, 'Yes'));
    expect(doc.fieldByName('agree')?.value).toBe('Yes');
    expect(doc.state.writeIntents).toContain('fields');
  });

  it('does nothing for a field that is not there', async () => {
    const { doc } = await openFake();
    await doc.apply(new SetFieldValueCommand(doc, 'fl-99' as ModelId, 'x'));
    expect(doc.undo.state.length).toBe(1);
  });
});

describe('SetMetadataCommand', () => {
  it('always records a metadata intent against the real PDFium behaviour', async () => {
    const { doc } = await openFake(RICH_SPEC, { setMetadata: false });
    await doc.apply(new SetMetadataCommand(doc, { title: 'Report', author: 'Tony' }));
    expect(doc.state.metadata.title).toBe('Report');
    expect(doc.state.metadata.author).toBe('Tony');
    expect(doc.state.writeIntents).toContain('metadata');
    await doc.undoLast();
    expect(doc.state.metadata.title).toBe('Rich fixture');
    expect(doc.state.metadata.author).toBe('M20');
  });

  it('merges consecutive edits back to the original values', async () => {
    const { doc } = await openFake(RICH_SPEC, { setMetadata: false });
    await doc.apply(new SetMetadataCommand(doc, { title: 'A' }));
    await doc.apply(new SetMetadataCommand(doc, { title: 'AB' }));
    await doc.apply(new SetMetadataCommand(doc, { subject: 'S' }));
    expect(doc.undo.state.length).toBe(1);
    await doc.undoLast();
    expect(doc.state.metadata.title).toBe('Rich fixture');
    expect(doc.state.metadata.subject).toBeNull();
  });

  it('uses the engine when one supports it', async () => {
    const { doc, engine } = await openFake(RICH_SPEC, { setMetadata: true });
    await doc.apply(new SetMetadataCommand(doc, { title: 'Engine-backed' }));
    expect(engine.calls).toContain('setMetadata');
    expect(doc.state.writeIntents).not.toContain('metadata');
  });
});

describe('SetLayerVisibleCommand', () => {
  it('toggles a layer and restores it', async () => {
    const { doc } = await openFake(RICH_SPEC, { setLayerVisible: false });
    const layer = doc.state.layers[0];
    const cmd = new SetLayerVisibleCommand(doc, must(layer?.id), false);
    expect(cmd.label).toBe('Hide layer');
    await doc.apply(cmd);
    expect(doc.layer(must(layer?.id))?.visible).toBe(false);
    expect(doc.state.writeIntents).toContain('layers');
    await doc.undoLast();
    expect(doc.layer(must(layer?.id))?.visible).toBe(true);
  });

  it('does nothing for a layer that is not there', async () => {
    const { doc } = await openFake();
    await doc.apply(new SetLayerVisibleCommand(doc, 'ly-99' as ModelId, false));
    expect(doc.state.layers.map((l) => l.visible)).toEqual([true, false]);
  });
});

describe('SetCustomCommand', () => {
  it('carries a caller-supplied label into the undo menu', async () => {
    const { doc } = await openFake();
    await doc.apply(new SetCustomCommand(doc, 'M33', { unit: 'mm' }, 'Change measurement unit'));
    expect(doc.undo.state.undoLabel).toBe('Change measurement unit');
  });
});

describe('draftAnnotation', () => {
  it('mints a fresh id and fills in the family fields', async () => {
    const { doc } = await openFake();
    const pageId = doc.page(0).id;
    const ink = draftAnnotation(
      doc,
      pageId,
      annotationSource('Ink', { paths: [[{ x: 0, y: 0 }]] }),
    );
    expect(ink.family).toBe('ink');
    expect(ink.pageId).toBe(pageId);
    expect(ink.flags).toEqual(DEFAULT_ANNOTATION_FLAGS);
    const second = draftAnnotation(doc, pageId, annotationSource());
    expect(second.id).not.toBe(ink.id);
  });
});

describe('composite commands', () => {
  it('undo a batch in one step, in reverse order', async () => {
    const { doc } = await openFake();
    const ids = pageIds(doc);
    await doc.batch('Rotate and delete', async () => {
      await doc.apply(new RotatePagesCommand(doc, [must(ids[0])], 90));
      await doc.apply(new DeletePagesCommand(doc, [must(ids[3])]));
    });
    expect(doc.undo.state.length).toBe(1);
    expect(doc.pageCount).toBe(3);
    await doc.undoLast();
    expect(doc.pageCount).toBe(4);
    expect(doc.page(0).rotation).toBe(0);
  });

  it('a batch that throws leaves the document as it was', async () => {
    const { doc } = await openFake();
    const before = doc.snapshot();
    await expect(
      doc.batch('Doomed', async () => {
        await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90));
        throw new Error('tool cancelled');
      }),
    ).rejects.toThrow('tool cancelled');
    expect(doc.snapshot()).toEqual(before);
    expect(doc.undo.state.length).toBe(0);
  });
});

describe('all commands together', () => {
  it('leave the model valid and reversible', async () => {
    const { doc } = await openFake();
    await loadAllAnnotations(doc);
    const before = doc.snapshot();
    const ids = pageIds(doc);
    const annotationId = must(doc.annotations(must(ids[0]))[0]?.id);
    const commands = [
      new RotatePagesCommand(doc, [must(ids[0])], 90, true),
      new SetPageBoxCommand(doc, must(ids[1]), 'crop', { x0: 1, y0: 1, x1: 300, y1: 400 }),
      new SetPageLabelCommand(doc, must(ids[2]), 'Appendix'),
      new InsertPagesCommand(doc, 2, 1, { width: 100, height: 100 }),
      new MovePageCommand(doc, must(ids[3]), 0),
      new DeletePagesCommand(doc, [must(ids[1])]),
      new UpdateAnnotationCommand(doc, annotationId, { contents: 'changed' }),
      new DeleteAnnotationCommand(doc, annotationId),
      new SetFieldValueCommand(doc, must(doc.fieldByName('agree')?.id), 'Yes'),
      new SetMetadataCommand(doc, { subject: 'Testing' }),
      new SetLayerVisibleCommand(doc, must(doc.state.layers[0]?.id), false),
      new SetCustomCommand(doc, 'M20', { probe: true }),
    ];
    for (const c of commands) {
      doc.breakMerge();
      await doc.apply(c);
    }
    expect(doc.validate()).toEqual([]);
    const after = doc.snapshot();
    expect(after).not.toEqual(before);

    while (doc.undo.canUndo) await doc.undoLast();
    expect(doc.snapshot()).toEqual(before);

    while (doc.undo.canRedo) await doc.redoLast();
    expect(doc.snapshot()).toEqual(after);
  });
});

/**
 * A real engine failure must not be mistaken for "this backend cannot do that". A corrupt file
 * or a bad handle has to surface as an error; only `NotImplementedError` becomes a write intent.
 */
describe('real engine failures propagate', () => {
  it('while creating an annotation', async () => {
    const { doc, engine } = await openFake();
    const pageId = doc.page(0).id;
    await doc.loadAnnotations(pageId);
    vi.spyOn(engine, 'addAnnotation').mockRejectedValue(new EngineError('internal', 'wasm died'));
    const draft = draftAnnotation(doc, pageId, annotationSource('Square'));
    await expect(doc.apply(new AddAnnotationCommand(doc, draft))).rejects.toThrow('wasm died');
  });

  it('while deleting an annotation', async () => {
    const { doc, engine } = await openFake();
    const list = await doc.loadAnnotations(doc.page(0).id);
    vi.spyOn(engine, 'deleteAnnotation').mockRejectedValue(new EngineError('corrupt', 'bad page'));
    const id = must(list[0], 'annotation').id;
    await expect(doc.apply(new DeleteAnnotationCommand(doc, id))).rejects.toThrow('bad page');
  });

  it('but a backend without annotations only records an intent', async () => {
    const { doc } = await openFake(RICH_SPEC, { annotations: false });
    const pageId = doc.page(0).id;
    await doc.loadAnnotations(pageId);
    const before = doc.annotations(pageId).length;
    const draft = draftAnnotation(doc, pageId, annotationSource('Square'));
    await doc.apply(new AddAnnotationCommand(doc, draft));
    expect(doc.annotations(pageId)).toHaveLength(before + 1);
    expect(doc.state.writeIntents).toContain('annotations');
  });
});
