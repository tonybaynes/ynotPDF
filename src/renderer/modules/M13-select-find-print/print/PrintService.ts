/**
 * `PrintService` (M13) — the orchestration between the print dialog, the engine and main.
 *
 * The renderer keeps the interesting half of printing: it imposes the pages and rasterises the
 * sheets, because that is where the engine lives. Main only receives finished sheets and gives
 * them to `webContents.print()` (ADR 0012). Sheets are sent one at a time so a hundred-page job
 * at 300 DPI never exists all at once in either process.
 */

import { hasBridge, invoke, type PrintJobResult, type PrinterInfo } from '@shared/ipc';
import type { PrintSettings } from '../settings';
import { buildPrintPlan, type PrintPlan, type PrintPlanInput } from './plan';
import { printToPdf } from './printToPdf';
import { renderSheet } from './render';
import type { Sheet } from './imposition';
import { withRasterSnapshot, type RasterPrintSource } from './rasterSnapshot';

export interface PrintSource extends RasterPrintSource {
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
    let jobId: string | undefined;
    try {
      return await withRasterSnapshot(
        source,
        new Set(
          plan.sheets.flatMap((sheet) =>
            sheet.placements.filter((p) => p.page >= 0).map((p) => p.page),
          ),
        ),
        settings,
        options.signal,
        async (doc) => {
          const check = (): void => {
            options.signal?.throwIfAborted();
            source.assertCurrent?.();
          };
          check();
          jobId = await invoke('print:begin', {
            widthPt: plan.paper.width,
            heightPt: plan.paper.height,
            printer: settings.printer,
            copies: settings.copies,
            collate: settings.collate,
            grayscale: settings.grayscale,
            title: source.title,
            ...(options.dryRun ? { dryRun: true } : {}),
          });
          for (const [index, sheet] of plan.sheets.entries()) {
            check();
            const png = await this.renderSheet(
              sheet,
              { ...source, doc },
              { ...settings, annotations: false, forms: false },
              options.signal,
            );
            check();
            await invoke('print:sheet', jobId, png);
            options.onProgress?.(index + 1, plan.sheets.length);
          }
          check();
          return await invoke('print:finish', jobId);
        },
      );
    } catch (error) {
      if (jobId) await invoke('print:cancel', jobId).catch(() => undefined);
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
    options.signal?.throwIfAborted();
    source.assertCurrent?.();
    const bytes = await printToPdf({
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
      ...(source.snapshot ? { bytes: await source.snapshot(options.signal) } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    options.signal?.throwIfAborted();
    source.assertCurrent?.();
    return bytes;
  }

  /** One sheet as PNG bytes, at the job's DPI. */
  renderSheet(
    sheet: Sheet,
    source: PrintSource,
    settings: PrintSettings,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return renderSheet(sheet, {
      engine: source.engine,
      doc: source.doc,
      dpi: settings.dpi,
      annotations: settings.annotations,
      forms: settings.forms,
      grayscale: settings.grayscale,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * A preview sheet as an object URL, rendered at screen resolution rather than the job's DPI —
   * a 300-DPI A4 preview thumbnail would be a 2 500-pixel image scaled into a 200-pixel box.
   */
  async previewUrl(
    sheet: Sheet,
    source: PrintSource,
    settings: PrintSettings,
    signal?: AbortSignal,
  ): Promise<string> {
    const pages = new Set(sheet.placements.filter((p) => p.page >= 0).map((p) => p.page));
    const png = await withRasterSnapshot(source, pages, settings, signal, (doc) =>
      renderSheet(sheet, {
        engine: source.engine,
        doc,
        dpi: 96,
        annotations: false,
        forms: false,
        grayscale: settings.grayscale,
        maxEdge: 1400,
        ...(signal ? { signal } : {}),
      }),
    );
    signal?.throwIfAborted();
    source.assertCurrent?.();
    return URL.createObjectURL(new Blob([png.slice()], { type: 'image/png' }));
  }
}
