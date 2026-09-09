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
 */

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { YnotTestApi } from '../../src/shared/testApi';

export interface App {
  readonly electron: ElectronApplication;
  readonly page: Page;
  /** Run a registered command by id in the renderer. */
  run(commandId: string, args?: Record<string, unknown>): Promise<unknown>;
  /** All registered command ids. */
  commands(): Promise<string[]>;
  /** Whether a command's `when` clause and permission allow it right now (M70). */
  isEnabled(commandId: string): Promise<boolean>;
  close(): Promise<void>;
}

/** Options for {@link launchApp}. */
export interface LaunchOptions {
  /**
   * Reuse the previous launch's user-data directory instead of a fresh one, so persisted
   * settings (theme, UI scale, recent files) survive a restart within one test file (M01).
   */
  readonly reuseUserData?: boolean;
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

export async function launchApp(options: LaunchOptions = {}): Promise<App> {
  const userData =
    options.reuseUserData && lastUserData !== undefined ? lastUserData : newUserData();
  lastUserData = userData;
  const executable = process.env['YNOT_E2E_EXECUTABLE'];
  const app = await electron.launch({
    ...(executable ? { executablePath: executable } : {}),
    args: [
      ...(executable ? [] : [resolve('out/main/index.js')]),
      `--user-data-dir=${userData}`,
      '--no-sandbox',
    ],
    env: {
      ...process.env,
      YNOT_E2E: '1',
      ELECTRON_ENABLE_LOGGING: '1',
    },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__ynot?.run === 'function', undefined, {
    timeout: 30_000,
  });
  return {
    electron: app,
    page,
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
    close: () => app.close(),
  };
}
