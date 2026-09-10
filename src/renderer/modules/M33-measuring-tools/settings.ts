/**
 * M33's settings: the scale a new document starts with, what snapping does, and the look of each
 * measuring tool ("Set as default").
 *
 * The same shape as M30's and M31's, through the settings IPC (ADR 0003) under `measure.*`: one
 * stored object per tool, merged over the factory defaults field by field, so an older store is
 * upgraded rather than rejected.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';
import {
  DEFAULT_MEASURE_SCALE,
  DEFAULT_MEASURE_STYLE,
  parseMeasureScale,
  type CaptionPosition,
  type LineEnding,
  type MeasureScale,
} from '@engine/appearance';
import { defaultColourFor } from '@modules/M30-markup-annotations/presets';

/** The measuring tools, which are also the settings keys and the command suffixes. */
export const MEASURE_TOOLS = ['distance', 'perimeter', 'area', 'calibrate'] as const;

export type MeasureToolId = (typeof MEASURE_TOOLS)[number];

/** The kinds of point a measurement can snap to. Each has its own toggle, as Foxit's do. */
export const SNAP_KINDS = ['endpoints', 'midpoints', 'intersections', 'paths'] as const;

export type SnapKind = (typeof SNAP_KINDS)[number];

/** The wording the menu and the indicator use. Never the bare key. */
export const SNAP_LABELS: Readonly<Record<SnapKind, string>> = {
  endpoints: 'Endpoints',
  midpoints: 'Midpoints',
  intersections: 'Intersections',
  paths: 'Points on a path',
};

/** Every property a measuring tool's default can carry. */
export interface MeasureDefaults {
  /** Stroke colour, `0xRRGGBB`. */
  readonly color: number;
  readonly borderWidth: number;
  /** Dash pattern in points; empty is a solid line. */
  readonly dashArray: ReadonlyArray<number>;
  /** `/LE` — what each end of the dimension line carries. */
  readonly lineEndings: readonly [LineEnding, LineEnding];
  /** `/LL`, `/LLE`, `/LLO` — a distance's leaders. */
  readonly leaderLength: number;
  readonly leaderExtend: number;
  readonly leaderOffset: number;
  /** Whether the value is drawn on the measurement, and where. */
  readonly caption: boolean;
  readonly captionPosition: CaptionPosition;
  readonly fontSize: number;
  /** Subject line (`/Subj`) — the tool's own name, as every editor writes it. */
  readonly subject: string;
}

const SUBJECTS: Readonly<Record<MeasureToolId, string>> = {
  distance: 'Distance',
  perimeter: 'Perimeter',
  area: 'Area',
  calibrate: 'Calibration',
};

/** The factory defaults for one tool. The colour comes from `resources/annotations/colours.json`. */
export function factoryMeasureDefaults(tool: MeasureToolId): MeasureDefaults {
  const base: MeasureDefaults = {
    color: defaultColourFor(tool),
    borderWidth: 1,
    dashArray: [],
    lineEndings: ['None', 'None'],
    leaderLength: DEFAULT_MEASURE_STYLE.leaderLength,
    leaderExtend: DEFAULT_MEASURE_STYLE.leaderExtend,
    leaderOffset: DEFAULT_MEASURE_STYLE.leaderOffset,
    caption: true,
    captionPosition: DEFAULT_MEASURE_STYLE.captionPosition,
    fontSize: DEFAULT_MEASURE_STYLE.fontSize,
    subject: SUBJECTS[tool],
  };
  // A distance is the one that gets leaders: the line stands off what it measures, the way a
  // dimension on a drawing does, so the drawing underneath stays readable.
  if (tool === 'distance') return { ...base, leaderLength: 8, leaderExtend: 4, leaderOffset: 2 };
  return base;
}

/** Settings that are not per tool. */
export interface MeasureSettings {
  /** The scale a document with no calibration of its own uses. */
  readonly scale: MeasureScale;
  /** The master snapping switch. */
  readonly snap: boolean;
  readonly snapEndpoints: boolean;
  readonly snapMidpoints: boolean;
  readonly snapIntersections: boolean;
  readonly snapPaths: boolean;
  /** How near a candidate has to be, in screen pixels, before it is snapped to. */
  readonly snapTolerance: number;
  /** Whether a new measurement's own value is written into `/Contents`. */
  readonly writeContents: boolean;
}

export const DEFAULT_MEASURE_SETTINGS: MeasureSettings = {
  scale: DEFAULT_MEASURE_SCALE,
  snap: true,
  snapEndpoints: true,
  snapMidpoints: true,
  snapIntersections: true,
  snapPaths: false,
  snapTolerance: 10,
  writeContents: true,
};

