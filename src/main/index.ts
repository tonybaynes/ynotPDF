/**
 * Electron main entry (M00): single-instance lock, one BrowserWindow, native menu, IPC
 * handlers, recent files and `.pdf` file-association handling on all three OSes.
 */

import { app, BrowserWindow, nativeTheme } from 'electron';
import { registerIpcHandlers } from './ipc';
import { buildMenu } from './menu';
import { RecentFiles } from './recent';
import { createMainWindow, getMainWindow, sendToRenderer } from './window';
import { readFileForRenderer } from './files';

const E2E = process.env['YNOT_E2E'] === '1';

// Files handed to us before the window is ready (argv on Windows/Linux, open-file on macOS).
const pendingOpens: string[] = [];
let rendererReady = false;

function pdfPathsFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((a) => !a.startsWith('-') && /\.pdf$/i.test(a));
}

async function openPathInRenderer(path: string): Promise<void> {
  const win = getMainWindow();
  if (!win || !rendererReady) {
    pendingOpens.push(path);
    return;
  }
  try {
    const file = await readFileForRenderer(path);
    recent.add(path);
    sendToRenderer('file:openRequested', file);
    sendToRenderer('recent:changed', recent.list());
    if (win.isMinimized()) win.restore();
    win.focus();
  } catch (error) {
    console.error(`could not open ${path}`, error);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const recent = new RecentFiles();

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
  const win = createMainWindow({ e2e: E2E });
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
    // Native chrome (Windows title bar, menu bar, dialogs) follows the app's dark default,
    // not the OS setting. M01 switches this to 'light' when the Daylight theme is active.
    nativeTheme.themeSource = 'dark';
    registerIpcHandlers(recent, {
      onOpenPath: openPathInRenderer,
      rebuildMenu: () => {
        buildMenu(recent);
      },
    });
    pendingOpens.push(...pdfPathsFromArgv(process.argv));
    await boot();
  });
}
