import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Document, familyOf, pageBox, pageSizeOf, type DocumentEvent } from '@core/Document';
import { SetCustomCommand, SetPageLabelCommand } from '@core/commands';
import type { ModelId } from '@core/Ids';
import { command } from '@core/Command';
import { FakeEngine } from './fakeEngine';
import { loadAllAnnotations, must, openFake, RICH_SPEC } from './helpers';

describe('Document.open', () => {
  it('builds pages with stable ids, labels and boxes', async () => {
    const { doc } = await openFake();
    expect(doc.pageCount).toBe(4);
    expect(doc.state.pages.map((p) => p.label)).toEqual(['i', 'ii', '1', '2']);
    expect(doc.state.pages.map((p) => String(p.id))).toEqual(['pg-1', 'pg-2', 'pg-3', 'pg-4']);
    const first = doc.page(0);
    expect(first.mediaBox).toEqual({ x0: 0, y0: 0, x1: 600, y1: 800 });
    expect(first.rotation).toBe(0);
    expect(first.objects).toBeNull();
  });

  it('maps each page id to its engine index', async () => {
    const { doc } = await openFake();
    expect(doc.enginePage(doc.page(2).id)).toBe(2);
    expect(doc.enginePage('pg-999' as ModelId)).toBeUndefined();
  });

  it('reads metadata, security, signatures and the title', async () => {
    const { doc } = await openFake();
    expect(doc.state.title).toBe('Rich fixture');
    expect(doc.state.metadata.author).toBe('M20');
    expect(doc.state.metadata.version).toBe('1.7');
    expect(doc.state.security.encrypted).toBe(false);
    expect(doc.state.security.permissions.modify).toBe(true);
    expect(doc.state.signatures).toHaveLength(1);
    expect(doc.state.signatures[0]?.reason).toBe('I approve');
    expect(doc.state.signatures[0]?.docMdpPermission).toBeNull();
  });

  it('falls back to the file name when the file has no title', async () => {
    const { doc } = await openFake({ pageCount: 1, metadata: {} });
    expect(doc.state.title).toBe('fixture.pdf');
  });

  it('builds the field tree, inventing the intermediate nodes', async () => {
    const { doc } = await openFake();
    const names = doc.state.fields.map((f) => f.name);
    expect(names).toContain('address');
    expect(names).toContain('address.city');
    const parent = doc.fieldByName('address');
    const child = doc.fieldByName('address.city');
    expect(parent?.synthetic).toBe(true);
    expect(child?.synthetic).toBe(false);
    expect(child?.parentId).toBe(parent?.id);
    expect(parent?.childIds).toContain(child?.id);
    expect(child?.partialName).toBe('city');
    expect(child?.widgets[0]?.pageId).toBe(doc.page(0).id);
  });

  it('flattens the outline into id-linked nodes and collects their destinations', async () => {
    const { doc } = await openFake();
    expect(doc.state.outline).toHaveLength(2);
    const [root, child] = doc.state.outline;
    expect(root?.title).toBe('Chapter 1');
    expect(root?.childIds).toEqual([child?.id]);
    expect(child?.parentId).toBe(root?.id);
    const dest = doc.destination(must(root?.destinationId));
    expect(dest?.pageId).toBe(doc.page(0).id);
    expect(dest?.top).toBe(800);
    // The named destination from the catalogue is there too.
    expect(doc.state.destinations.some((d) => d.name === 'top')).toBe(true);
  });

  it('adopts layers and attachments with model ids bound to the engine keys', async () => {
    const { doc } = await openFake();
    expect(doc.state.layers.map((l) => l.name)).toEqual(['Watermark', 'Notes']);
    const layer = doc.state.layers[1];
    expect(layer?.visible).toBe(false);
    expect(doc.idTable.engineKey('layer', must(layer?.id))).toBe('ocg.2');
    expect(doc.state.attachments[0]?.name).toBe('data.csv');
  });

  it('survives an engine whose optional reads all fail', async () => {
    const engine = new FakeEngine();
    const handle = engine.create({ pageCount: 2 });
    for (const method of [
      'permissions',
      'outline',
      'layers',
      'attachments',
      'formFields',
      'signatures',
      'namedDestinations',
    ] as const) {
      vi.spyOn(engine, method).mockRejectedValue(new Error('nope'));
    }
    const doc = await Document.fromHandle(engine, handle, { name: 'x.pdf' });
    expect(doc.pageCount).toBe(2);
    expect(doc.state.outline).toEqual([]);
    expect(doc.state.security.permissions.print).toBe(true);
  });

  it('closes the handle when building the model throws', async () => {
    const engine = new FakeEngine();
    const handle = engine.create({ pageCount: 1 });
    vi.spyOn(engine, 'open').mockResolvedValue(handle);
    vi.spyOn(engine, 'pageCount').mockRejectedValue(new Error('boom'));
    const close = vi.spyOn(engine, 'close');
    await expect(Document.open(engine, new Uint8Array([1]))).rejects.toThrow('boom');
    expect(close).toHaveBeenCalledWith(handle);
  });
});

