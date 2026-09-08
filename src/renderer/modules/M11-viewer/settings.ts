/**
 * Viewer settings (M11). The schema is declared on the manifest so M130's preferences UI can
 * render it; this file is the typed reader/writer the viewer itself uses.
 *
 * Everything goes through the settings IPC (ADR 0003) under `viewer.*`, plus two per-document
 * keys — the last scroll position and the guides — stored under a hash of the document's path
 * so reopening a file returns the reader to where they were.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';
import type { LayoutMode } from '@view/layout';
import type { Unit } from '@view/units';
import type { StoredGuide } from '@view/guides';

export interface ViewerSettings {
  /** Tile cache budget in megabytes. */
  readonly cacheMegabytes: number;
  readonly defaultLayout: LayoutMode;
  /** `page`, `width`, `visible` or `none` for "remember the last zoom". */
  readonly defaultZoom: 'page' | 'width' | 'visible' | 'none';
  readonly rulers: boolean;
  readonly rulerUnits: Unit;
  readonly grid: boolean;
  /** Grid spacing in points. */
  readonly gridSpacing: number;
  readonly snapToGrid: boolean;
  readonly guides: boolean;
  readonly lineWeights: boolean;
  readonly smoothText: boolean;
  readonly smoothImages: boolean;
  readonly smoothPaths: boolean;
  readonly grayscale: boolean;
  /** Night Mode leaves photographs alone. */
  readonly nightKeepImages: boolean;
  /** Restore the scroll position and zoom of a document that is reopened. */
  readonly restorePosition: boolean;
  /** Auto-scroll speed, lines per second at speed 1. */
  readonly autoScrollSpeed: number;
  /** Show the developer performance HUD. */
  readonly perfHud: boolean;
}

export const DEFAULT_SETTINGS: ViewerSettings = {
  cacheMegabytes: 256,
  defaultLayout: 'continuous',
  defaultZoom: 'width',
  rulers: false,
  rulerUnits: 'mm',
  grid: false,
  gridSpacing: 36,
  snapToGrid: false,
  guides: true,
  lineWeights: true,
  smoothText: true,
  smoothImages: true,
  smoothPaths: true,
  grayscale: false,
  nightKeepImages: true,
  restorePosition: true,
  autoScrollSpeed: 3,
  perfHud: false,
};

/** Keys as they appear in `settings.json`. */
const KEYS: Readonly<Record<keyof ViewerSettings, string>> = {
  cacheMegabytes: 'viewer.cache.megabytes',
  defaultLayout: 'viewer.layout',
  defaultZoom: 'viewer.zoom',
  rulers: 'viewer.rulers',
  rulerUnits: 'viewer.rulers.units',
  grid: 'viewer.grid',
  gridSpacing: 'viewer.grid.spacing',
  snapToGrid: 'viewer.grid.snap',
  guides: 'viewer.guides',
  lineWeights: 'viewer.lineWeights',
  smoothText: 'viewer.smooth.text',
  smoothImages: 'viewer.smooth.images',
  smoothPaths: 'viewer.smooth.paths',
  grayscale: 'viewer.grayscale',
  nightKeepImages: 'viewer.night.keepImages',
  restorePosition: 'viewer.restorePosition',
  autoScrollSpeed: 'viewer.autoScroll.speed',
  perfHud: 'viewer.perfHud',
};

