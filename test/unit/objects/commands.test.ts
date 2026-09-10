/**
 * M50's commands against the fake engine and a real `Document`: every change reaches the
 * engine, the edit state follows it, undo reverses both exactly, drags merge, and the journal
 * replays it all.
 */

import { describe, expect, it } from 'vitest';
import { deserialiseCommand, serialiseCommand } from '@core/Journal';
import type { PageObject } from '@engine/PdfEngine';
import {
  DeleteObjectsCommand,
  InsertObjectCommand,
  ReorderObjectsCommand,
  SetGroupsCommand,
  SetObjectStyleCommand,
  TransformObjectsCommand,
  registerObjectCodecs,
} from '@modules/M50-object-model/commands';
import {
  OBJECTS_NAMESPACE,
  plannedObjectsFor,
  readObjectsState,
  toBase64,
} from '@modules/M50-object-model/model';
import type { FakeDocumentSpec } from '../core/fakeEngine';
import { must, openFake } from '../core/helpers';

registerObjectCodecs();

const OBJECTS: ReadonlyArray<Omit<PageObject, 'index'>> = [
  {
    kind: 'path',
    rect: { x0: 10, y0: 10, x1: 110, y1: 60 },
    matrix: [1, 0, 0, 1, 0, 0],
    strokeColor: 0,
    strokeWidth: 1,
  },
  {
    kind: 'text',
    rect: { x0: 72, y0: 700, x1: 200, y1: 712 },
    matrix: [12, 0, 0, 12, 72, 700],
    text: 'Hi',
  },
  {
    kind: 'image',
    rect: { x0: 300, y0: 300, x1: 400, y1: 400 },
    matrix: [100, 0, 0, 100, 300, 300],
  },
];

const SPEC: FakeDocumentSpec = { pageCount: 2, objects: { 0: OBJECTS, 1: OBJECTS.slice(0, 1) } };

async function setup() {
  const { doc, engine } = await openFake(SPEC);
  const page = must(doc.state.pages[0], 'page');
  const objects = async () => await engine.pageObjects(doc.handle, 0);
  const state = () => readObjectsState(doc.custom(OBJECTS_NAMESPACE)).pages[page.id] ?? null;
  return { doc, engine, page, objects, state };
}

describe('TransformObjectsCommand', () => {
  it('moves the engine object, records the transform, and undoes both', async () => {
    const { doc, page, objects, state } = await setup();
    await doc.apply(new TransformObjectsCommand(doc, page.id, ['b2'], [1, 0, 0, 1, 10, 0]));
    expect((await objects())[2]?.rect.x0).toBe(310);
    const s = must(state(), 'state');
    expect(s.kinds).toEqual(['path', 'text', 'image']);
    expect(s.textMatrices).toEqual({ '1': [12, 0, 0, 12, 72, 700] });
    expect(s.live[2]).toMatchObject({ kind: 'base', index: 2, transform: [1, 0, 0, 1, 10, 0] });
    expect(doc.state.writeIntents).toContain('page-objects');
    expect(plannedObjectsFor(doc, page.id)?.edits).toEqual([
      { kind: 'transform', index: 2, matrix: [1, 0, 0, 1, 10, 0] },
    ]);

    await doc.undoLast();
    expect((await objects())[2]?.rect.x0).toBe(300);
    // The first edit's capture goes with it: no state, nothing planned.
    expect(state()).toBeNull();
    expect(plannedObjectsFor(doc, page.id)).toBeUndefined();

    await doc.redoLast();
    expect((await objects())[2]?.rect.x0).toBe(310);
    expect(must(state(), 'state').live[2]).toMatchObject({ transform: [1, 0, 0, 1, 10, 0] });
  });

  it('merges consecutive nudges of the same objects into one undo step', async () => {
    const { doc, page, objects } = await setup();
    await doc.apply(new TransformObjectsCommand(doc, page.id, ['b0'], [1, 0, 0, 1, 1, 0], 'Nudge'));
    await doc.apply(new TransformObjectsCommand(doc, page.id, ['b0'], [1, 0, 0, 1, 2, 0], 'Nudge'));
    await doc.apply(new TransformObjectsCommand(doc, page.id, ['b0'], [1, 0, 0, 1, 3, 0], 'Nudge'));
    expect((await objects())[0]?.rect.x0).toBe(16);
    await doc.undoLast();
    expect((await objects())[0]?.rect.x0).toBe(10);
    expect(doc.state.writeIntents).not.toContain('page-objects');
  });

  it('does not merge different objects or different labels', async () => {
    const { doc, page, objects } = await setup();
    await doc.apply(new TransformObjectsCommand(doc, page.id, ['b0'], [1, 0, 0, 1, 1, 0], 'Nudge'));
    await doc.apply(new TransformObjectsCommand(doc, page.id, ['b1'], [1, 0, 0, 1, 1, 0], 'Nudge'));
    await doc.apply(new TransformObjectsCommand(doc, page.id, ['b1'], [1, 0, 0, 1, 1, 0], 'Move'));
    await doc.undoLast();
    expect((await objects())[1]?.rect.x0).toBe(73);
    await doc.undoLast();
    expect((await objects())[1]?.rect.x0).toBe(72);
    expect((await objects())[0]?.rect.x0).toBe(11);
  });

  it('replays from the journal', async () => {
    const { doc, page, objects } = await setup();
    const original = new TransformObjectsCommand(
      doc,
      page.id,
      ['b0', 'b2'],
      [2, 0, 0, 2, 0, 0],
      'Resize',
    );
    const entry = serialiseCommand(original);
    const replayed = must(deserialiseCommand(doc, entry), 'command');
    await doc.apply(replayed);
    expect((await objects())[0]?.rect.x1).toBe(220);
    expect((await objects())[2]?.rect.x1).toBe(800);
    expect(replayed.label).toBe('Resize');
  });
});

