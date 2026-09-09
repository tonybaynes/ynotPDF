/**
 * M41's settings. The schema is declared on the manifest so M130's preferences dialog renders
 * it; this file is the typed reader/writer the service uses.
 *
 * Same shape as M40's: a key map, a default for everything, and a reader that falls back rather
 * than throwing — a hand-edited settings file must never stop the app opening a document.
 *
 * `scan.autoDeskew` lives here rather than with M91 because M41 owns the straightening; M91's
 * from-images path reads it through this module's service (see `M91-create-pdf.md`).
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';
import type { PageBoxName } from '@shared/pdf';
import { DEFAULT_NAME_PATTERN } from '@engine/ops/split';

/** Which of the five boxes the crop tool writes by default. */
export const CROP_BOXES: ReadonlyArray<{ readonly value: PageBoxName; readonly label: string }> = [
  { value: 'crop', label: 'Crop box — what a reader sees' },
  { value: 'trim', label: 'Trim box — the finished page after cutting' },
  { value: 'bleed', label: 'Bleed box — the area a printer keeps ink over' },
  { value: 'art', label: 'Art box — the meaningful content' },
  { value: 'media', label: 'Media box — the paper itself' },
];

export interface MergeSettings {
  /** Combine: give each source file a bookmark named after it. */
  readonly bookmarkPerFile: boolean;
  /** Combine: bring each source's own bookmarks across. */
  readonly keepSourceBookmarks: boolean;
  /** Combine: open the result in a new tab rather than saving it straight to a file. */
  readonly combineToNewTab: boolean;
  /** Split: the file-name pattern; see `fillNamePattern`. */
  readonly splitNamePattern: string;
  /** Split: keep bookmarks / comments / form fields in each part. */
  readonly splitKeepBookmarks: boolean;
  readonly splitKeepComments: boolean;
  readonly splitKeepForms: boolean;
  /** Crop: which box the tool writes. */
  readonly cropBox: PageBoxName;
  /** Crop: also set the MediaBox, so the paper really changes size. */
  readonly cropChangesPageSize: boolean;
  /** Crop: points of breathing room left round the content by "remove white margins". */
  readonly cropMarginPoints: number;
  /** Flatten: bake comments / form fields. */
  readonly flattenAnnotations: boolean;
  readonly flattenForms: boolean;
  /** Deskew: shrink the CropBox by the wedges the turn exposes. */
  readonly deskewTrimEdges: boolean;
  /** Deskew: straighten pages automatically when a PDF is created from images (M91, M130). */
  readonly autoDeskewScans: boolean;
}

export const DEFAULT_MERGE_SETTINGS: MergeSettings = {
  bookmarkPerFile: true,
  keepSourceBookmarks: true,
  combineToNewTab: true,
  splitNamePattern: DEFAULT_NAME_PATTERN,
  splitKeepBookmarks: true,
  splitKeepComments: true,
  splitKeepForms: true,
  cropBox: 'crop',
  cropChangesPageSize: false,
  cropMarginPoints: 4,
  flattenAnnotations: true,
  flattenForms: true,
  deskewTrimEdges: false,
  autoDeskewScans: false,
};

/** Keys as they appear in `settings.json`. */
const KEYS: Readonly<Record<keyof MergeSettings, string>> = {
  bookmarkPerFile: 'combine.bookmarkPerFile',
  keepSourceBookmarks: 'combine.keepSourceBookmarks',
  combineToNewTab: 'combine.toNewTab',
  splitNamePattern: 'split.namePattern',
  splitKeepBookmarks: 'split.keepBookmarks',
  splitKeepComments: 'split.keepComments',
  splitKeepForms: 'split.keepForms',
  cropBox: 'crop.box',
  cropChangesPageSize: 'crop.changePageSize',
  cropMarginPoints: 'crop.marginPoints',
  flattenAnnotations: 'flatten.annotations',
  flattenForms: 'flatten.forms',
  deskewTrimEdges: 'deskew.trimEdges',
  autoDeskewScans: 'scan.autoDeskew',
};

/** The settings key for one setting — the commands and the tests name the same string. */
export function settingKey(name: keyof MergeSettings): string {
  return KEYS[name];
}

