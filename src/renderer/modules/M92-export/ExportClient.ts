/**
 * `ExportClient` — the renderer's end of the export Worker (M92), the same shape as M41's
 * `OpsClient` and M91's `ConvertClient`: a job returns a handle with a promise and a `cancel()`,
 * progress arrives as it happens, and without a `Worker` (a unit test in Node) the same pure
 * functions run in-process, so the behaviour under test is the behaviour that ships.
 *
 * The one thing this client does that the others do not is answer questions. The image export
 * needs pages *rendered*, and only the renderer can reach the engine, so the worker asks and this
 * answers — see `exportProtocol.ts`.
 */

import { exportEmbeddedImages } from '@engine/export/embedded';
import { exportHtml } from '@engine/export/html';
import { exportImages } from '@engine/export/images';
import { exportRtf } from '@engine/export/rtf';
import { exportText } from '@engine/export/text';
import {
  ExportCancelled,
  ExportFailed,
  type ExportContext,
  type ExportProgress,
  type ExportResult,
  type RenderPage,
} from '@engine/export/types';
import { assertWorkerEnvelope } from '@shared/workerMessages';
import type { EmbeddedExportOptions, EmbeddedImageLike } from '@engine/export/embedded';
import type { HtmlExportOptions } from '@engine/export/html';
import type { ImageExportOptions } from '@engine/export/images';
import type { RtfExportOptions } from '@engine/export/rtf';
import type { TextExportOptions } from '@engine/export/text';
import type { ExportPage } from '@engine/export/textModel';
import type { ExportFromWorker, ExportToWorker } from './exportProtocol';

/** Minimal worker surface we rely on, so a test can pass a fake. */
export interface ExportWorkerLike {
  postMessage(message: ExportToWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'messageerror', listener: (ev: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (ev: ErrorEvent) => void): void;
  removeEventListener?(
    type: 'message' | 'messageerror',
    listener: (ev: MessageEvent) => void,
  ): void;
  removeEventListener?(type: 'error', listener: (ev: ErrorEvent) => void): void;
  terminate(): void;
}

export interface ExportHandle {
  readonly promise: Promise<ExportResult>;
  cancel(): void;
}

/** What every job carries: where to report progress, and how to get pixels when it needs them. */
export interface JobOptions {
  readonly onProgress?: ExportProgress;
  /** Required by the image export; ignored by the others. */
  readonly render?: RenderPage;
}

interface Pending {
  resolve(result: ExportResult): void;
  reject(error: Error): void;
  readonly onProgress: ExportProgress | undefined;
  readonly render: RenderPage | undefined;
}

export class ExportClient {
  private readonly worker: ExportWorkerLike | null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private failure: Error | null = null;
  private readonly onMessage = (ev: MessageEvent): void => {
    if (this.failure) return;
    try {
      assertWorkerEnvelope(ev.data, 'export');
      this.dispatch(ev.data as ExportFromWorker);
    } catch (error) {
      this.stop(error instanceof Error ? error : new Error(String(error)));
    }
  };
  private readonly onError = (ev: ErrorEvent): void => {
    this.stop(new ExportFailed(`The exporter stopped: ${ev.message}`));
  };
  private readonly onMessageError = (): void => {
    this.stop(new ExportFailed('The exporter stopped: a worker message could not be read'));
  };

  /** Spawns the module worker built from `export.worker.ts`, or runs in-process without one. */
  static spawn(): ExportClient {
    if (typeof Worker === 'undefined') return new ExportClient(null);
    const worker = new Worker(new URL('./export.worker.ts', import.meta.url), {
      type: 'module',
      name: 'ynot-export',
    });
    return new ExportClient(worker);
  }

  constructor(worker: ExportWorkerLike | null) {
    this.worker = worker;
    if (!worker) return;
    worker.addEventListener('message', this.onMessage);
    worker.addEventListener('error', this.onError);
    worker.addEventListener('messageerror', this.onMessageError);
  }

  get offThread(): boolean {
    return this.worker !== null;
  }

  images(options: ImageExportOptions, job: JobOptions): ExportHandle {
    return this.start(
      (id) => ({ kind: 'images', id, options }),
      (ctx) => {
        if (!job.render) return Promise.reject(new ExportFailed('No renderer was supplied'));
        return exportImages(job.render, options, ctx);
      },
      job,
    );
  }

