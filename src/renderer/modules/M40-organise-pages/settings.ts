/**
 * Page-organisation settings (M40). The schema is declared on the manifest so M130's preferences
 * dialog can render it; this file is the typed reader/writer the service uses.
 *
 * Same shape as M12's: a key map, a default for everything, and a reader that falls back rather
 * than throwing — a hand-edited settings file must never stop the app opening a document.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';
import { DEFAULT_PAGE_SIZE_ID, findPreset } from '@shared/pageSizes';

/** Where an insert lands when the reader has not said. */
export type InsertPosition = 'before' | 'after' | 'first' | 'last';

export const INSERT_POSITIONS: ReadonlyArray<{
  readonly value: InsertPosition;
  readonly label: string;
}> = [
  { value: 'before', label: 'Before the selected page' },
  { value: 'after', label: 'After the selected page' },
  { value: 'first', label: 'At the start of the document' },
  { value: 'last', label: 'At the end of the document' },
];

export interface OrganiseSettings {
  /** Preset id for a new blank page, from `resources/page-sizes.json`. */
  readonly blankPageSize: string;
  /** Where Insert puts pages by default. */
  readonly insertPosition: InsertPosition;
  /** Delete a bookmark whose page has been deleted (Foxit's behaviour; this brief asks for it). */
  readonly pruneBookmarksOnDelete: boolean;
  /** Ask before deleting pages. Off makes Delete immediate, and undo is still there. */
  readonly confirmDelete: boolean;
  /** Bring the source document's bookmarks in with inserted pages. */
  readonly keepBookmarksOnInsert: boolean;
  /** Keep comments (markup annotations) when extracting pages to a new document. */
  readonly extractWithComments: boolean;
  /** Naming pattern for "one file per page". `{name}`, `{page}` and `{label}` are substituted. */
  readonly extractNamePattern: string;
  /** Copy pages when dragging onto another document's tab, rather than moving them. */
  readonly dragBetweenDocumentsCopies: boolean;
}

export const DEFAULT_ORGANISE_SETTINGS: OrganiseSettings = {
  blankPageSize: DEFAULT_PAGE_SIZE_ID,
  insertPosition: 'after',
  pruneBookmarksOnDelete: true,
  confirmDelete: true,
  keepBookmarksOnInsert: true,
  extractWithComments: true,
  extractNamePattern: '{name} page {page}',
  dragBetweenDocumentsCopies: true,
};

/** Keys as they appear in `settings.json`. */
const KEYS: Readonly<Record<keyof OrganiseSettings, string>> = {
  blankPageSize: 'organise.blankPageSize',
  insertPosition: 'organise.insertPosition',
  pruneBookmarksOnDelete: 'organise.pruneBookmarksOnDelete',
  confirmDelete: 'organise.confirmDelete',
  keepBookmarksOnInsert: 'organise.keepBookmarksOnInsert',
  extractWithComments: 'organise.extractWithComments',
  extractNamePattern: 'organise.extractNamePattern',
  dragBetweenDocumentsCopies: 'organise.dragCopiesBetweenDocuments',
};

/** The settings key for one setting — the commands and the tests name the same string. */
export function settingKey(name: keyof OrganiseSettings): string {
  return KEYS[name];
}