describe('DeleteObjectsCommand', () => {
  it('removes objects, plans their removal, and puts the same objects back on undo', async () => {
    const { doc, page, objects, state } = await setup();
    await doc.apply(new DeleteObjectsCommand(doc, page.id, ['b0', 'b2']));
    const left = await objects();
    expect(left.map((o) => o.kind)).toEqual(['text']);
    expect(must(state(), 'state').live.map((o) => o.id)).toEqual(['b1']);
    expect(plannedObjectsFor(doc, page.id)?.edits).toEqual([
      { kind: 'remove', index: 0 },
      { kind: 'remove', index: 2 },
    ]);
    await doc.undoLast();
    expect((await objects()).map((o) => o.kind)).toEqual(['path', 'text', 'image']);
    expect((await objects())[0]?.rect).toEqual(OBJECTS[0]?.rect);
    expect(state()).toBeNull();
    await doc.redoLast();
    expect((await objects()).map((o) => o.kind)).toEqual(['text']);
  });

  it('keeps ids stable through a deletion for a later transform', async () => {
    const { doc, page, objects } = await setup();
    await doc.apply(new DeleteObjectsCommand(doc, page.id, ['b0']));
    await doc.apply(new TransformObjectsCommand(doc, page.id, ['b2'], [1, 0, 0, 1, 0, 5]));
    const list = await objects();
    expect(list[1]?.kind).toBe('image');
    expect(list[1]?.rect.y0).toBe(305);
    expect(plannedObjectsFor(doc, page.id)?.edits).toEqual([
      { kind: 'transform', index: 2, matrix: [1, 0, 0, 1, 0, 5] },
      { kind: 'remove', index: 0 },
    ]);
  });
});

describe('InsertObjectCommand', () => {
  const pdf = toBase64(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0]));

  it('appends a form object, names it, and undoes/redoes', async () => {
    const { doc, page, objects, state, engine } = await setup();
    const command = new InsertObjectCommand(doc, page.id, pdf, [1, 0, 0, 1, 50, 50], 'path');
    await doc.apply(command);
    expect(command.insertedId).toBe('p1');
    expect((await objects())[3]).toMatchObject({ kind: 'form', rect: { x0: 50, y0: 50 } });
    expect(must(state(), 'state').live[3]).toMatchObject({
      kind: 'pasted',
      id: 'p1',
      from: 'path',
    });
    expect(plannedObjectsFor(doc, page.id)?.edits).toEqual([
      { kind: 'insert', pdf, matrix: [1, 0, 0, 1, 50, 50] },
    ]);
    await doc.undoLast();
    expect((await objects()).length).toBe(3);
    expect(engine.calls.filter((c) => c === 'removeObject').length).toBe(1);
    await doc.redoLast();
    expect((await objects()).length).toBe(4);
    expect(engine.calls.filter((c) => c === 'restoreObject').length).toBe(1);
    expect(must(state(), 'state').pasted).toBe(1);
  });

  it('moves a pasted object by composing its matrix', async () => {
    const { doc, page, state } = await setup();
    await doc.apply(new InsertObjectCommand(doc, page.id, pdf, [1, 0, 0, 1, 50, 50], 'image'));
    await doc.apply(new TransformObjectsCommand(doc, page.id, ['p1'], [1, 0, 0, 1, 5, 5]));
    expect(must(state(), 'state').live[3]).toMatchObject({ matrix: [1, 0, 0, 1, 55, 55] });
    expect(plannedObjectsFor(doc, page.id)?.edits).toEqual([
      { kind: 'insert', pdf, matrix: [1, 0, 0, 1, 55, 55] },
    ]);
  });
});

