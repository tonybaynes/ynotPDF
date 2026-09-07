/**
 * Electron main entry (M00): single-instance lock, app windows, native menu, IPC handlers,
 * recent files and `.pdf` file-association handling on all three OSes. M02 adds remembered
 * window bounds and a second window for tabs dragged out of the strip.
 */

import { app, BrowserWindow, nativeTheme } from 'electron';
import { registerIpcHandlers } from './ipc';
import { buildMenu } from './menu';
import { RecentFiles } from './recent';
import { Settings, THEME_KEY } from './settings';
import { broadcast, createMainWindow, getMainWindow, sendTo } from './window';
import { readFileForRenderer } from './files';

const E2E = process.env['YNOT_E2E'] === '1';

// Files handed to us before the window is ready (argv on Windows/Linux, open-file on macOS).
const pendingOpens: string[] = [];
let rendererReady = false;

function pdfPathsFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((a) => !a.startsWith('-') && /\.pdf$/i.test(a));
}

async function openPathIn(win: BrowserWindow, path: string): Promise<void> {
  try {
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

/** Opens another window; `path` (if any) is loaded once its renderer is up (tab drag-out). */
function openWindow(path: string | undefined, from: BrowserWindow | null): void {
  const win = createMainWindow({ e2e: E2E, settings, parent: from });
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
  const win = createMainWindow({ e2e: E2E, settings });
  buildMenu(recent);
  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
    for (const p of pendingOpens.splice(0)) void openPathInRenderer(p);
  });
  await Promise.resolve();
}

if (gotLock) {
  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.ynotpdf.app');
    // Native chrome (Windows title bar, menu bar, dialogs) follows the *app's* theme, never the
    // OS setting. Read the saved theme here so the window opens in the right chrome; the
    // renderer confirms it through `theme:setNative` once ThemeManager has applied the theme.
    nativeTheme.themeSource = settings.get(THEME_KEY) === 'daylight' ? 'light' : 'dark';
    registerIpcHandlers(recent, settings, {
      onOpenPath: openPathInRenderer,
      rebuildMenu: () => {
        buildMenu(recent);
      },
      openWindow,
    });
    pendingOpens.push(...pdfPathsFromArgv(process.argv));
    await boot();
  });
}
