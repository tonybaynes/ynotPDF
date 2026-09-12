import { installTestFileGrants } from './e2eCapabilities';
import { fileCapabilities } from './fs/capabilities';
/**
 * Electron main entry (M00): single-instance lock, app windows, native menu, IPC handlers,
 * recent files and `.pdf` file-association handling on all three OSes. M02 adds remembered
 * window bounds and a second window for tabs dragged out of the strip.
 */

import { app, BrowserWindow, nativeTheme } from 'electron';
import { CloseBroker } from './fs/lifecycle';
import { RecoveryStore } from './fs/recovery';
import { FileWatchers } from './fs/watcher';
import { registerIpcHandlers } from './ipc';
import { buildMenu } from './menu';
import { PrintJobs } from './print';
import { RecentFiles } from './recent';
import { FolderSearches } from './search';
import { Settings, THEME_KEY } from './settings';
import { WebPdfPrinter } from './webpdf/WebPdfPrinter';
import { broadcast, createMainWindow, getMainWindow, sendTo } from './window';
import { cleanTempFiles, readFileForRenderer } from './files';
import { installWindowProbe } from './windowProbe';

const E2E = process.env['YNOT_E2E'] === '1';
/** An e2e window is parked off-screen and transparent unless the operator asked to watch it. */
const E2E_HIDDEN = E2E && process.env['YNOT_E2E_VISIBLE'] !== '1';

/*
 * A test window is off-screen (on Windows and macOS — see `window.ts`) and never focused, and
 * Chromium's instinct with a window like that is to background its renderer: timers coalesced,
 * animation frames throttled. Playwright drives a *running* application, so a test run keeps
 * them.
 *
 * These are the two switches Playwright and Puppeteer pass to every Chromium they launch, for
 * this exact reason; Electron does not get them for free, because we launch an application rather
 * than a browser. They are not what fixed the Linux frame rate — that was the window's position,
 * and `window.ts` tells that story — but they are the right thing to say either way.
 *
 * `test/e2e/app.spec.ts` has the guard that fails loudly if any of this ever comes undone.
 */
if (E2E_HIDDEN) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
}

// Records every window's comings and goings when `YNOT_WINDOW_PROBE` names a file, so a flash
// nobody can reproduce on demand leaves evidence behind. Off and free otherwise.
installWindowProbe(app);

// Files handed to us before the window is ready (argv on Windows/Linux, open-file on macOS).
const pendingOpens: string[] = [];
let rendererReady = false;

function pdfPathsFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((a) => !a.startsWith('-') && /\.pdf$/i.test(a));
}

async function openPathIn(win: BrowserWindow, path: string): Promise<void> {
  try {
    path = fileCapabilities.grant(win.id, path, ['read', 'write']);
    const file = await readFileForRenderer(path);
    recent.add(path);
    sendTo(win, 'file:openRequested', file);
    broadcast('recent:changed', recent.list());
    buildMenu(recent);
    if (win.isMinimized()) win.restore();
    win.focus();
  } catch (error) {
    console.error(`could not open ${path}`, error);
  }
}

async function openPathInRenderer(path: string): Promise<void> {
  const win = getMainWindow();
  if (!win || !rendererReady) {
    pendingOpens.push(path);
    return;
  }
  await openPathIn(win, path);
}

/**
 * Window options every window shares: remembered bounds, and the M21 close hook that lets the
 * renderer offer Save / Don't save / Cancel before the window goes.
 */
function windowOptions(parent?: BrowserWindow | null): Parameters<typeof createMainWindow>[0] {
  return {
    e2e: E2E,
    settings,
    ...(parent === undefined ? {} : { parent }),
    beforeClose: (win) => {
      if (!closeBroker.shouldHold(win.id)) return true;
      void closeBroker
        .askWindow(win.id, () => {
          sendTo(win, 'window:closeRequested', { reason: 'window' });
        })
        .then((allowed) => {
          // The renderer answers through `window:confirmClose`, which closes the window itself.
          // This is the other way out: the broker gave up waiting, and the window must still go —
          // a renderer that has stopped answering may not leave a window that cannot be closed.
          if (allowed && !win.isDestroyed()) win.close();
        });
      return false;
    },
    onClosed: (windowId) => {
      closeBroker.forget(windowId);
      watchers.release(windowId);
      searches.release(windowId);
    },
  };
}

