import type { OpResult } from '@engine/ops/types';

export interface ImportDeskewRequest {
  readonly bytes: Uint8Array;
}
export type ImportDeskewAnswer =
  | { readonly kind: 'progress'; readonly fraction: number | null; readonly message: string }
  | { readonly kind: 'done'; readonly result: OpResult }
  | { readonly kind: 'failed'; readonly message: string };
