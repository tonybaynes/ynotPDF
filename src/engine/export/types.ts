/**
 * The export operations (M92): pages to PNG / JPEG / TIFF / BMP, and a document to text, HTML
 * and RTF.
 *
 * Every one of them is a **pure function over pixels, text models and bytes** — nothing here
 * knows about a `Document`, a tab, a dialog, the DOM or Electron, which is what lets the same
 * code serve M92's dialogs, M120's batch runner and M121's command line without a second
 * implementation of "this document as PNGs". They run inside a Worker in the app and inside a
 * plain module in a unit test.
 *
 * Shared conventions, the same as M41's ops (ADR 0016) and M91's converters (ADR 0011):
 * - **Progress** is `(fraction, message)`; `fraction` is `null` while it is not yet known.
 * - **Cancelling** is an `AbortSignal`; an aborted export throws {@link ExportCancelled} and
 *   produces nothing at all, never a half-written file.
 * - **Warnings** are sentences for the reader. An export that meets something it can work around
 *   says so and carries on; only something that makes the answer wrong is an error.
 */

/** `fraction` 0..1 (or `null` while unknown) and a sentence about what is happening. */
export type ExportProgress = (fraction: number | null, message: string) => void;

export interface ExportContext {
  readonly signal?: AbortSignal;
  readonly progress?: ExportProgress;
}

/** The export was cancelled through its signal. Nothing was produced. */
export class ExportCancelled extends Error {
  override readonly name = 'ExportCancelled';
  constructor() {
    super('The export was cancelled');
  }
}

/** The document cannot be exported this way — the message is a sentence for the reader. */
export class ExportFailed extends Error {
  override readonly name = 'ExportFailed';
}

/** Throws {@link ExportCancelled} if the signal has been aborted. Call it between units of work. */
export function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ExportCancelled();
}

/** True for the error an aborted export throws, whichever export threw it. */
export function isExportCancelled(error: unknown): boolean {
  return error instanceof ExportCancelled;
}

/**
 * A page's pixels: RGBA rows, top-left origin — what `ImageData` holds, and what M41's `Raster`
 * already means elsewhere in the engine.
 */
export interface Raster {
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** A rendered page: its pixels, which page it is, and the resolution it was drawn at. */
export interface RenderedPage extends Raster {
  /** 0-based page index in the document. */
  readonly page: number;
  readonly dpi: number;
}

/**
 * How the exporter asks for a page's pixels.
 *
 * The exporter never holds an engine: the caller supplies this, so the pure code is the same
 * whether the pixels came from PDFium in the app or from an array a test drew itself.
 */
export type RenderPage = (page: number, dpi: number) => Promise<Raster>;

/** One file an export produced. `bytes` is complete: nothing appends to it afterwards. */
export interface ExportedFile {
  /** File name including the extension, already safe for every OS. */
  readonly name: string;
  readonly bytes: Uint8Array;
  /** IANA media type, for the clipboard and for a "what is this" line in the UI. */
  readonly mediaType: string;
  /** The 0-based source pages this file came from, in order. Empty for a whole-document file. */
  readonly pages: ReadonlyArray<number>;
}

/** What an export produced, plus anything worth telling the reader. */
export interface ExportResult {
  readonly files: ReadonlyArray<ExportedFile>;
  readonly warnings: ReadonlyArray<string>;
}

/** Every byte of an export result, for a `postMessage` transfer list. */
export function exportTransferables(result: ExportResult): ArrayBuffer[] {
  return result.files.map((f) => f.bytes.buffer as ArrayBuffer);
}
