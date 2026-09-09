/**
 * M32's settings (ADR 0003, `comments.*`): how the panel is arranged, and what the summary and
 * the import dialogs offered last time.
 *
 * Everything here is a *view* preference. Nothing in this file can change a document — hiding a
 * comment, grouping by author or sorting by date are all things the reader does to the panel, and
 * a preference that could quietly alter a file would be the wrong kind of setting entirely.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';
import type { SummaryLayout, SummarySort } from '@engine/summary';
import type { GroupBy, SortBy, SortDirection } from './rows';

/** How incoming comments meet ones already in the document. */
export type ImportPolicy = 'replace' | 'add';

export interface CommentSettings {
  readonly group: GroupBy;
  readonly sort: SortBy;
  readonly direction: SortDirection;
  /** Show replies under their comment; off folds every thread. */
  readonly showReplies: boolean;
  /** Jump the page to a comment when its row is selected. */
  readonly jumpOnSelect: boolean;
  /** Conflict policy the import dialog opens on. */
  readonly importPolicy: ImportPolicy;
  /** Include AcroForm data in an export. */
  readonly exportFormData: boolean;
  readonly summaryLayout: SummaryLayout;
  readonly summarySort: SummarySort;
  readonly summaryFontSize: number;
  readonly summarySequenceNumbers: boolean;
  readonly summaryIncludeEmptyPages: boolean;
  /** Rendering density of the page pictures in a summary, in dots per inch. */
  readonly summaryDpi: number;
}

export const DEFAULT_COMMENT_SETTINGS: CommentSettings = {
  group: 'page',
  sort: 'page',
  direction: 'asc',
  showReplies: true,
  jumpOnSelect: true,
  importPolicy: 'replace',
  exportFormData: false,
  summaryLayout: 'separate-connectors',
  summarySort: 'page',
  summaryFontSize: 9,
  summarySequenceNumbers: true,
  summaryIncludeEmptyPages: false,
  summaryDpi: 110,
};

const KEYS: Readonly<Record<keyof CommentSettings, string>> = {
  group: 'comments.group',
  sort: 'comments.sort',
  direction: 'comments.direction',
  showReplies: 'comments.showReplies',
  jumpOnSelect: 'comments.jumpOnSelect',
  importPolicy: 'comments.importPolicy',
  exportFormData: 'comments.exportFormData',
  summaryLayout: 'comments.summary.layout',
  summarySort: 'comments.summary.sort',
  summaryFontSize: 'comments.summary.fontSize',
  summarySequenceNumbers: 'comments.summary.sequenceNumbers',
  summaryIncludeEmptyPages: 'comments.summary.includeEmptyPages',
  summaryDpi: 'comments.summary.dpi',
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

export async function readCommentSettings(storage: SettingsStorage): Promise<CommentSettings> {
  const names = Object.keys(KEYS) as Array<keyof CommentSettings>;
  const entries = await Promise.all(
    names.map(async (name) => [name, await storage.get(KEYS[name])] as const),
  );
  const out: Record<string, unknown> = { ...DEFAULT_COMMENT_SETTINGS };
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    // A stored value of the wrong type is an older store, not a reason to refuse to start.
    if (typeof value === typeof DEFAULT_COMMENT_SETTINGS[name]) out[name] = value;
  }
  return out as unknown as CommentSettings;
}

export async function writeCommentSetting<K extends keyof CommentSettings>(
  storage: SettingsStorage,
  name: K,
  value: CommentSettings[K],
): Promise<void> {
  await storage.set(KEYS[name], value);
}

/** The manifest's settings schema — what M130's preferences dialog renders. */
export const COMMENT_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'comments',
  properties: {
    group: {
      type: 'enum',
      title: 'Comments: group by',
      default: 'page',
      options: [
        { value: 'none', label: 'Nothing' },
        { value: 'page', label: 'Page' },
        { value: 'author', label: 'Author' },
        { value: 'type', label: 'Type' },
        { value: 'date', label: 'Date' },
        { value: 'status', label: 'Status' },
      ],
    },
    sort: {
      type: 'enum',
      title: 'Comments: sort by',
      default: 'page',
      options: [
        { value: 'page', label: 'Page' },
        { value: 'author', label: 'Author' },
        { value: 'date', label: 'Date' },
        { value: 'type', label: 'Type' },
        { value: 'status', label: 'Status' },
      ],
    },
    showReplies: { type: 'boolean', title: 'Comments: show replies', default: true },
    jumpOnSelect: {
      type: 'boolean',
      title: 'Comments: go to the page when a comment is selected',
      default: true,
    },
    importPolicy: {
      type: 'enum',
      title: 'Comments: importing a comment that is already there',
      default: 'replace',
      options: [
        { value: 'replace', label: 'Replace it' },
        { value: 'add', label: 'Add it as a second copy' },
      ],
    },
    exportFormData: {
      type: 'boolean',
      title: 'Comments: include form data when exporting',
      default: false,
    },
    summaryFontSize: {
      type: 'number',
      title: 'Comment summary: text size',
      default: 9,
      min: 6,
      max: 18,
      step: 1,
    },
    summaryDpi: {
      type: 'number',
      title: 'Comment summary: page picture density (dpi)',
      default: 110,
      min: 72,
      max: 300,
      step: 1,
    },
  },
};