describe('page geometry helpers', () => {
  it('swaps width and height for a quarter turn', async () => {
    const { doc } = await openFake();
    const page = { ...doc.page(0), rotation: 90 as const };
    const size = pageSizeOf(page);
    expect(size.width).toBe(800);
    expect(size.height).toBe(600);
  });

  it('falls back through crop box for the boxes a file omits', async () => {
    const { doc } = await openFake();
    const page = doc.page(0);
    expect(pageBox(page, 'media')).toEqual(page.mediaBox);
    expect(pageBox(page, 'bleed')).toEqual(page.cropBox);
    expect(pageBox(page, 'trim')).toEqual(page.cropBox);
    expect(pageBox(page, 'art')).toEqual(page.cropBox);
    expect(doc.pageBox(page.id, 'crop')).toEqual(page.cropBox);
    expect(doc.pageBox('pg-99' as ModelId, 'crop')).toBeNull();
  });
});

describe('annotations', () => {
  it('classifies subtypes into families and keeps the family fields', async () => {
    const { doc } = await openFake();
    const list = await doc.loadAnnotations(doc.page(0).id);
    expect(list).toHaveLength(2);
    const [highlight, ink] = list;
    expect(highlight?.family).toBe('markup');
    expect(highlight?.contents).toBe('first note');
    expect(highlight?.family === 'markup' && highlight.quadPoints).toHaveLength(8);
    expect(ink?.family).toBe('ink');
    expect(ink?.family === 'ink' && ink.paths[0]).toHaveLength(2);
  });

  it('maps every subtype to a family, unknown ones included', () => {
    expect(familyOf('Highlight')).toBe('markup');
    expect(familyOf('PolyLine')).toBe('shape');
    expect(familyOf('Ink')).toBe('ink');
    expect(familyOf('Text')).toBe('note');
    expect(familyOf('FreeText')).toBe('freeText');
    expect(familyOf('Stamp')).toBe('stamp');
    expect(familyOf('Widget')).toBe('widget');
    expect(familyOf('Link')).toBe('link');
    expect(familyOf('FileAttachment')).toBe('fileAttachment');
    expect(familyOf('Movie')).toBe('other');
    expect(familyOf('3D')).toBe('other');
  });

  it('keeps a model id across a reload, so a selection survives', async () => {
    const { doc } = await openFake();
    const pageId = doc.page(0).id;
    const before = await doc.loadAnnotations(pageId);
    const after = await doc.loadAnnotations(pageId);
    expect(after.map((a) => a.id)).toEqual(before.map((a) => a.id));
  });

  it('finds an annotation anywhere in the document', async () => {
    const { doc } = await openFake();
    await loadAllAnnotations(doc);
    const target = doc.annotations(doc.page(2).id)[0];
    expect(doc.annotation(must(target?.id))?.subtype).toBe('Square');
    expect(doc.annotation('an-999' as ModelId)).toBeNull();
  });

  it('returns nothing for a page the engine does not hold', async () => {
    const { doc } = await openFake();
    expect(await doc.loadAnnotations('pg-99' as ModelId)).toEqual([]);
  });
});

