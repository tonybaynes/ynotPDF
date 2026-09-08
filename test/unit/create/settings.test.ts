/**
 * M91's settings and its memory of the last options used.
 *
 * The rule the tests exist for: a setting that is missing, of the wrong type, or no longer a
 * page size we ship falls back to the default rather than reaching a dialog as nonsense.
 */

import { describe, expect, it } from 'vitest';
import { memorySettingsStorage } from '@modules/M21-save/settings';
import {
  CREATE_SETTINGS_SCHEMA,
  DEFAULT_CREATE_SETTINGS,
  createSettingKey,
  readCreateSettings,
  readLastOptions,
  writeCreateSetting,
  writeLastOptions,
} from '@modules/M91-create-pdf/settings';

describe('the schema', () => {
  it('describes every setting, with the defaults it actually uses', () => {
    expect(CREATE_SETTINGS_SCHEMA.namespace).toBe('create');
    const properties = CREATE_SETTINGS_SCHEMA.properties;
    for (const name of Object.keys(DEFAULT_CREATE_SETTINGS)) {
      expect(properties[name]).toBeDefined();
      expect(properties[name]?.default).toBe(
        DEFAULT_CREATE_SETTINGS[name as keyof typeof DEFAULT_CREATE_SETTINGS],
      );
      expect(properties[name]?.title.length).toBeGreaterThan(8);
    }
  });

  it('offers the page sizes we ship, and only those', () => {
    const pageSize = CREATE_SETTINGS_SCHEMA.properties['pageSize'];
    expect(pageSize?.type).toBe('enum');
    const options = pageSize?.type === 'enum' ? pageSize.options : [];
    expect(options.map((o) => o.value)).toContain('A4');
    expect(options.map((o) => o.value)).toContain('Letter');
    expect(options.every((o) => o.label !== '')).toBe(true);
  });

  it('names each key under its namespace', () => {
    expect(createSettingKey('defaultDpi')).toBe('create.defaultDpi');
    expect(createSettingKey('openAfterCreate')).toBe('create.openAfterCreate');
  });
});

describe('reading settings', () => {
  it('gives the defaults when nothing is stored', async () => {
    await expect(readCreateSettings(memorySettingsStorage())).resolves.toEqual(
      DEFAULT_CREATE_SETTINGS,
    );
  });

  it('takes what is stored when it is the right type', async () => {
    const storage = memorySettingsStorage({
      'create.pageSize': 'Letter',
      'create.marginsMm': 25,
      'create.defaultDpi': 300,
      'create.webBackgroundGraphics': false,
      'create.textFont': 'serif',
      'create.openAfterCreate': false,
    });
    await expect(readCreateSettings(storage)).resolves.toMatchObject({
      pageSize: 'Letter',
      marginsMm: 25,
      defaultDpi: 300,
      webBackgroundGraphics: false,
      textFont: 'serif',
      openAfterCreate: false,
    });
  });

  it('falls back to the default for a wrong type, a null and a value we no longer offer', async () => {
    const storage = memorySettingsStorage({
      'create.marginsMm': 'wide',
      'create.defaultDpi': null,
      'create.textFont': 'comic',
      'create.pageSize': 'A0-Plus',
      'create.webTimeoutSeconds': undefined,
    });
    await expect(readCreateSettings(storage)).resolves.toEqual(DEFAULT_CREATE_SETTINGS);
  });

  it('writes a setting under its key', async () => {
    const storage = memorySettingsStorage();
    await writeCreateSetting(storage, 'textFontSize', 14);
    await expect(storage.get('create.textFontSize')).resolves.toBe(14);
    await expect(readCreateSettings(storage)).resolves.toMatchObject({ textFontSize: 14 });
  });
});

describe('the memory of the last options', () => {
  it('round-trips an object', async () => {
    const storage = memorySettingsStorage();
    await writeLastOptions(storage, 'image', { fit: 'fill', defaultDpi: 150 });
    await expect(readLastOptions(storage, 'image')).resolves.toEqual({
      fit: 'fill',
      defaultDpi: 150,
    });
  });

  it('is nothing at all when there is nothing, or when what is there is not an object', async () => {
    const storage = memorySettingsStorage({
      'create.last.text': 'not json',
      'create.last.web': '[1,2,3]',
      'create.last.blank': 'null',
      'create.last.html': 42,
    });
    await expect(readLastOptions(storage, 'image')).resolves.toBeNull();
    await expect(readLastOptions(storage, 'text')).resolves.toBeNull();
    await expect(readLastOptions(storage, 'web')).resolves.toBeNull();
    await expect(readLastOptions(storage, 'blank')).resolves.toBeNull();
    await expect(readLastOptions(storage, 'html')).resolves.toBeNull();
  });
});
