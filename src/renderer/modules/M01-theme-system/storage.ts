/**
 * Theme persistence over the typed settings IPC (M01). Outside Electron (unit tests, the dev
 * gallery) there is no bridge, so the caller falls back to `memoryStorage()`.
 */

import { hasBridge, invoke } from '@shared/ipc';
import { clampUiScale, isThemeName, UI_SCALE_DEFAULT } from '@theme/themes';
import type { ThemeState, ThemeStorage } from '@theme/ThemeManager';

/** Settings keys — must match `src/main/settings.ts`. */
export const THEME_KEY = 'theme.name';
export const UI_SCALE_KEY = 'ui.scale';
export const NIGHT_MODE_KEY = 'view.nightMode';

/** Reads/writes the theme choice through `settings:get` / `settings:set`. */
export function ipcThemeStorage(): ThemeStorage {
  return {
    async read(): Promise<Partial<ThemeState>> {
      if (!hasBridge()) return {};
      const [theme, scale, night] = await Promise.all([
        invoke('settings:get', THEME_KEY),
        invoke('settings:get', UI_SCALE_KEY),
        invoke('settings:get', NIGHT_MODE_KEY),
      ]);
      return {
        ...(isThemeName(theme) ? { theme } : {}),
        ...(typeof scale === 'number' ? { scale: clampUiScale(scale) } : {}),
        ...(typeof night === 'boolean' ? { nightMode: night } : {}),
      };
    },
    async write(state: ThemeState): Promise<void> {
      if (!hasBridge()) return;
      await Promise.all([
        invoke('settings:set', THEME_KEY, state.theme),
        invoke('settings:set', UI_SCALE_KEY, state.scale ?? UI_SCALE_DEFAULT),
        invoke('settings:set', NIGHT_MODE_KEY, state.nightMode),
      ]);
    },
  };
}