export const MERGE_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'documentOps',
  properties: {
    'combine.bookmarkPerFile': {
      type: 'boolean',
      title: 'Add a bookmark for each file when combining',
      default: DEFAULT_MERGE_SETTINGS.bookmarkPerFile,
    },
    'combine.keepSourceBookmarks': {
      type: 'boolean',
      title: 'Keep each file’s own bookmarks when combining',
      default: DEFAULT_MERGE_SETTINGS.keepSourceBookmarks,
    },
    'combine.toNewTab': {
      type: 'boolean',
      title: 'Open a combined document in a new tab instead of saving it straight away',
      default: DEFAULT_MERGE_SETTINGS.combineToNewTab,
    },
    'split.namePattern': {
      type: 'string',
      title: 'Name for each file when splitting',
      default: DEFAULT_MERGE_SETTINGS.splitNamePattern,
    },
    'split.keepBookmarks': {
      type: 'boolean',
      title: 'Keep bookmarks in each part when splitting',
      default: DEFAULT_MERGE_SETTINGS.splitKeepBookmarks,
    },
    'split.keepComments': {
      type: 'boolean',
      title: 'Keep comments in each part when splitting',
      default: DEFAULT_MERGE_SETTINGS.splitKeepComments,
    },
    'split.keepForms': {
      type: 'boolean',
      title: 'Keep form fields in each part when splitting',
      default: DEFAULT_MERGE_SETTINGS.splitKeepForms,
    },
    'crop.box': {
      type: 'enum',
      title: 'Box the crop tool sets',
      default: DEFAULT_MERGE_SETTINGS.cropBox,
      options: CROP_BOXES.map((o) => ({ value: o.value, label: o.label })),
    },
    'crop.changePageSize': {
      type: 'boolean',
      title: 'Cropping also changes the page size',
      default: DEFAULT_MERGE_SETTINGS.cropChangesPageSize,
    },
    'crop.marginPoints': {
      type: 'number',
      title: 'Space left round the content by “remove white margins” (points)',
      default: DEFAULT_MERGE_SETTINGS.cropMarginPoints,
      min: 0,
      max: 72,
      step: 1,
    },
    'flatten.annotations': {
      type: 'boolean',
      title: 'Flatten comments',
      default: DEFAULT_MERGE_SETTINGS.flattenAnnotations,
    },
    'flatten.forms': {
      type: 'boolean',
      title: 'Flatten form fields',
      default: DEFAULT_MERGE_SETTINGS.flattenForms,
    },
    'deskew.trimEdges': {
      type: 'boolean',
      title: 'Trim the corners a straightened page exposes',
      default: DEFAULT_MERGE_SETTINGS.deskewTrimEdges,
    },
    'scan.autoDeskew': {
      type: 'boolean',
      title: 'Straighten scanned pages automatically when importing images',
      default: DEFAULT_MERGE_SETTINGS.autoDeskewScans,
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

function isCropBox(value: unknown): value is PageBoxName {
  return CROP_BOXES.some((o) => o.value === value);
}

/** Reads every setting, falling back to the default for anything unset or malformed. */
export async function readMergeSettings(storage: SettingsStorage): Promise<MergeSettings> {
  const names = Object.keys(KEYS) as Array<keyof MergeSettings>;
  const values = await Promise.all(names.map((name) => storage.get(KEYS[name])));
  const at = (name: keyof MergeSettings): unknown => values[names.indexOf(name)];
  const pattern = at('splitNamePattern');
  const box = at('cropBox');
  const margin = at('cropMarginPoints');
  return {
    bookmarkPerFile: bool(at('bookmarkPerFile'), DEFAULT_MERGE_SETTINGS.bookmarkPerFile),
    keepSourceBookmarks: bool(
      at('keepSourceBookmarks'),
      DEFAULT_MERGE_SETTINGS.keepSourceBookmarks,
    ),
    combineToNewTab: bool(at('combineToNewTab'), DEFAULT_MERGE_SETTINGS.combineToNewTab),
    splitNamePattern:
      typeof pattern === 'string' && pattern.trim() !== ''
        ? pattern
        : DEFAULT_MERGE_SETTINGS.splitNamePattern,
    splitKeepBookmarks: bool(at('splitKeepBookmarks'), DEFAULT_MERGE_SETTINGS.splitKeepBookmarks),
    splitKeepComments: bool(at('splitKeepComments'), DEFAULT_MERGE_SETTINGS.splitKeepComments),
    splitKeepForms: bool(at('splitKeepForms'), DEFAULT_MERGE_SETTINGS.splitKeepForms),
    cropBox: isCropBox(box) ? box : DEFAULT_MERGE_SETTINGS.cropBox,
    cropChangesPageSize: bool(
      at('cropChangesPageSize'),
      DEFAULT_MERGE_SETTINGS.cropChangesPageSize,
    ),
    cropMarginPoints:
      typeof margin === 'number' && Number.isFinite(margin) && margin >= 0 && margin <= 72
        ? margin
        : DEFAULT_MERGE_SETTINGS.cropMarginPoints,
    flattenAnnotations: bool(at('flattenAnnotations'), DEFAULT_MERGE_SETTINGS.flattenAnnotations),
    flattenForms: bool(at('flattenForms'), DEFAULT_MERGE_SETTINGS.flattenForms),
    deskewTrimEdges: bool(at('deskewTrimEdges'), DEFAULT_MERGE_SETTINGS.deskewTrimEdges),
    autoDeskewScans: bool(at('autoDeskewScans'), DEFAULT_MERGE_SETTINGS.autoDeskewScans),
  };
}

export async function writeMergeSetting<K extends keyof MergeSettings>(
  storage: SettingsStorage,
  name: K,
  value: MergeSettings[K],
): Promise<void> {
  await storage.set(KEYS[name], value);
}
