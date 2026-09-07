/**
 * Engine Worker entry. Serves a `PdfEngine` over the RPC protocol in `rpc.ts`.
 *
 * M10: `createEngine()` builds the PDFium adapter (wasm + fonts come from `worker-assets.ts`,
 * loaded lazily so unit tests that import `serveEngine` never touch the 4 MB binary). Requests
 * are executed **one at a time** — PDFium is not re-entrant — from a queue, with a macrotask
 * yield between them so `cancel` messages are seen even when every render is short. A cancel
 * drops a queued request, marks the in-flight one (and aborts it when the engine supports
 * `cancelCurrent`), and either way the caller gets `EngineError('cancelled')`.
 */

import { EngineError, type PdfEngine } from './PdfEngine';
import { collectTransferables, type RpcFromWorker, type RpcRequest, type RpcToWorker } from './rpc';
import { yieldMacrotask } from './yield';

/** Engines that can abort the request currently executing. */
interface Cancellable {
  cancelCurrent(): void;
}

function isCancellable(engine: PdfEngine): engine is PdfEngine & Cancellable {
  return typeof (engine as Partial<Cancellable>).cancelCurrent === 'function';
}

/** Factory for the engine this worker serves: the PDFium adapter (M10). */
export async function createEngine(): Promise<PdfEngine> {
  const { loadEngineAssets } = await import('./worker-assets');
  const { PdfiumEngine } = await import('./pdfium/PdfiumEngine');
  const assets = await loadEngineAssets();
  return PdfiumEngine.create(assets);
}

export interface EnginePort {
  postMessage(message: RpcFromWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<RpcToWorker>) => void): void;
}

/**
 * Wires an engine to a message port. Exported so it can be unit-tested with a fake port.
 * Accepts a promise so the worker can start receiving (and queueing) while PDFium boots.
 */
export function serveEngine(
  engineOrPromise: PdfEngine | Promise<PdfEngine>,
  port: EnginePort,
): void {
  const queue: RpcRequest[] = [];
  const cancelled = new Set<number>();
  let engine: PdfEngine | null = null;
  let current: RpcRequest | null = null;
  let pumping = false;

  const fail = (id: number, error: unknown): void => {
    const e =
      error instanceof EngineError
        ? error
        : new EngineError('internal', error instanceof Error ? error.message : String(error));
    port.postMessage({ kind: 'fail', id, error: { code: e.code, message: e.message } });
  };

  const run = async (req: RpcRequest, eng: PdfEngine): Promise<void> => {
    const progress = (fraction: number): void => {
      port.postMessage({ kind: 'progress', id: req.id, fraction });
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked with Reflect.apply(engine) below
    const fn = eng[req.method] as (...args: unknown[]) => Promise<unknown>;
    const args = req.method === 'save' ? [...req.args, progress] : [...req.args];
    try {
      const result: unknown = await Reflect.apply(fn, eng, args);
      port.postMessage({ kind: 'ok', id: req.id, result }, collectTransferables(result));
    } catch (error) {
      fail(req.id, error);
    }
  };

  const pump = async (): Promise<void> => {
    if (pumping || !engine) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        const req = queue.shift();
        if (!req) break;
        current = req;
        // Let cancel messages (macrotasks) arrive between requests.
        await yieldMacrotask();
        if (cancelled.has(req.id)) {
          cancelled.delete(req.id);
          fail(req.id, new EngineError('cancelled', `${req.method} was cancelled`));
          current = null;
          continue;
        }
        await run(req, engine);
        cancelled.delete(req.id);
        current = null;
      }
    } finally {
      pumping = false;
    }
  };

  port.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.kind === 'request') {
      queue.push(msg);
      void pump();
      return;
    }
    if (msg.kind === 'cancel') {
      const at = queue.findIndex((r) => r.id === msg.id);
      if (at >= 0) {
        const [dropped] = queue.splice(at, 1);
        if (dropped) {
          fail(dropped.id, new EngineError('cancelled', `${dropped.method} was cancelled`));
        }
        return;
      }
      if (current?.id === msg.id) {
        cancelled.add(msg.id);
        if (engine && isCancellable(engine)) engine.cancelCurrent();
      }
    }
  });

  Promise.resolve(engineOrPromise).then(
    (eng) => {
      engine = eng;
      port.postMessage({ kind: 'ready' });
      void pump();
    },
    (error: unknown) => {
      // Boot failure: every queued (and future) request fails with the boot error.
      const message = error instanceof Error ? error.message : String(error);
      engine = new Proxy({} as PdfEngine, {
        get: () => () =>
          Promise.reject(new EngineError('internal', `engine failed to start: ${message}`)),
      });
      port.postMessage({ kind: 'ready' });
      void pump();
    },
  );
}

// Only run when actually loaded as a Worker (no `window`; not when imported by unit tests).
if (
  typeof window === 'undefined' &&
  typeof self !== 'undefined' &&
  typeof document === 'undefined'
) {
  serveEngine(createEngine(), self as unknown as EnginePort);
}
