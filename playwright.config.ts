import { defineConfig } from '@playwright/test';

/**
 * Playwright drives the built Electron app (see test/e2e/harness.ts).
 * Run `npm run e2e` (builds first) or `npx playwright test` after `npm run build`.
 */
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
});
