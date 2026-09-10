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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  /** All registered command ids. */
  commands(): Promise<string[]>;
  /** Whether a command's `when` clause and permission allow it right now (M70). */
  isEnabled(commandId: string): Promise<boolean>;
  /** Resizes the window's *content* area and waits for the renderer to lay out again (M04). */
  resize(size: WindowSize): Promise<void>;
  /** The window's current content size (M04). */
  contentSize(): Promise<WindowSize>;
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
  const dir = mkdtempSync(join(tmpdir(), 'ynot-e2e-'));
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

/** Waits for two animation frames — one for a change to land, one for the layout it causes. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
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

  const resize = async (size: WindowSize): Promise<void> => {
    await app.evaluate(({ BrowserWindow }, wanted) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('no window to resize');
      win.setContentSize(wanted.width, wanted.height);
    }, size);
    await settle(page);
    await page.waitForTimeout(150);
  };
  if (options.window) await resize(options.window);

  return {
    electron: app,
    page,
    userData,
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
    contentSize: () =>
      app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) throw new Error('no window to measure');
        const [width, height] = win.getContentSize();
        return { width: width ?? 0, height: height ?? 0 };
      }),
    close: () => app.close(),
  };
}
