/**
 * Viewer settings and the per-document memory (M11).
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  ipcSettingsStorage,
  documentKey,
  memorySettingsStorage,
  readDocumentState,
  readSettings,
  settingKey,
  VIEWER_SETTINGS_SCHEMA,
  writeDocumentState,
  writeSetting,
} from '@modules/M11-viewer/settings';
import { flagsKey, renderOptions, DEFAULT_FLAGS } from '@view/TileRenderer';

describe('settings', () => {
  it('falls back to the defaults when nothing is stored', async () => {
    expect(await readSettings(memorySettingsStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it('reads what was written', async () => {
    const storage = memorySettingsStorage();
    await writeSetting(storage, 'cacheMegabytes', 512);
    await writeSetting(storage, 'rulerUnits', 'in');
    await writeSetting(storage, 'grid', true);
    const settings = await readSettings(storage);
    expect(settings.cacheMegabytes).toBe(512);
    expect(settings.rulerUnits).toBe('in');
    expect(settings.grid).toBe(true);
  });

  it('ignores a stored value of the wrong type rather than corrupting the view', async () => {
    const storage = memorySettingsStorage({
      'viewer.cache.megabytes': 'lots',
      'viewer.rulers': 1,
      'viewer.grid.spacing': null,
    });
    const settings = await readSettings(storage);
    expect(settings.cacheMegabytes).toBe(DEFAULT_SETTINGS.cacheMegabytes);
    expect(settings.rulers).toBe(DEFAULT_SETTINGS.rulers);
    expect(settings.gridSpacing).toBe(DEFAULT_SETTINGS.gridSpacing);
  });

  it('every setting has a key and a schema entry, and the defaults agree', () => {
    for (const name of Object.keys(DEFAULT_SETTINGS) as Array<keyof typeof DEFAULT_SETTINGS>) {
      const key = settingKey(name);
      expect(key.startsWith('viewer.')).toBe(true);
      const property = key.slice('viewer.'.length);
      const spec = VIEWER_SETTINGS_SCHEMA.properties[property];
      expect(spec, `schema entry for ${key}`).toBeDefined();
      expect(spec?.default, `default for ${key}`).toEqual(DEFAULT_SETTINGS[name]);
    }
  });

  it('the schema namespace matches the key prefix', () => {
    expect(VIEWER_SETTINGS_SCHEMA.namespace).toBe('viewer');
  });

  it('the layout and zoom enums list every value the viewer accepts', () => {
    const layout = VIEWER_SETTINGS_SCHEMA.properties['layout'];
    expect(layout?.type).toBe('enum');
    if (layout?.type === 'enum') {
      expect(layout.options.map((o) => o.value)).toEqual([
        'single',
        'continuous',
        'facing',
        'facingContinuous',
        'book',
      ]);
    }
  });
});

describe('the IPC-backed storage', () => {
  it('reads nothing and writes nothing outside Electron, rather than throwing', async () => {
    // Unit tests run in Node with no preload bridge; the viewer must still boot on defaults.
    const storage = ipcSettingsStorage();
    expect(await storage.get('viewer.rulers')).toBeUndefined();
    await expect(storage.set('viewer.rulers', true)).resolves.toBeUndefined();
    expect(await readSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('per-document memory', () => {
  it('keys on the path without letting the path into the settings key', () => {
    const key = documentKey('D:\\Reports\\Q3 (final).pdf');
    expect(key).toMatch(/^viewer\.documents\.[a-z0-9]+$/);
    expect(key).not.toContain('\\');
    expect(key).not.toContain(' ');
    expect(documentKey('D:\\Reports\\Q3 (final).pdf')).toBe(key);
    expect(documentKey('D:\\Reports\\Q4 (final).pdf')).not.toBe(key);
  });

  it('round-trips the view state', async () => {
    const storage = memorySettingsStorage();
    const state = {
      page: 12,
      zoom: 1.5,
      fit: null,
      layout: 'facing' as const,
      scrollTop: 900,
      scrollLeft: 10,
      guides: [{ page: 12, axis: 'vertical' as const, at: 100 }],
    };
    await writeDocumentState(storage, '/tmp/a.pdf', state);
    expect(await readDocumentState(storage, '/tmp/a.pdf')).toEqual(state);
  });

  it('an unknown document remembers nothing', async () => {
    expect(await readDocumentState(memorySettingsStorage(), '/tmp/never.pdf')).toEqual({});
  });

  it('rubbish in the store reads as nothing rather than throwing', async () => {
    const storage = memorySettingsStorage({ [documentKey('/x.pdf')]: 'nonsense' });
    expect(await readDocumentState(storage, '/x.pdf')).toEqual({});
  });
});

describe('render flags', () => {
  it('the key changes whenever a flag that changes pixels changes', () => {
    const base = flagsKey(DEFAULT_FLAGS);
    for (const name of Object.keys(DEFAULT_FLAGS) as Array<keyof typeof DEFAULT_FLAGS>) {
      expect(flagsKey({ ...DEFAULT_FLAGS, [name]: !DEFAULT_FLAGS[name] })).not.toBe(base);
    }
  });

  it('translates to engine render options, rotation included', () => {
    const options = renderOptions({ ...DEFAULT_FLAGS, lineWeights: false, grayscale: true }, 90);
    expect(options.lineWeights).toBe(false);
    expect(options.grayscale).toBe(true);
    expect(options.rotation).toBe(90);
    expect(options.background).toBeUndefined();
    expect(renderOptions(DEFAULT_FLAGS, 0, 0x112233).background).toBe(0x112233);
  });
});
