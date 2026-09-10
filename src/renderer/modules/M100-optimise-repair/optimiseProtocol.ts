/**
 * Wire format between `OptimiseClient` and `optimise.worker.ts` (M100).
 *
 * The same shape M41's ops worker uses: one request kind per operation rather than a
 * `{ name, args }` pair, so the compiler checks that the dialog and the worker agree about what
 * an optimise's options are. Everything here is structured-cloneable, and finished bytes are
 * transferred rather than copied.
 *
 * **qpdf is not in here.** It runs in the main process (ADR 0011) and a Worker cannot reach main,
 * so the Worker does the pure passes and hands the bytes back; the client then makes one IPC call
 * and folds the answer into the report with `withStructure`.
 */

import type { OptimiseOptions, OptimiseResult, SpaceAudit } from '@engine/optimise';

export interface OptimiseRequest {
  readonly kind: 'optimise';
  readonly id: number;
  readonly bytes: Uint8Array;
  readonly options: OptimiseOptions;
}

export interface AuditRequest {
  readonly kind: 'audit';
  readonly id: number;
  readonly bytes: Uint8Array;
}

export interface OptimiseCancel {
  readonly kind: 'cancel';
  readonly id: number;
}

export interface OptimiseReady {
  readonly kind: 'ready';
}

export interface OptimiseProgress {
  readonly kind: 'progress';
  readonly id: number;
  readonly fraction: number | null;
  readonly message: string;
}

export interface OptimiseDone {
  readonly kind: 'done';
  readonly id: number;
  readonly result: OptimiseAnswer;
}

export interface OptimiseFailed {
  readonly kind: 'failed';
  readonly id: number;
  /** `"cancelled"` or `"failed"` — the kind has to survive as a string. */
  readonly reason: string;
  readonly message: string;
}

export type OptimiseAnswer =
  | { readonly op: 'optimise'; readonly value: OptimiseResult }
  | { readonly op: 'audit'; readonly value: SpaceAudit };

export type OptimiseToWorker = OptimiseRequest | AuditRequest | OptimiseCancel;
export type OptimiseFromWorker = OptimiseReady | OptimiseProgress | OptimiseDone | OptimiseFailed;