describe('ReorderObjectsCommand', () => {
  it('rewrites the order, takes the page off the writer path, and undoes', async () => {
    const { doc, page, objects, state } = await setup();
    await doc.apply(new ReorderObjectsCommand(doc, page.id, [2, 0, 1]));
    expect((await objects()).map((o) => o.kind)).toEqual(['image', 'path', 'text']);
    expect(must(state(), 'state').live.map((o) => o.id)).toEqual(['b2', 'b0', 'b1']);
    expect(plannedObjectsFor(doc, page.id)).toBeUndefined();
    await doc.undoLast();
    expect((await objects()).map((o) => o.kind)).toEqual(['path', 'text', 'image']);
    expect(state()).toBeNull();
  });
});

describe('SetObjectStyleCommand', () => {
  it('sets, merges and undoes a path style', async () => {
    const { doc, page, objects, state } = await setup();
    await doc.apply(
      new SetObjectStyleCommand(doc, page.id, 'b0', { strokeColor: 0xff }, { strokeColor: 0 }),
    );
    await doc.apply(
      new SetObjectStyleCommand(doc, page.id, 'b0', { strokeWidth: 3 }, { strokeWidth: 1 }),
    );
    expect((await objects())[0]).toMatchObject({ strokeColor: 0xff, strokeWidth: 3 });
    expect(must(state(), 'state').live[0]).toMatchObject({
      style: { strokeColor: 0xff, strokeWidth: 3 },
    });
    expect(plannedObjectsFor(doc, page.id)?.edits).toEqual([
      { kind: 'style', index: 0, style: { strokeColor: 0xff, strokeWidth: 3 } },
    ]);
    await doc.undoLast();
    expect((await objects())[0]).toMatchObject({ strokeColor: 0, strokeWidth: 1 });
    expect(state()).toBeNull();
  });
});

describe('SetGroupsCommand', () => {
  it('stores groups without touching the engine and undoes', async () => {
    const { doc, page, engine } = await setup();
    const before = engine.calls.length;
    await doc.apply(new SetGroupsCommand(doc, page.id, { g1: ['b0', 'b1'] }, 'Group'));
    expect(readObjectsState(doc.custom(OBJECTS_NAMESPACE)).groups[page.id]).toEqual({
      g1: ['b0', 'b1'],
    });
    expect(engine.calls.length).toBe(before);
    await doc.undoLast();
    expect(readObjectsState(doc.custom(OBJECTS_NAMESPACE)).groups[page.id]).toBeUndefined();
    const replayed = must(
      deserialiseCommand(
        doc,
        serialiseCommand(new SetGroupsCommand(doc, page.id, { g2: ['b2'] }, 'Group')),
      ),
      'command',
    );
    await doc.apply(replayed);
    expect(readObjectsState(doc.custom(OBJECTS_NAMESPACE)).groups[page.id]).toEqual({ g2: ['b2'] });
  });
});

describe('journal codecs', () => {
  it('rebuild every command kind and refuse a bad payload', async () => {
    const { doc, page } = await setup();
    const kinds = [
      new DeleteObjectsCommand(doc, page.id, ['b0']),
      new InsertObjectCommand(doc, page.id, 'QQ==', [1, 0, 0, 1, 0, 0], 'image'),
      new ReorderObjectsCommand(doc, page.id, [1, 0, 2]),
      new SetObjectStyleCommand(doc, page.id, 'b0', { fillColor: 1 }, {}),
    ];
    for (const c of kinds) {
      const back = deserialiseCommand(doc, serialiseCommand(c));
      expect(back?.id).toBe(c.id);
    }
    expect(deserialiseCommand(doc, { type: 'object.transform', payload: { ids: [] } })).toBeNull();
    expect(deserialiseCommand(doc, { type: 'object.insert', payload: { pageId: 'x' } })).toBeNull();
  });
});
