/**
 * Playwright harness (M00). Launches the built app (`out/main/index.js`) with `YNOT_E2E=1`
 * so the renderer installs `window.__ynot`, and exposes `run(commandId, args)` — every later
 * module's e2e goes through this.
 *
 * ```ts
 * const app = await launchApp();
 * await app.run('app.about');
 * await expect(app.page.locator('#about-dialog')).toBeVisible();
 * await app.close();
 * ```
 * Set `YNOT_E2E_EXECUTABLE` to a packaged binary to test the installer output instead.
 *
 * M04 added what a *startup* test needs, because the five defects the operator found by hand
 * all lived in paths the suite never took: a launch with no demo module ({@link
 * LaunchOptions.noDemo}), a profile seeded with settings ({@link LaunchOptions.settings}), a
 * document on the command line ({@link LaunchOptions.open}), and a window of a chosen size
 * ({@link LaunchOptions.window}).
 */

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { realpathSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SCHEMA_VERSION, unflatten, VERSION_KEY } from '../../src/shared/settings';
import type { YnotTestApi } from '../../src/shared/testApi';

/** A window size for {@link LaunchOptions.window} and {@link App.resize}. */
export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

export interface App {
  readonly electron: ElectronApplication;
  readonly page: Page;
  /** The user-data directory this launch is using (settings, recovery records). */
  readonly userData: string;
  /** Run a registered command by id in the renderer. */
  run(commandId: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Explicitly approves a staged test file or existing output folder, like a native dialog. */
  grantPath(path: string, folder?: boolean): Promise<string>;
  /** All registered command ids. */
  commands(): Promise<string[]>;
  /** Whether a command's `when` clause and permission allow it right now (M70). */
  isEnabled(commandId: string): Promise<boolean>;
  /**
   * Resizes until the renderer's viewport is exactly `size`, and waits for the layout (M04).
   *
   * The viewport, not the window: `setContentSize` and `getContentBounds` disagree by the frame
   * on some platforms — asking for 1280x800 here gives a renderer 1294x836 — and the number the
   * layout actually uses is `window.innerWidth`. A matrix that quietly tests a size nobody asked
   * for is worse than no matrix.
   */
  resize(size: WindowSize): Promise<void>;
  /** The size the renderer's layout sees — `window.innerWidth` × `innerHeight` (M04). */
  viewportSize(): Promise<WindowSize>;
  close(): Promise<void>;
}

/** Options for {@link launchApp}. */
export interface LaunchOptions {
  /**
   * Reuse the previous launch's user-data directory instead of a fresh one, so persisted
   * settings (theme, UI scale, recent files) survive a restart within one test file (M01).
   */
  readonly reuseUserData?: boolean;
  /**
   * Launch without the e2e demo module (M04). The demo module registers two left panels that
   * sort before M12's, so a fresh profile opens `demo.alpha` and the panel a *reader's* fresh
   * profile opens — Pages — is never mounted. That is where defect 2 hid: M12's Pages panel
   * came up as "the navigation panels are not available" for a month and no test could see it.
   */
  readonly noDemo?: boolean;
  /**
   * Settings written into the profile before the app starts, as flat dotted keys
   * (`'ui.leftPaneOnOpen': 'bookmarks'`, `'ui.scale': 150`, `'theme.name': 'daylight'`).
   * This is how a startup path is tested: the value has to be there *before* the first paint,
   * which running a command afterwards cannot reproduce.
   */
  readonly settings?: Readonly<Record<string, unknown>>;
  /** Absolute paths of PDFs to put on the command line, as a file association would (M04). */
  readonly open?: ReadonlyArray<string>;
  /** Content size to give the window once it exists (M04's scale/window matrix). */
  readonly window?: WindowSize;
}

/** Opens counted so far, so {@link fixturePath} can hand out a fresh path each time. */
let opens = 0;

/**
 * A synthetic path for a fixture opened by its bytes — **a different one every call**.
 *
 * A document opened by bytes still needs a path, because that is what the app keys a document
 * by, and M11 remembers where the reader left a document *by path*. A helper that defaults to
 * `C:/fixtures/<name>` therefore hands every test that opens `multipage.pdf` the same document
 * identity: the second test starts where the first one finished. It cost M60 a morning —
 * "two pages on from the start" reached page 4 — and it was never a macOS problem, it just
 * showed up there first (2026-09-11).
 *
 * Sharing a path is a fine thing to *ask* for: `viewer.spec.ts` does it deliberately to prove
 * the reader comes back to where they left a document. Ask by passing an explicit path. What
 * this removes is sharing nobody asked for.
 */
export function fixturePath(name: string): string {
  opens += 1;
  return `C:/fixtures/${String(opens)}/${name}`;
}

/** The user-data dir of the most recent launch, for `reuseUserData`. */
let lastUserData: string | undefined;

/** Every profile this worker has created, removed when the worker exits. */
const createdProfiles = new Set<string>();
let cleanupInstalled = false;

/**
 * A fresh Electron profile that will not outlive the test run.
 *
 * Nothing removed these before: every `launchApp()` left a `ynot-e2e-*` directory in the OS
 * temp folder, a full Electron profile each, and a day of module work left a thousand of them
 * and two gigabytes behind. They are removed when the worker process exits rather than when
 * the app closes, because `reuseUserData` needs a profile to survive its first close — a test
 * that checks a setting persists across a restart launches twice into the same directory.
 * `exit` handlers have to be synchronous, which `rmSync` is; a worker killed outright still
 * leaves its profiles, which is no worse than before.
 */
function newUserData(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ynot-e2e-')));
  createdProfiles.add(dir);
  if (!cleanupInstalled) {
    cleanupInstalled = true;
    process.on('exit', () => {
      for (const profile of createdProfiles) {
        rmSync(profile, { recursive: true, force: true });
      }
    });
  }
  return dir;
}

/**
 * Writes `settings.json` into a profile before the app opens it. `electron-store` reads dotted
 * keys as paths, so the flat record goes through the same `unflatten` the app's own import uses.
 */
function seedSettings(userData: string, settings: Readonly<Record<string, unknown>>): void {
  const record = { [VERSION_KEY]: SCHEMA_VERSION, ...settings };
  writeFileSync(join(userData, 'settings.json'), JSON.stringify(unflatten(record), null, 2));
}

/**
 * Waits for two animation frames — one for a change to land, one for the layout it causes.
 *
 * With a deadline, because an invisible window is one Chromium may decide nobody is looking at,
 * and a backgrounded renderer runs `requestAnimationFrame` once a second. The launch switches
 * are meant to stop that; this makes sure a regression there costs a test its accuracy rather
 * than the whole run its time.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const timer = setTimeout(done, 500);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(timer);
            done();
          }),
        );
      }),
  );
}

export async function launchApp(options: LaunchOptions = {}): Promise<App> {
  const userData =
    options.reuseUserData && lastUserData !== undefined ? lastUserData : newUserData();
  lastUserData = userData;
  if (options.settings) seedSettings(userData, options.settings);
  const executable = process.env['YNOT_E2E_EXECUTABLE'];
  const app = await electron.launch({
    ...(executable ? { executablePath: executable } : {}),
    args: [
      ...(executable ? [] : [resolve('out/main/index.js')]),
      `--user-data-dir=${userData}`,
      '--no-sandbox',
      ...(options.open ?? []),
    ],
    env: {
      ...process.env,
      YNOT_E2E: '1',
      ...(options.noDemo ? { YNOT_E2E_NO_DEMO: '1' } : {}),
      ELECTRON_ENABLE_LOGGING: '1',
    },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__ynot?.run === 'function', undefined, {
    timeout: 30_000,
  });

  const viewport = (): Promise<WindowSize> =>
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));

  const setContentSize = async (size: WindowSize): Promise<void> => {
    const before = await viewport();
    await app.evaluate(({ BrowserWindow }, wanted) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('no window to resize');
      win.setContentSize(wanted.width, wanted.height);
    }, size);
    // Wait for the *renderer* to report a different size, by polling rather than by counting
    // frames: a window Chromium believes nobody is looking at runs `requestAnimationFrame` once
    // a second, and two frames of patience then means reading a stale `innerWidth` and
    // "correcting" by a delta that was never real. A size that does not change at all falls
    // through on the timeout, and the caller tries again.
    await page
      .waitForFunction(
        (was: { w: number; h: number }) =>
          window.innerWidth !== was.w || window.innerHeight !== was.h,
        { w: before.width, h: before.height },
        { timeout: 3000, polling: 50 },
      )
      .catch(() => undefined);
    await settle(page);
  };

  /**
   * Asks for a content size, sees what the renderer got, and corrects by the difference.
   *
   * `setContentSize(1280, 800)` leaves a 1294x836 viewport here — the window frame, which
   * `getContentBounds` then reports as content anyway. Rather than assume a frame size per
   * platform, this measures the error once and takes it off the next request.
   */
  const resize = async (size: WindowSize): Promise<void> => {
    if (JSON.stringify(await viewport()) === JSON.stringify(size)) return;
    let ask = size;
    for (let attempt = 0; attempt < 4; attempt++) {
      await setContentSize(ask);
      const got = await viewport();
      if (got.width === size.width && got.height === size.height) return;
      ask = {
        width: ask.width + (size.width - got.width),
        height: ask.height + (size.height - got.height),
      };
    }
  };
  if (options.window) await resize(options.window);

