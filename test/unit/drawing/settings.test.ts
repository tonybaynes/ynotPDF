/**
 * M31's settings: factory defaults per tool, stored defaults merged over them field by field,
 * the pencil and eraser settings, favourites, and custom stamps.
 */

import { describe, expect, it } from 'vitest';
import {
  asCustomStamp,
  DEFAULT_DRAWING_SETTINGS,
  DRAWING_SETTINGS_SCHEMA,
  DRAWING_TOOLS,
  factoryDrawingDefaults,
  memorySettingsStorage,
  mergeDrawingDefaults,
  readCustomStamps,
  readDrawingDefaults,
  readDrawingSettings,
  writeCustomStamps,
  writeDrawingDefaults,
  writeDrawingSetting,
} from '@modules/M31-shapes-ink-stamps/settings';

describe('factory defaults', () => {
  it('gives every tool a subject, a colour and a width, and the arrow its head', () => {
    for (const tool of DRAWING_TOOLS) {
      const d = factoryDrawingDefaults(tool);
      expect(d.subject, tool).toBeTruthy();
      expect(d.borderWidth, tool).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(d.color), tool).toBe(true);
    }
    expect(factoryDrawingDefaults('arrow').lineEndings).toEqual(['None', 'OpenArrow']);
    expect(factoryDrawingDefaults('line').lineEndings).toEqual(['None', 'None']);
    expect(factoryDrawingDefaults('areaHighlight').borderWidth).toBe(0);
    expect(factoryDrawingDefaults('stamp').stampId).toBe('Approved');
  });

  it('merges a stored object over the factory, field by field, ignoring the wrong types', () => {
    const merged = mergeDrawingDefaults('rectangle', {
      color: 0x123456,
      fillColor: null,
      borderWidth: 'wide',
      dashArray: [3, 'x', -1, 2],
      lineEndings: ['Circle', 'Square'],
      cloudy: 2,
      nonsense: true,
    });
    expect(merged.color).toBe(0x123456);
    expect(merged.fillColor).toBeNull();
    expect(merged.borderWidth).toBe(2);
    expect(merged.dashArray).toEqual([3, 2]);
    expect(merged.lineEndings).toEqual(['Circle', 'Square']);
    expect(merged.cloudy).toBe(2);
    expect(mergeDrawingDefaults('line', { lineEndings: ['Circle'] }).lineEndings).toEqual([
      'None',
      'None',
    ]);
    expect(mergeDrawingDefaults('line', 'garbage')).toEqual(factoryDrawingDefaults('line'));
  });

  it('round-trips through storage', async () => {
    const storage = memorySettingsStorage();
    await writeDrawingDefaults(storage, 'pencil', {
      ...factoryDrawingDefaults('pencil'),
      borderWidth: 5,
    });
    expect((await readDrawingDefaults(storage, 'pencil')).borderWidth).toBe(5);
    expect((await readDrawingDefaults(storage, 'cloud')).cloudy).toBe(1);
  });
});

describe('the settings', () => {
  it('reads defaults for an empty store and honours what is stored, with types checked', async () => {
    expect(await readDrawingSettings(memorySettingsStorage())).toEqual(DEFAULT_DRAWING_SETTINGS);
    const storage = memorySettingsStorage({
      'draw.eraser.mode': 'stroke',
      'draw.eraser.radius': 'big',
      'draw.ink.groupStrokes': false,
      'stamps.favourites': ['Approved', 4, 'Draft'],
    });
    const settings = await readDrawingSettings(storage);
    expect(settings.eraserMode).toBe('stroke');
    expect(settings.eraserRadius).toBe(DEFAULT_DRAWING_SETTINGS.eraserRadius);
    expect(settings.inkGroupStrokes).toBe(false);
    expect(settings.favouriteStamps).toEqual(['Approved', 'Draft']);
    const odd = await readDrawingSettings(
      memorySettingsStorage({ 'draw.eraser.mode': 'sideways' }),
    );
    expect(odd.eraserMode).toBe('split');
  });

  it('writes one key at a time', async () => {
    const storage = memorySettingsStorage();
    await writeDrawingSetting(storage, 'eraserRadius', 9);
    expect(await storage.get('draw.eraser.radius')).toBe(9);
  });

  it('has a schema entry with a matching default for every preference it exposes', () => {
    expect(DRAWING_SETTINGS_SCHEMA.namespace).toBe('draw');
    expect(DRAWING_SETTINGS_SCHEMA.properties['eraser.mode']?.default).toBe(
      DEFAULT_DRAWING_SETTINGS.eraserMode,
    );
    expect(DRAWING_SETTINGS_SCHEMA.properties['ink.groupMs']?.default).toBe(
      DEFAULT_DRAWING_SETTINGS.inkGroupMs,
    );
  });
});

describe('custom stamps', () => {
  it('accepts a complete record and refuses a partial one', () => {
    expect(asCustomStamp({ id: 'a', label: 'A', data: 'AA==', width: 1, height: 1 })?.created).toBe(
      '',
    );
    expect(asCustomStamp({ id: 'a', label: 'A', data: 'AA==', width: 1 })).toBeNull();
    expect(asCustomStamp('no')).toBeNull();
  });

  it('round-trips a list and drops the malformed entries', async () => {
    const storage = memorySettingsStorage({
      'stamps.custom': [
        { id: 'x', label: 'X', data: 'AA==', width: 2, height: 3, created: 'now' },
        { id: 'bad' },
      ],
    });
    const list = await readCustomStamps(storage);
    expect(list.length).toBe(1);
    await writeCustomStamps(storage, []);
    expect(await readCustomStamps(storage)).toEqual([]);
    expect(await readCustomStamps(memorySettingsStorage({ 'stamps.custom': 'nope' }))).toEqual([]);
  });
});
