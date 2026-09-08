/**
 * M03: the About dialog names the architecture, which is how the operator tells which installer
 * landed on a Windows-on-ARM PC (ADR 0009).
 *
 * Set `YNOT_EXPECT_ARCH` to assert an exact one — the `windows-11-arm` CI job sets `arm64` and
 * drives the *installed* arm64 build (`YNOT_E2E_EXECUTABLE`), so a pass there means the arm64
 * binaries really are running natively rather than emulated.
 */

import { expect, test } from '@playwright/test';
import { launchApp, type App } from './harness';

const PLATFORM_NAMES: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

let app: App;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
});

test('the About dialog names the platform and architecture', async () => {
  await app.run('app.about');
  const platform = app.page.locator('#about-dialog dd[data-field="platform"]');
  await expect(platform).toBeVisible();
  const text = (await platform.textContent())?.trim() ?? '';

  const name = PLATFORM_NAMES[process.platform] ?? process.platform;
  const expected = process.env['YNOT_EXPECT_ARCH'];
  if (expected !== undefined && expected !== '') {
    // Exactly this, with no "(emulated on …)" tail: the right installer, running natively.
    expect(text).toBe(`${name} ${expected}`);
  } else {
    expect(text).toMatch(new RegExp(`^${name} (x64|arm64|ia32)( \\(emulated on \\w+\\))?$`));
  }
  await app.page.keyboard.press('Escape');
});
