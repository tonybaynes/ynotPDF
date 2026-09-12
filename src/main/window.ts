import { fileCapabilities } from './fs/capabilities';
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
  /**
   * Asked before the window closes (M21). Returning `false` holds the close back while the
   * renderer offers Save / Don't save / Cancel; it closes the window itself when the reader
   * agrees. Absent means the window always closes.
   */
  readonly beforeClose?: (win: BrowserWindow) => boolean;
  /** The window has gone, so whoever was tracking it can let go (M21). */
  readonly onClosed?: (windowId: number) => void;
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
  // A test run must not take over the machine. Playwright drives the renderer over the debug
  // protocol, not through real OS input, so a test window needs no screen at all: it is parked
  // off every display, made transparent, kept out of the taskbar, and shown *inactive* so it
  // never steals the keyboard from whatever the operator is doing on whichever desktop they are
  // on (2026-09-10). Set YNOT_E2E_VISIBLE=1 to watch a run instead.
  const hidden = options.e2e && process.env['YNOT_E2E_VISIBLE'] !== '1';
  /*
   * …but only where hiding a window and keeping it *drawing* are compatible, and on X11 they are
   * not.
   *
   * `requestAnimationFrame` is driven by the compositor, and the compositor produces frames for a
   * surface that is actually on a screen. Park a window at −32000 on Windows or macOS and Chromium
   * keeps drawing it anyway; do the same under X11 and the frames stop — about two a second, from
   * a fallback timer — while the page still cheerfully reports itself visible, which is what makes
   * it so hard to see. Seven Linux tests failed that way on 2026-09-10: a frame-rate acceptance
   * measuring 1.19 fps against a floor of 30, a drag that never reached its target, a find that
   * highlighted nothing, a `ResizeObserver` that never fired, a dialog that never closed.
   *
   * So on Linux the window stays where it is. It is still kept out of the taskbar and still shown
   * *inactive*, so it never takes the keyboard from anyone; and on a CI runner it is drawn into
   * Xvfb, a virtual screen with nobody in front of it, which is the isolation that matters there.
   *
   * **And the same reasoning retires it on macOS.** Parking exists for one machine: Tony's
   * Windows PC, which he works on while a suite runs. Every other place the suite runs — the
   * macOS, Linux and ARM runners — has nobody sitting in front of it, so a window on screen
   * interrupts no one (Tony, 2026-09-11).
   *
   * macOS would not have obliged in any case. It clamps a window back into the visible frame:
   * one asking for -32000,-32000 reported **0,31** in CI, full size over the desktop and hidden
   * only by its opacity — and a transparent window still takes mouse clicks. Fighting the OS to
   * hide a window nobody is looking at was cost without benefit, so this is Windows only.
   */
  const parkOffScreen = hidden && process.platform === 'win32';
  const win = new BrowserWindow({
    width: cascade?.width ?? bounds.width,
    height: cascade?.height ?? bounds.height,
    ...(parkOffScreen
      ? { x: -32_000, y: -32_000 }
      : cascade
        ? { x: cascade.x + 40, y: cascade.y + 40 }
        : saved
          ? { x: bounds.x, y: bounds.y }
          : {}),
    minWidth: 720,
    minHeight: 480,
    show: false,
    skipTaskbar: hidden,
    title: 'ynotPDF',
    // There is no application menu off macOS (see main/menu.ts): the ribbon's tab row is the
    // only tab row. `true` keeps Alt from summoning a menu bar that should not exist.
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // A test window is off-screen and never focused, and Chromium's answer to that is to
      // throttle the renderer's timers and animation frames. Playwright drives a *running*
      // application, so this run keeps them. See the occlusion note in `main/index.ts`.
      ...(options.e2e ? { backgroundThrottling: false } : {}),
      // `--ynot-e2e-no-demo` leaves the demo module out so a run takes the real startup path
      // (M04): the panel a fresh profile opens is then M12's, not the demo's.
      additionalArguments: options.e2e
        ? process.env['YNOT_E2E_NO_DEMO'] === '1'
          ? ['--ynot-e2e', '--ynot-e2e-no-demo']
          : ['--ynot-e2e']
        : [],
    },
  });
  windows.add(win);
  if (saved?.maximized) win.maximize();
  if (options.settings && !options.parent) rememberWindowBounds(win, options.settings);

  win.once('ready-to-show', () => {
    if (parkOffScreen) {
      // Transparent as well as off-screen: a display the operator plugs in later must not
      // suddenly show a test window. (`setOpacity` is a Windows and macOS API, which is the
      // other reason this branch is not taken on Linux.)
      win.setOpacity(0);
      win.showInactive();
      return;
    }
    // `showInactive` keeps the DOM focusable without taking the OS focus, which the focus-order
    // tests still need. On Linux this is the whole of the treatment — see `parkOffScreen`.
    if (hidden) {
      win.showInactive();
      return;
    }
    win.show();
  });
  // Unsaved work: the renderer is the only place that knows about it and the only place that can
  // ask, so the close waits for its answer (M21). `beforeClose` says `true` when there is nothing
  // to ask about, which is every window until a document is edited.
  if (options.beforeClose) {
    const beforeClose = options.beforeClose;
    win.on('close', (event) => {
      if (win.isDestroyed()) return;
      if (beforeClose(win)) return;
      event.preventDefault();
    });
  }
  win.on('closed', () => {
    fileCapabilities.clear(win.id);
    windows.delete(win);
    options.onClosed?.(win.id);
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