  return {
    electron: app,
    page,
    userData,
    grantPath: (path, folder = false) =>
      app.evaluate(
        ({ BrowserWindow }, request) => {
          const win = BrowserWindow.getAllWindows()[0];
          const hook = (
            globalThis as unknown as {
              __ynotGrantTestPath?: (id: number, path: string, folder: boolean) => string;
            }
          ).__ynotGrantTestPath;
          if (!win || !hook) throw new Error('Test file-grant hook is unavailable');
          return hook(win.id, request.path, request.folder);
        },
        { path, folder },
      ),
    run: (id, args) =>
      page.evaluate(
        ([cid, cargs]) => {
          const api: YnotTestApi | undefined = window.__ynot;
          if (!api) throw new Error('window.__ynot missing (not an e2e build?)');
          return api.run(cid, cargs);
        },
        [id, args ?? {}] as const,
      ),
    isEnabled: (id) =>
      page.evaluate((cid) => {
        const api: YnotTestApi | undefined = window.__ynot;
        if (!api) throw new Error('window.__ynot missing (not an e2e build?)');
        return api.isEnabled(cid);
      }, id),
    commands: () =>
      page.evaluate(() => {
        const api: YnotTestApi | undefined = window.__ynot;
        return api ? api.commands() : [];
      }),
    resize,
    viewportSize: viewport,
    close: () => app.close(),
  };
}
