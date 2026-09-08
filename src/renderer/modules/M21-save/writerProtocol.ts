/**
 * Wire format between `WriterClient` and `writer.worker.ts` (M21).
 *
 * Three kinds each way and nothing clever: a write, a cancel, and the answers. Everything here
 * is structured-cloneable, and the finished bytes are transferred rather than copied.
 */

import type { WriteOptions, WritePhase, WritePlan } from '@engine/Writer';

export interface WriterRequest {
  readonly kind: 'write';
  readonly id: number;
  readonly bytes: Uint8Array;
  readonly plan: WritePlan;
  readonly options: WriteOptions;
}

export interface WriterCancel {
  readonly kind: 'cancel';
  readonly id: number;
}

export interface WriterReady {
  readonly kind: 'ready';
}

export interface WriterProgress {
  readonly kind: 'progress';
  readonly id: number;
  readonly fraction: number;
  readonly phase: WritePhase;
}

export interface WriterDone {
  readonly kind: 'done';
  readonly id: number;
  readonly bytes: Uint8Array;
  readonly applied: ReadonlyArray<WritePhase>;
  readonly appearances: number;
  readonly warnings: ReadonlyArray<string>;
}

export interface WriterFailed {
  readonly kind: 'failed';
  readonly id: number;
  /** `"cancelled"`, `"encrypted"`, `"corrupt"` or `"failed"`. */
  readonly reason: string;
  readonly message: string;
}

export type WriterToWorker = WriterRequest | WriterCancel;
export type WriterFromWorker = WriterReady | WriterProgress | WriterDone | WriterFailed;
