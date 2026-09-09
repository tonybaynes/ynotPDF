/**
 * M31's settings: the default look of every drawing tool ("Set as default"), how the pencil and
 * the eraser behave, and the stamps the reader keeps — favourites and custom ones.
 *
 * All of it goes through the settings IPC (ADR 0003) under `draw.*` and `stamps.*`, the same way
 * M30's `annot.*` does, and for the same reasons: one stored object per tool, merged over the
 * factory defaults field by field so an older store is upgraded rather than rejected.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';
import type { LineEnding } from '@engine/appearance';
import { defaultColourFor } from '@modules/M30-markup-annotations/presets';

/** The drawing tools, which are also the settings keys and the command suffixes. */
export const DRAWING_TOOLS = [
  'rectangle',
  'ellipse',
  'line',
  'arrow',
  'polygon',
  'polyline',
  'cloud',
  'areaHighlight',
  'pencil',
  'stamp',
  'attachFile',
] as const;

export type DrawingToolId = (typeof DRAWING_TOOLS)[number];

/** Every property a drawing tool's default can carry. Which ones matter depends on the tool. */
export interface DrawingDefaults {
  /** Stroke colour, `0xRRGGBB`. */
  readonly color: number;
  /** Interior colour, or null for none. */
  readonly fillColor: number | null;
  readonly borderWidth: number;
  /** Dash pattern in points; empty is a solid line. */
  readonly dashArray: ReadonlyArray<number>;
  /** Cloud intensity for the cloud tool (and a cloudy rectangle): 1 or 2. */
  readonly cloudy: number;
  readonly lineEndings: readonly [LineEnding, LineEnding];
  /** The stamp id the stamp tool places, or the last one used. */
  readonly stampId: string;
  /** File-attachment icon (`/Name`). */
  readonly icon: string;
  /** Subject line (`/Subj`) — Foxit fills it with the tool's own name; so do we. */
  readonly subject: string;
}

const SUBJECTS: Readonly<Record<DrawingToolId, string>> = {
  rectangle: 'Rectangle',
  ellipse: 'Oval',
  line: 'Line',
  arrow: 'Arrow',
  polygon: 'Polygon',
  polyline: 'Polyline',
  cloud: 'Cloud',
  areaHighlight: 'Area Highlight',
  pencil: 'Pencil',
  stamp: 'Stamp',
  attachFile: 'File Attachment',
};

/** The factory defaults for one tool. Colours come from `resources/annotations/colours.json`. */
export function factoryDrawingDefaults(tool: DrawingToolId): DrawingDefaults {
  const base: DrawingDefaults = {
    color: defaultColourFor(tool),
    fillColor: null,
    borderWidth: 2,
    dashArray: [],
    cloudy: 1,
    lineEndings: ['None', 'None'],
    stampId: 'Approved',
    icon: 'PushPin',
    subject: SUBJECTS[tool],
  };
  switch (tool) {
    case 'arrow':
      return { ...base, lineEndings: ['None', 'OpenArrow'] };
    case 'pencil':
      return { ...base, borderWidth: 2 };
    case 'areaHighlight':
      return { ...base, color: defaultColourFor('highlight'), borderWidth: 0 };
    default:
      return base;
  }
}

/** Settings that are not per tool. */
export interface DrawingSettings {
  /** Strokes drawn within `inkGroupMs` of each other go into one Ink annotation. */
  readonly inkGroupStrokes: boolean;
  readonly inkGroupMs: number;
  /** What the eraser does to a stroke it touches. */
  readonly eraserMode: 'stroke' | 'split';
  /** Eraser radius in points. */
  readonly eraserRadius: number;
  /** Whether a pen's pressure widens the stroke. */
  readonly pressure: boolean;
  /** Stamp ids the reader starred, in the order they were starred. */
  readonly favouriteStamps: ReadonlyArray<string>;
}

export const DEFAULT_DRAWING_SETTINGS: DrawingSettings = {
  inkGroupStrokes: true,
  inkGroupMs: 1500,
  eraserMode: 'split',
  eraserRadius: 6,
  pressure: true,
  favouriteStamps: [],
};

/** A custom stamp the reader imported: always PNG, always with its size (see ADR 0015). */
export interface CustomStamp {
  readonly id: string;
  readonly label: string;
  /** Base64 PNG. */
  readonly data: string;
  readonly width: number;
  readonly height: number;
  /** ISO 8601. */
  readonly created: string;
}

const KEYS: Readonly<Record<keyof DrawingSettings, string>> = {
  inkGroupStrokes: 'draw.ink.groupStrokes',
  inkGroupMs: 'draw.ink.groupMs',
  eraserMode: 'draw.eraser.mode',
  eraserRadius: 'draw.eraser.radius',
  pressure: 'draw.ink.pressure',
  favouriteStamps: 'stamps.favourites',
};

const CUSTOM_STAMPS_KEY = 'stamps.custom';

const defaultsKey = (tool: DrawingToolId): string => `draw.defaults.${tool}`;

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

