/**
 * `EngineClient` — the renderer-side proxy to the engine Worker (M00 shell).
 *
 * Usage:
 * ```ts
 * const engine = EngineClient.spawn();        // starts src/engine/worker.ts
 * const doc = await engine.open(bytes);
 * const { bitmap } = await engine.render(doc, 0, 2);
 * ```
 * Every `PdfEngine` method is forwarded as a request over `postMessage`; results come back by
 * id. `ImageBitmap` / `ArrayBuffer` payloads are transferred, not copied. Rejections arrive as
 * `EngineError` with the original `code`.
 */

import {
  ENGINE_METHODS,
  EngineError,
  type EngineMethod,
  type PdfEngine,
  type ProgressCallback,
} from './PdfEngine';
import { collectTransferables, type RpcFromWorker, type RpcRequest } from './rpc';

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  progress?: ProgressCallback | undefined;
}

/** Minimal worker surface we rely on (so tests can pass a fake). */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (ev: ErrorEvent) => void): void;
  terminate(): void;
}

export class EngineClient {
  private readonly worker: WorkerLike;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly readyPromise: Promise<void>;
  private terminated = false;

  /** The typed engine proxy. Call `PdfEngine` methods on it directly. */
  readonly engine: PdfEngine;

  /** Spawns the module worker built from `src/engine/worker.ts`. */
  static spawn(): EngineClient {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'ynot-engine',
    });
    return new EngineClient(worker);
  }

  constructor(worker: WorkerLike) {
    this.worker = worker;
    this.readyPromise = new Promise<void>((resolve) => {
      worker.addEventListener('message', (ev: MessageEvent) => {
        const msg = ev.data as RpcFromWorker;
        if (msg.kind === 'ready') {
          resolve();
          return;
        }
        this.dispatch(msg);
      });
    });
    worker.addEventListener('error', (ev: ErrorEvent) => {
      const error = new EngineError('internal', `engine worker crashed: ${ev.message}`);
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    });
    this.engine = this.buildProxy();
  }

  /** Resolves once the worker has signalled readiness. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Stops the worker. All in-flight calls reject. */
  terminate(): void {
    this.terminated = true;
    this.worker.terminate();
    const error = new EngineError('internal', 'engine client terminated');
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  /** Low-level call. Prefer the typed `engine` proxy. */
  call<M extends EngineMethod>(
    method: M,
    args: Parameters<PdfEngine[M]>,
  ): Promise<Awaited<ReturnType<PdfEngine[M]>>> {
    if (this.terminated) {
      return Promise.reject(new EngineError('internal', 'engine client terminated'));
    }
    const id = this.nextId++;
    // A trailing function argument is a progress callback: keep it here, do not post it.
    const plainArgs = [...(args as ReadonlyArray<unknown>)];
    let progress: ProgressCallback | undefined;
    const last = plainArgs[plainArgs.length - 1];
    if (typeof last === 'function') {
      progress = last as ProgressCallback;
      plainArgs.pop();
    }
    const request: RpcRequest = { kind: 'request', id, method, args: plainArgs };
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve,
        reject,
        progress,
      });
      this.worker.postMessage(request, collectTransferables(plainArgs));
    });
  }

  private dispatch(msg: RpcFromWorker): void {
    if (msg.kind === 'ready') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.kind === 'progress') {
      p.progress?.(msg.fraction);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.kind === 'ok') p.resolve(msg.result);
    else p.reject(new EngineError(msg.error.code, msg.error.message));
  }

  private buildProxy(): PdfEngine {
    const proxy: Record<string, unknown> = {};
    for (const method of ENGINE_METHODS) {
      proxy[method] = (...args: unknown[]) =>
        this.call(method, args as Parameters<PdfEngine[typeof method]>);
    }
    return proxy as unknown as PdfEngine;
  }
}