/** The manifest's settings schema — what M130's preferences dialog renders. */
export const VIEWER_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'viewer',
  properties: {
    'cache.megabytes': {
      type: 'number',
      title: 'Page cache (MB)',
      default: DEFAULT_SETTINGS.cacheMegabytes,
      min: 32,
      max: 4096,
      step: 32,
    },
    layout: {
      type: 'enum',
      title: 'Page layout',
      default: DEFAULT_SETTINGS.defaultLayout,
      options: [
        { value: 'single', label: 'Single page' },
        { value: 'continuous', label: 'Continuous' },
        { value: 'facing', label: 'Facing' },
        { value: 'facingContinuous', label: 'Continuous facing' },
        { value: 'book', label: 'Book' },
      ],
    },
    zoom: {
      type: 'enum',
      title: 'Zoom when a document opens',
      default: DEFAULT_SETTINGS.defaultZoom,
      options: [
        { value: 'page', label: 'Fit page' },
        { value: 'width', label: 'Fit width' },
        { value: 'visible', label: 'Fit visible' },
        { value: 'none', label: 'Last used' },
      ],
    },
    rulers: { type: 'boolean', title: 'Show rulers', default: DEFAULT_SETTINGS.rulers },
    'rulers.units': {
      type: 'enum',
      title: 'Ruler units',
      default: DEFAULT_SETTINGS.rulerUnits,
      options: [
        { value: 'pt', label: 'Points' },
        { value: 'mm', label: 'Millimetres' },
        { value: 'cm', label: 'Centimetres' },
        { value: 'in', label: 'Inches' },
      ],
    },
    grid: { type: 'boolean', title: 'Show grid', default: DEFAULT_SETTINGS.grid },
    'grid.spacing': {
      type: 'number',
      title: 'Grid spacing (points)',
      default: DEFAULT_SETTINGS.gridSpacing,
      min: 2,
      max: 288,
      step: 1,
    },
    'grid.snap': { type: 'boolean', title: 'Snap to grid', default: DEFAULT_SETTINGS.snapToGrid },
    guides: { type: 'boolean', title: 'Show guides', default: DEFAULT_SETTINGS.guides },
    lineWeights: {
      type: 'boolean',
      title: 'Draw lines at their true widths',
      default: DEFAULT_SETTINGS.lineWeights,
    },
    'smooth.text': {
      type: 'boolean',
      title: 'Smooth text',
      default: DEFAULT_SETTINGS.smoothText,
    },
    'smooth.images': {
      type: 'boolean',
      title: 'Smooth images',
      default: DEFAULT_SETTINGS.smoothImages,
    },
    'smooth.paths': {
      type: 'boolean',
      title: 'Smooth line art',
      default: DEFAULT_SETTINGS.smoothPaths,
    },
    grayscale: {
      type: 'boolean',
      title: 'Render pages in greyscale',
      default: DEFAULT_SETTINGS.grayscale,
    },
    'night.keepImages': {
      type: 'boolean',
      title: 'Night Mode leaves photographs as they are',
      default: DEFAULT_SETTINGS.nightKeepImages,
    },
    restorePosition: {
      type: 'boolean',
      title: 'Reopen documents where I left them',
      default: DEFAULT_SETTINGS.restorePosition,
    },
    'autoScroll.speed': {
      type: 'number',
      title: 'Auto-scroll speed',
      default: DEFAULT_SETTINGS.autoScrollSpeed,
      min: 1,
      max: 10,
      step: 1,
    },
    perfHud: {
      type: 'boolean',
      title: 'Show the performance HUD',
      default: DEFAULT_SETTINGS.perfHud,
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

/** Reads every viewer setting, falling back to the default for anything unset or malformed. */
export async function readSettings(storage: SettingsStorage): Promise<ViewerSettings> {
  const entries = await Promise.all(
    (Object.keys(KEYS) as Array<keyof ViewerSettings>).map(
      async (name) => [name, await storage.get(KEYS[name])] as const,
    ),
  );
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    if (typeof value === typeof DEFAULT_SETTINGS[name]) out[name] = value;
  }
  return out as unknown as ViewerSettings;
}

export async function writeSetting<K extends keyof ViewerSettings>(
  storage: SettingsStorage,
  name: K,
  value: ViewerSettings[K],
): Promise<void> {
  await storage.set(KEYS[name], value);
}

/** The settings key for a setting name — used by the commands that toggle them. */
export function settingKey(name: keyof ViewerSettings): string {
  return KEYS[name];
}

// ---- per-document state -----------------------------------------------------------------------

/** What is remembered about a document between sessions. */
export interface DocumentViewState {
  readonly page: number;
  readonly zoom: number;
  readonly fit: 'page' | 'width' | 'visible' | null;
  readonly layout: LayoutMode;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly guides: ReadonlyArray<StoredGuide>;
}

/**
 * A short, stable key for a document path. `settings.json` keys are dotted, and a Windows path
 * is full of characters that would break that, so the path is hashed (FNV-1a, 32-bit — this is
 * a lookup key, not a security boundary).
 */
export function documentKey(path: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `viewer.documents.${(hash >>> 0).toString(36)}`;
}

export async function readDocumentState(
  storage: SettingsStorage,
  path: string,
): Promise<Partial<DocumentViewState>> {
  const raw = await storage.get(documentKey(path));
  if (!raw || typeof raw !== 'object') return {};
  return raw;
}

export async function writeDocumentState(
  storage: SettingsStorage,
  path: string,
  state: DocumentViewState,
): Promise<void> {
  await storage.set(documentKey(path), state);
}
