/**
 * M53's settings. The schema is declared on the manifest so M130's preferences dialog renders it;
 * this file is the typed reader/writer the service and the dialogs use.
 *
 * Same shape as M100's: a key map, a default for everything, and a reader that falls back rather
 * than throwing. The reader's own presets live here too, as JSON in one string setting per
 * family — data the reader made rather than data we ship, and not something the preferences UI
 * could edit sensibly, so those four are hidden from the schema and managed from the dialogs.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';

export interface DecorationSettings {
  /** Units the margin and offset fields are typed in. */
  readonly units: 'pt' | 'mm' | 'cm' | 'in';
  /** Ask before following a link that leaves the document. */
  readonly confirmExternalLinks: boolean;
  /** Draw a dashed outline around every link while the link tool is active. */
  readonly showLinkOutlines: boolean;
  /** Also match bare `www.` and e-mail addresses when detecting links, not only full URLs. */
  readonly detectBareLinks: boolean;
  /** The reader's own presets, as JSON. See the note above. */
  readonly presets: string;
}

export const DEFAULT_DECORATION_SETTINGS: DecorationSettings = {
  units: 'mm',
  confirmExternalLinks: true,
  showLinkOutlines: true,
  detectBareLinks: true,
  presets: '[]',
};

/** Keys as they appear in `settings.json`. */
const KEYS: Readonly<Record<keyof DecorationSettings, string>> = {
  units: 'decorations.units',
  confirmExternalLinks: 'decorations.confirmExternalLinks',
  showLinkOutlines: 'decorations.showLinkOutlines',
  detectBareLinks: 'decorations.detectBareLinks',
  presets: 'decorations.presets',
};

/** The settings key for one setting — the commands and the tests name the same string. */
export function settingKey(name: keyof DecorationSettings): string {
  return KEYS[name];
}

export const DECORATION_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'decorations',
  title: 'Page marks and links',
  icon: 'stamp',
  order: 53,
  properties: {
    units: {
      type: 'enum',
      title: 'Units for margins and offsets',
      description: 'What the number fields in the header, watermark and background dialogs mean.',
      default: DEFAULT_DECORATION_SETTINGS.units,
      options: [
        { value: 'mm', label: 'Millimetres' },
        { value: 'cm', label: 'Centimetres' },
        { value: 'in', label: 'Inches' },
        { value: 'pt', label: 'Points' },
      ],
      live: true,
      keywords: ['margin', 'inches', 'millimetres', 'points'],
    },
    confirmExternalLinks: {
      type: 'boolean',
      title: 'Ask before opening a link that leaves the document',
      description:
        'A link inside a PDF is the document asking to open something. With this on you see the whole address first and decide.',
      default: DEFAULT_DECORATION_SETTINGS.confirmExternalLinks,
      live: true,
      keywords: ['url', 'web', 'security', 'safety'],
    },
    showLinkOutlines: {
      type: 'boolean',
      title: 'Outline links while the link tool is chosen',
      description: 'A dashed border round every link area, so you can see what is there to edit.',
      default: DEFAULT_DECORATION_SETTINGS.showLinkOutlines,
      live: true,
      keywords: ['link', 'outline', 'border'],
    },
    detectBareLinks: {
      type: 'boolean',
      title: 'Detect addresses written without http://',
      description:
        'Find "www.example.com" and e-mail addresses as well as full web addresses when creating links from the text.',
      default: DEFAULT_DECORATION_SETTINGS.detectBareLinks,
      live: true,
      keywords: ['auto', 'detect', 'email', 'www'],
    },
  },
};

export interface SettingsStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** The real store, over M02's settings IPC. */
export function ipcSettingsStorage(): SettingsStorage {
  return {
    get: async (key) => (hasBridge() ? await invoke('settings:get', key) : undefined),
    set: async (key, value) => {
      if (hasBridge()) await invoke('settings:set', key, value);
    },
  };
}

/** Reads every setting, falling back rather than throwing. */
export async function readSettings(storage: SettingsStorage): Promise<DecorationSettings> {
  const read = async <K extends keyof DecorationSettings>(
    name: K,
    check: (value: unknown) => value is DecorationSettings[K],
  ): Promise<DecorationSettings[K]> => {
    try {
      const value = await storage.get(KEYS[name]);
      return check(value) ? value : DEFAULT_DECORATION_SETTINGS[name];
    } catch {
      return DEFAULT_DECORATION_SETTINGS[name];
    }
  };
  const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
  const isString = (v: unknown): v is string => typeof v === 'string';
  const isUnit = (v: unknown): v is DecorationSettings['units'] =>
    v === 'pt' || v === 'mm' || v === 'cm' || v === 'in';
  return {
    units: await read('units', isUnit),
    confirmExternalLinks: await read('confirmExternalLinks', isBool),
    showLinkOutlines: await read('showLinkOutlines', isBool),
    detectBareLinks: await read('detectBareLinks', isBool),
    presets: await read('presets', isString),
  };
}

export async function writeSetting<K extends keyof DecorationSettings>(
  storage: SettingsStorage,
  name: K,
  value: DecorationSettings[K],
): Promise<void> {
  await storage.set(KEYS[name], value);
}
