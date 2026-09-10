/**
 * The settings file's contract (`src/shared/settings.ts`) and the hub above it
 * (`SettingsService`): versions and migrations, the flat/nested pair, export and import, and —
 * the part that matters most — that a write reaches the module which owns the setting.
 *
 * Everything here runs in Node with a memory store, so "live apply" is proved by a fake service
 * with a `load()` rather than by a running application; the e2e suite proves the real thing.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildExport,
  drop,
  dropTree,
  EXPORT_KIND,
  flatten,
  isSettingsKey,
  migrate,
  parseExport,
  SCHEMA_VERSION,
  SettingsImportError,
  under,
  unflatten,
  valueAt,
  VERSION_KEY,
  type Migration,
  type SettingsRecord,
} from '@shared/settings';
import {
  memorySettingsStorage,
  SettingsService,
  type ServiceLookup,
  type SettingsApplier,
} from '@modules/M130-preferences/SettingsService';

describe('dotted keys', () => {
  it('accepts the keys the modules actually use', () => {
    for (const key of ['theme.name', 'viewer.cache.megabytes', 'ui.bookmarks.wrapTitles']) {
      expect(isSettingsKey(key)).toBe(true);
    }
  });

  it('refuses empty segments, whitespace and bracket syntax', () => {
    for (const key of ['', '.a', 'a.', 'a..b', 'a b', 'a["b"]', 'a.b[0]']) {
      expect(isSettingsKey(key)).toBe(false);
    }
  });

  it('knows what sits under a prefix', () => {
    expect(under('ui.qat', 'ui')).toBe(true);
    expect(under('ui', 'ui')).toBe(true);
    // A prefix is a whole segment, not a string prefix.
    expect(under('uiscale', 'ui')).toBe(false);
  });
});

describe('flatten / unflatten', () => {
  it('round-trips the shape electron-store keeps on disk', () => {
    const nested = {
      theme: { name: 'graphite' },
      ui: { qat: ['file.open'], leftPane: { width: 260, collapsed: false } },
      version: 1,
    };
    const flat = flatten(nested);
    expect(flat).toEqual({
      'theme.name': 'graphite',
      'ui.qat': ['file.open'],
      'ui.leftPane.width': 260,
      'ui.leftPane.collapsed': false,
      version: 1,
    });
    expect(unflatten(flat)).toEqual(nested);
  });

  it('treats an array as a value, not as a branch', () => {
    expect(flatten({ a: ['x', 'y'] })).toEqual({ a: ['x', 'y'] });
  });

  it('keeps an empty object as a value so a key is never lost', () => {
    expect(flatten({ a: {} })).toEqual({ a: {} });
  });

  it('drops one key without touching the rest', () => {
    const record: SettingsRecord = { a: 1, b: 2 };
    drop(record, 'a');
    expect(record).toEqual({ b: 2 });
  });

  /**
   * The store is a tree, so an object stored at a key becomes several keys. These three tests
   * are the ones that matter: a module has to get back the object it wrote.
   */
  it('rebuilds an object setting that flattening spread across several keys', () => {
    const flat = flatten({ annot: { defaults: { note: { color: 255, fontSize: 12 } } } });
    expect(flat).toEqual({ 'annot.defaults.note.color': 255, 'annot.defaults.note.fontSize': 12 });
    expect(valueAt(flat, 'annot.defaults.note')).toEqual({ color: 255, fontSize: 12 });
    expect(valueAt(flat, 'annot.defaults.note.color')).toBe(255);
    expect(valueAt(flat, 'nothing.here')).toBeUndefined();
  });

  it('deletes a whole subtree, not just the exact key', () => {
    const record = flatten({ annot: { defaults: { note: { color: 1 } }, other: true } });
    dropTree(record, 'annot.defaults');
    expect(record).toEqual({ 'annot.other': true });
  });

  it('keeps an array whole — which is why a map with dotted keys is stored as one', () => {
    // `{ 'edit.find': 'Mod+F' }` would come back as `{ edit: { find: … } }`; a list of entries
    // is a leaf, so it survives untouched.
    const entries = [{ command: 'edit.find', key: 'Mod+F' }];
    const flat = flatten({ shortcuts: { bindings: entries } });
    expect(flat).toEqual({ 'shortcuts.bindings': entries });
    expect(valueAt(flat, 'shortcuts.bindings')).toEqual(entries);
  });
});

