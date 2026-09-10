/**
 * M50's edit state: what is read back from the custom bag, how ids and order work, and what the
 * writer is handed.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_STATE,
  baseId,
  fromBase64,
  indexOfId,
  isReordered,
  liveIds,
  plannedEdits,
  plannedObjectsFor,
  readObjectsState,
  toBase64,
  type LiveObject,
  type PageEditState,
  OBJECTS_NAMESPACE,
} from '@modules/M50-object-model/model';
import { openFake } from '../core/helpers';

const state = (live: LiveObject[], extra: Partial<PageEditState> = {}): PageEditState => ({
  original: toBase64(new TextEncoder().encode('q Q')),
  resources: '',
  kinds: ['path', 'text', 'image'],
  textMatrices: { '1': [1, 0, 0, 1, 10, 20] },
  live,
  pasted: 0,
  ...extra,
});

describe('readObjectsState', () => {
  it('is empty for an empty bag and drops anything malformed', () => {
    expect(readObjectsState({})).toEqual(EMPTY_STATE);
    const read = readObjectsState({
      pages: {
        p1: {
          original: 'AA==',
          kinds: ['path', 3],
          live: [{ kind: 'base', id: 'b0', index: 0 }, { nope: 1 }],
          textMatrices: { '0': [1, 0, 0, 1, 0, 0], '1': 'x' },
        },
        p2: { original: 5 },
      },
      groups: { p1: { g1: ['b0', 'b1', 7] }, p3: 'no' },
    });
    expect(Object.keys(read.pages)).toEqual(['p1']);
    expect(read.pages['p1']?.kinds).toEqual(['path']);
    expect(read.pages['p1']?.live).toEqual([{ kind: 'base', id: 'b0', index: 0 }]);
    expect(Object.keys(read.pages['p1']?.textMatrices ?? {})).toEqual(['0']);
    expect(read.groups['p1']).toEqual({ g1: ['b0', 'b1'] });
    expect(read.groups['p3']).toBeUndefined();
  });

  it('keeps transforms, styles and pasted entries', () => {
    const read = readObjectsState({
      pages: {
        p1: {
          original: 'AA==',
          kinds: [],
          live: [
            {
              kind: 'base',
              id: 'b0',
              index: 0,
              transform: [1, 0, 0, 1, 5, 5],
              style: { fillColor: 1, dash: [1, 2] },
            },
            { kind: 'pasted', id: 'p1', pdf: 'AA==', matrix: [1, 0, 0, 1, 0, 0], from: 'image' },
            { kind: 'pasted', id: 'p2', pdf: 'AA==', matrix: [1, 0, 0, 1, 0, 0], from: 'nonsense' },
          ],
          pasted: 2,
        },
      },
    });
    const live = read.pages['p1']?.live ?? [];
    expect(live[0]).toMatchObject({
      transform: [1, 0, 0, 1, 5, 5],
      style: { fillColor: 1, dash: [1, 2] },
    });
    expect(live[1]).toMatchObject({ kind: 'pasted', from: 'image' });
    expect(live[2]).toMatchObject({ from: 'form' });
    expect(read.pages['p1']?.pasted).toBe(2);
  });
});

describe('ids and order', () => {
  it('names baseline objects by index until a page has state', () => {
    expect(baseId(3)).toBe('b3');
    expect(liveIds(null, 3)).toEqual(['b0', 'b1', 'b2']);
    expect(liveIds(state([{ kind: 'base', id: 'b2', index: 2 }]), 9)).toEqual(['b2']);
    expect(indexOfId([{ kind: 'base', id: 'b2', index: 2 }], 'b2')).toBe(0);
    expect(indexOfId([], 'b2')).toBe(-1);
  });

  it('tells a replayable order from a rewritten one', () => {
    const base = (i: number): LiveObject => ({ kind: 'base', id: `b${i}`, index: i });
    const pasted = (n: number): LiveObject => ({
      kind: 'pasted',
      id: `p${n}`,
      pdf: '',
      matrix: [1, 0, 0, 1, 0, 0],
      from: 'path',
    });
    expect(isReordered([base(0), base(2), pasted(1), pasted(2)])).toBe(false);
    expect(isReordered([base(2), base(0)])).toBe(true);
    expect(isReordered([pasted(1), base(0)])).toBe(true);
    expect(isReordered([base(0), pasted(2), pasted(1)])).toBe(true);
    expect(isReordered([])).toBe(false);
  });
});

describe('plannedEdits', () => {
  it('lists transforms, styles, inserts and the removals implied by absence', () => {
    const edits = plannedEdits(
      state([
        {
          kind: 'base',
          id: 'b0',
          index: 0,
          transform: [1, 0, 0, 1, 1, 1],
          style: { strokeWidth: 2 },
        },
        { kind: 'base', id: 'b2', index: 2 },
        { kind: 'pasted', id: 'p1', pdf: 'QQ==', matrix: [1, 0, 0, 1, 3, 3], from: 'path' },
      ]),
    );
    expect(edits).toEqual([
      { kind: 'transform', index: 0, matrix: [1, 0, 0, 1, 1, 1] },
      { kind: 'style', index: 0, style: { strokeWidth: 2 } },
      { kind: 'insert', pdf: 'QQ==', matrix: [1, 0, 0, 1, 3, 3] },
      { kind: 'remove', index: 1 },
    ]);
  });
});

describe('plannedObjectsFor', () => {
  it('plans a page with state, even with no edits left, and nothing for a reordered one', async () => {
    const { doc } = await openFake();
    const page = doc.state.pages[0];
    if (!page) throw new Error('no page');
    expect(plannedObjectsFor(doc, page.id)).toBeUndefined();
    doc.setCustomRecord(OBJECTS_NAMESPACE, {
      pages: {
        [page.id]: state([
          { kind: 'base', id: 'b0', index: 0 },
          { kind: 'base', id: 'b1', index: 1 },
          { kind: 'base', id: 'b2', index: 2 },
        ]),
      },
    });
    const planned = plannedObjectsFor(doc, page.id);
    expect(planned?.edits).toEqual([]);
    expect(planned?.kinds).toEqual(['path', 'text', 'image']);
    expect(planned?.textMatrices).toEqual({ '1': [1, 0, 0, 1, 10, 20] });
    expect(new TextDecoder().decode(fromBase64(planned?.original ?? ''))).toBe('q Q');
    doc.setCustomRecord(OBJECTS_NAMESPACE, {
      pages: {
        [page.id]: state([
          { kind: 'base', id: 'b1', index: 1 },
          { kind: 'base', id: 'b0', index: 0 },
        ]),
      },
    });
    expect(plannedObjectsFor(doc, page.id)).toBeUndefined();
  });
});

describe('base64', () => {
  it('round-trips bytes of every value', () => {
    const bytes = new Uint8Array(70000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 255;
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});
