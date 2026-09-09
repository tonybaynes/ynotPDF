/**
 * The whole-document operations (M41): combine, split, crop, flatten, deskew.
 *
 * Every one of them is a **pure function over bytes** — bytes and options in, bytes out. None of
 * them knows about a `Document`, a tab, a dialog or the DOM, which is what lets the same code
 * serve M41's dialogs, M120's batch runner and M121's command line without a second
 * implementation of "split this file". They may not touch Node or Electron either: they run
 * inside a Worker in the app and inside a plain module in a unit test.
 *
 * Shared conventions, mirroring M91's converters (ADR 0011):
 * - **Progress** is `(fraction, message)`; `fraction` is `null` while it is not yet known.
 * - **Cancelling** is an `AbortSignal`; an aborted op throws {@link OpCancelled} and produces
 *   nothing at all, never a half-written file.
 * - **Warnings** are sentences for the reader. An op that meets something it can work around
 *   says so and carries on; only something that makes the answer wrong is an error.
 */

import type { PdfRect } from '@shared/pdf';

/** `fraction` 0..1 (or `null` while unknown) and a sentence about what is happening. */
export type OpProgress = (fraction: number | null, message: string) => void;

export interface OpContext {
  readonly signal?: AbortSignal;
  readonly progress?: OpProgress;
}

/** The operation was cancelled through its signal. Nothing was produced. */
export class OpCancelled extends Error {
  override readonly name = 'OpCancelled';
  constructor() {
    super('The operation was cancelled');
  }
}

/** The input cannot be worked on — the message is a sentence for the reader. */
export class OpFailed extends Error {
  override readonly name = 'OpFailed';
}

/** Throws {@link OpCancelled} if the signal has been aborted. Call it between units of work. */
export function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new OpCancelled();
}

/** True for the error an aborted op throws, whichever op threw it. */
export function isCancelled(error: unknown): boolean {
  return error instanceof OpCancelled;
}

/** One document handed to an op: its bytes, and a name used for titles and bookmarks. */
export interface OpSource {
  readonly name: string;
  readonly bytes: Uint8Array;
  /**
   * Which of its pages to take, 0-based, in order. Absent or empty means all of them, in the
   * document's own order.
   */
  readonly pages?: ReadonlyArray<number>;
}

/** What an op produced, plus anything worth telling the reader. */
export interface OpResult {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly warnings: ReadonlyArray<string>;
}

/**
 * A rendered page, as `ImageData` gives it: RGBA rows, top-left origin.
 *
 * The two ops that look at pixels — "remove white margins" and skew detection — take this rather
 * than an `ImageBitmap`, so their arithmetic can be tested against a picture a test drew itself
 * with no canvas, no worker and no PDF anywhere near it.
 */
export interface Raster {
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** A page's five boxes as an op wants to write them; `undefined` leaves a box alone. */
export interface BoxPatch {
  readonly media?: PdfRect | null;
  readonly crop?: PdfRect | null;
  readonly bleed?: PdfRect | null;
  readonly trim?: PdfRect | null;
  readonly art?: PdfRect | null;
}
