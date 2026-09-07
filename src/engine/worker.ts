/**
 * Engine Worker entry (M00). Serves a `PdfEngine` over the RPC protocol in `rpc.ts`.
 * M10 replaces `createEngine()` with the PDFium adapter; nothing else here changes.
 */

import { EngineError, NotImplementedEngine, type PdfEngine } from './PdfEngine';
import { collectTransferables, type RpcFromWorker, type RpcToWorker } from './rpc';

/** Factory for the engine this worker serves. M10: `return new PdfiumEngine()`. */
export function createEngine(): PdfEngine {
  return new NotImplementedEngine();
}

/** Wires an engine to a message port. Exported so it can be unit-tested with a fake port. */
export function serveEngine(
  engine: PdfEngine,
  port: {
    postMessage(message: RpcFromWorker, transfer?: Transferable[]): void;
    addEventListener(type: 'message', listener: (ev: MessageEvent<RpcToWorker>) => void): void;
  },
): void {
  port.addEventListener('message', (ev) => {
    const req = ev.data;
    if (req.kind !== 'request') return;
    const progress = (fraction: number) => {
      port.postMessage({ kind: 'progress', id: req.id, fraction });
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked with Reflect.apply(engine) below
    const fn = engine[req.method] as (...args: unknown[]) => Promise<unknown>;
    const args = req.method === 'save' ? [...req.args, progress] : [...req.args];
    Promise.resolve()
      .then(() => Reflect.apply(fn, engine, args))
      .then(
        (result) => {
          port.postMessage({ kind: 'ok', id: req.id, result }, collectTransferables(result));
        },
        (error: unknown) => {
          const e =
            error instanceof EngineError
              ? error
              : new EngineError('internal', error instanceof Error ? error.message : String(error));
          port.postMessage({
            kind: 'fail',
            id: req.id,
            error: { code: e.code, message: e.message },
          });
        },
      );
  });
  port.postMessage({ kind: 'ready' });
}

// Only run when actually loaded as a Worker (no `window`; not when imported by unit tests).
if (
  typeof window === 'undefined' &&
  typeof self !== 'undefined' &&
  typeof document === 'undefined'
) {
  serveEngine(createEngine(), self as unknown as Parameters<typeof serveEngine>[1]);
}