describe('lazy page objects', () => {
  it('loads objects on demand and records them on the page', async () => {
    const { doc, engine } = await openFake({ pageCount: 1 });
    const pageId = doc.page(0).id;
    expect(doc.page(0).objects).toBeNull();
    const spy = vi.spyOn(engine, 'pageObjects');
    await doc.loadObjects(pageId);
    expect(doc.page(0).objects).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('change events', () => {
  let doc: Document;
  let seen: DocumentEvent[];

  beforeEach(async () => {
    ({ doc } = await openFake());
    seen = [];
    doc.onAny((e) => seen.push(e));
  });

  it('emits page:changed with what changed', async () => {
    const pageId = doc.page(0).id;
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'cover'));
    expect(seen).toContainEqual({ type: 'page:changed', pageId, what: 'label' });
  });

  it('emits document:revision after every applied command', async () => {
    await doc.apply(new SetPageLabelCommand(doc, doc.page(0).id, 'a'));
    const revisions = seen.filter((e) => e.type === 'document:revision');
    expect(revisions).toHaveLength(1);
    expect(doc.state.revision).toBe(1);
  });

  it('delivers to a typed subscription and stops on unsubscribe', async () => {
    const handler = vi.fn();
    const off = doc.on('custom:changed', handler);
    await doc.apply(new SetCustomCommand(doc, 'M30', { tool: 'ink' }));
    expect(handler).toHaveBeenCalledWith({ type: 'custom:changed', namespace: 'M30' });
    off();
    await doc.apply(new SetCustomCommand(doc, 'M30', { tool: 'pen' }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps going when one handler throws', () => {
    const good = vi.fn();
    doc.on('metadata:changed', () => {
      throw new Error('bad panel');
    });
    doc.on('metadata:changed', good);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    doc.setMetadataRecord({ title: 'x' });
    expect(good).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });

  it('drops every subscription when the document closes', async () => {
    expect(doc.events.listenerCount).toBeGreaterThan(0);
    await doc.close();
    expect(doc.events.listenerCount).toBe(0);
    expect(doc.isClosed).toBe(true);
  });
});

describe('the custom bag', () => {
  it('gives each module its own namespace', async () => {
    const { doc } = await openFake();
    await doc.apply(new SetCustomCommand(doc, 'M30', { colour: 'yellow' }));
    await doc.apply(new SetCustomCommand(doc, 'M31', { width: 3 }));
    expect(doc.custom('M30')).toEqual({ colour: 'yellow' });
    expect(doc.custom('M31')).toEqual({ width: 3 });
    expect(doc.custom('M99')).toEqual({});
  });

  it('merges into a namespace and restores the whole slice on undo', async () => {
    const { doc } = await openFake();
    await doc.apply(new SetCustomCommand(doc, 'M30', { a: 1 }));
    await doc.apply(new SetCustomCommand(doc, 'M30', { b: 2 }));
    expect(doc.custom('M30')).toEqual({ a: 1, b: 2 });
    await doc.undoLast();
    expect(doc.custom('M30')).toEqual({ a: 1 });
  });
});

describe('transactions', () => {
  it('records everything between begin and commit as one undo entry', async () => {
    const { doc } = await openFake();
    const pageId = doc.page(0).id;
    doc.beginTransaction('Rename twice');
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'a'));
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'b'));
    await doc.commit();
    expect(doc.undo.state.length).toBe(1);
    expect(doc.undo.state.undoLabel).toBe('Rename twice');
    await doc.undoLast();
    expect(doc.page(0).label).toBe('i');
  });

  it('rolls back atomically and records nothing', async () => {
    const { doc } = await openFake();
    const pageId = doc.page(0).id;
    doc.beginTransaction('Abandoned');
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'a'));
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'b'));
    await doc.rollback();
    expect(doc.page(0).label).toBe('i');
    expect(doc.undo.state.length).toBe(0);
    expect(doc.undo.canUndo).toBe(false);
  });

  it('flattens nested transactions into one entry', async () => {
    const { doc } = await openFake();
    doc.beginTransaction('Outer');
    await doc.apply(new SetPageLabelCommand(doc, doc.page(0).id, 'a'));
    doc.beginTransaction('Inner');
    await doc.apply(new SetPageLabelCommand(doc, doc.page(1).id, 'b'));
    await doc.commit();
    await doc.commit();
    expect(doc.undo.state.length).toBe(1);
    expect(doc.undo.state.undoLabel).toBe('Outer');
    await doc.undoLast();
    expect(doc.page(0).label).toBe('i');
    expect(doc.page(1).label).toBe('ii');
  });

  it('an empty transaction records nothing', async () => {
    const { doc } = await openFake();
    doc.beginTransaction('Nothing happened');
    await doc.commit();
    expect(doc.undo.state.length).toBe(0);
  });

  it('commit or rollback without a transaction is an error, not a silent no-op', async () => {
    const { doc } = await openFake();
    await expect(doc.commit()).rejects.toThrow('commit() without beginTransaction()');
    await expect(doc.rollback()).rejects.toThrow('rollback() without beginTransaction()');
  });
});

