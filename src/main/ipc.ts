/**
 * IPC handlers (M00). One entry per channel in `IpcInvokeMap`; the `IpcHandlers` type makes a
 * missing or mistyped handler a compile error.
 *
 * Window channels act on the window that sent the request (`BrowserWindow.fromWebContents`), so
 * they stay correct once a tab has been dragged out into a second window (M02).
 */

import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
} from 'electron';
import type { FileKind, IpcHandlers, IpcInvokeChannel, SaveDialogOptions } from '../shared/ipc';
import type { PrintJobs } from './print';
import type { FolderSearches } from './search';
import { hostArch, targetArch } from './arch';
import { appVersion } from './version';
import { readFileForRenderer, readFolder, writeBytes, writeInto, writeTempFile } from './files';
import { systemFontFamilies } from './fonts';
import { probeFile, writeAtomic } from './fs/atomic';
import type { CloseBroker } from './fs/lifecycle';
import type { RecoveryStore } from './fs/recovery';
import type { FileWatchers } from './fs/watcher';
import type { RecentFiles } from './recent';
import type { Settings } from './settings';
import { loadCertificates } from '../engine/security/pubsec/certificates';
import { toBase64 } from '../engine/security/pubsec/crypto';
import type { SecurityIntent } from '../engine/security/types';
import { security } from './security';
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
  /** Open print jobs (M13). */
  printJobs: PrintJobs;
  /** Running folder searches (M13). */
  searches: FolderSearches;
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

/**
 * Filters for the open dialog, by kind (M70).
 *
 * Windows shows the first filter by default and macOS uses the union of the extensions, so the
 * kind's own filter comes first and "All files" last in both. `.pfx` is Windows' name for a
 * `.p12` and `.p7c` is macOS's for a `.p7b`; a reader should not have to know that, so every
 * spelling is accepted.
 */
const FILE_FILTERS: Record<FileKind, Electron.FileFilter[]> = {
  pdf: [{ name: 'PDF documents', extensions: ['pdf'] }],
  certificate: [
    { name: 'Certificates', extensions: ['cer', 'crt', 'der', 'pem', 'p7b', 'p7c'] },
    { name: 'Certificate bundles', extensions: ['p7b', 'p7c'] },
  ],
  'digital-id': [{ name: 'Digital IDs', extensions: ['p12', 'pfx'] }],
};

const FILE_TITLES: Record<FileKind, string> = {
  pdf: 'Open PDF',
  certificate: 'Choose a certificate',
  'digital-id': 'Choose your digital ID',
};

