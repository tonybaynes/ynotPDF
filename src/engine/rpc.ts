/**
 * Wire format for the engine Worker RPC (shared by `EngineClient.ts` and `worker.ts`).
 * Requests carry a method name and arguments; responses carry a result or a serialised error.
 * `ImageBitmap` and `ArrayBuffer` results are passed in the transfer list.
 *
 * M10 (ADR 0005) adds `cancel`: a queued request is dropped, an in-flight render is aborted at
 * its next pause point, and the request rejects with `EngineError('cancelled')`.
 */

import type { EngineErrorCode, EngineMethod } from './PdfEngine';

export interface RpcRequest {
  readonly kind: 'request';
  readonly id: number;
  readonly method: EngineMethod;
  readonly args: ReadonlyArray<unknown>;
}

/** Cancels request `id` (ADR 0005). Ignored when the request already finished. */
export interface RpcCancel {
  readonly kind: 'cancel';
  readonly id: number;
}

export interface RpcOk {
  readonly kind: 'ok';
  readonly id: number;
  readonly result: unknown;
}

export interface RpcFail {
  readonly kind: 'fail';
  readonly id: number;
  readonly error: { readonly code: EngineErrorCode; readonly message: string };
}

/** Progress notification for long operations (`save`). */
export interface RpcProgress {
  readonly kind: 'progress';
  readonly id: number;
  readonly fraction: number;
}

/** Sent once by the worker when its engine is ready to receive requests. */
export interface RpcReady {
  readonly kind: 'ready';
}

export type RpcToWorker = RpcRequest | RpcCancel;
export type RpcFromWorker = RpcOk | RpcFail | RpcProgress | RpcReady;

/** Collects transferable objects (bitmaps, buffers) from a value for `postMessage`. */
export function collectTransferables(value: unknown, into: Transferable[] = []): Transferable[] {
  if (value instanceof ArrayBuffer) into.push(value);
  else if (ArrayBuffer.isView(value)) into.push(value.buffer as ArrayBuffer);
  else if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) into.push(value);
  else if (Array.isArray(value)) for (const v of value) collectTransferables(v, into);
  else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectTransferables(v, into);
  }
  return into;
}