describe('dirty tracking and saving', () => {
  it('is clean on open, dirty after a change, clean after a save', async () => {
    const { doc } = await openFake();
    expect(doc.isDirty).toBe(false);
    await doc.apply(new SetPageLabelCommand(doc, doc.page(0).id, 'x'));
    expect(doc.isDirty).toBe(true);
    await doc.save();
    expect(doc.isDirty).toBe(false);
  });

  it('refuses to work once closed', async () => {
    const { doc } = await openFake();
    await doc.close();
    await expect(
      doc.apply(
        command(
          'x',
          'X',
          () => undefined,
          () => undefined,
        ),
      ),
    ).rejects.toThrow('is closed');
    await expect(doc.save()).rejects.toThrow('is closed');
    await doc.close(); // closing twice is a no-op
  });
});

describe('write intents', () => {
  it('lists what the engine refused, and clears them again on undo', async () => {
    const { doc } = await openFake(RICH_SPEC, { setMetadata: false });
    const { SetMetadataCommand } = await import('@core/commands');
    await doc.apply(new SetMetadataCommand(doc, { title: 'New title' }));
    expect(doc.state.writeIntents).toContain('metadata');
    expect(doc.state.metadata.title).toBe('New title');
    await doc.undoLast();
    expect(doc.state.writeIntents).not.toContain('metadata');
  });

  it('stays empty when the engine takes every change', async () => {
    const { doc } = await openFake(RICH_SPEC);
    const { RotatePagesCommand } = await import('@core/commands');
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90));
    expect(doc.state.writeIntents).toEqual([]);
  });
});

describe('validate', () => {
  it('is happy with a freshly opened document', async () => {
    const { doc } = await openFake();
    await loadAllAnnotations(doc);
    expect(doc.validate()).toEqual([]);
  });

  it('reports a document with no pages', async () => {
    const { doc } = await openFake({ pageCount: 1 });
    doc.removePageRecord(doc.page(0).id);
    expect(doc.validate().map((i) => i.code)).toContain('document.no-pages');
  });

  it('a removed page takes its annotations with it, so nothing is orphaned', async () => {
    const { doc } = await openFake();
    await loadAllAnnotations(doc);
    const pageId = doc.page(0).id;
    const removed = doc.removePageRecord(pageId);
    expect(removed?.annotations).toHaveLength(2);
    expect(doc.validate().map((i) => i.code)).not.toContain('annotation.orphan-page');
  });

  it('reports annotations filed against a page that is not in the document', async () => {
    const { doc } = await openFake();
    await loadAllAnnotations(doc);
    const orphans = doc.annotations(doc.page(0).id);
    doc.removePageRecord(doc.page(0).id);
    // Put the annotations back by hand, as a broken recovery file might.
    doc.restoreAnnotations(must(orphans[0]?.pageId), orphans);
    expect(doc.validate().map((i) => i.code)).toContain('annotation.orphan-page');
  });

  it('distinguishes a page whose annotations were never loaded from one with none', async () => {
    const { doc } = await openFake();
    const removed = doc.removePageRecord(doc.page(3).id);
    expect(removed?.annotations).toBeNull();
  });

  it('reports a bad rectangle and a bad opacity', async () => {
    const { doc } = await openFake();
    const pageId = doc.page(0).id;
    const list = await doc.loadAnnotations(pageId);
    const first = list[0];
    if (!first) throw new Error('fixture has no annotation');
    doc.putAnnotation({ ...first, rect: { x0: 10, y0: 10, x1: 0, y1: 0 }, opacity: 4 });
    const codes = doc.validate().map((i) => i.code);
    expect(codes).toContain('annotation.bad-rect');
    expect(codes).toContain('annotation.bad-opacity');
  });

  it('reports a page whose rotation is not a quarter turn', async () => {
    const { doc } = await openFake();
    doc.replacePage(doc.page(0).id, (p) => ({ ...p, rotation: 45 as never }), 'rotation');
    expect(doc.validate().map((i) => i.code)).toContain('page.bad-rotation');
  });

  it('reports a destination pointing at a page that has gone', async () => {
    const { doc } = await openFake();
    doc.removePageRecord(doc.page(0).id);
    expect(doc.validate().map((i) => i.code)).toContain('destination.orphan-page');
  });
});

/**
 * The remaining invariants. A `validate()` that only fires on the easy cases is worse than
 * none, so every issue code the model can raise has a test that provokes it.
 */
