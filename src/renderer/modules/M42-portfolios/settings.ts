/**
 * Portfolio settings (M42). The schema is declared on the manifest so M130's preferences dialog
 * can render it; this file is the typed reader/writer the service uses.
 *
 * Two preferences, both of them the hook the brief asks M130 for: how a portfolio's grid opens,
 * and whether a portfolio made here starts with a cover sheet.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';
import type { PortfolioView } from '@shared/portfolio';

/** The two views a reader can be shown by default; `hidden` is a file's own choice, not ours. */
export const DEFAULT_VIEWS: ReadonlyArray<{
  readonly value: PortfolioView;
  readonly label: string;
}> = [
  { value: 'details', label: 'Details (a table of columns)' },
  { value: 'tile', label: 'Tiles (a picture of each file)' },
];

export interface PortfolioSettings {
  /** How the grid opens when a portfolio has no view of its own. */
  readonly defaultView: PortfolioView;
  /** Whether *File ▸ New ▸ Portfolio* draws a cover sheet. */
  readonly coverSheetOnNew: boolean;
  /** Show a first-page picture for embedded PDFs in tiles view. */
  readonly tileThumbnails: boolean;
}

export const DEFAULT_PORTFOLIO_SETTINGS: PortfolioSettings = {
  defaultView: 'details',
  coverSheetOnNew: true,
  tileThumbnails: true,
};

const KEYS: Readonly<Record<keyof PortfolioSettings, string>> = {
  defaultView: 'portfolio.defaultView',
  coverSheetOnNew: 'portfolio.coverSheetOnNew',
  tileThumbnails: 'portfolio.tileThumbnails',
};

export function settingKey(name: keyof PortfolioSettings): string {
  return KEYS[name];
}

export const PORTFOLIO_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'portfolio',
  properties: {
    defaultView: {
      type: 'enum',
      title: 'Show a portfolio as',
      default: DEFAULT_PORTFOLIO_SETTINGS.defaultView,
      options: DEFAULT_VIEWS.map((v) => ({ value: v.value, label: v.label })),
    },
    coverSheetOnNew: {
      type: 'boolean',
      title: 'Give a new portfolio a cover sheet',
      default: DEFAULT_PORTFOLIO_SETTINGS.coverSheetOnNew,
    },
    tileThumbnails: {
      type: 'boolean',
      title: 'Show a picture of the first page in tiles view',
      default: DEFAULT_PORTFOLIO_SETTINGS.tileThumbnails,
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

function isView(value: unknown): value is PortfolioView {
  return DEFAULT_VIEWS.some((v) => v.value === value);
}

export async function readPortfolioSettings(storage: SettingsStorage): Promise<PortfolioSettings> {
  const [view, cover, thumbnails] = await Promise.all(
    (Object.keys(KEYS) as Array<keyof PortfolioSettings>).map((name) => storage.get(KEYS[name])),
  );
  return {
    defaultView: isView(view) ? view : DEFAULT_PORTFOLIO_SETTINGS.defaultView,
    coverSheetOnNew:
      typeof cover === 'boolean' ? cover : DEFAULT_PORTFOLIO_SETTINGS.coverSheetOnNew,
    tileThumbnails:
      typeof thumbnails === 'boolean' ? thumbnails : DEFAULT_PORTFOLIO_SETTINGS.tileThumbnails,
  };
}

export async function writePortfolioSetting<K extends keyof PortfolioSettings>(
  storage: SettingsStorage,
  name: K,
  value: PortfolioSettings[K],
): Promise<void> {
  await storage.set(KEYS[name], value);
}
