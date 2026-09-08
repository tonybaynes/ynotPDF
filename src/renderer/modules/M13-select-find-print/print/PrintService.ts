/**
 * `PrintService` (M13) — the orchestration between the print dialog, the engine and main.
 *
 * The renderer keeps the interesting half of printing: it imposes the pages and rasterises the
 * sheets, because that is where the engine lives. Main only receives finished sheets and gives
 * them to `webContents.print()` (ADR 0011). Sheets are sent one at a time so a hundred-page job
 * at 300 DPI never exists all at once in either process.
 */

import type { DocHandle, PdfEngine } from '@engine/PdfEngine';
import { hasBridge, invoke, type PrintJobResult, type PrinterInfo } from '@shared/ipc';
import type { PrintSettings } from '../settings';
import { buildPrintPlan, type PrintPlan, type PrintPlanInput } from './plan';
import { printToPdf } from './printToPdf';
import { renderSheet } from './render';
import type { Sheet } from './imposition';

export interface PrintSource {
  readonly engine: PdfEngine;
  readonly doc: DocHandle;
  readonly title: string;
}

export interface PrintRunOptions {
  readonly source: PrintSource;
  readonly plan: PrintPlan;
  readonly settings: PrintSettings;
  readonly onProgress?: (done: number, total: number) => void;
  readonly signal?: AbortSignal;
  /** Build the job in main but do not send it to a printer (the e2e suite). */
  readonly dryRun?: boolean;
}

export class PrintService {
  /** Printers the OS knows about; empty outside Electron. */
  async printers(): Promise<PrinterInfo[]> {
    if (!hasBridge()) return [];
    try {
      return await invoke('print:printers');
    } catch {
      return [];
    }
  }

  /** The plan for a set of settings — pure, and what the dialog previews. */
  plan(input: PrintPlanInput): PrintPlan {
    return buildPrintPlan(input);
  }

  /** Renders every sheet and prints them. */
  async print(options: PrintRunOptions): Promise<PrintJobResult> {
    const { plan, settings, source } = options;
    if (plan.error) return { sheets: 0, printed: false, documentPath: null, error: plan.error };
    if (!hasBridge()) {
      return {
        sheets: plan.sheets.length,
        printed: false,
        documentPath: null,
        error: 'Printing needs the desktop app',
      };
    }
    const jobId = await invoke('print:begin', {
      widthPt: plan.paper.width,
      heightPt: plan.paper.height,
      printer: settings.printer,
      copies: settings.copies,
      collate: settings.collate,
      grayscale: settings.grayscale,
      title: source.title,
      ...(options.dryRun ? { dryRun: true } : {}),
    });
    try {
      for (const [index, sheet] of plan.sheets.entries()) {
        options.signal?.throwIfAborted();
        const png = await this.renderSheet(sheet, source, settings);
        await invoke('print:sheet', jobId, png);
        options.onProgress?.(index + 1, plan.sheets.length);
      }
      return await invoke('print:finish', jobId);
    } catch (error) {
      await invoke('print:cancel', jobId).catch(() => undefined);
      return {
        sheets: 0,
        printed: false,
        documentPath: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** The bytes of "Print to PDF" — the same imposition, written to a file instead. */
  async toPdf(options: PrintRunOptions): Promise<Uint8Array> {
    const { plan, settings, source } = options;
    if (plan.error) throw new Error(plan.error);
    return await printToPdf({
      engine: source.engine,
      doc: source.doc,
      sheets: plan.sheets,
      asImage: settings.printAsImage,
      render: {
        dpi: settings.dpi,
        annotations: settings.annotations,
        forms: settings.forms,
        grayscale: settings.grayscale,
      },
      title: source.title,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /** One sheet as PNG bytes, at the job's DPI. */
  renderSheet(sheet: Sheet, source: PrintSource, settings: PrintSettings): Promise<Uint8Array> {
    return renderSheet(sheet, {
      engine: source.engine,
      doc: source.doc,
      dpi: settings.dpi,
      annotations: settings.annotations,
      forms: settings.forms,
      grayscale: settings.grayscale,
    });
  }

  /**
   * A preview sheet as an object URL, rendered at screen resolution rather than the job's DPI —
   * a 300-DPI A4 preview thumbnail would be a 2 500-pixel image scaled into a 200-pixel box.
   */
  async previewUrl(sheet: Sheet, source: PrintSource, settings: PrintSettings): Promise<string> {
    const png = await renderSheet(sheet, {
      engine: source.engine,
      doc: source.doc,
      dpi: 96,
      annotations: settings.annotations,
      forms: settings.forms,
      grayscale: settings.grayscale,
      maxEdge: 1400,
    });
    return URL.createObjectURL(new Blob([png.slice()], { type: 'image/png' }));
  }
}
