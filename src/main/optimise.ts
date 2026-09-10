/**
 * The structural half of optimising, in the main process (M100, ADR 0019).
 *
 * This file is `src/main/security.ts` with a different façade on the front of it, and for exactly
 * the same reason: qpdf ships as WebAssembly that dies if a renderer so much as loads it
 * (ADR 0011), and main is the one place in the app that is an ordinary Node environment.
 *
 * The renderer reaches it through the typed `optimise:*` channels in `src/shared/ipc.ts`. Only
 * what qpdf must do crosses that boundary — object streams, flate recompression, unreferenced
 * objects, linearisation, `--check` and the rewrite a repair falls back to. The image and font
 * work is pure and stays in a renderer Worker, where it costs no IPC at all.
 */

import { createRequire } from 'node:module';
import { QpdfTasks } from '../engine/optimise';
import { Qpdf, type QpdfFactory } from '../engine/security/qpdf';

const require_ = createRequire(import.meta.url);

let cached: QpdfTasks | null = null;

/**
 * The one `QpdfTasks` for this process, built on first use.
 *
 * Lazily, for the reason M70 gives: a session that never optimises or repairs anything should not
 * pay for 1.3 MB of WebAssembly. It gets its own `Qpdf` rather than sharing M70's, because a
 * `Qpdf` serialises its runs behind one queue and a save that is re-encrypting has no business
 * waiting behind an optimise of another document.
 *
 * No `locateFile`: under Node the module resolves `qpdf.wasm` next to itself, which is correct
 * both from `node_modules` in development and from inside the asar archive in a packaged app.
 */
export function optimiseTasks(): QpdfTasks {
  cached ??= new QpdfTasks(
    new Qpdf({ factory: require_('@neslinesli93/qpdf-wasm') as QpdfFactory }),
  );
  return cached;
}
