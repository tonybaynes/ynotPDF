/**
 * Main window (M00): one `BrowserWindow` with `contextIsolation: true`, `sandbox: true`,
 * the preload bridge, and the `--ynot-e2e` flag passed only when `YNOT_E2E=1`.
 */

import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import type { IpcEvent, IpcEventChannel } from '../shared/ipc';

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

export function createMainWindow(options: { e2e: boolean }): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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
  mainWindow = win;

  win.once('ready-to-show', () => {
    win.show();
  });
  win.on('closed', () => {
    mainWindow = null;
  });
  win.on('focus', () => {
    sendToRenderer('window:focusChanged', { focused: true });
  });
  win.on('blur', () => {
    sendToRenderer('window:focusChanged', { focused: false });
  });

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

/** Type-safe push to the renderer. No-op when the window is gone. */
export function sendToRenderer<C extends IpcEventChannel>(channel: C, payload: IpcEvent<C>): void {
  const win = getMainWindow();
  if (!win) return;
  win.webContents.send(channel, payload);
}
