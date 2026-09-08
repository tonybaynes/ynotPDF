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
import { readFileForRenderer, writeBytes, writeTempFile } from './files';
import { probeFile, writeAtomic } from './fs/atomic';
import type { CloseBroker } from './fs/lifecycle';
import type { RecoveryStore } from './fs/recovery';
import type { FileWatchers } from './fs/watcher';
import type { RecentFiles } from './recent';
import type { Settings } from './settings';
import { readClipboard } from './webpdf/clipboard';
import { decodeWithNativeImage } from './webpdf/decodeImage';
import type { WebPdfPrinter } from './webpdf/WebPdfPrinter';
import { allWindows, broadcast, getMainWindow } from './window';

export interface IpcDeps {
  onOpenPath(path: string): Promise<void>;
  rebuildMenu(): void;
  /** Opens another app window, optionally loading `path` into it once ready (M02). */
  openWindow(path: string | undefined, from: BrowserWindow | null): void;
  /** Watches open documents for changes made outside the app (M21). */
  watchers: FileWatchers;
  /** Where autosave records live (M21). */
  recovery: RecoveryStore;
  /** Holds a close or a quit back while the renderer asks about unsaved work (M21). */
  closeBroker: CloseBroker;
  /** Prints web pages and generated HTML in a hidden window (M91). */
  readonly webpdf: WebPdfPrinter;
}

/**
 * True in an e2e run (`YNOT_E2E=1`).
 *
 * The two channels that hand something to the operating system — "open this attachment" and
 * "open this link" — do everything except the last step when it is set. A test must never make
 * the machine it runs on open Foxit, or a browser: it asserts that the app asked, which is the
 * part that is ours. (It found this the hard way: a debugging run opened three PDFs in Foxit.)
 */
const E2E = process.env['YNOT_E2E'] === '1';

function windowOf(event: { readonly sender: unknown }): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender as Electron.WebContents);
  return win && !win.isDestroyed() ? win : getMainWindow();
}

/** The native Save dialog, filtered to PDFs. `null` when the reader cancelled. */
async function saveDialog(
  win: BrowserWindow | null,
  options: { defaultPath?: string; title?: string; buttonLabel?: string },
): Promise<string | null> {
  const dialogOptions: Electron.SaveDialogOptions = {
    title: options.title ?? 'Save PDF',
    ...(options.defaultPath !== undefined ? { defaultPath: options.defaultPath } : {}),
    ...(options.buttonLabel !== undefined ? { buttonLabel: options.buttonLabel } : {}),
    filters: [
      { name: 'PDF documents', extensions: ['pdf'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const result = win
    ? await dialog.showSaveDialog(win, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions);
  return result.canceled || !result.filePath ? null : result.filePath;
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
    'file:saveDialog': (e, defaultPath) =>
      saveDialog(windowOf(e), defaultPath === undefined ? {} : { defaultPath }),
    'file:saveAsDialog': (e, options) => saveDialog(windowOf(e), options ?? {}),
    'file:writeAtomic': async (_e, path, bytes, options) => {
      // Our own write must not come back as "someone changed your file"; the mute is set before
      // the bytes land and expires by itself, and is lifted early when the write fails.
      deps.watchers.suspend(path);
      try {
        const written = await writeAtomic(path, bytes, {
          backup: options?.backup ?? false,
        });
        const after = await probeFile(path);
        return { ...written, modifiedAt: after.modifiedAt };
      } catch (error) {
        deps.watchers.resume(path);
        throw error;
      }
    },
    'file:probe': (_e, path) => probeFile(path),
    'file:watch': (e, path, watching) => {
      const win = windowOf(e);
      if (!win) return;
      if (watching) deps.watchers.watch(path, win.id);
      else deps.watchers.unwatch(path, win.id);
    },
    'file:suspendWatch': (_e, path, ms) => {
      deps.watchers.suspend(path, ms);
    },
    'recovery:list': () => deps.recovery.list(),
    'recovery:save': (_e, id, payload) => deps.recovery.save(id, payload),
    'recovery:read': (_e, id) => deps.recovery.read(id),
    'recovery:discard': (_e, id) => deps.recovery.discard(id),
    'recovery:clear': () => deps.recovery.clear(),
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
    'window:setFullScreen': (e, fullScreen) => {
      const win = windowOf(e);
      if (!win) return false;
      const next = fullScreen ?? !win.isFullScreen();
      win.setFullScreen(next);
      return win.isFullScreen();
    },
    'window:count': () => allWindows().length,
    'window:setUnsaved': (e, unsaved) => {
      const win = windowOf(e);
      if (win) deps.closeBroker.setUnsaved(win.id, unsaved);
    },
    'window:confirmClose': (e, close) => {
      const win = windowOf(e);
      if (!win) return;
      deps.closeBroker.answerWindow(win.id, close);
      if (close) win.close();
    },
    'app:confirmQuit': (_e, quit) => {
      deps.closeBroker.answerQuit(quit);
      if (quit) app.quit();
    },
    'shell:openTempFile': async (_e, name, bytes) => {
      const path = await writeTempFile(name, bytes);
      if (E2E) return path;
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
      return path;
    },
    'shell:openExternal': async (_e, url) => {
      if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) URLs may be opened');
      if (E2E) return;
      await shell.openExternal(url);
    },
    'shell:showItemInFolder': (_e, path) => {
      shell.showItemInFolder(path);
    },
    'devtools:toggle': (e) => {
      windowOf(e)?.webContents.toggleDevTools();
    },
    // Multi-select with the caller's filters (M91). The files are not added to Recent: they are
    // sources for a new document, not documents that were opened.
    'file:openFilesDialog': async (e, options) => {
      const win = windowOf(e);
      const multi = options?.multi !== false;
      const filters = options?.filters ?? [{ name: 'All files', extensions: ['*'] }];
      const dialogOptions: Electron.OpenDialogOptions = {
        title: options?.title ?? 'Create PDF from files',
        properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: filters.map((f) => ({ name: f.name, extensions: [...f.extensions] })),
        ...(options?.buttonLabel !== undefined ? { buttonLabel: options.buttonLabel } : {}),
      };
      const result = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled) return [];
      return Promise.all(result.filePaths.map((path) => readFileForRenderer(path)));
    },
    'webpdf:render': (_e, request) => deps.webpdf.render(request),
    'webpdf:cancel': (_e, jobId) => {
      deps.webpdf.cancel(jobId);
    },
    'clipboard:read': () => readClipboard(),
    'image:decode': (_e, bytes) => decodeWithNativeImage(bytes),
  };

  for (const channel of Object.keys(handlers) as IpcInvokeChannel[]) {
    const handler = handlers[channel] as (
      event: Electron.IpcMainInvokeEvent,
      ...args: unknown[]
    ) => unknown;
    ipcMain.handle(channel, (event, ...args: unknown[]) => handler(event, ...args));
  }
}
