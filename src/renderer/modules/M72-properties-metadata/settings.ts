/**
 * M72's settings. The schema is declared on the manifest so M130's preferences dialog can render
 * it; this file is the typed reader the service uses. Everything goes through the settings IPC
 * (ADR 0003) under `properties.*`.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';

export interface PropertiesSettings {
  /**
   * Obey the document's own initial view when it is opened — its page mode, layout, opening page
   * and magnification. Off means the reader's own view preferences always win.
   */
  readonly applyInitialView: boolean;
  /**
   * Obey the file's request to hide the toolbar, the menu bar or the rest of the window
   * furniture. Separate from the setting above because it is the intrusive half: a document that
   * hides the ribbon takes the application away from the reader, and some do it thoughtlessly.
   */
  readonly applyWindowOptions: boolean;
  /** Show the document's title in the tab, rather than its file name, when the file asks. */
  readonly applyDisplayDocTitle: boolean;
}

export const DEFAULT_PROPERTIES_SETTINGS: PropertiesSettings = {
  applyInitialView: true,
  applyWindowOptions: false,
  applyDisplayDocTitle: true,
};

const KEYS: Readonly<Record<keyof PropertiesSettings, string>> = {
  applyInitialView: 'properties.applyInitialView',
  applyWindowOptions: 'properties.applyWindowOptions',
  applyDisplayDocTitle: 'properties.applyDisplayDocTitle',
};

export const PROPERTIES_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'properties',
  properties: {
    applyInitialView: {
      type: 'boolean',
      title: 'Open documents the way they ask to be opened (page, magnification, panel)',
      default: DEFAULT_PROPERTIES_SETTINGS.applyInitialView,
    },
    applyWindowOptions: {
      type: 'boolean',
      title: 'Also let a document hide the toolbar and the navigation pane',
      default: DEFAULT_PROPERTIES_SETTINGS.applyWindowOptions,
    },
    applyDisplayDocTitle: {
      type: 'boolean',
      title: "Show a document's title instead of its file name when it asks",
      default: DEFAULT_PROPERTIES_SETTINGS.applyDisplayDocTitle,
    },
  },
};

/** Where a setting is read from. The same shape M21 uses; tests pass a memory implementation. */
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

/** Reads every setting, falling back to the default for anything unset or of the wrong type. */
export async function readPropertiesSettings(
  storage: SettingsStorage,
): Promise<PropertiesSettings> {
  const entries = await Promise.all(
    (Object.keys(KEYS) as Array<keyof PropertiesSettings>).map(
      async (name) => [name, await storage.get(KEYS[name])] as const,
    ),
  );
  const out: Record<string, unknown> = { ...DEFAULT_PROPERTIES_SETTINGS };
  for (const [name, value] of entries) {
    if (typeof value === 'boolean') out[name] = value;
  }
  return out as unknown as PropertiesSettings;
}

export function propertiesSettingKey(name: keyof PropertiesSettings): string {
  return KEYS[name];
}
