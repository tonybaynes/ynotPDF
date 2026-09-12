/**
 * `WriterClient` — the renderer's end of the writer Worker (M21).
 *
 * `write()` returns a handle with the promise and a `cancel()`, because a save has to be
 * cancellable while it is running rather than only before it starts. Cancelling rejects with
 * `WriteCancelled`; the caller has not written anything to disk at that point, so nothing has
 * been lost.
 *
 * When there is no `Worker` — a unit test in Node — the same writer runs in-process, so the
 * behaviour under test is the behaviour that ships.
 */

import { assertWorkerEnvelope } from '@shared/workerMessages';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import {
  WriteCancelled,
  WriteUnsupported,
  type WriteOptions,
  type WritePhase,
  type WritePlan,
  type WriteResult,
} from '@engine/Writer';
import type { WriterFromWorker, WriterToWorker } from './writerProtocol';

/** Minimal worker surface we rely on, so a test can pass a fake. */
export interface WriterWorkerLike {
  postMessage(message: WriterToWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'messageerror', listener: (ev: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (ev: ErrorEvent) => void): void;
  removeEventListener?(
    type: 'message' | 'messageerror',
    listener: (ev: MessageEvent) => void,
  ): void;
  removeEventListener?(type: 'error', listener: (ev: ErrorEvent) => void): void;
  terminate(): void;
}

export interface WriteHandle {
  readonly promise: Promise<WriteResult>;
  cancel(): void;
}

export interface WriteJob {
  readonly bytes: Uint8Array;
  readonly plan: WritePlan;
  readonly options?: WriteOptions;
  readonly onProgress?: (fraction: number, phase: WritePhase) => void;
}

interface Pending {
  resolve(result: WriteResult): void;
  reject(error: Error): void;
  onProgress: ((fraction: number, phase: WritePhase) => void) | undefined;
}

export class WriterClient {
  private readonly worker: WriterWorkerLike | null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private failure: Error | null = null;
  private readonly onMessage = (ev: MessageEvent): void => {
    if (this.failure) return;
    try {
      assertWorkerEnvelope(ev.data, 'writer');
      this.dispatch(ev.data as WriterFromWorker);
    } catch (error) {
      this.stop(error instanceof Error ? error : new Error(String(error)));
    }
  };
  private readonly onError = (ev: ErrorEvent): void => {
    this.stop(new Error(`The writer stopped: ${ev.message}`));
  };
  private readonly onMessageError = (): void => {
    this.stop(new Error('The writer stopped: a worker message could not be read'));
  };

  /** Spawns the module worker built from `writer.worker.ts`, or runs in-process without one. */
  static spawn(): WriterClient {
    if (typeof Worker === 'undefined') return new WriterClient(null);
    const worker = new Worker(new URL('./writer.worker.ts', import.meta.url), {
      type: 'module',
      name: 'ynot-writer',
    });
    return new WriterClient(worker);
  }

  constructor(worker: WriterWorkerLike | null) {
    this.worker = worker;
    if (!worker) return;
    worker.addEventListener('message', this.onMessage);
    worker.addEventListener('error', this.onError);
    worker.addEventListener('messageerror', this.onMessageError);
  }

  /** True when writing happens off the main thread. */
  get offThread(): boolean {
    return this.worker !== null;
  }

  write(job: WriteJob): WriteHandle {
    if (this.failure) return { promise: Promise.reject(this.failure), cancel: () => undefined };
    return this.worker ? this.writeInWorker(this.worker, job) : writeInProcess(job);
  }

  private writeInWorker(worker: WriterWorkerLike, job: WriteJob): WriteHandle {
    const id = this.nextId++;
    const promise = new Promise<WriteResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress: job.onProgress });
    });
    // The buffer is transferred, so the caller's copy is detached — always hand over a copy of
    // bytes you still need. `SaveService` does.
    try {
      worker.postMessage(
        { kind: 'write', id, bytes: job.bytes, plan: job.plan, options: job.options ?? {} },
        [job.bytes.buffer as ArrayBuffer],
      );
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

  private dispatch(message: WriterFromWorker): void {
    if (message.kind === 'ready') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.kind === 'progress') {
      pending.onProgress?.(message.fraction, message.phase);
      return;
    }
    this.pending.delete(message.id);
    if (message.kind === 'done') {
      pending.resolve({
        bytes: message.bytes,
        applied: message.applied,
        appearances: message.appearances,
        warnings: message.warnings,
      });
      return;
    }
    pending.reject(reviveError(message.reason, message.message));
  }

  dispose(): void {
    this.stop(new WriteCancelled());
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

/** Rebuilds the typed error from the string that crossed `postMessage`. */
function reviveError(reason: string, message: string): Error {
  if (reason === 'cancelled') return new WriteCancelled();
  if (reason === 'encrypted' || reason === 'corrupt') {
    return new WriteUnsupported(reason, message);
  }
  return new Error(message);
}

/** The no-Worker path: the same writer, on this thread, still cancellable between phases. */
function writeInProcess(job: WriteJob): WriteHandle {
  const controller = new AbortController();
  const promise = new FullRewriteWriter().write({
    bytes: job.bytes,
    plan: job.plan,
    ...(job.options === undefined ? {} : { options: job.options }),
    signal: controller.signal,
    ...(job.onProgress === undefined ? {} : { progress: job.onProgress }),
  });
  return {
    promise,
    cancel: () => {
      controller.abort();
    },
  };
}
