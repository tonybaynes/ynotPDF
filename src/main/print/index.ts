/**
 * Printing (M13, ADR 0012). Electron gives a desktop app exactly one cross-platform way to put
 * ink on paper: `webContents.print()`. So a print job becomes a tiny HTML document — one `<img>`
 * per sheet, each declared at the exact paper size, with `@page { margin: 0 }` — loaded into a
 * hidden `BrowserWindow` and printed.
 *
 * The renderer has already done the interesting half: it imposed the pages onto sheets and
 * rasterised each sheet at the chosen DPI. This file only has to not get in the way — which
 * mostly means writing the sheets to a temporary folder and referencing them by relative path,
 * because a hundred 300-DPI sheets inlined as data URLs is a string no process should be asked
 * to hold.
 *
 * Every job cleans up after itself: the temporary folder goes when the job finishes, is
 * cancelled, or when the app quits with a job still open.
 */

import { BrowserWindow } from 'electron';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrintJobResult, PrintJobSetup } from '../../shared/ipc';

/** Microns per PDF point (1 pt = 1/72 in, 1 in = 25 400 µm). */
const MICRONS_PER_POINT = 25400 / 72;

interface Job {
  readonly id: string;
  readonly dir: string;
  readonly setup: PrintJobSetup;
  readonly sheets: string[];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The print document. The sheet size is declared three times over — `@page size`, the image's
 * CSS box and Electron's `pageSize` — because each of the three is authoritative for a different
 * part of the pipeline and disagreeing about it is how a print ends up scaled by 96/72.
 */
export function buildPrintHtml(setup: PrintJobSetup, sheets: ReadonlyArray<string>): string {
  const w = setup.widthPt;
  const h = setup.heightPt;
  const images = sheets.map((name) => `<img src="${escapeHtml(name)}" alt="" />`).join('\n      ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(setup.title ?? 'ynotPDF')}</title>
    <style>
      @page { size: ${w}pt ${h}pt; margin: 0; }
      html, body { margin: 0; padding: 0; }
      img {
        display: block;
        width: ${w}pt;
        height: ${h}pt;
        break-after: page;
        page-break-after: always;
      }
      img:last-of-type { break-after: auto; page-break-after: auto; }
    </style>
  </head>
  <body>
      ${images}
  </body>
</html>
`;
}

export class PrintJobs {
  private readonly jobs = new Map<string, Job>();
  private counter = 0;

  /** Opens a job and returns its id. Sheets are added one at a time afterwards. */
  begin(setup: PrintJobSetup): string {
    const id = `print-${++this.counter}-${Date.now().toString(36)}`;
    const dir = mkdtempSync(join(tmpdir(), 'ynot-print-'));
    this.jobs.set(id, { id, dir, setup, sheets: [] });
    return id;
  }

  /** Writes one rendered sheet. Sheets print in the order they are added. */
  addSheet(id: string, png: Uint8Array): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown print job ${id}`);
    const name = `sheet-${String(job.sheets.length).padStart(4, '0')}.png`;
    writeFileSync(join(job.dir, name), png);
    job.sheets.push(name);
  }

  sheetCount(id: string): number {
    return this.jobs.get(id)?.sheets.length ?? 0;
  }

  /** Builds the document and prints it. A dry run stops after building it. */
  async finish(id: string, parent: BrowserWindow | null): Promise<PrintJobResult> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown print job ${id}`);
    const documentPath = join(job.dir, 'print.html');
    writeFileSync(documentPath, buildPrintHtml(job.setup, job.sheets), 'utf8');
    if (job.sheets.length === 0) {
      this.cancel(id);
      return { sheets: 0, printed: false, documentPath: null, error: 'Nothing to print' };
    }
    if (job.setup.dryRun) {
      // The folder is left in place so the test can read it; the caller cancels when it is done.
      return { sheets: job.sheets.length, printed: false, documentPath };
    }
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await win.loadFile(documentPath);
      await imagesReady(win);
      const printed = await print(win, job.setup);
      return { sheets: job.sheets.length, printed, documentPath: null };
    } catch (error) {
      return {
        sheets: job.sheets.length,
        printed: false,
        documentPath: null,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (!win.isDestroyed()) win.destroy();
      this.cancel(id);
      if (parent && !parent.isDestroyed()) parent.focus();
    }
  }

  /** Drops a job and deletes its temporary folder. Safe to call twice. */
  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    try {
      rmSync(job.dir, { recursive: true, force: true });
    } catch {
      // A temporary folder that will not delete is not worth failing a print over.
    }
  }

  disposeAll(): void {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }
}

/** Resolves once every `<img>` in the print document has decoded. */
async function imagesReady(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(
    `Promise.all(Array.from(document.images).map((i) => i.complete ? null : i.decode().catch(() => null))).then(() => true)`,
  );
}

function print(win: BrowserWindow, setup: PrintJobSetup): Promise<boolean> {
  return new Promise((resolve, reject) => {
    win.webContents.print(
      {
        silent: true,
        printBackground: true,
        ...(setup.printer ? { deviceName: setup.printer } : {}),
        copies: Math.max(1, Math.round(setup.copies ?? 1)),
        collate: setup.collate ?? true,
        color: !(setup.grayscale ?? false),
        margins: { marginType: 'none' },
        pageSize: {
          width: Math.round(setup.widthPt * MICRONS_PER_POINT),
          height: Math.round(setup.heightPt * MICRONS_PER_POINT),
        },
        landscape: false,
      },
      (success, reason) => {
        // "cancelled" is the reader changing their mind, not a failure.
        if (success || reason === 'cancelled') resolve(success);
        else reject(new Error(reason));
      },
    );
  });
}
