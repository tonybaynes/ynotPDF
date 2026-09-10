/**
 * M60 settings: how fields are highlighted, how a new one is named and snapped, and what the
 * designer's defaults are. Persisted through the settings IPC like every other module's, with an
 * in-memory storage for tests.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';

export interface FormSettings {
  /** Draw a tinted box behind every field so an unfilled form is obvious. */
  readonly highlightFields: boolean;
  /** Outline a required field, so "you must fill this in" is visible without colour alone. */
  readonly outlineRequired: boolean;
  /** Move to the next field as soon as a comb or a maximum-length field is full. */
  readonly autoTab: boolean;
  /** Keep the field tool selected after a field is drawn, so a row of them is one pass. */
  readonly keepToolSelected: boolean;
  /** Snap a drawn or dragged field to the grid. */
  readonly snapToGrid: boolean;
  /** The grid step, in points. */
  readonly gridStep: number;
  /** Arrow-key nudge, in points. Shift multiplies by ten. */
  readonly nudge: number;
  /** The name a new field is offered, before the number: "Text 1", "Text 2". */
  readonly namePrefix: string;
}

export const DEFAULT_FORM_SETTINGS: FormSettings = {
  highlightFields: true,
  outlineRequired: true,
  autoTab: true,
  keepToolSelected: false,
  snapToGrid: false,
  gridStep: 6,
  nudge: 1,
  namePrefix: '',
};

/** Setting keys as stored, one per field. */
export const SETTING_KEYS: Readonly<Record<keyof FormSettings, string>> = {
  highlightFields: 'forms.highlight',
  outlineRequired: 'forms.outlineRequired',
  autoTab: 'forms.autoTab',
  keepToolSelected: 'forms.keepTool',
  snapToGrid: 'forms.snapToGrid',
  gridStep: 'forms.gridStep',
  nudge: 'forms.nudge',
  namePrefix: 'forms.namePrefix',
};

export const FORM_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'forms',
  title: 'Forms',
  icon: 'text-cursor-input',
  properties: {
    highlight: {
      type: 'boolean',
      title: 'Highlight form fields',
      description: 'Draws a tinted box behind every field, so an empty form shows where to type.',
      section: 'Filling in',
      default: DEFAULT_FORM_SETTINGS.highlightFields,
      live: true,
    },
    outlineRequired: {
      type: 'boolean',
      title: 'Outline required fields',
      description:
        'A required field gets a heavier outline as well as its highlight, so it is not told apart by colour alone.',
      section: 'Filling in',
      default: DEFAULT_FORM_SETTINGS.outlineRequired,
      live: true,
    },
    autoTab: {
      type: 'boolean',
      title: 'Move on when a field is full',
      description:
        'A field with a maximum length, or a comb, hands the keyboard to the next field as soon as the last character is typed.',
      section: 'Filling in',
      default: DEFAULT_FORM_SETTINGS.autoTab,
      live: true,
    },
    keepTool: {
      type: 'boolean',
      title: 'Keep the field tool selected',
      description: 'Stay on the tool after drawing a field, so a row of them is one pass.',
      section: 'Designing',
      default: DEFAULT_FORM_SETTINGS.keepToolSelected,
      live: true,
    },
    snapToGrid: {
      type: 'boolean',
      title: 'Snap fields to the grid',
      section: 'Designing',
      default: DEFAULT_FORM_SETTINGS.snapToGrid,
      live: true,
    },
    gridStep: {
      type: 'number',
      title: 'Grid step',
      unit: 'pt',
      section: 'Designing',
      default: DEFAULT_FORM_SETTINGS.gridStep,
      min: 1,
      max: 72,
      step: 1,
      live: true,
    },
    nudge: {
      type: 'number',
      title: 'Arrow-key nudge',
      unit: 'pt',
      section: 'Designing',
      default: DEFAULT_FORM_SETTINGS.nudge,
      min: 0.1,
      max: 50,
      step: 0.5,
      live: true,
    },
    namePrefix: {
      type: 'string',
      title: 'Name new fields with',
      description:
        'Put in front of the type name when a field is created: "order." makes "order.Text 1".',
      section: 'Designing',
      default: DEFAULT_FORM_SETTINGS.namePrefix,
      live: true,
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

export async function readSettings(storage: SettingsStorage): Promise<FormSettings> {
  const d = DEFAULT_FORM_SETTINGS;
  const prefix = await storage.get(SETTING_KEYS.namePrefix);
  return {
    highlightFields: asBoolean(await storage.get(SETTING_KEYS.highlightFields), d.highlightFields),
    outlineRequired: asBoolean(await storage.get(SETTING_KEYS.outlineRequired), d.outlineRequired),
    autoTab: asBoolean(await storage.get(SETTING_KEYS.autoTab), d.autoTab),
    keepToolSelected: asBoolean(
      await storage.get(SETTING_KEYS.keepToolSelected),
      d.keepToolSelected,
    ),
    snapToGrid: asBoolean(await storage.get(SETTING_KEYS.snapToGrid), d.snapToGrid),
    gridStep: asNumber(await storage.get(SETTING_KEYS.gridStep), d.gridStep, 1, 72),
    nudge: asNumber(await storage.get(SETTING_KEYS.nudge), d.nudge, 0.1, 50),
    namePrefix: typeof prefix === 'string' ? prefix : d.namePrefix,
  };
}

export async function writeSetting<K extends keyof FormSettings>(
  storage: SettingsStorage,
  key: K,
  value: FormSettings[K],
): Promise<void> {
  await storage.set(SETTING_KEYS[key], value);
}