export async function readDrawingSettings(storage: SettingsStorage): Promise<DrawingSettings> {
  const names = Object.keys(KEYS) as Array<keyof DrawingSettings>;
  const entries = await Promise.all(
    names.map(async (name) => [name, await storage.get(KEYS[name])] as const),
  );
  const out: Record<string, unknown> = { ...DEFAULT_DRAWING_SETTINGS };
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    if (name === 'favouriteStamps') {
      if (Array.isArray(value)) out[name] = value.filter((v) => typeof v === 'string');
      continue;
    }
    if (name === 'eraserMode') {
      if (value === 'stroke' || value === 'split') out[name] = value;
      continue;
    }
    if (typeof value === typeof DEFAULT_DRAWING_SETTINGS[name]) out[name] = value;
  }
  return out as unknown as DrawingSettings;
}

export async function writeDrawingSetting<K extends keyof DrawingSettings>(
  storage: SettingsStorage,
  name: K,
  value: DrawingSettings[K],
): Promise<void> {
  await storage.set(KEYS[name], value);
}

export async function readDrawingDefaults(
  storage: SettingsStorage,
  tool: DrawingToolId,
): Promise<DrawingDefaults> {
  return mergeDrawingDefaults(tool, await storage.get(defaultsKey(tool)));
}

/** Merges a stored object over the factory defaults, field by field (see the file comment). */
export function mergeDrawingDefaults(tool: DrawingToolId, raw: unknown): DrawingDefaults {
  const base = factoryDrawingDefaults(tool);
  if (!raw || typeof raw !== 'object') return base;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base) as Array<keyof DrawingDefaults>) {
    const value = source[key];
    if (value === undefined) continue;
    switch (key) {
      case 'fillColor':
        if (value === null || typeof value === 'number') out[key] = value;
        break;
      case 'dashArray':
        if (Array.isArray(value)) {
          out[key] = value.filter((n): n is number => typeof n === 'number' && n > 0);
        }
        break;
      case 'lineEndings':
        if (
          Array.isArray(value) &&
          value.length === 2 &&
          value.every((v) => typeof v === 'string')
        ) {
          out[key] = value;
        }
        break;
      default:
        if (typeof value === typeof base[key]) out[key] = value;
    }
  }
  return out as unknown as DrawingDefaults;
}

export async function writeDrawingDefaults(
  storage: SettingsStorage,
  tool: DrawingToolId,
  defaults: DrawingDefaults,
): Promise<void> {
  await storage.set(defaultsKey(tool), defaults);
}

export async function readCustomStamps(storage: SettingsStorage): Promise<CustomStamp[]> {
  const raw = await storage.get(CUSTOM_STAMPS_KEY);
  if (!Array.isArray(raw)) return [];
  const out: CustomStamp[] = [];
  for (const item of raw) {
    const stamp = asCustomStamp(item);
    if (stamp) out.push(stamp);
  }
  return out;
}

export function asCustomStamp(value: unknown): CustomStamp | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (
    typeof r['id'] !== 'string' ||
    typeof r['label'] !== 'string' ||
    typeof r['data'] !== 'string' ||
    typeof r['width'] !== 'number' ||
    typeof r['height'] !== 'number'
  ) {
    return null;
  }
  return {
    id: r['id'],
    label: r['label'],
    data: r['data'],
    width: r['width'],
    height: r['height'],
    created: typeof r['created'] === 'string' ? r['created'] : '',
  };
}

export async function writeCustomStamps(
  storage: SettingsStorage,
  stamps: ReadonlyArray<CustomStamp>,
): Promise<void> {
  await storage.set(CUSTOM_STAMPS_KEY, stamps);
}

/** The manifest's settings schema — what M130's preferences dialog renders. */
export const DRAWING_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'draw',
  properties: {
    'ink.groupStrokes': {
      type: 'boolean',
      title: 'Pencil strokes drawn close together become one annotation',
      default: DEFAULT_DRAWING_SETTINGS.inkGroupStrokes,
    },
    'ink.groupMs': {
      type: 'number',
      title: 'How long a pause ends a pencil group (milliseconds)',
      default: DEFAULT_DRAWING_SETTINGS.inkGroupMs,
      min: 200,
      max: 10000,
      step: 100,
    },
    'ink.pressure': {
      type: 'boolean',
      title: 'A pen’s pressure widens the pencil stroke',
      default: DEFAULT_DRAWING_SETTINGS.pressure,
    },
    'eraser.mode': {
      type: 'enum',
      title: 'What the eraser does to a stroke it touches',
      default: DEFAULT_DRAWING_SETTINGS.eraserMode,
      options: [
        { value: 'split', label: 'Cut the stroke where the eraser passes' },
        { value: 'stroke', label: 'Remove the whole stroke' },
      ],
    },
    'eraser.radius': {
      type: 'number',
      title: 'Eraser size (points)',
      default: DEFAULT_DRAWING_SETTINGS.eraserRadius,
      min: 1,
      max: 40,
      step: 1,
    },
  },
};