describe('migrations', () => {
  it('stamps an unversioned file with the current version and changes nothing else', () => {
    const { record, applied } = migrate({ 'theme.name': 'midnight' });
    expect(applied).toEqual([]);
    expect(record).toEqual({ 'theme.name': 'midnight', [VERSION_KEY]: SCHEMA_VERSION });
  });

  it('does not modify the record it is given', () => {
    const before: SettingsRecord = { a: 1 };
    migrate(before);
    expect(before).toEqual({ a: 1 });
  });

  it('leaves a file from a newer build alone, version and all', () => {
    const { record } = migrate({ [VERSION_KEY]: 99, 'future.setting': true });
    expect(record[VERSION_KEY]).toBe(99);
    expect(record['future.setting']).toBe(true);
  });

  it('runs only the steps a file has not had — the mechanism, on a worked example', () => {
    // The shipped list is empty (nothing has been renamed yet), so the ordering rule is proved
    // by handing `migrate` real steps rather than left untested until the first real rename.
    const ran: number[] = [];
    const steps: Migration[] = [
      {
        to: 2,
        note: 'two',
        apply: (r) => {
          ran.push(2);
          r['two'] = true;
        },
      },
      {
        to: 3,
        note: 'three',
        apply: (r) => {
          ran.push(3);
          r['three'] = true;
        },
      },
    ];
    const first = migrate({ [VERSION_KEY]: 1, 'theme.name': 'graphite' }, steps);
    expect(first.record).toMatchObject({ two: true, three: true, 'theme.name': 'graphite' });
    expect(first.applied.map((m) => m.note)).toEqual(['two', 'three']);
    expect(ran).toEqual([2, 3]);

    ran.length = 0;
    const second = migrate({ [VERSION_KEY]: 2 }, steps);
    expect(second.record['two']).toBeUndefined();
    expect(second.record['three']).toBe(true);
    expect(ran).toEqual([3]);

    ran.length = 0;
    expect(migrate({ [VERSION_KEY]: 3 }, steps).applied).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('treats a version that is not a finite number as the oldest one', () => {
    const steps: Migration[] = [
      {
        to: 2,
        note: 'two',
        apply: (r) => {
          r['two'] = true;
        },
      },
    ];
    expect(migrate({ [VERSION_KEY]: 'one' }, steps).record['two']).toBe(true);
    expect(migrate({ [VERSION_KEY]: Number.NaN }, steps).record['two']).toBe(true);
  });
});

describe('export and import', () => {
  it('writes an envelope that says what it is, without the version key as a setting', () => {
    const envelope = buildExport(
      { 'theme.name': 'daylight', [VERSION_KEY]: SCHEMA_VERSION },
      { now: new Date('2026-09-10T09:00:00Z'), app: '0.0.1' },
    );
    expect(envelope.kind).toBe(EXPORT_KIND);
    expect(envelope.settings).toEqual({ 'theme.name': 'daylight' });
    expect(envelope.exported).toBe('2026-09-10T09:00:00.000Z');
    expect(envelope.app).toBe('0.0.1');
  });

  it('reads its own output back', () => {
    const text = JSON.stringify(buildExport({ 'ui.qat': ['file.open'], 'theme.name': 'midnight' }));
    const { settings, dropped } = parseExport(text);
    expect(settings).toEqual({ 'ui.qat': ['file.open'], 'theme.name': 'midnight' });
    expect(dropped).toEqual([]);
  });

  it('accepts a hand-written nested file as well as a flat one', () => {
    const text = JSON.stringify({
      kind: EXPORT_KIND,
      version: 1,
      exported: '2026-09-10T09:00:00.000Z',
      settings: { theme: { name: 'high-contrast' } },
    });
    expect(parseExport(text).settings).toEqual({ 'theme.name': 'high-contrast' });
  });

  it('drops an unusable line rather than refusing the whole file', () => {
    const text = JSON.stringify({
      kind: EXPORT_KIND,
      version: 1,
      exported: '',
      settings: { 'theme.name': 'graphite', 'a..b': 1 },
    });
    const result = parseExport(text);
    expect(result.settings).toEqual({ 'theme.name': 'graphite' });
    expect(result.dropped).toEqual(['a..b']);
  });

  it('says in a sentence why a file is not one of ours', () => {
    expect(() => parseExport('%PDF-1.7')).toThrow(SettingsImportError);
    // Valid JSON, but a list or a string is still not a settings export.
    expect(() => parseExport('[1, 2, 3]')).toThrow(/does not contain a settings export/);
    expect(() => parseExport('"just text"')).toThrow(/does not contain a settings export/);
    expect(() => parseExport('{}')).toThrow(/not exported from ynotPDF/);
    expect(() => parseExport(JSON.stringify({ kind: EXPORT_KIND, version: 1 }))).toThrow(
      /no settings in it/,
    );
    try {
      parseExport('not json at all');
    } catch (error) {
      expect((error as Error).message).toMatch(/not JSON/);
    }
  });
});

// ---- the hub ------------------------------------------------------------------------------------

/** A module service of the shape ADR 0018 §6 describes. */
function fakeModule(): { load: () => void; calls: number } {
  const state = {
    calls: 0,
    load: (): void => {
      state.calls++;
    },
  };
  return state;
}

function lookup(services: Record<string, unknown>): ServiceLookup {
  return {
    serviceNames: () => Object.keys(services).sort(),
    service: <T>(name: string) => services[name] as T,
    hasService: (name) => name in services,
  };
}

describe('SettingsService', () => {
  it('reads the file into a cache and answers from it', async () => {
    const service = new SettingsService({
      storage: memorySettingsStorage({ 'theme.name': 'midnight' }),
    });
    expect(service.isLoaded).toBe(false);
    await service.load();
    expect(service.isLoaded).toBe(true);
    expect(service.peek('theme.name')).toBe('midnight');
    expect(service.snapshot()).toEqual({ 'theme.name': 'midnight' });
  });

  it('writes an aliased setting under both keys, whichever side is written', async () => {
    const storage = memorySettingsStorage();
    const service = new SettingsService({ storage });
    await service.load();
    await service.write('theme.scale', 150);
    expect(await storage.get('ui.scale')).toBe(150);
    expect(await storage.get('theme.scale')).toBe(150);
    await service.write('ui.scale', 120);
    expect(await storage.get('theme.scale')).toBe(120);
  });

  it('deletes a key when the value is undefined — that is how one setting is reset', async () => {
    const storage = memorySettingsStorage({ 'annot.showTooltips': false });
    const service = new SettingsService({ storage });
    await service.load();
    await service.write('annot.showTooltips', undefined);
    expect(await storage.get('annot.showTooltips')).toBeUndefined();
    expect(service.peek('annot.showTooltips')).toBeUndefined();
  });

  it('reloads every module service that can re-read itself, once per write', async () => {
    const viewer = fakeModule();
    const comments = fakeModule();
    const service = new SettingsService({
      storage: memorySettingsStorage(),
      registry: lookup({ viewer, comments, selection: {}, registry: {} }),
    });
    await service.load();
    await service.writeMany({ 'viewer.rulers': true, 'comments.sort': 'page' });
    expect(viewer.calls).toBe(1);
    expect(comments.calls).toBe(1);
  });

  it('leaves the services it was told to skip alone', async () => {
    const own = fakeModule();
    const other = fakeModule();
    const service = new SettingsService({
      storage: memorySettingsStorage(),
      registry: lookup({ preferences: own, other }),
      skipServices: ['preferences'],
    });
    await service.load();
    await service.write('x.y', 1);
    expect(own.calls).toBe(0);
    expect(other.calls).toBe(1);
  });

  it('carries on when one module refuses to reload, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const good = fakeModule();
    const bad = {
      load: () => {
        throw new Error('nope');
      },
    };
    const service = new SettingsService({
      storage: memorySettingsStorage(),
      registry: lookup({ aBad: bad, zGood: good }),
    });
    await service.load();
    await service.write('x.y', 1);
    expect(good.calls).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('runs an applier only when a key it cares about changed', async () => {
    const seen: SettingsRecord[] = [];
    const applier: SettingsApplier = {
      prefixes: ['theme'],
      apply: (values) => {
        seen.push(values);
      },
    };
    const service = new SettingsService({
      storage: memorySettingsStorage(),
      appliers: [applier],
    });
    await service.load();
    await service.write('viewer.rulers', true);
    expect(seen).toHaveLength(0);
    await service.write('theme.name', 'daylight');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.['theme.name']).toBe('daylight');
  });

  it('tells its listeners which keys changed', async () => {
    const service = new SettingsService({ storage: memorySettingsStorage() });
    await service.load();
    const keys: string[][] = [];
    const off = service.subscribe((changed) => keys.push([...changed]));
    await service.write('viewer.rulers', true);
    off();
    await service.write('viewer.grid', true);
    expect(keys).toEqual([['viewer.rulers']]);
  });

  it('resets one page without touching the others', async () => {
    const storage = memorySettingsStorage({
      'viewer.rulers': true,
      'viewer.grid': true,
      'theme.name': 'midnight',
    });
    const service = new SettingsService({ storage });
    await service.load();
    await service.reset(['viewer']);
    expect(service.peek('viewer.rulers')).toBeUndefined();
    expect(service.peek('theme.name')).toBe('midnight');
  });

  it('resets everything when it is given no prefixes', async () => {
    const service = new SettingsService({
      storage: memorySettingsStorage({ a: 1, b: 2 }),
    });
    await service.load();
    await service.reset([]);
    expect(service.snapshot()).toEqual({});
  });

  it('imports by merging: a key the file does not mention keeps its value', async () => {
    const storage = memorySettingsStorage({ 'theme.name': 'midnight', 'viewer.grid': true });
    const service = new SettingsService({ storage });
    await service.load();
    const text = JSON.stringify(buildExport({ 'theme.name': 'daylight' }));
    const result = await service.importText(text);
    expect(result.written).toBe(1);
    expect(service.peek('theme.name')).toBe('daylight');
    expect(service.peek('viewer.grid')).toBe(true);
  });

  it('exports what it holds, as text ending in a newline', async () => {
    const service = new SettingsService({
      storage: memorySettingsStorage({ 'theme.name': 'graphite' }),
    });
    const text = await service.exportText('0.0.1');
    expect(text.endsWith('\n')).toBe(true);
    expect(parseExport(text).settings).toEqual({ 'theme.name': 'graphite' });
  });

  it('round-trips export → reset → import', async () => {
    const storage = memorySettingsStorage({ 'theme.name': 'high-contrast', 'ui.scale': 150 });
    const service = new SettingsService({ storage });
    const text = await service.exportText();
    await service.reset([]);
    expect(service.snapshot()).toEqual({});
    await service.importText(text);
    expect(service.peek('theme.name')).toBe('high-contrast');
    expect(service.peek('ui.scale')).toBe(150);
  });
});
