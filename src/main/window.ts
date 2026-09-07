/**
 * Application windows (M00, multi-window in M02). Every window is a `BrowserWindow` with
 * `contextIsolation: true`, `sandbox: true`, the preload bridge, and the `--ynot-e2e` flag
 * passed only when `YNOT_E2E=1`.
 *
 * The first window is the "main" window; a tab dragged out of the tab strip opens another one
 * through `window:new`. `getMainWindow()` returns the focused window when there is one, so IPC
 * that says "this window" targets the right one.
 */

import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import type { IpcEvent, IpcEventChannel } from '../shared/ipc';
import type { Settings } from './settings';
import { DEFAULT_BOUNDS, loadWindowBounds, rememberWindowBounds } from './windowState';

const windows = new Set<BrowserWindow>();

export interface WindowOptions {
  readonly e2e: boolean;
  /** When present the window remembers and restores its bounds per display arrangement. */
  readonly settings?: Settings;
  /** Cascade from this window (a detached tab opens beside its source). */
  readonly parent?: BrowserWindow | null;
}

/** The focused app window, else the first one still open, else `null`. */
export function getMainWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && windows.has(focused) && !focused.isDestroyed()) return focused;
  for (const win of windows) if (!win.isDestroyed()) return win;
  return null;
}

/** All live app windows. */
export function allWindows(): BrowserWindow[] {
  return Array.from(windows).filter((w) => !w.isDestroyed());
}

export function createMainWindow(options: WindowOptions): BrowserWindow {
  const saved = options.settings && !options.parent ? loadWindowBounds(options.settings) : null;
  const bounds = saved ?? DEFAULT_BOUNDS;
  const cascade =
    options.parent && !options.parent.isDestroyed() ? options.parent.getBounds() : null;
  const win = new BrowserWindow({
    width: cascade?.width ?? bounds.width,
    height: cascade?.height ?? bounds.height,
    ...(cascade
      ? { x: cascade.x + 40, y: cascade.y + 40 }
      : saved
        ? { x: bounds.x, y: bounds.y }
        : {}),
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'ynotPDF',
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      additionalArguments: options.e2e ? ['--ynot-e2e'] : [],
    },
  });
  windows.add(win);
  if (saved?.maximized) win.maximize();
  if (options.settings && !options.parent) rememberWindowBounds(win, options.settings);

  win.once('ready-to-show', () => {
    win.show();
  });
  win.on('closed', () => {
    windows.delete(win);
  });
  win.on('focus', () => {
    sendTo(win, 'window:focusChanged', { focused: true });
  });
  win.on('blur', () => {
    sendTo(win, 'window:focusChanged', { focused: false });
  });
  const pushState = (): void => {
    sendTo(win, 'window:stateChanged', {
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
      focused: win.isFocused(),
    });
  };
  win.on('maximize', pushState);
  win.on('unmaximize', pushState);
  win.on('enter-full-screen', pushState);
  win.on('leave-full-screen', pushState);

  // Never navigate the app window; open external links in the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return win;
}

/** Type-safe push to one window. No-op when it is gone. */
export function sendTo<C extends IpcEventChannel>(
  win: BrowserWindow | null,
  channel: C,
  payload: IpcEvent<C>,
): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

/** Type-safe push to the focused (or first) window. No-op when there is none. */
export function sendToRenderer<C extends IpcEventChannel>(channel: C, payload: IpcEvent<C>): void {
  sendTo(getMainWindow(), channel, payload);
}

/** Push to every open window (recent-files changes, settings that all windows show). */
export function broadcast<C extends IpcEventChannel>(channel: C, payload: IpcEvent<C>): void {
  for (const win of allWindows()) sendTo(win, channel, payload);
}
