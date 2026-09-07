/**
 * The four themes (M01, PLAN.md §3.2). This is the single list every other part of the app
 * reads: the ThemeManager, the status-bar switcher, the palette commands, the gallery and the
 * contrast test. Adding a theme = add a CSS file under `src/renderer/theme/` and a row here.
 */

export type ThemeName = 'graphite' | 'midnight' | 'daylight' | 'high-contrast';

export interface ThemeInfo {
  readonly name: ThemeName;
  /** Human label for menus, palette and the status bar. */
  readonly label: string;
  /** Value the theme sets for `color-scheme`; also pushed to Electron's `nativeTheme`. */
  readonly scheme: 'dark' | 'light';
  /** One-line description shown in the gallery. */
  readonly description: string;
  /** CSS file name under `src/renderer/theme/`. */
  readonly file: `${ThemeName}.css`;
}

export const THEMES: ReadonlyArray<ThemeInfo> = [
  {
    name: 'graphite',
    label: 'Graphite',
    scheme: 'dark',
    description: 'Dark default. Near-black surfaces, white text and icons, blue accent.',
    file: 'graphite.css',
  },
  {
    name: 'midnight',
    label: 'Midnight',
    scheme: 'dark',
    description: 'Pure black, dark-blue panels, gold text, white borders (the logistics-hub look).',
    file: 'midnight.css',
  },
  {
    name: 'daylight',
    label: 'Daylight',
    scheme: 'light',
    description: 'Light grey, no pure white. Black text, set heavier. Deep-blue accent.',
    file: 'daylight.css',
  },
  {
    name: 'high-contrast',
    label: 'High Contrast',
    scheme: 'dark',
    description: 'Pure black, white and yellow. 2 px borders, no greys.',
    file: 'high-contrast.css',
  },
];

export const DEFAULT_THEME: ThemeName = 'graphite';

export const THEME_NAMES: ReadonlyArray<ThemeName> = THEMES.map((t) => t.name);

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && (THEME_NAMES as ReadonlyArray<string>).includes(value);
}

export function themeInfo(name: ThemeName): ThemeInfo {
  const info = THEMES.find((t) => t.name === name);
  if (!info) throw new Error(`Unknown theme: ${name}`);
  return info;
}

/** UI scale limits (percent). PLAN.md §3.2: 100–200 %. */
export const UI_SCALE_MIN = 100;
export const UI_SCALE_MAX = 200;
export const UI_SCALE_STEP = 10;
export const UI_SCALE_DEFAULT = 100;

/** Clamps and rounds a percentage to the allowed range/step. */
export function clampUiScale(percent: number): number {
  if (!Number.isFinite(percent)) return UI_SCALE_DEFAULT;
  const rounded = Math.round(percent / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, rounded));
}