  embedded(
    images: ReadonlyArray<EmbeddedImageLike>,
    options: EmbeddedExportOptions,
    job: JobOptions = {},
  ): ExportHandle {
    return this.start(
      (id) => ({ kind: 'embedded', id, images, options }),
      (ctx) => Promise.resolve(exportEmbeddedImages(images, options, ctx)),
      job,
    );
  }

  text(
    pages: ReadonlyArray<ExportPage>,
    options: TextExportOptions,
    job: JobOptions = {},
  ): ExportHandle {
    return this.start(
      (id) => ({ kind: 'text', id, pages, options }),
      (ctx) => Promise.resolve(exportText(pages, options, ctx)),
      job,
    );
  }

  html(
    pages: ReadonlyArray<ExportPage>,
    options: HtmlExportOptions,
    job: JobOptions = {},
  ): ExportHandle {
    return this.start(
      (id) => ({ kind: 'html', id, pages, options }),
      (ctx) => Promise.resolve(exportHtml(pages, options, ctx)),
      job,
    );
  }

  rtf(
    pages: ReadonlyArray<ExportPage>,
    options: RtfExportOptions,
    job: JobOptions = {},
  ): ExportHandle {
    return this.start(
      (id) => ({ kind: 'rtf', id, pages, options }),
      (ctx) => Promise.resolve(exportRtf(pages, options, ctx)),
      job,
    );
  }

  terminate(): void {
    this.stop(new ExportCancelled());
  }

  private stop(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.worker?.removeEventListener?.('message', this.onMessage);
    this.worker?.removeEventListener?.('error', this.onError);
    this.worker?.removeEventListener?.('messageerror', this.onMessageError);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker?.terminate();
  }

  private start(
    request: (id: number) => ExportToWorker,
    inProcess: (ctx: ExportContext) => Promise<ExportResult>,
    job: JobOptions,
  ): ExportHandle {
    if (this.failure) return { promise: Promise.reject(this.failure), cancel: () => undefined };
    const worker = this.worker;
    if (!worker) {
      const controller = new AbortController();
      return {
        promise: inProcess({
          signal: controller.signal,
          ...(job.onProgress === undefined ? {} : { progress: job.onProgress }),
        }),
        cancel: () => {
          controller.abort();
        },
      };
    }
    const id = this.nextId++;
    const promise = new Promise<ExportResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        onProgress: job.onProgress,
        render: job.render,
      });
    });
    try {
      worker.postMessage(request(id));
    } catch (error) {
      this.stop(error instanceof Error ? error : new Error(String(error)));
    }
    return {
      promise,
      cancel: () => {
        if (!this.pending.has(id)) return;
        try {
          worker.postMessage({ kind: 'cancel', id });
        } catch (error) {
          this.stop(error instanceof Error ? error : new Error(String(error)));
        }
      },
    };
  }

  private dispatch(message: ExportFromWorker): void {
    if (message.kind === 'ready') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    switch (message.kind) {
      case 'progress':
        pending.onProgress?.(message.fraction, message.message);
        return;
      case 'render':
        void this.answerRender(message.id, message.token, message.page, message.dpi, pending);
        return;
      case 'done':
        this.pending.delete(message.id);
        pending.resolve(message.result);
        return;
      case 'failed':
        this.pending.delete(message.id);
        pending.reject(
          message.reason === 'cancelled'
            ? new ExportCancelled()
            : new ExportFailed(message.message),
        );
        return;
    }
  }

  private async answerRender(
    id: number,
    token: number,
    page: number,
    dpi: number,
    pending: Pending,
  ): Promise<void> {
    const worker = this.worker;
    if (!worker || this.failure || !this.pending.has(id)) return;
    try {
      if (!pending.render) throw new Error('No renderer was supplied');
      const raster = await pending.render(page, dpi);
      if (this.failure || !this.pending.has(id)) return;
      // A copy only when the caller handed us a view we do not own; the buffer is transferred.
      const data =
        raster.data instanceof Uint8Array
          ? raster.data
          : new Uint8Array(raster.data.buffer.slice(0));
      worker.postMessage(
        { kind: 'rendered', id, token, data, width: raster.width, height: raster.height },
        [data.buffer as ArrayBuffer],
      );
    } catch (error) {
      if (this.failure || !this.pending.has(id)) return;
      try {
        worker.postMessage({
          kind: 'rendered',
          id,
          token,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch (postError) {
        this.stop(postError instanceof Error ? postError : new Error(String(postError)));
      }
    }
  }
}