/** The setting that governs one snap kind. */
export const SNAP_SETTING: Readonly<Record<SnapKind, keyof MeasureSettings>> = {
  endpoints: 'snapEndpoints',
  midpoints: 'snapMidpoints',
  intersections: 'snapIntersections',
  paths: 'snapPaths',
};

const KEYS: Readonly<Record<keyof MeasureSettings, string>> = {
  scale: 'measure.scale',
  snap: 'measure.snap.on',
  snapEndpoints: 'measure.snap.endpoints',
  snapMidpoints: 'measure.snap.midpoints',
  snapIntersections: 'measure.snap.intersections',
  snapPaths: 'measure.snap.paths',
  snapTolerance: 'measure.snap.tolerance',
  writeContents: 'measure.writeContents',
};

const defaultsKey = (tool: MeasureToolId): string => `measure.defaults.${tool}`;

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

export async function readMeasureSettings(storage: SettingsStorage): Promise<MeasureSettings> {
  const names = Object.keys(KEYS) as Array<keyof MeasureSettings>;
  const entries = await Promise.all(
    names.map(async (name) => [name, await storage.get(KEYS[name])] as const),
  );
  const out: Record<string, unknown> = { ...DEFAULT_MEASURE_SETTINGS };
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    if (name === 'scale') {
      const scale = parseMeasureScale(value);
      if (scale) out[name] = scale;
      continue;
    }
    if (typeof value === typeof DEFAULT_MEASURE_SETTINGS[name]) out[name] = value;
  }
  return out as unknown as MeasureSettings;
}

export async function writeMeasureSetting<K extends keyof MeasureSettings>(
  storage: SettingsStorage,
  name: K,
  value: MeasureSettings[K],
): Promise<void> {
  await storage.set(KEYS[name], value);
}

export async function readMeasureDefaults(
  storage: SettingsStorage,
  tool: MeasureToolId,
): Promise<MeasureDefaults> {
  return mergeMeasureDefaults(tool, await storage.get(defaultsKey(tool)));
}

/** Merges a stored object over the factory defaults, field by field (see the file comment). */
export function mergeMeasureDefaults(tool: MeasureToolId, raw: unknown): MeasureDefaults {
  const base = factoryMeasureDefaults(tool);
  if (!raw || typeof raw !== 'object') return base;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base) as Array<keyof MeasureDefaults>) {
    const value = source[key];
    if (value === undefined) continue;
    switch (key) {
      case 'dashArray':
        if (Array.isArray(value)) {
          out[key] = value.filter((n): n is number => typeof n === 'number' && n > 0);
        }
        break;
      case 'captionPosition':
        if (value === 'Inline' || value === 'Top') out[key] = value;
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
  return out as unknown as MeasureDefaults;
}

export async function writeMeasureDefaults(
  storage: SettingsStorage,
  tool: MeasureToolId,
  defaults: MeasureDefaults,
): Promise<void> {
  await storage.set(defaultsKey(tool), defaults);
}

/** The manifest's settings schema — what M130's preferences dialog renders. */
export const MEASURE_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'measure',
  properties: {
    'snap.on': {
      type: 'boolean',
      title: 'Snap measurements to what is drawn on the page',
      default: DEFAULT_MEASURE_SETTINGS.snap,
    },
    'snap.endpoints': {
      type: 'boolean',
      title: 'Snap to the ends of a line',
      default: DEFAULT_MEASURE_SETTINGS.snapEndpoints,
    },
    'snap.midpoints': {
      type: 'boolean',
      title: 'Snap to the middle of a line',
      default: DEFAULT_MEASURE_SETTINGS.snapMidpoints,
    },
    'snap.intersections': {
      type: 'boolean',
      title: 'Snap to where two lines cross',
      default: DEFAULT_MEASURE_SETTINGS.snapIntersections,
    },
    'snap.paths': {
      type: 'boolean',
      title: 'Snap to any point along a line',
      default: DEFAULT_MEASURE_SETTINGS.snapPaths,
    },
    'snap.tolerance': {
      type: 'number',
      title: 'How near the pointer has to be before it snaps (screen pixels)',
      default: DEFAULT_MEASURE_SETTINGS.snapTolerance,
      min: 2,
      max: 40,
      step: 1,
    },
    writeContents: {
      type: 'boolean',
      title: 'Write the measured value into the comment text as well as on to the page',
      default: DEFAULT_MEASURE_SETTINGS.writeContents,
    },
  },
};
