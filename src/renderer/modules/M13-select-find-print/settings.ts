/**
 * M13's settings: the find options that stick between searches, the snapshot DPI, and the print
 * dialog's "remember last settings". All of it goes through the settings IPC (ADR 0003) under
 * `find.*`, `snapshot.*` and `print.*`.
 *
 * The print settings are a single stored object rather than one key per switch: they are only
 * ever read and written together, and a partially migrated print dialog would be worse than one
 * that starts from its defaults.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';
import { DEFAULT_FIND_OPTIONS, type FindOptions } from './find/search';
import type { NUpOrder, ScalingMode } from './print/imposition';
import { DEFAULT_PAPER_ID } from './print/paper';

/** Where a search looks. */
export type SearchScope = 'document' | 'open' | 'folder';

export interface SelectFindSettings {
  /** Find options remembered between searches, as Foxit remembers its check boxes. */
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
  readonly ignoreDiacritics: boolean;
  readonly includeBookmarks: boolean;
  readonly includeComments: boolean;
  readonly includeFormFields: boolean;
  /** Words apart, for the advanced panel's proximity search. 0 is off. */
  readonly proximity: number;
  /** The advanced panel's last scope. */
  readonly scope: SearchScope;
  /** Recurse into sub-folders during a folder search. */
  readonly recursive: boolean;
  /** Stop a folder search after this many hits, so a big tree cannot run away. */
  readonly maxHits: number;
  /** Snapshot resolution, dots per inch. */
  readonly snapshotDpi: number;
  /** A snapshot goes to the clipboard, to a file, or to both. */
  readonly snapshotTarget: 'clipboard' | 'file' | 'both';
  /** Remember the print dialog's settings between jobs. */
  readonly rememberPrint: boolean;
}

export const DEFAULT_SELECT_FIND_SETTINGS: SelectFindSettings = {
  matchCase: false,
  wholeWord: false,
  regex: false,
  ignoreDiacritics: false,
  includeBookmarks: false,
  includeComments: false,
  includeFormFields: false,
  proximity: 0,
  scope: 'document',
  recursive: true,
  maxHits: 5000,
  snapshotDpi: 300,
  snapshotTarget: 'clipboard',
  rememberPrint: true,
};

const KEYS: Readonly<Record<keyof SelectFindSettings, string>> = {
  matchCase: 'find.matchCase',
  wholeWord: 'find.wholeWord',
  regex: 'find.regex',
  ignoreDiacritics: 'find.ignoreDiacritics',
  includeBookmarks: 'find.includeBookmarks',
  includeComments: 'find.includeComments',
  includeFormFields: 'find.includeFormFields',
  proximity: 'find.proximity',
  scope: 'find.scope',
  recursive: 'find.recursive',
  maxHits: 'find.maxHits',
  snapshotDpi: 'snapshot.dpi',
  snapshotTarget: 'snapshot.target',
  rememberPrint: 'print.remember',
};

/** The stored print settings — everything the dialog offers. */
export interface PrintSettings {
  /** Empty string means "the system default printer". */
  readonly printer: string;
  readonly copies: number;
  readonly collate: boolean;
  readonly rangeMode: 'all' | 'current' | 'selection' | 'custom';
  readonly rangeText: string;
  readonly subset: 'all' | 'odd' | 'even';
  readonly reverse: boolean;
  readonly scaling: ScalingMode;
  readonly customScale: number;
  readonly autoRotate: boolean;
  readonly autoCentre: boolean;
  readonly paperId: string;
  readonly orientation: 'portrait' | 'landscape' | 'auto';
  /** Margins in points. */
  readonly marginTop: number;
  readonly marginRight: number;
  readonly marginBottom: number;
  readonly marginLeft: number;
  /** `single`, `nup`, `booklet` or `tile`. */
  readonly mode: 'single' | 'nup' | 'booklet' | 'tile';
  readonly nUpColumns: number;
  readonly nUpRows: number;
  readonly nUpOrder: NUpOrder;
  readonly nUpBorder: boolean;
  readonly bookletSubset: 'both' | 'front' | 'back';
  readonly bookletBinding: 'left' | 'right';
  readonly tileScale: number;
  readonly tileOverlap: number;
  readonly tileMarks: boolean;
  readonly annotations: boolean;
  readonly forms: boolean;
  readonly grayscale: boolean;
  /** Rasterise everything, including for Print to PDF. */
  readonly printAsImage: boolean;
  readonly dpi: number;
}

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  printer: '',
  copies: 1,
  collate: true,
  rangeMode: 'all',
  rangeText: '',
  subset: 'all',
  reverse: false,
  scaling: 'shrink',
  customScale: 100,
  autoRotate: true,
  autoCentre: true,
  paperId: DEFAULT_PAPER_ID,
  orientation: 'auto',
  marginTop: 0,
  marginRight: 0,
  marginBottom: 0,
  marginLeft: 0,
  mode: 'single',
  nUpColumns: 2,
  nUpRows: 1,
  nUpOrder: 'horizontal',
  nUpBorder: false,
  bookletSubset: 'both',
  bookletBinding: 'left',
  tileScale: 1,
  tileOverlap: 0,
  tileMarks: true,
  annotations: true,
  forms: true,
  grayscale: false,
  printAsImage: false,
  dpi: 150,
};

