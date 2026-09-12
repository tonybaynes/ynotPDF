/**
 * `ConvertClient` — the renderer's end of the conversion Worker (M91), the same shape as M21's
 * `WriterClient`: a job returns a handle with a promise and a `cancel()`, progress arrives as it
 * happens, and without a `Worker` (a unit test in Node) the same converters run in-process so the
 * behaviour under test is the behaviour that ships.
 */

import { assertWorkerEnvelope } from '@shared/workerMessages';
import { createRegistry, type ConverterRegistry } from '@engine/create/registry';
import {
  ConvertCancelled,
  ConvertUnsupported,
  type ConvertEnvironment,
  type ConvertInput,
  type ConvertProgress,
  type ConvertResult,
  type ConvertUnsupportedReason,
} from '@engine/create/types';
import type { ConvertFromWorker, ConvertToWorker } from './createProtocol';

/** Minimal worker surface we rely on, so a test can pass a fake. */
export interface ConvertWorkerLike {
  postMessage(message: ConvertToWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'messageerror', listener: (ev: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (ev: ErrorEvent) => void): void;
  removeEventListener?(
    type: 'message' | 'messageerror',
    listener: (ev: MessageEvent) => void,
  ): void;
  removeEventListener?(type: 'error', listener: (ev: ErrorEvent) => void): void;
  terminate(): void;
}

export interface ConvertHandle {
  readonly promise: Promise<ConvertResult>;
  cancel(): void;
}

export interface ConvertJob {
  readonly converter: string;
  readonly inputs: ReadonlyArray<ConvertInput>;
  readonly options: unknown;
  readonly onProgress?: ConvertProgress;
  /** Buffers to hand over to the worker rather than copy. The caller must not need them after. */
  readonly transfer?: boolean;
}

interface Pending {
  resolve(result: ConvertResult): void;
  reject(error: Error): void;
  onProgress: ConvertProgress | undefined;
}

const UNSUPPORTED: ReadonlySet<string> = new Set<ConvertUnsupportedReason>([
  'unknown-format',
  'corrupt',
  'no-decoder',
  'no-printer',
  'timeout',
  'empty',
]);

export class ConvertClient {
  private readonly worker: ConvertWorkerLike | null;
  private readonly env: ConvertEnvironment;
  private registry: ConverterRegistry | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private failure: Error | null = null;
  private readonly onMessage = (ev: MessageEvent): void => {
    if (this.failure) return;
    try {
      assertWorkerEnvelope(ev.data, 'convert');
      this.dispatch(ev.data as ConvertFromWorker);
    } catch (error) {
      this.stop(error instanceof Error ? error : new Error(String(error)));
    }
  };
  private readonly onError = (ev: ErrorEvent): void => {
    this.stop(new Error(`The converter stopped: ${ev.message}`));
  };
  private readonly onMessageError = (): void => {
    this.stop(new Error('The converter stopped: a worker message could not be read'));
  };

  /** Spawns the module worker built from `create.worker.ts`, or runs in-process without one. */
  static spawn(env: ConvertEnvironment = {}): ConvertClient {
    if (typeof Worker === 'undefined') return new ConvertClient(null, env);
    const worker = new Worker(new URL('./create.worker.ts', import.meta.url), {
      type: 'module',
      name: 'ynot-create',
    });
    return new ConvertClient(worker, env);
  }

  constructor(worker: ConvertWorkerLike | null, env: ConvertEnvironment = {}) {
    this.worker = worker;
    this.env = env;
    if (!worker) return;
    worker.addEventListener('message', this.onMessage);
    worker.addEventListener('error', this.onError);
    worker.addEventListener('messageerror', this.onMessageError);
  }

  get offThread(): boolean {
    return this.worker !== null;
  }

  convert(job: ConvertJob): ConvertHandle {
    if (this.failure) return { promise: Promise.reject(this.failure), cancel: () => undefined };
    return this.worker ? this.inWorker(this.worker, job) : this.inProcess(job);
  }

  private inWorker(worker: ConvertWorkerLike, job: ConvertJob): ConvertHandle {
    const id = this.nextId++;
    const promise = new Promise<ConvertResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress: job.onProgress });
    });
    const inputs = job.transfer
      ? job.inputs
      : job.inputs.map((i) => ({ ...i, bytes: i.bytes.slice() }));
    const buffers = new Set<ArrayBuffer>();
    for (const input of inputs) buffers.add(input.bytes.buffer as ArrayBuffer);
    try {
      worker.postMessage(
        { kind: 'convert', id, converter: job.converter, inputs, options: job.options },
        [...buffers],
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

  private dispatch(message: ConvertFromWorker): void {
    if (message.kind === 'ready') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.kind === 'progress') {
      pending.onProgress?.(message.fraction, message.message);
      return;
    }
    this.pending.delete(message.id);
    if (message.kind === 'done') {
      pending.resolve({
        bytes: message.bytes,
        pageCount: message.pageCount,
        title: message.title,
        warnings: message.warnings,
      });
      return;
    }
    pending.reject(reviveError(message.reason, message.message));
  }

  /** The no-Worker path: the same registry, on this thread. */
  private inProcess(job: ConvertJob): ConvertHandle {
    this.registry ??= createRegistry();
    const converter = this.registry.get(job.converter);
    const controller = new AbortController();
    const promise = converter
      ? converter.convert(job.inputs, job.options, {
          env: this.env,
          signal: controller.signal,
          ...(job.onProgress === undefined ? {} : { progress: job.onProgress }),
        })
      : Promise.reject(new Error(`No converter is called "${job.converter}"`));
    return {
      promise,
      cancel: () => {
        controller.abort();
      },
    };
  }

  dispose(): void {
    this.stop(new ConvertCancelled());
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

/** Rebuilds the typed error from the strings that crossed `postMessage`. */
export function reviveError(reason: string, message: string): Error {
  if (reason === 'cancelled') return new ConvertCancelled();
  if (UNSUPPORTED.has(reason))
    return new ConvertUnsupported(reason as ConvertUnsupportedReason, message);
  return new Error(message);
}
