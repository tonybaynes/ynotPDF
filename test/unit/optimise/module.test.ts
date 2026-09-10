/**
 * M100's renderer half, as far as it can be tested without a window (M100).
 *
 * The settings reader, the preset store, the words and numbers the dialog puts on screen, and the
 * geometry the donut is drawn from. The dialog itself and the service's dialogs need a DOM and are
 * exercised by the e2e suite; everything here is a pure function and is checked as one.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPTIMISE_SETTINGS,
  memorySettingsStorage,
  parseCustomPresets,
  readOptimiseSettings,
  serialiseCustomPresets,
  settingKey,
  writeOptimiseSetting,
  OPTIMISE_SETTINGS_SCHEMA,
} from '@modules/M100-optimise-repair/settings';
import {
  arcPath,
  formatBytes,
  percent,
  ringPath,
  savingLine,
  visibleSlices,
} from '@modules/M100-optimise-repair/auditView';
import { matchPreset } from '@modules/M100-optimise-repair/optimiseDialog';
import { optimisedName, repairedName } from '@modules/M100-optimise-repair/manifest';
import { BUILT_IN_PRESETS, NO_CHANGE, presetById, type SpaceAudit } from '@engine/optimise';

describe('settings', () => {
  it('falls back to the defaults when nothing is stored', async () => {
    expect(await readOptimiseSettings(memorySettingsStorage())).toEqual(DEFAULT_OPTIMISE_SETTINGS);
  });

  it('reads what was written', async () => {
    const storage = memorySettingsStorage();
    await writeOptimiseSetting(storage, 'linearizeOnSave', true);
    await writeOptimiseSetting(storage, 'preset', 'small');
    const read = await readOptimiseSettings(storage);
    expect(read.linearizeOnSave).toBe(true);
    expect(read.preset).toBe('small');
  });

  it('ignores a value of the wrong type rather than falling over', async () => {
    const storage = memorySettingsStorage({
      [settingKey('linearizeOnSave')]: 'yes please',
      [settingKey('preset')]: 42,
      [settingKey('checkOnOpen')]: null,
    });
    const read = await readOptimiseSettings(storage);
    expect(read).toEqual(DEFAULT_OPTIMISE_SETTINGS);
  });

  it('declares every setting it reads, so Preferences can show them', () => {
    const declared = Object.keys(OPTIMISE_SETTINGS_SCHEMA.properties);
    // `customPresets` is deliberately not declared: it is a list of objects the reader edits from
    // the Optimise dialog, and Preferences has no control that could edit it sensibly.
    for (const name of ['preset', 'linearizeOnSave', 'checkOnOpen', 'confirmReplace'] as const) {
      expect(declared).toContain(settingKey(name));
    }
    expect(declared).not.toContain(settingKey('customPresets'));
  });

  it('says fast web view and password protection cannot both happen', () => {
    const setting = OPTIMISE_SETTINGS_SCHEMA.properties['optimise.linearizeOnSave'];
    expect(setting?.description).toMatch(/cannot be combined with password/i);
  });
});

describe('the reader’s own presets', () => {
  it('round-trips through the settings string', () => {
    const mine = {
      id: 'mine',
      name: 'Mine',
      description: 'What I use.',
      lossless: false,
      builtIn: false,
      options: presetById('small')?.options ?? NO_CHANGE,
    };
    const parsed = parseCustomPresets(serialiseCustomPresets([mine]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe('mine');
    expect(parsed[0]?.builtIn).toBe(false);
    expect(parsed[0]?.options).toEqual(mine.options);
  });

  it('survives a settings file somebody edited by hand', () => {
    expect(parseCustomPresets('not json')).toEqual([]);
    expect(parseCustomPresets('{}')).toEqual([]);
    expect(parseCustomPresets('[1, 2, 3]')).toEqual([]);
    expect(parseCustomPresets('[{"name":"no id"}]')).toEqual([]);
  });

  it('refuses to let a custom preset shadow a built-in one', () => {
    const shadow = JSON.stringify([{ id: 'standard', name: 'Not really', options: {} }]);
    expect(parseCustomPresets(shadow)).toEqual([]);
  });

  it('works out losslessness for itself rather than trusting the stored flag', () => {
    const lying = JSON.stringify([
      { id: 'mine', name: 'Mine', lossless: true, options: presetById('smallest')?.options },
    ]);
    expect(parseCustomPresets(lying)[0]?.lossless).toBe(false);
  });
});

describe('naming the copies', () => {
  it('names an optimised copy after the original', () => {
    expect(optimisedName('C:/Users/tony/Report.pdf')).toBe('Report (optimised).pdf');
    expect(optimisedName('/home/tony/Report.PDF')).toBe('Report (optimised).pdf');
    expect(optimisedName('Report')).toBe('Report (optimised).pdf');
  });

  it('names a repaired copy the same way', () => {
    expect(repairedName('C:\\docs\\Broken.pdf')).toBe('Broken (repaired).pdf');
  });
});

describe('the words and the numbers', () => {
  it('says bytes the way a file manager does', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(999)).toBe('999 bytes');
    expect(formatBytes(1000)).toMatch(/^1\.0 kB$/);
    expect(formatBytes(1_500_000)).toMatch(/^1\.5 MB$/);
    expect(formatBytes(45_000)).toBe('45 kB');
    expect(formatBytes(-1)).toBe('—');
  });

  it('says the saving as a sentence', () => {
    expect(savingLine(1_000_000, 400_000)).toMatch(/60% smaller/);
    expect(savingLine(1000, 1000)).toMatch(/no smaller/);
    expect(savingLine(1000, 1200)).toMatch(/no smaller/);
  });

  it('never lets a real category read as nothing', () => {
    expect(percent(0)).toBe('0%');
    expect(percent(0.0001)).toBe('<1%');
    expect(percent(0.5)).toBe('50%');
    expect(percent(1)).toBe('100%');
  });
});

describe('the chart’s arithmetic', () => {
  const audit = (entries: ReadonlyArray<[string, number]>, total: number): SpaceAudit => ({
    total,
    slices: entries.map(([category, bytes]) => ({
      category: category as SpaceAudit['slices'][number]['category'],
      bytes,
      share: bytes / total,
      objects: 1,
    })),
  });

  it('gathers the slivers into one row', () => {
    const shown = visibleSlices(
      audit(
        [
          ['images', 900],
          ['fonts', 60],
          ['content', 20],
          ['comments', 20],
        ],
        1000,
      ),
      0.05,
    );
    expect(shown.map((s) => s.label)).toEqual(['Images', 'Fonts', 'Everything else']);
    expect(shown[2]?.bytes).toBe(40);
  });

  it('leaves out a category that is not there at all', () => {
    const shown = visibleSlices(
      audit(
        [
          ['images', 1000],
          ['fonts', 0],
        ],
        1000,
      ),
      0.01,
    );
    expect(shown.map((s) => s.label)).toEqual(['Images']);
  });

  it('sorts the biggest first', () => {
    const shown = visibleSlices(
      audit(
        [
          ['images', 100],
          ['fonts', 900],
        ],
        1000,
      ),
      0.01,
    );
    expect(shown.map((s) => s.label)).toEqual(['Fonts', 'Images']);
  });

  it('draws an arc that starts and ends where it should', () => {
    // A quarter turn from the top: starts at (90, 6) and ends at (174, 90) on a 180 box.
    const path = arcPath(90, 84, 46, -Math.PI / 2, 0);
    expect(path).toMatch(/^M 90\.00 6\.00 A 84 84 0 0 1 174\.00 90\.00/);
    expect(path.endsWith('Z')).toBe(true);
  });

  it('draws the whole ring as two circles rather than a collapsed arc', () => {
    const path = ringPath(90, 84, 46);
    expect(path.split('M')).toHaveLength(3);
    expect(path).toContain('A 84 84 0 1 1');
    expect(path).toContain('A 46 46 0 1 0');
  });
});

describe('recognising a preset', () => {
  it('finds the preset a set of options exactly is', () => {
    for (const preset of BUILT_IN_PRESETS) {
      expect(matchPreset(BUILT_IN_PRESETS, preset.options)).toBe(preset.id);
    }
  });

  it('answers null once the reader has changed something', () => {
    const standard = presetById('standard');
    if (!standard) throw new Error('no standard preset');
    const changed = {
      ...standard.options,
      images: {
        ...standard.options.images,
        colour: { ...standard.options.images.colour, quality: 41 },
      },
    };
    expect(matchPreset(BUILT_IN_PRESETS, changed)).toBeNull();
  });
});
