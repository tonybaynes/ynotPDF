/**
 * M91 settings: the defaults every Create dialog starts from, and the memory of what the reader
 * chose last time. Same shape as M21's: a typed record, a schema for M130's preferences page,
 * and a storage interface a test can replace with a map.
 */

import type { SettingsSchema } from '@shared/module';
import { PAGE_SIZE_PRESETS } from '@shared/pageSizes';
import type { TextFontChoice } from '@engine/create/text/TextConverter';

export {
  ipcSettingsStorage,
  memorySettingsStorage,
  type SettingsStorage,
} from '@modules/M21-save/settings';
import type { SettingsStorage } from '@modules/M21-save/settings';

export interface CreateSettings {
  /** Preset id from `resources/page-sizes.json`. */
  readonly pageSize: string;
  /** All four margins, millimetres. */
  readonly marginsMm: number;
  /** Assumed for images that say nothing about their resolution. */
  readonly defaultDpi: number;
  readonly webTimeoutSeconds: number;
  readonly webBackgroundGraphics: boolean;
  readonly textFont: TextFontChoice;
  readonly textFontSize: number;
  /** Open the created document in a new tab (off = only Save As it). */
  readonly openAfterCreate: boolean;
}

export const DEFAULT_CREATE_SETTINGS: CreateSettings = {
  pageSize: 'A4',
  marginsMm: 15,
  defaultDpi: 96,
  webTimeoutSeconds: 30,
  webBackgroundGraphics: true,
  textFont: 'mono',
  textFontSize: 10,
  openAfterCreate: true,
};

const KEYS: Readonly<Record<keyof CreateSettings, string>> = {
  pageSize: 'create.pageSize',
  marginsMm: 'create.marginsMm',
  defaultDpi: 'create.defaultDpi',
  webTimeoutSeconds: 'create.webTimeoutSeconds',
  webBackgroundGraphics: 'create.webBackgroundGraphics',
  textFont: 'create.textFont',
  textFontSize: 'create.textFontSize',
  openAfterCreate: 'create.openAfterCreate',
};

/** Prefix of the per-kind memory of the last options used (`create.last.images`, …). */
export const LAST_OPTIONS_PREFIX = 'create.last.';

export const CREATE_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'create',
  properties: {
    pageSize: {
      type: 'enum',
      title: 'Default page size for created documents',
      default: DEFAULT_CREATE_SETTINGS.pageSize,
      options: PAGE_SIZE_PRESETS.map((p) => ({ value: p.id, label: p.label })),
    },
    marginsMm: {
      type: 'number',
      title: 'Default margins (mm)',
      default: DEFAULT_CREATE_SETTINGS.marginsMm,
      min: 0,
      max: 50,
      step: 1,
    },
    defaultDpi: {
      type: 'number',
      title: 'Resolution assumed for images with none (dpi)',
      default: DEFAULT_CREATE_SETTINGS.defaultDpi,
      min: 36,
      max: 1200,
      step: 1,
    },
    webTimeoutSeconds: {
      type: 'number',
      title: 'Give up loading a web page after (seconds)',
      default: DEFAULT_CREATE_SETTINGS.webTimeoutSeconds,
      min: 5,
      max: 300,
      step: 5,
    },
    webBackgroundGraphics: {
      type: 'boolean',
      title: 'Print background colours and images of web pages',
      default: DEFAULT_CREATE_SETTINGS.webBackgroundGraphics,
    },
    textFont: {
      type: 'enum',
      title: 'Font for plain text',
      default: DEFAULT_CREATE_SETTINGS.textFont,
      options: [
        { value: 'mono', label: 'Monospace (Courier)' },
        { value: 'sans', label: 'Proportional (Helvetica)' },
        { value: 'serif', label: 'Serif (Times)' },
      ],
    },
    textFontSize: {
      type: 'number',
      title: 'Font size for plain text (pt)',
      default: DEFAULT_CREATE_SETTINGS.textFontSize,
      min: 6,
      max: 24,
      step: 1,
    },
    openAfterCreate: {
      type: 'boolean',
      title: 'Open a created document in a new tab',
      default: DEFAULT_CREATE_SETTINGS.openAfterCreate,
    },
  },
};

const FONTS: ReadonlyArray<TextFontChoice> = ['mono', 'sans', 'serif'];

/** Reads every setting, falling back to the default for anything unset or malformed. */
export async function readCreateSettings(storage: SettingsStorage): Promise<CreateSettings> {
  const entries = await Promise.all(
    (Object.keys(KEYS) as Array<keyof CreateSettings>).map(
      async (name) => [name, await storage.get(KEYS[name])] as const,
    ),
  );
  const out: Record<string, unknown> = { ...DEFAULT_CREATE_SETTINGS };
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    if (typeof value !== typeof DEFAULT_CREATE_SETTINGS[name]) continue;
    if (name === 'textFont' && !FONTS.includes(value as TextFontChoice)) continue;
    if (name === 'pageSize' && !PAGE_SIZE_PRESETS.some((p) => p.id === value)) continue;
    out[name] = value;
  }
  return out as unknown as CreateSettings;
}

export async function writeCreateSetting<K extends keyof CreateSettings>(
  storage: SettingsStorage,
  name: K,
  value: CreateSettings[K],
): Promise<void> {
  await storage.set(KEYS[name], value);
}

export function createSettingKey(name: keyof CreateSettings): string {
  return KEYS[name];
}

/** The last options the reader used for one kind of creation, if any were remembered. */
export async function readLastOptions(
  storage: SettingsStorage,
  kind: string,
): Promise<Record<string, unknown> | null> {
  const raw = await storage.get(`${LAST_OPTIONS_PREFIX}${kind}`);
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function writeLastOptions(
  storage: SettingsStorage,
  kind: string,
  options: unknown,
): Promise<void> {
  await storage.set(`${LAST_OPTIONS_PREFIX}${kind}`, JSON.stringify(options));
}
