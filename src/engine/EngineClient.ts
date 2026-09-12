/**
 * `EngineClient` — the renderer-side proxy to the engine Worker.
 *
 * Usage:
 * ```ts
 * const client = EngineClient.spawn();        // starts src/engine/worker.ts
 * const doc = await client.engine.open(bytes);
 * const { bitmap } = await client.engine.render(doc, 0, 2);
 * ```
 * Every `PdfEngine` method is forwarded as a request over `postMessage`; results come back by
 * id. `ImageBitmap` / `ArrayBuffer` payloads are transferred, not copied. Rejections arrive as
 * `EngineError` with the original `code`.
 *
 * M10 (ADR 0005): `request()` returns a cancellable handle and `cancelRenders()` drops every
 * pending render — the viewer calls it on scroll so superseded tiles never reach PDFium.
 */

import {
  ENGINE_METHODS,
  EngineError,
  type DocHandle,
  type EngineMethod,
  type PdfEngine,
  type ProgressCallback,
} from './PdfEngine';
import { collectTransferables, type RpcFromWorker, type RpcRequest, type RpcToWorker } from './rpc';

/**
 * One engine method as a callable type. `PdfEngine` has optional methods since M33 (ADR 0018),
 * and `Parameters<T>` refuses a `T` that may be `undefined` — the proxy forwards every method by
 * name whether the backend implements it or not, so the union is narrowed here.
 */
type EngineFn<M extends EngineMethod> = NonNullable<PdfEngine[M]>;

interface Pending {
  readonly method: EngineMethod;
  /** Document handle of the call, when its first argument is one. */
  readonly doc: number | undefined;
  resolve(value: unknown): void;
  reject(error: Error): void;
  progress?: ProgressCallback | undefined;
}

/** A request in flight. `cancel()` rejects it with `EngineError('cancelled')`. */
export interface RequestHandle<T> {
  readonly id: number;
  readonly promise: Promise<T>;
  cancel(): void;
}

/** Minimal worker surface we rely on (so tests can pass a fake). */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (ev: ErrorEvent) => void): void;
  removeEventListener?(type: 'message', listener: (ev: MessageEvent) => void): void;
  removeEventListener?(type: 'error', listener: (ev: ErrorEvent) => void): void;
  terminate(): void;
}

export class EngineClient {
  private readonly worker: WorkerLike;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly readyPromise: Promise<void>;
  private terminated = false;
  private failure: EngineError | null = null;
  private resolveReady: () => void = () => undefined;
  private rejectReady: (error: Error) => void = () => undefined;
  private readonly onMessage = (ev: MessageEvent): void => {
    if (this.terminated) return;
    const msg = ev.data as RpcFromWorker;
    if (msg.kind === 'ready') this.resolveReady();
    else this.dispatch(msg);
  };
  private readonly onError = (ev: ErrorEvent): void => {
    this.stop(new EngineError('internal', `engine worker crashed: ${ev.message}`));
  };

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
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Failure may precede the first ready() caller. Preserve rejection without an unhandled one.
    void this.readyPromise.catch(() => undefined);
    worker.addEventListener('message', this.onMessage);
    worker.addEventListener('error', this.onError);
    this.engine = this.buildProxy();
  }

  /** Resolves once the worker has signalled readiness. */
  ready(): Promise<void> {
    return this.failure ? Promise.reject(this.failure) : this.readyPromise;
  }

  /** Number of requests awaiting a reply. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Stops the worker. All in-flight calls reject. */
  terminate(): void {
    this.stop(new EngineError('internal', 'engine client terminated'));
  }

  private stop(error: EngineError): void {
    if (this.terminated) return;
    this.terminated = true;
    this.failure = error;
    this.worker.removeEventListener?.('message', this.onMessage);
    this.worker.removeEventListener?.('error', this.onError);
    this.rejectReady(error);
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.worker.terminate();
  }

  /** Low-level call. Prefer the typed `engine` proxy. */
  call<M extends EngineMethod>(
    method: M,
    args: Parameters<EngineFn<M>>,
  ): Promise<Awaited<ReturnType<EngineFn<M>>>> {
    return this.request(method, args).promise;
  }

  /** Like {@link call} but returns a handle that can cancel the request (ADR 0005). */
  request<M extends EngineMethod>(
    method: M,
    args: Parameters<EngineFn<M>>,
  ): RequestHandle<Awaited<ReturnType<EngineFn<M>>>> {
    const id = this.nextId++;
    if (this.terminated) {
      return {
        id,
        promise: Promise.reject(
          this.failure ?? new EngineError('internal', 'engine client terminated'),
        ),
        cancel: () => undefined,
      };
    }
    // A trailing function argument is a progress callback: keep it here, do not post it.
    const plainArgs = [...(args as ReadonlyArray<unknown>)];
    let progress: ProgressCallback | undefined;
    const last = plainArgs[plainArgs.length - 1];
    if (typeof last === 'function') {
      progress = last as ProgressCallback;
      plainArgs.pop();
    }
    const request: RpcRequest = { kind: 'request', id, method, args: plainArgs };
    const first = plainArgs[0];
    const promise = new Promise<Awaited<ReturnType<EngineFn<M>>>>((resolve, reject) => {
      this.pending.set(id, {
        method,
        doc: typeof first === 'number' && method !== 'info' ? first : undefined,
        resolve,
        reject,
        progress,
      });
      try {
        this.worker.postMessage(request, collectTransferables(plainArgs));
      } catch (error) {
        this.stop(
          new EngineError('internal', error instanceof Error ? error.message : String(error)),
        );
      }
    });
    return {
      id,
      promise,
      cancel: () => {
        this.cancel(id);
      },
    };
  }

  /** Cancels one request. No-op when it already settled. */
  cancel(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    const msg: RpcToWorker = { kind: 'cancel', id };
    p.reject(new EngineError('cancelled', `${p.method} was cancelled`));
    if (!this.terminated) {
      try {
        this.worker.postMessage(msg);
      } catch (error) {
        this.stop(
          new EngineError('internal', error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  /** Cancels every pending render (optionally only those of `doc`). Returns how many. */
  cancelRenders(doc?: DocHandle): number {
    let n = 0;
    for (const [id, p] of [...this.pending]) {
      if (p.method !== 'render') continue;
      if (doc !== undefined && p.doc !== doc) continue;
      this.cancel(id);
      n++;
    }
    return n;
  }

  private dispatch(msg: RpcFromWorker): void {
    if (msg.kind === 'ready') return;
    const p = this.pending.get(msg.id);
    if (!p) {
      // Cancelled locally after the worker finished: release any bitmap it sent.
      if (msg.kind === 'ok') closeBitmaps(msg.result);
      return;
    }
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
        this.call(method, args as Parameters<EngineFn<typeof method>>);
    }
    return proxy as unknown as PdfEngine;
  }
}

function closeBitmaps(value: unknown): void {
  if (typeof ImageBitmap === 'undefined') return;
  if (value instanceof ImageBitmap) value.close();
  else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) closeBitmaps(v);
  }
}