const PRINT_KEY = 'print.lastSettings';

/** The manifest's settings schema — what M130's preferences dialog renders. */
export const SELECT_FIND_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'find',
  properties: {
    matchCase: { type: 'boolean', title: 'Find: match case', default: false },
    wholeWord: { type: 'boolean', title: 'Find: whole words only', default: false },
    regex: {
      type: 'boolean',
      title: 'Find: treat the query as a regular expression',
      default: false,
    },
    ignoreDiacritics: { type: 'boolean', title: 'Find: ignore accents', default: false },
    includeBookmarks: { type: 'boolean', title: 'Find: search bookmarks too', default: false },
    includeComments: { type: 'boolean', title: 'Find: search comments too', default: false },
    includeFormFields: { type: 'boolean', title: 'Find: search form values too', default: false },
    proximity: {
      type: 'number',
      title: 'Find: words apart for a proximity match (0 is off)',
      default: 0,
      min: 0,
      max: 50,
      step: 1,
    },
    recursive: { type: 'boolean', title: 'Folder search includes sub-folders', default: true },
    maxHits: {
      type: 'number',
      title: 'Stop a folder search after this many hits',
      default: DEFAULT_SELECT_FIND_SETTINGS.maxHits,
      min: 100,
      max: 100_000,
      step: 100,
    },
    'snapshot.dpi': {
      type: 'number',
      title: 'Snapshot resolution (DPI)',
      default: DEFAULT_SELECT_FIND_SETTINGS.snapshotDpi,
      min: 72,
      max: 1200,
      step: 1,
    },
    'snapshot.target': {
      type: 'enum',
      title: 'A snapshot goes to',
      default: DEFAULT_SELECT_FIND_SETTINGS.snapshotTarget,
      options: [
        { value: 'clipboard', label: 'The clipboard' },
        { value: 'file', label: 'A file' },
        { value: 'both', label: 'Both' },
      ],
    },
    'print.remember': {
      type: 'boolean',
      title: 'Remember the print settings between jobs',
      default: true,
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

export async function readSettings(storage: SettingsStorage): Promise<SelectFindSettings> {
  const names = Object.keys(KEYS) as Array<keyof SelectFindSettings>;
  const entries = await Promise.all(
    names.map(async (name) => [name, await storage.get(KEYS[name])] as const),
  );
  const out: Record<string, unknown> = { ...DEFAULT_SELECT_FIND_SETTINGS };
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    if (typeof value === typeof DEFAULT_SELECT_FIND_SETTINGS[name]) out[name] = value;
  }
  return out as unknown as SelectFindSettings;
}

export async function writeSetting<K extends keyof SelectFindSettings>(
  storage: SettingsStorage,
  name: K,
  value: SelectFindSettings[K],
): Promise<void> {
  await storage.set(KEYS[name], value);
}

export function settingKey(name: keyof SelectFindSettings): string {
  return KEYS[name];
}

/** The find options the settings currently describe. */
export function findOptionsOf(settings: SelectFindSettings): FindOptions {
  return {
    ...DEFAULT_FIND_OPTIONS,
    matchCase: settings.matchCase,
    wholeWord: settings.wholeWord,
    regex: settings.regex,
    ignoreDiacritics: settings.ignoreDiacritics,
    includeBookmarks: settings.includeBookmarks,
    includeComments: settings.includeComments,
    includeFormFields: settings.includeFormFields,
    proximity: settings.proximity,
  };
}

/**
 * Reads the stored print settings, field by field against the defaults. A stored object from an
 * older version is merged rather than rejected, and a field of the wrong type is ignored.
 */
export async function readPrintSettings(storage: SettingsStorage): Promise<PrintSettings> {
  const raw = await storage.get(PRINT_KEY);
  return mergePrintSettings(raw);
}

/** Exported for the unit test: the merge is the part that has to survive a schema change. */
export function mergePrintSettings(raw: unknown): PrintSettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_PRINT_SETTINGS;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...DEFAULT_PRINT_SETTINGS };
  for (const key of Object.keys(DEFAULT_PRINT_SETTINGS) as Array<keyof PrintSettings>) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (typeof value === typeof DEFAULT_PRINT_SETTINGS[key]) out[key] = value;
  }
  return out as unknown as PrintSettings;
}

export async function writePrintSettings(
  storage: SettingsStorage,
  settings: PrintSettings,
): Promise<void> {
  await storage.set(PRINT_KEY, settings);
}
