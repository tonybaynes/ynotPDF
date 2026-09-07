/**
 * e2e harness (M00). Installed ONLY when main was launched with `YNOT_E2E=1` (the preload
 * bridge reports `e2e: true`); never in a normal run. Playwright calls
 * `window.__ynot.run(commandId, args)` to drive the app — see test/e2e/harness.ts.
 */

import type { Registry } from '@core/Registry';
import type { YnotTestApi } from '@shared/testApi';

export function installTestHarness(registry: Registry): void {
  const api: YnotTestApi = {
    run: (id, args) => registry.run(id, args ?? {}),
    commands: () => registry.allCommands().map((c) => c.id),
    has: (id) => registry.has(id),
    isEnabled: (id) => registry.isEnabled(id),
  };
  window.__ynot = api;
}
