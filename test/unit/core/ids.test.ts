import { describe, expect, it } from 'vitest';
import { IdAllocator, IdTable, isId, kindOf, type ModelId } from '@core/Ids';

describe('IdAllocator', () => {
  it('numbers each kind separately and never repeats', () => {
    const ids = new IdAllocator();
    expect(ids.next('page')).toBe('pg-1');
    expect(ids.next('page')).toBe('pg-2');
    expect(ids.next('annotation')).toBe('an-1');
    expect(ids.count('page')).toBe(2);
    expect(ids.count('annotation')).toBe(1);
  });

  it('produces a thousand distinct ids', () => {
    const ids = new IdAllocator();
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(ids.next('annotation'));
    expect(seen.size).toBe(1000);
  });

  it('reserves ids from a replayed journal so later allocations cannot collide', () => {
    const ids = new IdAllocator();
    ids.reserve('pg-40' as ModelId);
    expect(ids.next('page')).toBe('pg-41');
  });

  it('ignores a reservation that is not a model id', () => {
    const ids = new IdAllocator();
    ids.reserve('nonsense' as ModelId);
    ids.reserve('pg-not-a-number' as ModelId);
    expect(ids.next('page')).toBe('pg-1');
  });

  it('round-trips its counters', () => {
    const ids = new IdAllocator();
    ids.next('page');
    ids.next('page');
    ids.next('layer');
    const restored = IdAllocator.fromJSON(ids.toJSON());
    expect(restored.next('page')).toBe('pg-3');
    expect(restored.next('layer')).toBe('ly-2');
  });

  it('ignores unknown kinds and non-integers when restoring', () => {
    const restored = IdAllocator.fromJSON({ page: 5, nonsense: 9, layer: 1.5 });
    expect(restored.next('page')).toBe('pg-6');
    expect(restored.next('layer')).toBe('ly-1');
  });

  it('recognises the kind of an id', () => {
    expect(kindOf('pg-3')).toBe('page');
    expect(kindOf('an-3')).toBe('annotation');
    expect(kindOf('zz-3')).toBeNull();
    expect(kindOf('nodash')).toBeNull();
    expect(isId('fl-1', 'field')).toBe(true);
    expect(isId('fl-1', 'page')).toBe(false);
  });
});

describe('IdTable', () => {
  const a = 'pg-1' as ModelId;
  const b = 'pg-2' as ModelId;

  it('maps both ways within a kind', () => {
    const t = new IdTable();
    t.bind('page', a, '0');
    expect(t.engineKey('page', a)).toBe('0');
    expect(t.modelId('page', '0')).toBe(a);
    expect(t.has('page', a)).toBe(true);
    expect(t.size('page')).toBe(1);
  });

  it('keeps kinds apart, so a page and an annotation may share an engine key', () => {
    const t = new IdTable();
    t.bind('page', a, '0');
    t.bind('annotation', 'an-1' as ModelId, '0');
    expect(t.modelId('page', '0')).toBe(a);
    expect(t.modelId('annotation', '0')).toBe('an-1');
  });

  it('re-binding an engine key drops the model id that held it', () => {
    const t = new IdTable();
    t.bind('page', a, '0');
    t.bind('page', b, '0');
    expect(t.modelId('page', '0')).toBe(b);
    expect(t.engineKey('page', a)).toBeUndefined();
  });

  it('re-binding a model id drops its old engine key', () => {
    const t = new IdTable();
    t.bind('page', a, '0');
    t.bind('page', a, '5');
    expect(t.engineKey('page', a)).toBe('5');
    expect(t.modelId('page', '0')).toBeUndefined();
  });

  it('unbinds without touching other entries', () => {
    const t = new IdTable();
    t.bind('page', a, '0');
    t.bind('page', b, '1');
    t.unbind('page', a);
    expect(t.engineKey('page', a)).toBeUndefined();
    expect(t.engineKey('page', b)).toBe('1');
    t.unbind('page', a); // second time is a no-op
    expect(t.size('page')).toBe(1);
  });

  it('rebindAll replaces every entry of one kind and leaves the others alone', () => {
    const t = new IdTable();
    t.bind('page', a, '0');
    t.bind('annotation', 'an-1' as ModelId, 'a0.0');
    t.rebindAll('annotation', [
      ['an-7' as ModelId, 'a0.0'],
      ['an-8' as ModelId, 'a0.1'],
    ]);
    expect(t.modelId('annotation', 'a0.0')).toBe('an-7');
    expect(t.engineKey('annotation', 'an-1' as ModelId)).toBeUndefined();
    expect(t.engineKey('page', a)).toBe('0');
  });
});
