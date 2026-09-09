/**
 * `OpsClient` — the renderer's end of M41's operations Worker.
 *
 * Same shape as M21's `WriterClient` and M91's `ConvertClient`: a job returns a handle with a
 * promise and a `cancel()`, progress arrives as it happens, and when there is no `Worker` — a
 * unit test in Node — the same functions run in-process, so what the tests exercise is what
 * ships.
 */

import { combine, type CombineOptions, type CombineResult } from '@engine/ops/combine';
import { cropPages, type CropOptions } from '@engine/ops/crop';
import { deskewPages, type DeskewOptions, type DeskewResult } from '@engine/ops/deskew';
import { flatten, type FlattenOptions, type FlattenResult } from '@engine/ops/flatten';
import { split, type SplitOptions, type SplitResult } from '@engine/ops/split';
import {
  OpCancelled,
  OpFailed,
  type OpContext,
  type OpProgress,
  type OpResult,
  type OpSource,
} from '@engine/ops/types';
import type { OpsAnswer, OpsFromWorker, OpsToWorker } from './opsProtocol';

/** Minimal worker surface we rely on, so a test can pass a fake. */
export interface OpsWorkerLike {
  postMessage(message: OpsToWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (ev: ErrorEvent) => void): void;
  terminate(): void;
}

export interface OpHandle<T> {
  readonly promise: Promise<T>;
  cancel(): void;
}

interface Pending {
  resolve(answer: OpsAnswer): void;
  reject(error: Error): void;
  onProgress: OpProgress | undefined;
}

export class OpsClient {
  private readonly worker: OpsWorkerLike | null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  /** Spawns the module worker built from `ops.worker.ts`, or runs in-process without one. */
  static spawn(): OpsClient {
    if (typeof Worker === 'undefined') return new OpsClient(null);
    const worker = new Worker(new URL('./ops.worker.ts', import.meta.url), {
      type: 'module',
      name: 'ynot-ops',
    });
    return new OpsClient(worker);
  }

  constructor(worker: OpsWorkerLike | null) {
    this.worker = worker;
    if (!worker) return;
    worker.addEventListener('message', (ev: MessageEvent) => {
      this.dispatch(ev.data as OpsFromWorker);
    });
    worker.addEventListener('error', (ev: ErrorEvent) => {
      const error = new OpFailed(`The document operation stopped: ${ev.message}`);
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    });
  }

  /** True when the work happens off the main thread. */
  get offThread(): boolean {
    return this.worker !== null;
  }

  combine(
    sources: ReadonlyArray<OpSource>,
    options: CombineOptions,
    onProgress?: OpProgress,
  ): OpHandle<CombineResult> {
    return this.start<CombineResult>(
      (id) => ({ kind: 'combine', id, sources, options }),
      // The sources' buffers stay on this side: the reader may combine the same files twice.
      () => [],
      (ctx) => combine(sources, options, ctx),
      'combine',
      onProgress,
    );
  }

  split(bytes: Uint8Array, options: SplitOptions, onProgress?: OpProgress): OpHandle<SplitResult> {
    return this.start<SplitResult>(
      (id) => ({ kind: 'split', id, bytes, options }),
      () => [bytes.buffer as ArrayBuffer],
      (ctx) => split(bytes, options, ctx),
      'split',
      onProgress,
    );
  }

  crop(bytes: Uint8Array, options: CropOptions, onProgress?: OpProgress): OpHandle<OpResult> {
    return this.start<OpResult>(
      (id) => ({ kind: 'crop', id, bytes, options }),
      () => [bytes.buffer as ArrayBuffer],
      (ctx) => cropPages(bytes, options, ctx),
      'crop',
      onProgress,
    );
  }

  flatten(
    bytes: Uint8Array,
    options: Omit<FlattenOptions, 'appearances'>,
    onProgress?: OpProgress,
  ): OpHandle<FlattenResult> {
    return this.start<FlattenResult>(
      (id) => ({ kind: 'flatten', id, bytes, options }),
      () => [bytes.buffer as ArrayBuffer],
      (ctx) => flatten(bytes, options, ctx),
      'flatten',
      onProgress,
    );
  }

  deskew(
    bytes: Uint8Array,
    options: DeskewOptions,
    onProgress?: OpProgress,
  ): OpHandle<DeskewResult> {
    return this.start<DeskewResult>(
      (id) => ({ kind: 'deskew', id, bytes, options }),
      () => [bytes.buffer as ArrayBuffer],
      (ctx) => deskewPages(bytes, options, ctx),
      'deskew',
      onProgress,
    );
  }

  /**
   * The two paths, side by side: post the request and wait, or run the same function here.
   *
   * `transfer` is a callback rather than an array because it must not be evaluated on the
   * in-process path — reading `.buffer` is harmless, but handing the same bytes to both paths
   * would be a bug waiting to happen the first time someone reorders these lines.
   */
  private start<T>(
    request: (id: number) => OpsToWorker,
    transfer: () => Transferable[],
    inProcess: (ctx: OpContext) => Promise<T>,
    op: OpsAnswer['op'],
    onProgress: OpProgress | undefined,
  ): OpHandle<T> {
    const worker = this.worker;
    if (!worker) {
      const controller = new AbortController();
      return {
        promise: inProcess({
          signal: controller.signal,
          ...(onProgress === undefined ? {} : { progress: onProgress }),
        }),
        cancel: () => {
          controller.abort();
        },
      };
    }
    const id = this.nextId++;
    const promise = new Promise<OpsAnswer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
    }).then((answer) => {
      if (answer.op !== op)
        throw new OpFailed('The document operation answered the wrong question');
      return answer.value as T;
    });
    worker.postMessage(request(id), transfer());
    return {
      promise,
      cancel: () => {
        if (this.pending.has(id)) worker.postMessage({ kind: 'cancel', id });
      },
    };
  }

  private dispatch(message: OpsFromWorker): void {
    if (message.kind === 'ready') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.kind === 'progress') {
      pending.onProgress?.(message.fraction, message.message);
      return;
    }
    this.pending.delete(message.id);
    if (message.kind === 'done') {
      pending.resolve(message.result);
      return;
    }
    pending.reject(
      message.reason === 'cancelled' ? new OpCancelled() : new OpFailed(message.message),
    );
  }

  dispose(): void {
    for (const p of this.pending.values()) p.reject(new OpCancelled());
    this.pending.clear();
    this.worker?.terminate();
  }
}
