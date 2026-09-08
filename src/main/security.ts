/**
 * Document security, in the main process (M70, ADR 0011).
 *
 * qpdf runs here rather than in a renderer Worker, and the reason is not architectural taste —
 * the Worker was built first and does not survive contact with Electron. This build of qpdf-wasm
 * has had its `wasmBinary` option minified away and honours only `locateFile`, so in a renderer it
 * must be handed a URL and will always go and load it; and in an Electron renderer, whose origin
 * is `file://`, every way of doing that ends with the **renderer process dying outright** —
 * `render-process-gone`, exit code 143, no exception to catch and no window left. Main is a Node
 * environment: the module's own default reads `qpdf.wasm` off disk (out of `app.asar` in a
 * packaged build, which `fs` handles), there is no fetch, no blob, no worker and no CSP.
 *
 * It is also where the rest of the app wants it. M120's batch runs and M121's command line have
 * no window at all, and the file system they work over is already main's.
 *
 * The renderer reaches this through the typed `security:*` channels in `src/shared/ipc.ts`,
 * exactly as it reaches `file:writeAtomic`. Bytes cross once per operation, which is the same
 * crossing a save already makes.
 */

import { createRequire } from 'node:module';
import { Security } from '../engine/security/Security';
import { Qpdf, type QpdfFactory } from '../engine/security/qpdf';

const require_ = createRequire(import.meta.url);

let cached: Security | null = null;

/**
 * The one `Security` for this process, built on first use.
 *
 * Lazily, because a session that never opens or writes a protected document should not pay for
 * 1.3 MB of WebAssembly — the same reasoning M21 applies to its writer.
 *
 * No `locateFile`: under Node the module resolves `qpdf.wasm` next to itself, which is correct
 * both from `node_modules` in development and from inside the asar archive in a packaged app.
 */
export function security(): Security {
  cached ??= new Security(
    new Qpdf({ factory: require_('@neslinesli93/qpdf-wasm') as QpdfFactory }),
  );
  return cached;
}
