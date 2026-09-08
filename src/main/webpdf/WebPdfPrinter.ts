/**
 * Chromium's print-to-PDF, one hidden sandboxed window per job (M91, ADR 0011).
 *
 * Main returns bytes and data only: the PDF, the page's title, its final URL and every link on
 * it. Every decision about what the document looks like is made by the caller through
 * `WebPrintSettings`, and `printOptionsFor` is the one place those settings become Electron's
 * `printToPDF` options — it is pure so it can be unit-tested without a window.
 */

import { app, BrowserWindow } from 'electron';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WebPrintSettings, WebRenderRequest, WebRenderResult } from '../../shared/create';
import { marginsToPoints, resolvePageSize, sizeInInches } from '../../shared/pageSizes';

/** How long `document.fonts.ready` may hold the print back. */
const FONTS_READY_CAP_MS = 2_000;
/** A short breath after load so late layout (web fonts swapping in) settles before printing. */
const SETTLE_MS = 150;
/** Upper bound on the links reported for one page — a sitemap-sized page cannot flood IPC. */
const MAX_LINKS = 5_000;
/** Chromium's `net::ERR_ABORTED`: a navigation superseded by another (a redirect, a cancel). */
const ERR_ABORTED = -3;

const PRINTABLE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'file:']);

/** True for the URL schemes the hidden window may load: `http:`, `https:` and `file:`. */
export function isPrintableUrl(url: string): boolean {
  try {
    return PRINTABLE_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/*
 * Chromium's print header/footer templates. Only sizes and spacing are styled — the page's own
 * colours are left to Chromium's defaults, and no colour literal may appear in a source file.
 */
const HEADER_TEMPLATE =
  '<div style="font-size:8px;width:100%;margin:0 10mm;display:flex;justify-content:space-between">' +
  '<span class="title"></span><span class="date"></span></div>';
const FOOTER_TEMPLATE =
  '<div style="font-size:8px;width:100%;margin:0 10mm;display:flex;justify-content:space-between">' +
  '<span class="url"></span>' +
  '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>';

/**
 * Turns the shared print settings into Electron's `printToPDF` options. The page size is passed
 * already oriented, in inches, so `landscape` is always `false`; margins are clamped by
 * `marginsToPoints` so they can never swallow the page.
 */
export function printOptionsFor(settings: WebPrintSettings): Electron.PrintToPDFOptions {
  const sizePt = resolvePageSize(settings.pageSize, settings.orientation);
  const size = sizeInInches(sizePt);
  const marginsPt = marginsToPoints(settings.margins, sizePt);
  const scale = Number.isFinite(settings.scale) ? Math.min(2, Math.max(0.1, settings.scale)) : 1;
  return {
    pageSize: { width: size.width, height: size.height },
    landscape: false,
    margins: {
      top: marginsPt.top / 72,
      right: marginsPt.right / 72,
      bottom: marginsPt.bottom / 72,
      left: marginsPt.left / 72,
    },
    printBackground: settings.backgroundGraphics,
    scale,
    preferCSSPageSize: settings.preferCssPageSize,
    displayHeaderFooter: settings.headerFooter,
    ...(settings.headerFooter
      ? { headerTemplate: HEADER_TEMPLATE, footerTemplate: FOOTER_TEMPLATE }
      : {}),
    generateDocumentOutline: false,
  };
}

interface Job {
  readonly win: BrowserWindow;
  cancelled: boolean;
  /** Rejects the pending render; set once the load has started. */
  fail: ((error: Error) => void) | null;
}

/** A job id as a file name: anything outside `[A-Za-z0-9_-]` becomes `_`. */
function safeFileName(jobId: string): string {
  const cleaned = jobId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'job';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `promise` but gives up (resolving with `fallback`) after `ms`. */
function withCap<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const capped = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(fallback);
    }, ms);
  });
  return Promise.race([promise, capped]).finally(() => {
    clearTimeout(timer);
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WebPdfPrinter {
  readonly #jobs = new Map<string, Job>();

  /**
   * Loads the request's source in a hidden window and prints it. Rejects on a URL scheme that
   * is not printable, a failed load, a timeout, or a cancel (`Error('cancelled')`).
   */
  async render(request: WebRenderRequest): Promise<WebRenderResult> {
    const { jobId, source, settings } = request;
    if (this.#jobs.has(jobId)) throw new Error(`A render job named "${jobId}" is already running`);
    if (source.kind === 'url' && !isPrintableUrl(source.url)) {
      throw new Error(`Only http:, https: and file: URLs can be printed (got ${source.url})`);
    }

    const warnings: string[] = [];
    const win = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    const job: Job = { win, cancelled: false, fail: null };
    this.#jobs.set(jobId, job);

    const contents = win.webContents;
    let loaded = false;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // The first navigation (and its redirects) is the page we were asked for; after that the
    // page stays put — a script must not walk the hidden window somewhere else.
    contents.on('will-navigate', (event) => {
      if (loaded) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });

    let tempFile: string | null = null;
    let debuggerAttached = false;
    try {
      // Media emulation goes through the DevTools protocol; `print` is what Chromium prints
      // under anyway, so only `screen` needs the debugger.
      if (settings.media === 'screen') {
        try {
          contents.debugger.attach('1.3');
          debuggerAttached = true;
          await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'screen' });
        } catch (error) {
          warnings.push(`Could not emulate screen media: ${describe(error)}`);
        }
      }

      let url: string;
      if (source.kind === 'url') {
        url = source.url;
      } else {
        // Generated HTML is printed from a file, not a `data:` URL, so that a `<base href>` in it
        // may point at `file:` images (design decisions, M91). The HTML carries its own <base>.
        const dir = join(app.getPath('temp'), 'ynotpdf-create');
        await mkdir(dir, { recursive: true });
        tempFile = join(dir, `${safeFileName(jobId)}.html`);
        await writeFile(tempFile, source.html, 'utf8');
        url = pathToFileURL(tempFile).href;
      }

      await this.#load(job, url, settings.timeoutMs);
      loaded = true;
      if (job.cancelled || contents.isDestroyed()) throw new Error('cancelled');

      await withCap(
        contents
          .executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true')
          .catch((error: unknown) => {
            warnings.push(`Could not wait for fonts: ${describe(error)}`);
            return false;
          }),
        FONTS_READY_CAP_MS,
        false,
      );
      await delay(SETTLE_MS);
      if (job.cancelled || contents.isDestroyed()) throw new Error('cancelled');

      const finalUrl = contents.getURL() || url;
      const title = contents.getTitle().trim() || finalUrl;
      const links = await this.#collectLinks(contents, warnings);

      const buffer = await contents.printToPDF(printOptionsFor(settings));
      if (job.cancelled) throw new Error('cancelled');
      return { url: finalUrl, title, pdf: new Uint8Array(buffer), links, warnings };
    } catch (error) {
      // A window destroyed by `cancel` fails in whatever way it was busy; the caller asked for
      // the cancel and gets it named as such.
      if (job.cancelled) throw new Error('cancelled', { cause: error });
      throw error;
    } finally {
      this.#jobs.delete(jobId);
      job.fail = null;
      if (debuggerAttached && !contents.isDestroyed() && contents.debugger.isAttached()) {
        try {
          contents.debugger.detach();
        } catch {
          // The page may have gone away with the debugger still attached; nothing to undo.
        }
      }
      if (!win.isDestroyed()) win.destroy();
      if (tempFile !== null) {
        await rm(tempFile, { force: true }).catch(() => undefined);
      }
    }
  }

  /** Destroys a job's window. The pending `render` then rejects with `Error('cancelled')`. */
  cancel(jobId: string): void {
    const job = this.#jobs.get(jobId);
    if (!job) return;
    job.cancelled = true;
    if (!job.win.isDestroyed()) job.win.destroy();
    job.fail?.(new Error('cancelled'));
  }

  /** Cancels every job. Called when the app quits. */
  dispose(): void {
    for (const jobId of Array.from(this.#jobs.keys())) this.cancel(jobId);
  }

  /**
   * Starts the navigation and resolves on `did-finish-load`. Rejects on a main-frame load
   * failure (sub-frame failures and `ERR_ABORTED` — a superseded navigation — are not failures),
   * on the job's timeout, or when the window is destroyed under us.
   */
  #load(job: Job, url: string, timeoutMs: number): Promise<void> {
    const contents = job.win.webContents;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => {
          finish(new Error(`Timed out after ${timeoutMs} ms waiting for ${url} to load`));
        },
        Math.max(1, timeoutMs),
      );
      const finish = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.fail = null;
        if (!contents.isDestroyed()) {
          contents.removeListener('did-finish-load', onFinish);
          contents.removeListener('did-fail-load', onFail);
          contents.removeListener('destroyed', onDestroyed);
        }
        if (error) reject(error);
        else resolve();
      };
      const onFinish = (): void => {
        finish(null);
      };
      const onFail = (
        _event: Electron.Event,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean,
      ): void => {
        if (!isMainFrame || errorCode === ERR_ABORTED) return;
        finish(
          new Error(`Could not load ${validatedURL || url}: ${errorDescription} (${errorCode})`),
        );
      };
      const onDestroyed = (): void => {
        finish(new Error('cancelled'));
      };
      job.fail = finish;
      contents.on('did-finish-load', onFinish);
      contents.on('did-fail-load', onFail);
      contents.on('destroyed', onDestroyed);
      contents.loadURL(url).catch((error: unknown) => {
        // `loadURL` itself rejects on a main-frame failure with the same information the
        // `did-fail-load` event carries; whichever arrives first wins, and ERR_ABORTED is a
        // redirect or a cancel, never a failure of its own.
        const code = (error as { errno?: number }).errno;
        if (code === ERR_ABORTED) return;
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async #collectLinks(
    contents: Electron.WebContents,
    warnings: string[],
  ): Promise<ReadonlyArray<string>> {
    try {
      const raw: unknown = await contents.executeJavaScript(
        `Array.from(document.links).map((a) => a.href).slice(0, ${MAX_LINKS})`,
      );
      if (!Array.isArray(raw)) return [];
      return raw.filter((href): href is string => typeof href === 'string').slice(0, MAX_LINKS);
    } catch (error) {
      warnings.push(`Could not read the page's links: ${describe(error)}`);
      return [];
    }
  }
}