/** The native Save dialog, filtered to PDFs. `null` when the reader cancelled. */
async function saveDialog(
  win: BrowserWindow | null,
  options: SaveDialogOptions,
): Promise<string | null> {
  const filters = options.filters?.length
    ? options.filters.map((f) => ({ name: f.name, extensions: [...f.extensions] }))
    : [
        { name: 'PDF documents', extensions: ['pdf'] },
        { name: 'All files', extensions: ['*'] },
      ];
  const dialogOptions: Electron.SaveDialogOptions = {
    title: options.title ?? 'Save PDF',
    ...(options.defaultPath !== undefined ? { defaultPath: options.defaultPath } : {}),
    ...(options.buttonLabel !== undefined ? { buttonLabel: options.buttonLabel } : {}),
    filters,
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
    'file:pickFile': async (e, kind, options) => {
      const win = windowOf(e);
      const dialogOptions: Electron.OpenDialogOptions = {
        title: options?.title ?? FILE_TITLES[kind],
        properties: options?.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: [...FILE_FILTERS[kind], { name: 'All files', extensions: ['*'] }],
      };
      const result = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled) return [];
      // Deliberately not added to Recent: a certificate is not a document the reader reopens.
      return Promise.all(result.filePaths.map((path) => readFileForRenderer(path)));
    },
    'file:readFolder': (_e, path, options) => readFolder(path, options),
    'file:writeInto': (_e, dir, relativePath, bytes) => writeInto(dir, relativePath, bytes),
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

    // ---- document security (M70, ADR 0011) -----------------------------------------------------
    'security:inspect': async (_e, bytes) => security().inspect(bytes),
    'security:isOwnerPassword': (_e, bytes, password) =>
      security().isOwnerPassword(bytes, password),
    'security:protect': async (_e, bytes, intent, secrets) => {
      const result = await security().protect(bytes, intent as SecurityIntent, secrets);
      return { bytes: result.bytes, warnings: [...result.warnings] };
    },
    'security:remove': async (_e, bytes, password) => {
      const result = await security().remove(bytes, password);
      return { bytes: result.bytes, warnings: [...result.warnings] };
    },
    'security:unlock': async (_e, bytes, p12, password) => {
      const result = await security().unlockWithDigitalId(bytes, p12, password);
      return {
        bytes: result.bytes,
        permissions: result.permissions,
        openedAs: result.openedAs,
      };
    },
    'security:readCertificates': (_e, bytes, fileName) =>
      loadCertificates(bytes, fileName).map((cert) => ({
        name: cert.name,
        issuer: cert.issuer,
        serial: cert.serial,
        validFrom: cert.validFrom,
        validTo: cert.validTo,
        expired: cert.expired,
        certificateBase64: toBase64(cert.der),
      })),
    'security:version': () => security().version(),
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
    'settings:all': () => settings.all(),
    'settings:setMany': (_e, values) => {
      settings.setMany(values);
    },
    'settings:reset': (_e, prefixes) => {
      settings.reset(prefixes);
    },
    'settings:path': () => settings.path,
    'settings:get': (_e, key) => settings.get(key),
    'settings:set': (_e, key, value) => {
      settings.set(key, value);
    },
    // Read from the OS font directories once per process (M30, ADR 0013); an unreadable machine
    // simply reports nothing and the free-text picker offers the base families alone.
    'fonts:list': () => systemFontFamilies(),
    // Keeps the OS chrome (title bar, menus, native dialogs) in step with the active theme.
    'theme:setNative': (_e, scheme) => {
      nativeTheme.themeSource = scheme;
    },
    'app:info': () => ({
      name: app.getName(),
      version: appVersion(),
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

    // ---- M13: clipboard, folder search, printing (ADR 0012) ---------------------------------
    'clipboard:write': async (_e, payload) => {
      // One item carrying every format, not one `write` per format: a paste target then picks
      // the richest thing it understands instead of receiving whichever we put down last.
      const item: Record<string, string> = {};
      if (payload.text !== undefined) item['text/plain'] = payload.text;
      if (payload.html !== undefined) item['text/html'] = payload.html;
      if (payload.rtf !== undefined) item['text/rtf'] = payload.rtf;
      if (Object.keys(item).length === 0) return;
      try {
        await clipboard.write([new ClipboardItem(item)]);
      } catch (error) {
        // A platform that will not take one of the richer formats must not lose the copy: fall
        // back to plain text, which every platform takes.
        if (payload.text === undefined) throw error;
        await clipboard.writeText(payload.text);
      }
    },
    'clipboard:writeImage': async (_e, png) => {
      const blob = new Blob([Buffer.from(png)], { type: 'image/png' });
      await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    },
    'dialog:pickFolder': async (e, title) => {
      const win = windowOf(e);
      const options: Electron.OpenDialogOptions = {
        title: title ?? 'Choose a folder to search',
        properties: ['openDirectory'],
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    'search:folder': (e, request) => {
      const win = windowOf(e);
      if (!win) throw new Error('No window to search from');
      return deps.searches.start(win, request);
    },
    'search:cancel': (_e, jobId) => {
      deps.searches.cancel(jobId);
    },
    'print:printers': async (e) => {
      const win = windowOf(e);
      if (!win) return [];
      const printers = await win.webContents.getPrintersAsync();
      // `PrinterInfo` has no portable "is default" flag; the platform puts it in `options`
      // under a different name on each OS, so all three are checked and none is assumed.
      return printers.map((p) => {
        const options = p.options as Readonly<Record<string, unknown>> | undefined;
        const isDefault =
          options?.['printer-is-default'] === 'true' ||
          options?.['is-default'] === 'true' ||
          options?.['default'] === 'true';
        return {
          name: p.name,
          displayName: p.displayName || p.name,
          isDefault,
          ...(p.description ? { description: p.description } : {}),
        };
      });
    },
    'print:begin': (_e, setup) => deps.printJobs.begin(setup),
    'print:sheet': (_e, jobId, png) => {
      deps.printJobs.addSheet(jobId, png);
    },
    'print:finish': (e, jobId) => deps.printJobs.finish(jobId, windowOf(e)),
    'print:cancel': (_e, jobId) => {
      deps.printJobs.cancel(jobId);
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
