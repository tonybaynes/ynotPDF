/**
 * The app's own version.
 *
 * `app.getVersion()` answers with **Electron's** version whenever the app is not packaged, so a
 * development run's About dialog claimed to be ynotPDF 44.2.0 (2026-09-10) — and there is no
 * package.json beside `out/main` to read instead. `__APP_VERSION__` is baked in by
 * `electron.vite.config.ts` from the real package.json, which is true in every launch mode.
 */

import { app } from 'electron';

declare const __APP_VERSION__: string | undefined;

export function appVersion(): string {
  if (app.isPackaged) return app.getVersion();
  return typeof __APP_VERSION__ === 'string' && __APP_VERSION__ !== ''
    ? __APP_VERSION__
    : app.getVersion();
}
