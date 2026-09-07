/**
 * The e2e test API installed on `window.__ynot` — ONLY when the app is launched with
 * `YNOT_E2E=1` (see `src/renderer/app/testHarness.ts` and `test/e2e/harness.ts`).
 */

import type { CommandArgs } from './module';

export interface YnotTestApi {
  /** Run a registered command by id; resolves with the command's return value. */
  run(commandId: string, args?: CommandArgs): Promise<unknown>;
  /** All registered command ids (including hidden ones). */
  commands(): string[];
  has(commandId: string): boolean;
  isEnabled(commandId: string): boolean;
}

declare global {
  interface Window {
    /** Present only in e2e runs. */
    __ynot?: YnotTestApi;
  }
}
