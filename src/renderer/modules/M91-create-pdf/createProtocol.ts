/**
 * Wire format between `ConvertClient` and `create.worker.ts` (M91) — the same three-and-three
 * shape as M21's writer protocol. Everything is structured-cloneable; input bytes go over as
 * transfers and the finished PDF comes back as one.
 */

import type { ConvertInput } from '@engine/create/types';

export interface ConvertRequest {
  readonly kind: 'convert';
  readonly id: number;
  /** Converter id in the registry (`"image"`, `"text"`, `"blank"`, `"web-assemble"`…). */
  readonly converter: string;
  readonly inputs: ReadonlyArray<ConvertInput>;
  readonly options: unknown;
}

export interface ConvertCancel {
  readonly kind: 'cancel';
  readonly id: number;
}

export interface ConvertReady {
  readonly kind: 'ready';
}

export interface ConvertProgressMessage {
  readonly kind: 'progress';
  readonly id: number;
  readonly fraction: number | null;
  readonly message: string;
}

export interface ConvertDone {
  readonly kind: 'done';
  readonly id: number;
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly title: string;
  readonly warnings: ReadonlyArray<string>;
}

export interface ConvertFailed {
  readonly kind: 'failed';
  readonly id: number;
  /** `"cancelled"`, a {@link ConvertUnsupportedReason}, or `"failed"`. */
  readonly reason: string;
  readonly message: string;
}

export type ConvertToWorker = ConvertRequest | ConvertCancel;
export type ConvertFromWorker = ConvertReady | ConvertProgressMessage | ConvertDone | ConvertFailed;
