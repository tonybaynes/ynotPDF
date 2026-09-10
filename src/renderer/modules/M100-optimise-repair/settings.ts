/**
 * M100's settings. The schema is declared on the manifest so M130's preferences dialog renders
 * it; this file is the typed reader/writer the service uses.
 *
 * Same shape as M41's: a key map, a default for everything, and a reader that falls back rather
 * than throwing — a hand-edited settings file must never stop the app opening a document.
 *
 * The reader's own presets live here too, as JSON in one string setting. They are data the reader
 * made rather than data we ship, so `resources/optimise-presets.json` is not the place for them,
 * and a list of objects is not something M130's preferences UI can edit sensibly — which is why
 * the setting is marked hidden from the schema and managed from the Optimise dialog instead.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';
import { DEFAULT_PRESET_ID, readPreset, type OptimisePreset } from '@engine/optimise';

export interface OptimiseSettings {
  /** The preset the dialog opens on. */
  readonly preset: string;
  /**
   * Linearise every save for fast web view. Off by default: it costs a qpdf pass on every save,
   * and it cannot be combined with password protection (ADR 0019 §3).
   */
  readonly linearizeOnSave: boolean;
  /** Check a document with qpdf when it opens, and offer to repair it when something is wrong. */
  readonly checkOnOpen: boolean;
  /** Ask before optimising over the file the document was opened from. */
  readonly confirmReplace: boolean;
  /** Presets the reader saved, as JSON. See the note above. */
  readonly customPresets: string;
}

export const DEFAULT_OPTIMISE_SETTINGS: OptimiseSettings = {
  preset: DEFAULT_PRESET_ID,
  linearizeOnSave: false,
  checkOnOpen: true,
  confirmReplace: true,
  customPresets: '[]',
};

/** Keys as they appear in `settings.json`. */
const KEYS: Readonly<Record<keyof OptimiseSettings, string>> = {
  preset: 'optimise.preset',
  linearizeOnSave: 'optimise.linearizeOnSave',
  checkOnOpen: 'optimise.checkOnOpen',
  confirmReplace: 'optimise.confirmReplace',
  customPresets: 'optimise.customPresets',
};

/** The settings key for one setting — the commands and the tests name the same string. */
export function settingKey(name: keyof OptimiseSettings): string {
  return KEYS[name];
}

export const OPTIMISE_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'optimise',
  title: 'Optimise and repair',
  icon: 'file-archive',
  properties: {
    'optimise.preset': {
      type: 'enum',
      title: 'Preset the Optimise dialog opens on',
      description: 'You can still change it in the dialog; this is only where it starts.',
      default: DEFAULT_OPTIMISE_SETTINGS.preset,
      options: [
        { value: 'lossless', label: 'Lossless — no pixel changes' },
        { value: 'standard', label: 'Standard — reading and printing' },
        { value: 'small', label: 'Small — for email' },
        { value: 'smallest', label: 'Smallest — screen only' },
      ],
      live: true,
    },
    'optimise.linearizeOnSave': {
      type: 'boolean',
      title: 'Optimise saved files for fast web view',
      description:
        'Puts the first page at the front of the file so it appears before the rest has ' +
        'downloaded. Adds a second or two to every save, and cannot be combined with password ' +
        'protection — a saved file gets one or the other, and you are told which.',
      default: DEFAULT_OPTIMISE_SETTINGS.linearizeOnSave,
      live: true,
    },
    'optimise.checkOnOpen': {
      type: 'boolean',
      title: 'Check a document for damage when it opens',
      description:
        'A damaged file usually still opens, and you are offered a repaired copy when it does. ' +
        'Turning this off means nothing is checked and nothing is offered.',
      default: DEFAULT_OPTIMISE_SETTINGS.checkOnOpen,
      live: true,
    },
    'optimise.confirmReplace': {
      type: 'boolean',
      title: 'Ask before optimising over the open file',
      description:
        'Saving an optimised copy over the file the document came from reloads it, which clears ' +
        'the undo history.',
      default: DEFAULT_OPTIMISE_SETTINGS.confirmReplace,
      advanced: true,
      live: true,
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

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const str = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value !== '' ? value : fallback;

/** Reads every setting, falling back to the default for anything unset or malformed. */
export async function readOptimiseSettings(storage: SettingsStorage): Promise<OptimiseSettings> {
  const names = Object.keys(KEYS) as Array<keyof OptimiseSettings>;
  const values = await Promise.all(names.map((name) => storage.get(KEYS[name])));
  const at = (name: keyof OptimiseSettings): unknown => values[names.indexOf(name)];
  return {
    preset: str(at('preset'), DEFAULT_OPTIMISE_SETTINGS.preset),
    linearizeOnSave: bool(at('linearizeOnSave'), DEFAULT_OPTIMISE_SETTINGS.linearizeOnSave),
    checkOnOpen: bool(at('checkOnOpen'), DEFAULT_OPTIMISE_SETTINGS.checkOnOpen),
    confirmReplace: bool(at('confirmReplace'), DEFAULT_OPTIMISE_SETTINGS.confirmReplace),
    customPresets: str(at('customPresets'), DEFAULT_OPTIMISE_SETTINGS.customPresets),
  };
}

export async function writeOptimiseSetting<K extends keyof OptimiseSettings>(
  storage: SettingsStorage,
  name: K,
  value: OptimiseSettings[K],
): Promise<void> {
  await storage.set(KEYS[name], value);
}

/**
 * The reader's own presets, parsed out of the settings string.
 *
 * Never throws: a settings file somebody edited by hand, or one written by a future version, must
 * cost the reader their custom presets at worst — not the dialog.
 */
export function parseCustomPresets(json: string): OptimisePreset[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: OptimisePreset[] = [];
  for (const entry of raw) {
    const preset = readPreset(entry, false);
    // A custom preset may not shadow a built-in one: the dialog looks them up by id.
    if (preset && !['lossless', 'standard', 'small', 'smallest'].includes(preset.id)) {
      out.push(preset);
    }
  }
  return out;
}

/** The other direction: the reader's presets as the settings string holds them. */
export function serialiseCustomPresets(presets: ReadonlyArray<OptimisePreset>): string {
  return JSON.stringify(
    presets.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      options: p.options,
    })),
  );
}