/** Opens another window; `path` (if any) is loaded once its renderer is up (tab drag-out). */
function openWindow(path: string | undefined, from: BrowserWindow | null): void {
  const win = createMainWindow(windowOptions(from));
  if (path !== undefined) {
    win.webContents.once('did-finish-load', () => {
      void openPathIn(win, path);
    });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const recent = new RecentFiles();
const settings = new Settings();
const closeBroker = new CloseBroker();
const watchers = new FileWatchers((path) => {
  broadcast('file:changedOnDisk', { path });
});
const printJobs = new PrintJobs();
const searches = new FolderSearches();
const webpdf = new WebPdfPrinter();
let recovery: RecoveryStore | null = null;

/**
 * Quit is held back the same way a window close is (M21), and only while a window has reported
 * unsaved work — a clean app quits at once, and so does one whose renderer has stopped answering
 * (the broker gives up after five seconds).
 */
app.on('before-quit', (event) => {
  if (closeBroker.quitApproved || !closeBroker.anyUnsaved) return;
  const win = getMainWindow();
  if (!win) return;
  event.preventDefault();
  void closeBroker
    .askQuit(() => {
      sendTo(win, 'app:quitRequested', {});
    })
    .then((allowed) => {
      // As above: the renderer normally answers through `app:confirmQuit`, and this is what
      // happens when it does not answer at all. Quitting must never depend on it.
      if (allowed) app.quit();
    });
});

app.on('will-quit', () => {
  webpdf.dispose();
  void watchers.closeAll();
  printJobs.disposeAll();
  searches.disposeAll();
  // Temporary copies of attachments the reader opened in another application (M12, ADR 0011).
  void cleanTempFiles();
});

app.on('second-instance', (_event, argv) => {
  const win = getMainWindow();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  for (const p of pdfPathsFromArgv(argv)) void openPathInRenderer(p);
});

// macOS: file association / drag onto the Dock icon.
app.on('open-file', (event, path) => {
  event.preventDefault();
  void openPathInRenderer(path);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || E2E) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void boot();
});

async function boot(): Promise<void> {
  createMainWindow(windowOptions());
  buildMenu(recent);
  // Anything main is holding for the renderer is flushed when the renderer says it is ready
  // (`app:ready`), not when the document finishes loading. See `onRendererReady`.
  await Promise.resolve();
}

if (gotLock) {
  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.ynotpdf.app');
    // Native chrome (Windows title bar, menu bar, dialogs) follows the *app's* theme, never the
    // OS setting. Read the saved theme here so the window opens in the right chrome; the
    // renderer confirms it through `theme:setNative` once ThemeManager has applied the theme.
    nativeTheme.themeSource = settings.get(THEME_KEY) === 'daylight' ? 'light' : 'dark';
    recovery = new RecoveryStore(app.getPath('userData'));
    if (process.env['YNOT_E2E'] === '1') installTestFileGrants(recent);
    registerIpcHandlers(recent, settings, {
      onOpenPath: openPathInRenderer,
      onRendererReady: () => {
        // A PDF from the command line or a file association waits here.
        //
        // This used to hang off `did-finish-load`, which fires when the *document* has loaded —
        // while the renderer's entry module still has a theme to read, a shell to mount and its
        // IPC listeners to install, all behind `await`s. The push landed before anything was
        // listening and the app opened empty: intermittently, which is why it survived (M04,
        // 2026-09-10). The renderer now says so itself, once, at the end of its boot.
        rendererReady = true;
        for (const p of pendingOpens.splice(0)) void openPathInRenderer(p);
      },
      rebuildMenu: () => {
        buildMenu(recent);
      },
      openWindow,
      watchers,
      recovery,
      closeBroker,
      printJobs,
      searches,
      webpdf,
    });
    pendingOpens.push(...pdfPathsFromArgv(process.argv));
    await boot();
  });
}
