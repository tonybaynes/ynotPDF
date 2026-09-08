/**
 * Navigation-panel settings (M12). The schema is declared on the manifest so M130's preferences
 * dialog can render it; this file is the typed reader/writer the panels use.
 *
 * `ui.leftPaneOnOpen` is the operator's requirement in one key: **Pages is the default panel**,
 * and the other three values are the ways of saying otherwise. It is applied on every document
 * open, which is why a file whose `/PageMode` asks for `/UseOutlines` still opens on Pages —
 * the user's choice wins over the file's.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';
import { DEFAULT_THUMBNAIL_SIZE, nearestSize } from './thumbnails/grid';

/** What the left pane does when a document opens. */
export type LeftPaneOnOpen = 'pages' | 'bookmarks' | 'last-used' | 'closed';

export const LEFT_PANE_ON_OPEN: ReadonlyArray<{
  readonly value: LeftPaneOnOpen;
  readonly label: string;
}> = [
  { value: 'pages', label: 'Pages (thumbnails)' },
  { value: 'bookmarks', label: 'Bookmarks' },
  { value: 'last-used', label: 'The panel I used last' },
  { value: 'closed', label: 'Closed' },
];

export interface NavigationSettings {
  /** Which panel a document opens on. Operator requirement: Pages. */
  readonly leftPaneOnOpen: LeftPaneOnOpen;
  /** Thumbnail width in CSS pixels; always one of `THUMBNAIL_SIZES`. */
  readonly thumbnailSize: number;
  /** Wrap long bookmark titles instead of clipping them to one line (Foxit's option). */
  readonly wrapBookmarkTitles: boolean;
  /** Follow the reader: highlight the bookmark covering the current page as they scroll. */
  readonly highlightCurrentBookmark: boolean;
  /** Open the Attachments panel by itself when a document has embedded files. */
  readonly openAttachmentsPanel: boolean;
  /** Bookmark levels a document opens expanded to. 0 shows roots only. */
  readonly expandBookmarksToLevel: number;
}

export const DEFAULT_NAVIGATION_SETTINGS: NavigationSettings = {
  leftPaneOnOpen: 'pages',
  thumbnailSize: DEFAULT_THUMBNAIL_SIZE,
  wrapBookmarkTitles: true,
  highlightCurrentBookmark: true,
  openAttachmentsPanel: true,
  expandBookmarksToLevel: 1,
};

/** Keys as they appear in `settings.json`. */
const KEYS: Readonly<Record<keyof NavigationSettings, string>> = {
  leftPaneOnOpen: 'ui.leftPaneOnOpen',
  thumbnailSize: 'ui.thumbnailSize',
  wrapBookmarkTitles: 'ui.bookmarks.wrapTitles',
  highlightCurrentBookmark: 'ui.bookmarks.followPage',
  openAttachmentsPanel: 'ui.attachments.openOnFiles',
  expandBookmarksToLevel: 'ui.bookmarks.expandToLevel',
};

/** The settings key for one setting — the commands and the tests name the same string. */
export function settingKey(name: keyof NavigationSettings): string {
  return KEYS[name];
}

export const NAVIGATION_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'ui',
  properties: {
    leftPaneOnOpen: {
      type: 'enum',
      title: 'When a document opens, show',
      default: DEFAULT_NAVIGATION_SETTINGS.leftPaneOnOpen,
      options: LEFT_PANE_ON_OPEN.map((o) => ({ value: o.value, label: o.label })),
    },
    thumbnailSize: {
      type: 'number',
      title: 'Thumbnail size (pixels)',
      default: DEFAULT_NAVIGATION_SETTINGS.thumbnailSize,
      min: 80,
      max: 300,
      step: 20,
    },
    'bookmarks.wrapTitles': {
      type: 'boolean',
      title: 'Wrap long bookmark titles',
      default: DEFAULT_NAVIGATION_SETTINGS.wrapBookmarkTitles,
    },
    'bookmarks.followPage': {
      type: 'boolean',
      title: 'Highlight the bookmark for the page I am reading',
      default: DEFAULT_NAVIGATION_SETTINGS.highlightCurrentBookmark,
    },
    'bookmarks.expandToLevel': {
      type: 'number',
      title: 'Bookmark levels expanded when a document opens',
      default: DEFAULT_NAVIGATION_SETTINGS.expandBookmarksToLevel,
      min: 0,
      max: 6,
      step: 1,
    },
    'attachments.openOnFiles': {
      type: 'boolean',
      title: 'Open the Attachments panel for a document that has embedded files',
      default: DEFAULT_NAVIGATION_SETTINGS.openAttachmentsPanel,
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

function isLeftPaneOnOpen(value: unknown): value is LeftPaneOnOpen {
  return LEFT_PANE_ON_OPEN.some((o) => o.value === value);
}

/** Reads every setting, falling back to the default for anything unset or malformed. */
export async function readNavigationSettings(
  storage: SettingsStorage,
): Promise<NavigationSettings> {
  const [pane, size, wrap, follow, attachments, level] = await Promise.all(
    (Object.keys(KEYS) as Array<keyof NavigationSettings>).map((name) => storage.get(KEYS[name])),
  );
  return {
    leftPaneOnOpen: isLeftPaneOnOpen(pane) ? pane : DEFAULT_NAVIGATION_SETTINGS.leftPaneOnOpen,
    // A hand-edited file may say 137; the ladder is what the buttons step, so snap to it.
    thumbnailSize:
      typeof size === 'number' ? nearestSize(size) : DEFAULT_NAVIGATION_SETTINGS.thumbnailSize,
    wrapBookmarkTitles:
      typeof wrap === 'boolean' ? wrap : DEFAULT_NAVIGATION_SETTINGS.wrapBookmarkTitles,
    highlightCurrentBookmark:
      typeof follow === 'boolean' ? follow : DEFAULT_NAVIGATION_SETTINGS.highlightCurrentBookmark,
    openAttachmentsPanel:
      typeof attachments === 'boolean'
        ? attachments
        : DEFAULT_NAVIGATION_SETTINGS.openAttachmentsPanel,
    expandBookmarksToLevel:
      typeof level === 'number' && Number.isFinite(level)
        ? Math.max(0, Math.min(6, Math.round(level)))
        : DEFAULT_NAVIGATION_SETTINGS.expandBookmarksToLevel,
  };
}

export async function writeNavigationSetting<K extends keyof NavigationSettings>(
  storage: SettingsStorage,
  name: K,
  value: NavigationSettings[K],
): Promise<void> {
  await storage.set(KEYS[name], value);
}
