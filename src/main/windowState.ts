/**
 * Remembered window bounds (M02). Size, position and maximised state are stored per *display
 * arrangement* so a laptop that is sometimes docked keeps one position for the built-in screen
 * and another for the external monitor. Persisted through the shared `Settings` store under
 * `window.bounds.<displayKey>`; read by main before the first window is created, which is why
 * this cannot live in the renderer. The pure parts are in `windowBounds.ts`.
 */

import { screen, type BrowserWindow } from 'electron';
import type { Settings } from './settings';
import {
  clampToDisplays,
  DEFAULT_BOUNDS,
  displayKey,
  isSavedBounds,
  WINDOW_BOUNDS_KEY,
  type SavedBounds,
} from './windowBounds';

function currentKey(): string {
  return `${WINDOW_BOUNDS_KEY}.${displayKey(screen.getAllDisplays())}`;
}

/** Reads the remembered bounds for the current display arrangement, clamped to be visible. */
export function loadWindowBounds(settings: Settings): SavedBounds | null {
  const saved = settings.get(currentKey());
  if (!isSavedBounds(saved)) return null;
  return clampToDisplays(saved, screen.getAllDisplays());
}

/**
 * Tracks a window and writes its bounds (debounced) whenever they change. The un-maximised
 * bounds are what get stored, plus the maximised flag, so restoring is exact.
 */
export function rememberWindowBounds(win: BrowserWindow, settings: Settings): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = (): void => {
    if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
    const maximized = win.isMaximized();
    const rect = maximized ? win.getNormalBounds() : win.getBounds();
    settings.set(currentKey(), { ...rect, maximized });
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 300);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    save();
  });
}

export { DEFAULT_BOUNDS };
export type { SavedBounds };
