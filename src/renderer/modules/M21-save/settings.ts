/**
 * Save settings (M21). The schema is declared on the manifest so M130's preferences dialog can
 * render it; this file is the typed reader/writer the save service uses.
 *
 * Everything goes through the settings IPC (ADR 0003) under `save.*`, plus one remembered value:
 * the folder Save As last used, so the dialog opens where the reader was last time.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';

export interface SaveSettings {
  /** Minutes between autosaves. 0 turns autosave off. */
  readonly autosaveMinutes: number;
  /** Rename the previous version to `<name>.bak` before each save. */
  readonly keepBackup: boolean;
  /** Write cross-reference and object streams (smaller files, PDF 1.5 and later). */
  readonly objectStreams: boolean;
  /** Offer to recover unsaved documents on the next launch. */
  readonly recoverOnLaunch: boolean;
  /** Watch open documents for changes made by other programs. */
  readonly watchFiles: boolean;
}

export const DEFAULT_SAVE_SETTINGS: SaveSettings = {
  autosaveMinutes: 5,
  keepBackup: false,
  objectStreams: true,
  recoverOnLaunch: true,
  watchFiles: true,
};

/** Keys as they appear in `settings.json`. */
const KEYS: Readonly<Record<keyof SaveSettings, string>> = {
  autosaveMinutes: 'save.autosaveMinutes',
  keepBackup: 'save.keepBackup',
  objectStreams: 'save.objectStreams',
  recoverOnLaunch: 'save.recoverOnLaunch',
  watchFiles: 'save.watchFiles',
};

/** Where Save As last put a file. Not in {@link SaveSettings}: it is a memory, not a preference. */
export const LAST_FOLDER_KEY = 'save.lastFolder';

export const SAVE_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'save',
  properties: {
    autosaveMinutes: {
      type: 'number',
      title: 'Autosave recovery information every (minutes, 0 to turn off)',
      default: DEFAULT_SAVE_SETTINGS.autosaveMinutes,
      min: 0,
      max: 120,
      step: 1,
    },
    keepBackup: {
      type: 'boolean',
      title: 'Keep the previous version as a .bak file',
      default: DEFAULT_SAVE_SETTINGS.keepBackup,
    },
    objectStreams: {
      type: 'boolean',
      title: 'Write compressed object streams (smaller files)',
      default: DEFAULT_SAVE_SETTINGS.objectStreams,
    },
    recoverOnLaunch: {
      type: 'boolean',
      title: 'Offer to recover unsaved documents when the app starts',
      default: DEFAULT_SAVE_SETTINGS.recoverOnLaunch,
    },
    watchFiles: {
      type: 'boolean',
      title: 'Tell me when an open document changes on disk',
      default: DEFAULT_SAVE_SETTINGS.watchFiles,
    },
  },
};

/** Where a setting is read from and written to. Tests pass a memory implementation. */
export interface SettingsStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export function ipcSettingsStorage(): SettingsStorage {
  return {
    get: async (key) => (hasBridge() ? await invoke('settings:get', key) : undefined),
    set: async (key, value) => {
      if (hasBridge()) await invoke('settings:set', key, value);
    },
  };
}

export function memorySettingsStorage(
  initial: Readonly<Record<string, unknown>> = {},
): SettingsStorage {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    get: (key) => Promise.resolve(map.get(key)),
    set: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
  };
}

/** Reads every save setting, falling back to the default for anything unset or malformed. */
export async function readSaveSettings(storage: SettingsStorage): Promise<SaveSettings> {
  const entries = await Promise.all(
    (Object.keys(KEYS) as Array<keyof SaveSettings>).map(
      async (name) => [name, await storage.get(KEYS[name])] as const,
    ),
  );
  const out: Record<string, unknown> = { ...DEFAULT_SAVE_SETTINGS };
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    if (typeof value === typeof DEFAULT_SAVE_SETTINGS[name]) out[name] = value;
  }
  return out as unknown as SaveSettings;
}

export async function writeSaveSetting<K extends keyof SaveSettings>(
  storage: SettingsStorage,
  name: K,
  value: SaveSettings[K],
): Promise<void> {
  await storage.set(KEYS[name], value);
}

/** The settings key for a setting name — used by the commands that change them. */
export function saveSettingKey(name: keyof SaveSettings): string {
  return KEYS[name];
}
