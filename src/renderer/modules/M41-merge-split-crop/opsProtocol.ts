/**
 * Wire format between `OpsClient` and `ops.worker.ts` (M41).
 *
 * One request kind per operation rather than a `{ name, args }` pair, so the compiler checks
 * that the dialog and the worker agree about what a split's options are. Everything here is
 * structured-cloneable, and finished bytes are transferred rather than copied.
 */

import type { CombineOptions, CombineResult } from '@engine/ops/combine';
import type { CropOptions } from '@engine/ops/crop';
import type { DeskewOptions, DeskewResult } from '@engine/ops/deskew';
import type { FlattenOptions, FlattenResult } from '@engine/ops/flatten';
import type { SplitOptions, SplitResult } from '@engine/ops/split';
import type { OpResult, OpSource } from '@engine/ops/types';

export interface CombineRequest {
  readonly kind: 'combine';
  readonly id: number;
  readonly sources: ReadonlyArray<OpSource>;
  readonly options: CombineOptions;
}

export interface SplitRequest {
  readonly kind: 'split';
  readonly id: number;
  readonly bytes: Uint8Array;
  readonly options: SplitOptions;
}

export interface CropRequest {
  readonly kind: 'crop';
  readonly id: number;
  readonly bytes: Uint8Array;
  readonly options: CropOptions;
}

export interface FlattenRequest {
  readonly kind: 'flatten';
  readonly id: number;
  readonly bytes: Uint8Array;
  /** `appearances` cannot cross `postMessage`, so the worker never sees that hook. */
  readonly options: Omit<FlattenOptions, 'appearances'>;
}

export interface DeskewRequest {
  readonly kind: 'deskew';
  readonly id: number;
  readonly bytes: Uint8Array;
  readonly options: DeskewOptions;
}

export interface OpsCancel {
  readonly kind: 'cancel';
  readonly id: number;
}

export interface OpsReady {
  readonly kind: 'ready';
}

export interface OpsProgress {
  readonly kind: 'progress';
  readonly id: number;
  readonly fraction: number | null;
  readonly message: string;
}

/** The result, in whichever shape the operation answers with. */
export interface OpsDone {
  readonly kind: 'done';
  readonly id: number;
  readonly result: OpsAnswer;
}

export interface OpsFailed {
  readonly kind: 'failed';
  readonly id: number;
  /** `"cancelled"` or `"failed"` — the kind has to survive as a string. */
  readonly reason: string;
  readonly message: string;
}

export type OpsAnswer =
  | { readonly op: 'combine'; readonly value: CombineResult }
  | { readonly op: 'split'; readonly value: SplitResult }
  | { readonly op: 'crop'; readonly value: OpResult }
  | { readonly op: 'flatten'; readonly value: FlattenResult }
  | { readonly op: 'deskew'; readonly value: DeskewResult };

export type OpsToWorker =
  CombineRequest | SplitRequest | CropRequest | FlattenRequest | DeskewRequest | OpsCancel;

export type OpsFromWorker = OpsReady | OpsProgress | OpsDone | OpsFailed;
