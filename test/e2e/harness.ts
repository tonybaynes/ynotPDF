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
import { mkdtempSync } from 'node:fs';
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

export async function launchApp(options: LaunchOptions = {}): Promise<App> {
  const userData =
    options.reuseUserData && lastUserData !== undefined
      ? lastUserData
      : mkdtempSync(join(tmpdir(), 'ynot-e2e-'));
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
    commands: () =>
      page.evaluate(() => {
        const api: YnotTestApi | undefined = window.__ynot;
        return api ? api.commands() : [];
      }),
    close: () => app.close(),
  };
}