export const ORGANISE_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'organise',
  properties: {
    blankPageSize: {
      type: 'string',
      title: 'Size of a new blank page',
      default: DEFAULT_ORGANISE_SETTINGS.blankPageSize,
    },
    insertPosition: {
      type: 'enum',
      title: 'Insert pages',
      default: DEFAULT_ORGANISE_SETTINGS.insertPosition,
      options: INSERT_POSITIONS.map((o) => ({ value: o.value, label: o.label })),
    },
    pruneBookmarksOnDelete: {
      type: 'boolean',
      title: 'Delete bookmarks that pointed at a deleted page',
      default: DEFAULT_ORGANISE_SETTINGS.pruneBookmarksOnDelete,
    },
    confirmDelete: {
      type: 'boolean',
      title: 'Ask before deleting pages',
      default: DEFAULT_ORGANISE_SETTINGS.confirmDelete,
    },
    keepBookmarksOnInsert: {
      type: 'boolean',
      title: 'Bring bookmarks in with inserted pages',
      default: DEFAULT_ORGANISE_SETTINGS.keepBookmarksOnInsert,
    },
    extractWithComments: {
      type: 'boolean',
      title: 'Keep comments when extracting pages',
      default: DEFAULT_ORGANISE_SETTINGS.extractWithComments,
    },
    extractNamePattern: {
      type: 'string',
      title: 'Name for each file when extracting one file per page',
      default: DEFAULT_ORGANISE_SETTINGS.extractNamePattern,
    },
    dragCopiesBetweenDocuments: {
      type: 'boolean',
      title: 'Dragging pages onto another document’s tab copies them',
      default: DEFAULT_ORGANISE_SETTINGS.dragBetweenDocumentsCopies,
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

function isInsertPosition(value: unknown): value is InsertPosition {
  return INSERT_POSITIONS.some((o) => o.value === value);
}

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

/** Reads every setting, falling back to the default for anything unset or malformed. */
export async function readOrganiseSettings(storage: SettingsStorage): Promise<OrganiseSettings> {
  const names = Object.keys(KEYS) as Array<keyof OrganiseSettings>;
  const values = await Promise.all(names.map((name) => storage.get(KEYS[name])));
  const at = (name: keyof OrganiseSettings): unknown => values[names.indexOf(name)];
  const size = at('blankPageSize');
  const position = at('insertPosition');
  const pattern = at('extractNamePattern');
  return {
    // A preset that is not in the file any more would silently make every blank page A4-shaped
    // without saying so; snapping back to the default at least matches what the dialog shows.
    blankPageSize:
      typeof size === 'string' && findPreset(size) ? size : DEFAULT_ORGANISE_SETTINGS.blankPageSize,
    insertPosition: isInsertPosition(position)
      ? position
      : DEFAULT_ORGANISE_SETTINGS.insertPosition,
    pruneBookmarksOnDelete: bool(
      at('pruneBookmarksOnDelete'),
      DEFAULT_ORGANISE_SETTINGS.pruneBookmarksOnDelete,
    ),
    confirmDelete: bool(at('confirmDelete'), DEFAULT_ORGANISE_SETTINGS.confirmDelete),
    keepBookmarksOnInsert: bool(
      at('keepBookmarksOnInsert'),
      DEFAULT_ORGANISE_SETTINGS.keepBookmarksOnInsert,
    ),
    extractWithComments: bool(
      at('extractWithComments'),
      DEFAULT_ORGANISE_SETTINGS.extractWithComments,
    ),
    extractNamePattern:
      typeof pattern === 'string' && pattern.trim() !== ''
        ? pattern
        : DEFAULT_ORGANISE_SETTINGS.extractNamePattern,
    dragBetweenDocumentsCopies: bool(
      at('dragBetweenDocumentsCopies'),
      DEFAULT_ORGANISE_SETTINGS.dragBetweenDocumentsCopies,
    ),
  };
}

export async function writeOrganiseSetting<K extends keyof OrganiseSettings>(
  storage: SettingsStorage,
  name: K,
  value: OrganiseSettings[K],
): Promise<void> {
  await storage.set(KEYS[name], value);
}

/**
 * A file name from the "one file per page" pattern. `{name}` is the document, `{page}` the
 * 1-based position and `{label}` the page's own label — which are not the same thing once a
 * document has been renumbered.
 *
 * Two rules beyond filling the blanks, and both exist to stop a page being lost:
 *
 * - a pattern that names **neither** the page nor its label gets the page number appended, or
 *   every page of the run would be written to one name and twenty extracted pages would leave
 *   one file containing the twentieth;
 * - spaces are kept, because they are legal and the reader typed them, while what Windows and
 *   POSIX actually refuse is *replaced* rather than removed — removing would let two different
 *   names collapse into one.
 */
export function extractFileName(
  pattern: string,
  parts: { readonly name: string; readonly page: number; readonly label: string },
): string {
  const filled = pattern
    .replaceAll('{name}', parts.name)
    .replaceAll('{page}', String(parts.page))
    .replaceAll('{label}', parts.label);
  const safe = filled
    .replace(/[<>:"/\\|?*]/gu, '-')
    .replace(/\p{Cc}/gu, '-')
    .trim();
  // A name ending in a dot or a space is legal to create on Linux and impossible to open on
  // Windows, so it is trimmed on every platform rather than only where it breaks.
  const trimmed = safe.replace(/[. ]+$/u, '');
  // The extension is added at the end, so a pattern that already carries one does not get two —
  // and so the page number goes *before* it rather than after: 'Report 3.pdf', not
  // 'Report.pdf 3.pdf'.
  const withoutExtension = trimmed.replace(/\.pdf$/iu, '').replace(/[. ]+$/u, '');
  const namesThePage = pattern.includes('{page}') || pattern.includes('{label}');
  const base = namesThePage ? withoutExtension : `${withoutExtension} ${String(parts.page)}`.trim();
  return base === '' ? `page ${String(parts.page)}.pdf` : `${base}.pdf`;
}
