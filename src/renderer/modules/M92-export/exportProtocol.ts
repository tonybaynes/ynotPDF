/**
 * Wire format between `ExportClient` and `export.worker.ts` (M92), the same shape as M41's
 * `opsProtocol.ts`.
 *
 * One request kind per export rather than a `{ name, args }` pair, so the compiler checks that
 * the dialog and the worker agree about what a PNG export's options are. Everything here is
 * structured-cloneable, and finished bytes are transferred rather than copied.
 *
 * The image export is the one that cannot simply be posted across: it needs a page *rendered*,
 * and only the renderer has the engine. So `renderPage` goes the other way — the worker asks for
 * a page's pixels and the client answers — which keeps the encoding off the main thread without
 * moving PDFium anywhere.
 */

import type { EmbeddedExportOptions, EmbeddedImageLike } from '@engine/export/embedded';
import type { HtmlExportOptions } from '@engine/export/html';
import type { ImageExportOptions } from '@engine/export/images';
import type { RtfExportOptions } from '@engine/export/rtf';
import type { TextExportOptions } from '@engine/export/text';
import type { ExportPage } from '@engine/export/textModel';
import type { ExportResult } from '@engine/export/types';

export interface ImagesRequest {
  readonly kind: 'images';
  readonly id: number;
  readonly options: ImageExportOptions;
}

export interface EmbeddedRequest {
  readonly kind: 'embedded';
  readonly id: number;
  readonly images: ReadonlyArray<EmbeddedImageLike>;
  readonly options: EmbeddedExportOptions;
}

export interface TextRequest {
  readonly kind: 'text';
  readonly id: number;
  readonly pages: ReadonlyArray<ExportPage>;
  readonly options: TextExportOptions;
}

export interface HtmlRequest {
  readonly kind: 'html';
  readonly id: number;
  readonly pages: ReadonlyArray<ExportPage>;
  readonly options: HtmlExportOptions;
}

export interface RtfRequest {
  readonly kind: 'rtf';
  readonly id: number;
  readonly pages: ReadonlyArray<ExportPage>;
  readonly options: RtfExportOptions;
}

export interface ExportCancel {
  readonly kind: 'cancel';
  readonly id: number;
}

/** The renderer's answer to a `renderPage` question: the pixels, or why there are none. */
export interface RenderedReply {
  readonly kind: 'rendered';
  readonly id: number;
  readonly token: number;
  readonly data?: Uint8Array;
  readonly width?: number;
  readonly height?: number;
  readonly error?: string;
}

export interface ExportReady {
  readonly kind: 'ready';
}

export interface ExportProgressMessage {
  readonly kind: 'progress';
  readonly id: number;
  readonly fraction: number | null;
  readonly message: string;
}

/** The worker asking the renderer for a page's pixels. */
export interface RenderRequest {
  readonly kind: 'render';
  readonly id: number;
  readonly token: number;
  readonly page: number;
  readonly dpi: number;
}

export interface ExportDone {
  readonly kind: 'done';
  readonly id: number;
  readonly result: ExportResult;
}

export interface ExportFailedMessage {
  readonly kind: 'failed';
  readonly id: number;
  /** `"cancelled"` or `"failed"` — the kind has to survive as a string. */
  readonly reason: string;
  readonly message: string;
}

export type ExportToWorker =
  | ImagesRequest
  | EmbeddedRequest
  | TextRequest
  | HtmlRequest
  | RtfRequest
  | ExportCancel
  | RenderedReply;

export type ExportFromWorker =
  ExportReady | ExportProgressMessage | RenderRequest | ExportDone | ExportFailedMessage;
