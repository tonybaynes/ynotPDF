/**
 * IPC handlers (M00). One entry per channel in `IpcInvokeMap`; the `IpcHandlers` type makes a
 * missing or mistyped handler a compile error.
 *
 * Window channels act on the window that sent the request (`BrowserWindow.fromWebContents`), so
 * they stay correct once a tab has been dragged out into a second window (M02).
 */

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import type { IpcHandlers, IpcInvokeChannel } from '../shared/ipc';
import { hostArch, targetArch } from './arch';
import { readFileForRenderer, writeBytes } from './files';
import type { RecentFiles } from './recent';
import type { Settings } from './settings';
import { allWindows, broadcast, getMainWindow } from './window';

export interface IpcDeps {
  onOpenPath(path: string): Promise<void>;
  rebuildMenu(): void;
  /** Opens another app window, optionally loading `path` into it once ready (M02). */
  openWindow(path: string | undefined, from: BrowserWindow | null): void;
}

function windowOf(event: { readonly sender: unknown }): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender as Electron.WebContents);
  return win && !win.isDestroyed() ? win : getMainWindow();
}

export function registerIpcHandlers(recent: RecentFiles, settings: Settings, deps: IpcDeps): void {
  const recentChanged = (): void => {
    broadcast('recent:changed', recent.list());
    deps.rebuildMenu();
  };
  const handlers: IpcHandlers = {
    'file:openDialog': async (e) => {
      const win = windowOf(e);
      const options: Electron.OpenDialogOptions = {
        title: 'Open PDF',
        properties: ['openFile'],
        filters: [
          { name: 'PDF documents', extensions: ['pdf'] },
          { name: 'All files', extensions: ['*'] },
        ],
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      const path = result.filePaths[0];
      if (result.canceled || !path) return null;
      const file = await readFileForRenderer(path);
      recent.add(path);
      recentChanged();
      return file;
    },
    'file:read': async (_e, path) => {
      const file = await readFileForRenderer(path);
      recent.add(path);
      recentChanged();
      return file;
    },
    'file:write': (_e, path, bytes) => writeBytes(path, bytes),
    'file:saveDialog': async (e, defaultPath) => {
      const win = windowOf(e);
      const options: Electron.SaveDialogOptions = {
        title: 'Save PDF',
        ...(defaultPath !== undefined ? { defaultPath } : {}),
        filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
      };
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    'recent:list': () => recent.list(),
    'recent:add': (_e, path) => {
      const list = recent.add(path);
      recentChanged();
      return list;
    },
    'recent:clear': () => {
      const list = recent.clear();
      recentChanged();
      return list;
    },
    'recent:pin': (_e, path, pinned) => {
      const list = recent.pin(path, pinned);
      recentChanged();
      return list;
    },
    'recent:remove': (_e, path) => {
      const list = recent.remove(path);
      recentChanged();
      return list;
    },
    'settings:get': (_e, key) => settings.get(key),
    'settings:set': (_e, key, value) => {
      settings.set(key, value);
    },
    // Keeps the OS chrome (title bar, menus, native dialogs) in step with the active theme.
    'theme:setNative': (_e, scheme) => {
      nativeTheme.themeSource = scheme;
    },
    'app:info': () => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      platform: process.platform,
      arch: targetArch(),
      hostArch: hostArch(),
      isPackaged: app.isPackaged,
      e2e: process.env['YNOT_E2E'] === '1',
    }),
    'app:quit': () => {
      app.quit();
    },
    'window:minimize': (e) => {
      windowOf(e)?.minimize();
    },
    'window:toggleMaximize': (e) => {
      const win = windowOf(e);
      if (!win) return;
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    },
    'window:close': (e) => {
      windowOf(e)?.close();
    },
    'window:setTitle': (e, title) => {
      windowOf(e)?.setTitle(title);
    },
    'window:new': (e, path) => {
      deps.openWindow(path, windowOf(e));
    },
    'window:getState': (e) => {
      const win = windowOf(e);
      return {
        maximized: win?.isMaximized() ?? false,
        fullScreen: win?.isFullScreen() ?? false,
        focused: win?.isFocused() ?? false,
      };
    },
    'window:count': () => allWindows().length,
    'shell:openExternal': async (_e, url) => {
      if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) URLs may be opened');
      await shell.openExternal(url);
    },
    'shell:showItemInFolder': (_e, path) => {
      shell.showItemInFolder(path);
    },
    'devtools:toggle': (e) => {
      windowOf(e)?.webContents.toggleDevTools();
    },
  };

  for (const channel of Object.keys(handlers) as IpcInvokeChannel[]) {
    const handler = handlers[channel] as (
      event: Electron.IpcMainInvokeEvent,
      ...args: unknown[]
    ) => unknown;
    ipcMain.handle(channel, (event, ...args: unknown[]) => handler(event, ...args));
  }
}
