/**
 * `OptimiseClient` — the renderer's end of M100's Worker, and the one place that knows the whole
 * pipeline is split across three processes.
 *
 * An optimise is: **Worker** (images, fonts, duplicates, discards — pure arithmetic, off the main
 * thread) → **main** (qpdf: object streams, flate, unreferenced objects, linearisation) → back
 * here, where `withStructure` folds the two halves into one report. The reader sees one progress
 * dialog and one set of numbers; nothing above this file has to know where each step ran.
 *
 * Same shape as M21's `WriterClient` and M41's `OpsClient`: a job returns a handle with a promise
 * and a `cancel()`, progress arrives as it happens, and when there is no `Worker` — a unit test in
 * Node — the same functions run in-process, so what the tests exercise is what ships.
 */

import { assertWorkerEnvelope } from '@shared/workerMessages';
import { hasBridge, invoke } from '@shared/ipc';
import {
  OpCancelled,
  OpFailed,
  auditBytes,
  optimise,
  withStructure,
  type BytesAndWarnings,
  type OpContext,
  type OpProgress,
  type OptimiseOptions,
  type OptimiseResult,
  type SpaceAudit,
  type StructureOptions,
} from '@engine/optimise';
import type { OptimiseAnswer, OptimiseFromWorker, OptimiseToWorker } from './optimiseProtocol';

/** Minimal worker surface we rely on, so a test can pass a fake. */
export interface OptimiseWorkerLike {
  postMessage(message: OptimiseToWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'messageerror', listener: (ev: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (ev: ErrorEvent) => void): void;
  removeEventListener?(
    type: 'message' | 'messageerror',
    listener: (ev: MessageEvent) => void,
  ): void;
  removeEventListener?(type: 'error', listener: (ev: ErrorEvent) => void): void;
  terminate(): void;
}

export interface OptimiseHandle<T> {
  readonly promise: Promise<T>;
  cancel(): void;
}

/** The qpdf half. Injected so a test can run the pipeline with no main process anywhere. */
export type StructureRunner = (
  bytes: Uint8Array,
  options: StructureOptions,
) => Promise<BytesAndWarnings>;

interface Pending {
  resolve(answer: OptimiseAnswer): void;
  reject(error: Error): void;
  onProgress: OpProgress | undefined;
}

/** The default qpdf runner: main, through the typed channel. */
export function ipcStructureRunner(): StructureRunner {
  return async (bytes, options) => {
    if (!hasBridge()) return { bytes, warnings: [] };
    const result = await invoke('optimise:structure', bytes, options);
    return { bytes: result.bytes, warnings: result.warnings };
  };
}

export class OptimiseClient {
  private readonly worker: OptimiseWorkerLike | null;
  private readonly structure: StructureRunner;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private failure: Error | null = null;
  private readonly onMessage = (ev: MessageEvent): void => {
    if (this.failure) return;
    try {
      assertWorkerEnvelope(ev.data, 'optimise');
      this.dispatch(ev.data as OptimiseFromWorker);
    } catch (error) {
      this.stop(error instanceof Error ? error : new Error(String(error)));
    }
  };
  private readonly onError = (ev: ErrorEvent): void => {
    this.stop(new OpFailed(`Optimising stopped: ${ev.message}`));
  };
  private readonly onMessageError = (): void => {
    this.stop(new OpFailed('Optimising stopped: a worker message could not be read'));
  };

  /** Spawns the module worker built from `optimise.worker.ts`, or runs in-process without one. */
  static spawn(structure: StructureRunner = ipcStructureRunner()): OptimiseClient {
    if (typeof Worker === 'undefined') return new OptimiseClient(null, structure);
    const worker = new Worker(new URL('./optimise.worker.ts', import.meta.url), {
      type: 'module',
      name: 'ynot-optimise',
    });
    return new OptimiseClient(worker, structure);
  }

  constructor(worker: OptimiseWorkerLike | null, structure: StructureRunner) {
    this.worker = worker;
    this.structure = structure;
    if (!worker) return;
    worker.addEventListener('message', this.onMessage);
    worker.addEventListener('error', this.onError);
    worker.addEventListener('messageerror', this.onMessageError);
  }

  /** True when the arithmetic happens off the main thread. */
  get offThread(): boolean {
    return this.worker !== null;
  }

  /**
   * The whole optimise: the Worker's passes, then qpdf's, then one report.
   *
   * Progress is reported as the Worker sees it and then once more for the repack, which is a
   * single step of unknown length — `null` rather than a fraction, because a progress bar that
   * sits at 95 % for four seconds is worse than one that says it does not know.
   */
  run(
    bytes: Uint8Array,
    options: OptimiseOptions,
    onProgress?: OpProgress,
  ): OptimiseHandle<OptimiseResult> {
    let cancelled = false;
    const inner = this.start<OptimiseResult>(
      (id) => ({ kind: 'optimise', id, bytes, options }),
      () => [bytes.buffer as ArrayBuffer],
      (ctx) => optimise(bytes, options, {}, ctx),
      'optimise',
      onProgress,
    );

    const promise = inner.promise.then(async (result) => {
      if (cancelled) throw new OpCancelled();
      onProgress?.(null, 'Repacking the file');
      const packed = await this.structure(result.bytes, options.structure);
      if (cancelled) throw new OpCancelled();
      return withStructure(result, packed, options.structure);
    });

    return {
      promise,
      cancel: () => {
        cancelled = true;
        inner.cancel();
      },
    };
  }

  /** The space audit of a document, changing nothing. */
  audit(bytes: Uint8Array): OptimiseHandle<SpaceAudit> {
    return this.start<SpaceAudit>(
      (id) => ({ kind: 'audit', id, bytes }),
      // The bytes stay on this side: the dialog audits the document it is still holding.
      () => [],
      () => auditBytes(bytes),
      'audit',
      undefined,
    );
  }

  /**
   * The two paths, side by side: post the request and wait, or run the same function here.
   *
   * `transfer` is a callback rather than an array because it must not be evaluated on the
   * in-process path — reading `.buffer` is harmless, but handing the same bytes to both paths
   * would be a bug waiting to happen the first time someone reordered these lines.
   */
  private start<T>(
    request: (id: number) => OptimiseToWorker,
    transfer: () => Transferable[],
    inProcess: (ctx: OpContext) => Promise<T>,
    op: OptimiseAnswer['op'],
    onProgress: OpProgress | undefined,
  ): OptimiseHandle<T> {
    if (this.failure) return { promise: Promise.reject(this.failure), cancel: () => undefined };
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
    const promise = new Promise<OptimiseAnswer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
    }).then((answer) => {
      if (answer.op !== op) throw new OpFailed('Optimising answered the wrong question');
      return answer.value as T;
    });
    try {
      worker.postMessage(request(id), transfer());
    } catch (error) {
      this.stop(error instanceof Error ? error : new Error(String(error)));
    }
    return {
      promise,
      cancel: () => {
        if (!this.pending.has(id)) return;
        try {
          worker.postMessage({ kind: 'cancel', id });
        } catch (error) {
          this.stop(error instanceof Error ? error : new Error(String(error)));
        }
      },
    };
  }

  private dispatch(message: OptimiseFromWorker): void {
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
    this.stop(new OpCancelled());
  }

  private stop(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.worker?.removeEventListener?.('message', this.onMessage);
    this.worker?.removeEventListener?.('error', this.onError);
    this.worker?.removeEventListener?.('messageerror', this.onMessageError);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker?.terminate();
  }
}
