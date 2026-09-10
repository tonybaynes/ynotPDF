/**
 * The export Worker (M92).
 *
 * Encoding a 300 dpi A4 page is eight megapixels of filtering and deflating, and a hundred-page
 * document is a hundred of those. On the main thread that is a frozen window with a progress bar
 * that cannot move and a Cancel button that cannot be pressed — exactly when the reader most
 * wants both. So it happens here.
 *
 * The pixels still come from the *engine* worker, because PDFium lives there and is not
 * re-entrant: this one asks the renderer for a page (`render`), the renderer asks the engine, and
 * the RGBA comes back and is transferred, not copied. That is one extra hop and no extra copy.
 *
 * `serveExport` is exported so a unit test can drive it through a fake port, and `ExportClient`
 * runs the same functions in-process when there is no `Worker` at all.
 */

import { exportEmbeddedImages } from '@engine/export/embedded';
import { exportHtml } from '@engine/export/html';
import { exportImages } from '@engine/export/images';
import { exportRtf } from '@engine/export/rtf';
import { exportText } from '@engine/export/text';
import {
  ExportCancelled,
  exportTransferables,
  type ExportContext,
  type ExportResult,
  type Raster,
} from '@engine/export/types';
import type { ExportFromWorker, ExportToWorker } from './exportProtocol';

/** Minimal worker surface, so `serveExport` can be driven by a fake port in tests. */
export interface ExportPort {
  postMessage(message: ExportFromWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<ExportToWorker>) => void): void;
}

export function serveExport(port: ExportPort): void {
  const controllers = new Map<number, AbortController>();
  const waiting = new Map<
    number,
    { resolve: (raster: Raster) => void; reject: (error: Error) => void }
  >();
  let nextToken = 1;

  const run = async (
    id: number,
    work: (ctx: ExportContext) => Promise<ExportResult>,
  ): Promise<void> => {
    const controller = new AbortController();
    controllers.set(id, controller);
    try {
      const result = await work({
        signal: controller.signal,
        progress: (fraction, message) => {
          port.postMessage({ kind: 'progress', id, fraction, message });
        },
      });
      port.postMessage({ kind: 'done', id, result }, exportTransferables(result));
    } catch (error) {
      port.postMessage({ kind: 'failed', id, ...describe(error) });
    } finally {
      controllers.delete(id);
      // Anything still waiting for pixels belongs to a job that has finished or failed.
      for (const [token, pending] of waiting) {
        pending.reject(new ExportCancelled());
        waiting.delete(token);
      }
    }
  };

  /** Asks the renderer for one page's pixels. */
  const renderPage =
    (id: number) =>
    async (page: number, dpi: number): Promise<Raster> => {
      const token = nextToken++;
      const promise = new Promise<Raster>((resolve, reject) => {
        waiting.set(token, { resolve, reject });
      });
      port.postMessage({ kind: 'render', id, token, page, dpi });
      return await promise;
    };

  port.addEventListener('message', (ev) => {
    const message = ev.data;
    switch (message.kind) {
      case 'cancel':
        controllers.get(message.id)?.abort();
        return;
      case 'rendered': {
        const pending = waiting.get(message.token);
        if (!pending) return;
        waiting.delete(message.token);
        if (message.data && message.width !== undefined && message.height !== undefined) {
          pending.resolve({ data: message.data, width: message.width, height: message.height });
        } else {
          pending.reject(new Error(message.error ?? 'the page could not be drawn'));
        }
        return;
      }
      case 'images':
        void run(
          message.id,
          async (ctx) => await exportImages(renderPage(message.id), message.options, ctx),
        );
        return;
      case 'embedded':
        void run(message.id, (ctx) =>
          Promise.resolve(exportEmbeddedImages(message.images, message.options, ctx)),
        );
        return;
      case 'text':
        void run(message.id, (ctx) =>
          Promise.resolve(exportText(message.pages, message.options, ctx)),
        );
        return;
      case 'html':
        void run(message.id, (ctx) =>
          Promise.resolve(exportHtml(message.pages, message.options, ctx)),
        );
        return;
      case 'rtf':
        void run(message.id, (ctx) =>
          Promise.resolve(exportRtf(message.pages, message.options, ctx)),
        );
        return;
    }
  });

  port.postMessage({ kind: 'ready' });
}

/** Errors cross `postMessage` as data, so the kind has to survive as a string. */
function describe(error: unknown): { reason: string; message: string } {
  if (error instanceof ExportCancelled) return { reason: 'cancelled', message: error.message };
  return { reason: 'failed', message: error instanceof Error ? error.message : String(error) };
}

// Only when actually loaded as a Worker — not when a unit test imports `serveExport`.
if (
  typeof window === 'undefined' &&
  typeof self !== 'undefined' &&
  typeof document === 'undefined'
) {
  serveExport(self as unknown as ExportPort);
}
