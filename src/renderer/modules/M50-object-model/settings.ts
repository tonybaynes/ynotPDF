/**
 * M50 settings: how snapping and alignment behave, and the nudge step. Persisted through the
 * settings IPC like every other module's, with an in-memory storage for tests.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';

/** Which kinds the Edit Object tool picks up (Foxit: All / Text / Image / Shape / Shading). */
export type ObjectFilter = 'all' | 'text' | 'image' | 'path' | 'shading';

export const OBJECT_FILTERS: ReadonlyArray<{ id: ObjectFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'text', label: 'Text' },
  { id: 'image', label: 'Image' },
  { id: 'path', label: 'Shape' },
  { id: 'shading', label: 'Shading' },
];

export interface ObjectSettings {
  /** Snap a move to other objects' edges and centres (smart guides). */
  readonly snapToObjects: boolean;
  /** Snap a move to ruler guides. */
  readonly snapToGuides: boolean;
  /** How close, in points, before a snap takes hold. */
  readonly snapTolerance: number;
  /** What Align uses as its reference. */
  readonly alignTo: 'selection' | 'page';
  /** Arrow-key nudge, in points. Shift multiplies by ten. */
  readonly nudge: number;
}

export const DEFAULT_OBJECT_SETTINGS: ObjectSettings = {
  snapToObjects: true,
  snapToGuides: true,
  snapTolerance: 4,
  alignTo: 'selection',
  nudge: 1,
};

/** Setting keys as stored, one per field. */
export const SETTING_KEYS: Readonly<Record<keyof ObjectSettings, string>> = {
  snapToObjects: 'objects.snap.objects',
  snapToGuides: 'objects.snap.guides',
  snapTolerance: 'objects.snap.tolerance',
  alignTo: 'objects.align.to',
  nudge: 'objects.nudge',
};

export const OBJECT_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'objects',
  properties: {
    'snap.objects': {
      type: 'boolean',
      title: 'Snap to other objects',
      default: DEFAULT_OBJECT_SETTINGS.snapToObjects,
    },
    'snap.guides': {
      type: 'boolean',
      title: 'Snap to guides',
      default: DEFAULT_OBJECT_SETTINGS.snapToGuides,
    },
    'snap.tolerance': {
      type: 'number',
      title: 'Snap distance (pt)',
      default: DEFAULT_OBJECT_SETTINGS.snapTolerance,
      min: 1,
      max: 20,
      step: 1,
    },
    'align.to': {
      type: 'enum',
      title: 'Align objects to',
      default: DEFAULT_OBJECT_SETTINGS.alignTo,
      options: [
        { value: 'selection', label: 'The selection' },
        { value: 'page', label: 'The page' },
      ],
    },
    nudge: {
      type: 'number',
      title: 'Arrow-key nudge (pt)',
      default: DEFAULT_OBJECT_SETTINGS.nudge,
      min: 0.1,
      max: 50,
      step: 0.5,
    },
  },
};

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
): SettingsStorage & { readonly values: Map<string, unknown> } {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    values,
    get: (key) => Promise.resolve(values.get(key)),
    set: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

function asBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function asNumber(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

export async function readSettings(storage: SettingsStorage): Promise<ObjectSettings> {
  const d = DEFAULT_OBJECT_SETTINGS;
  const alignTo = await storage.get(SETTING_KEYS.alignTo);
  return {
    snapToObjects: asBoolean(await storage.get(SETTING_KEYS.snapToObjects), d.snapToObjects),
    snapToGuides: asBoolean(await storage.get(SETTING_KEYS.snapToGuides), d.snapToGuides),
    snapTolerance: asNumber(await storage.get(SETTING_KEYS.snapTolerance), d.snapTolerance, 1, 20),
    alignTo: alignTo === 'page' || alignTo === 'selection' ? alignTo : d.alignTo,
    nudge: asNumber(await storage.get(SETTING_KEYS.nudge), d.nudge, 0.1, 50),
  };
}

export async function writeSetting<K extends keyof ObjectSettings>(
  storage: SettingsStorage,
  key: K,
  value: ObjectSettings[K],
): Promise<void> {
  await storage.set(SETTING_KEYS[key], value);
}