describe('validate covers every invariant it claims', () => {
  it('reports a bad optional page box', async () => {
    const { doc } = await openFake();
    doc.replacePage(
      doc.page(0).id,
      (p) => ({ ...p, trimBox: { x0: 10, y0: 10, x1: 0, y1: 0 } }),
      'boxes',
      'trim',
    );
    expect(doc.validate().map((i) => i.code)).toContain('page.bad-box');
  });

  it('reports an annotation filed under a page it does not name', async () => {
    const { doc } = await openFake();
    const first = doc.page(0).id;
    const second = doc.page(1).id;
    const list = await doc.loadAnnotations(first);
    const stray = must(list[0], 'annotation');
    doc.restoreAnnotations(second, [stray]);
    expect(doc.validate().map((i) => i.code)).toContain('annotation.page-mismatch');
  });

  it('reports a field whose parent is not in the document', async () => {
    const { doc } = await openFake();
    const child = must(doc.fieldByName('address.city'), 'field');
    doc.store.set((s) => ({
      fields: s.fields
        .filter((f) => f.name !== 'address')
        .map((f) => (f.id === child.id ? { ...f, parentId: 'fl-999' as ModelId } : f)),
    }));
    expect(doc.validate().map((i) => i.code)).toContain('field.missing-parent');
  });

  it('reports a widget on a page that has gone', async () => {
    const { doc } = await openFake();
    doc.removePageRecord(doc.page(0).id);
    expect(doc.validate().map((i) => i.code)).toContain('field.widget-orphan-page');
  });

  it('reports a bookmark whose parent or child is missing', async () => {
    const { doc } = await openFake();
    const roots = doc.state.outline;
    const root = must(roots[0], 'bookmark');
    doc.setOutlineRecord([
      { ...root, parentId: 'ol-999' as ModelId, childIds: ['ol-998' as ModelId] },
    ]);
    const codes = doc.validate().map((i) => i.code);
    expect(codes).toContain('outline.missing-parent');
    expect(codes).toContain('outline.missing-child');
  });

  it('reports duplicate ids', async () => {
    const { doc } = await openFake();
    const first = doc.page(0);
    doc.insertPageRecord({ ...first }, 1);
    expect(doc.validate().map((i) => i.code)).toContain('page.duplicate-id');
  });
});

describe('the events emitter', () => {
  it('stops delivering to onAny after unsubscribe', async () => {
    const { doc } = await openFake();
    const seen: string[] = [];
    const off = doc.onAny((e) => seen.push(e.type));
    doc.setMetadataRecord({ title: 'a' });
    expect(seen).toContain('metadata:changed');
    off();
    const before = seen.length;
    doc.setMetadataRecord({ title: 'b' });
    expect(seen).toHaveLength(before);
  });

  it('counts its listeners, for leak checks', async () => {
    const { doc } = await openFake();
    const start = doc.events.listenerCount;
    const offOne = doc.on('metadata:changed', () => undefined);
    const offAny = doc.onAny(() => undefined);
    expect(doc.events.listenerCount).toBe(start + 2);
    offOne();
    offAny();
    expect(doc.events.listenerCount).toBe(start);
  });
});

describe('model mutators are no-ops for entities that are not there', () => {
  it('ignore unknown ids rather than throwing', async () => {
    const { doc } = await openFake();
    const before = doc.snapshot();
    doc.replacePage('pg-99' as ModelId, (p) => p, 'label');
    doc.removePageRecord('pg-99' as ModelId);
    doc.movePageRecord('pg-99' as ModelId, 0);
    doc.removeAnnotationRecord('an-99' as ModelId);
    doc.setFieldValueRecord('fl-99' as ModelId, 'x');
    doc.setLayerVisibleRecord('ly-99' as ModelId, false);
    doc.forgetAnnotations('pg-99' as ModelId);
    doc.deleteCustomRecord('M99');
    doc.restoreAnnotations('pg-99' as ModelId, null);
    expect(doc.snapshot()).toEqual(before);
  });
});

describe('the idle merge barrier', () => {
  it('splits a run of edits once the user has paused', async () => {
    const { doc } = await openFake();
    doc.mergeIdleMs = 500;
    const pageId = doc.page(0).id;
    const clock = vi.spyOn(Date, 'now');

    clock.mockReturnValue(10_000);
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'a'));
    clock.mockReturnValue(10_100);
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'ab'));
    expect(doc.undo.state.length).toBe(1);

    // A pause longer than the barrier starts a new entry.
    clock.mockReturnValue(20_000);
    await doc.apply(new SetPageLabelCommand(doc, pageId, 'abc'));
    expect(doc.undo.state.length).toBe(2);

    clock.mockRestore();
    await doc.undoLast();
    expect(doc.page(0).label).toBe('ab');
    await doc.undoLast();
    expect(doc.page(0).label).toBe('i');
  });
});
