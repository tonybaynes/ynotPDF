/**
 * Folder search, main-process half (M13, ADR 0011). Owns the worker threads, forwards their
 * messages to the window that asked, and makes sure a window that goes away does not leave a
 * worker chewing through a folder for nobody.
 *
 * The PDFium wasm is read here rather than in the worker: in a packaged app it lives inside
 * `app.asar`, and asar-aware `fs` is a main-process guarantee.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { BrowserWindow } from 'electron';
import type { FolderSearchRequest } from '../../shared/ipc';
import { sendTo } from '../window';
import type { SearchWorkerMessage } from './worker';

const require_ = createRequire(import.meta.url);

/** Where the worker bundle lands (see `electron.vite.config.ts`). */
function workerPath(): string {
  return join(import.meta.dirname, 'searchWorker.js');
}

/** The PDFium wasm, read once and shared by every search. */
let wasmCache: Uint8Array | null = null;

function loadWasm(): Uint8Array {
  if (wasmCache) return wasmCache;
  const path = require_.resolve('@hyzyla/pdfium/dist/pdfium.wasm');
  wasmCache = new Uint8Array(readFileSync(path));
  return wasmCache;
}

interface Job {
  readonly id: string;
  readonly worker: Worker;
  readonly windowId: number;
}

export class FolderSearches {
  private readonly jobs = new Map<string, Job>();
  private counter = 0;

  /** Starts a search and returns its job id. Everything else arrives as events. */
  start(win: BrowserWindow, request: FolderSearchRequest): string {
    const id = `search-${++this.counter}-${Date.now().toString(36)}`;
    const worker = new Worker(workerPath(), {
      workerData: { wasm: loadWasm(), request },
    });
    const job: Job = { id, worker, windowId: win.id };
    this.jobs.set(id, job);

    const send = (message: SearchWorkerMessage): void => {
      if (win.isDestroyed()) {
        this.cancel(id);
        return;
      }
      switch (message.kind) {
        case 'progress':
          sendTo(win, 'search:progress', {
            jobId: id,
            scanned: message.scanned,
            total: message.total,
            file: message.file,
          });
          break;
        case 'results':
          sendTo(win, 'search:results', { jobId: id, hits: message.hits });
          break;
        case 'done':
          sendTo(win, 'search:done', {
            jobId: id,
            cancelled: false,
            hits: message.hits,
            ...(message.error !== undefined ? { error: message.error } : {}),
          });
          this.forget(id);
          break;
      }
    };

    worker.on('message', (message: SearchWorkerMessage) => {
      send(message);
    });
    worker.on('error', (error: Error) => {
      if (!win.isDestroyed()) {
        sendTo(win, 'search:done', { jobId: id, cancelled: false, hits: 0, error: error.message });
      }
      this.forget(id);
    });
    worker.on('exit', () => {
      this.jobs.delete(id);
    });
    return id;
  }

  /** Stops a search. The renderer is told, so a cancelled panel can say so. */
  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    void job.worker.terminate();
  }

  /** Cancels every search started by a window that has gone. */
  release(windowId: number): void {
    for (const job of [...this.jobs.values()]) {
      if (job.windowId === windowId) this.cancel(job.id);
    }
  }

  disposeAll(): void {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }

  private forget(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    void job.worker.terminate();
  }
}
