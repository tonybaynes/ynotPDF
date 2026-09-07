/**
 * IPC handlers (M00). One entry per channel in `IpcInvokeMap`; the `IpcHandlers` type makes a
 * missing or mistyped handler a compile error.
 */

import { app, dialog, ipcMain, nativeTheme, shell } from 'electron';
import type { IpcHandlers, IpcInvokeChannel } from '../shared/ipc';
import { readFileForRenderer, writeBytes } from './files';
import type { RecentFiles } from './recent';
import type { Settings } from './settings';
import { getMainWindow, sendToRenderer } from './window';

export interface IpcDeps {
  onOpenPath(path: string): Promise<void>;
  rebuildMenu(): void;
}

export function registerIpcHandlers(recent: RecentFiles, settings: Settings, deps: IpcDeps): void {
  const handlers: IpcHandlers = {
    'file:openDialog': async () => {
      const win = getMainWindow();
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
      sendToRenderer('recent:changed', recent.list());
      deps.rebuildMenu();
      return file;
    },
    'file:read': async (_e, path) => {
      const file = await readFileForRenderer(path);
      recent.add(path);
      sendToRenderer('recent:changed', recent.list());
      deps.rebuildMenu();
      return file;
    },
    'file:write': (_e, path, bytes) => writeBytes(path, bytes),
    'file:saveDialog': async (_e, defaultPath) => {
      const win = getMainWindow();
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
      deps.rebuildMenu();
      return list;
    },
    'recent:clear': () => {
      const list = recent.clear();
      deps.rebuildMenu();
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
      arch: process.arch,
      isPackaged: app.isPackaged,
      e2e: process.env['YNOT_E2E'] === '1',
    }),
    'app:quit': () => {
      app.quit();
    },
    'window:minimize': () => {
      getMainWindow()?.minimize();
    },
    'window:toggleMaximize': () => {
      const win = getMainWindow();
      if (!win) return;
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    },
    'window:close': () => {
      getMainWindow()?.close();
    },
    'window:setTitle': (_e, title) => {
      getMainWindow()?.setTitle(title);
    },
    'shell:openExternal': async (_e, url) => {
      if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) URLs may be opened');
      await shell.openExternal(url);
    },
    'shell:showItemInFolder': (_e, path) => {
      shell.showItemInFolder(path);
    },
    'devtools:toggle': () => {
      getMainWindow()?.webContents.toggleDevTools();
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
