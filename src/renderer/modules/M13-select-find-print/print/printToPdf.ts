/**
 * "Print to PDF" (M13). It runs the *same* imposition as the printer path, so a booklet saved to
 * a file folds the same way as one that came out of the machine — that is the whole point of
 * keeping the imposition pure.
 *
 * Two routes, chosen by the dialog's **Print as image** switch:
 *
 * - **off (default): vector.** Each source page is embedded as a Form XObject and drawn into its
 *   place. The text stays text, so the result is searchable and sharp at any zoom — and the
 *   acceptance test can read the imposition back out of the file with `textRuns`. The cost is
 *   that pdf-lib embeds a page's *content*, so annotation and form-widget appearances do not come
 *   with it.
 * - **on: raster.** Each sheet is the rendered bitmap the printer would have received, so
 *   everything visible on screen — annotations, widgets, Night Mode off — is in the file. Bigger,
 *   and no text.
 *
 * The dialog says which is which; nothing here decides for the reader.
 */

import { PDFDocument, degrees } from 'pdf-lib';
import type { DocHandle, PdfEngine } from '@engine/PdfEngine';
import { yieldMacrotask } from '@engine/yield';
import type { Placement, Sheet } from './imposition';
import { renderSheet, type SheetRenderOptions } from './render';

export interface PrintToPdfOptions {
  readonly engine: PdfEngine;
  readonly doc: DocHandle;
  readonly sheets: ReadonlyArray<Sheet>;
  /** Rasterise instead of embedding pages. */
  readonly asImage: boolean;
  readonly render: Omit<SheetRenderOptions, 'engine' | 'doc'>;
  readonly title?: string;
  readonly onProgress?: (done: number, total: number) => void;
  readonly signal?: AbortSignal;
}

/** Builds the imposed document and returns its bytes. */
export async function printToPdf(options: PrintToPdfOptions): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  out.setProducer('ynotPDF');
  out.setCreator('ynotPDF');
  if (options.title) out.setTitle(options.title);

  if (options.asImage) {
    await drawRasterSheets(out, options);
  } else {
    await drawVectorSheets(out, options);
  }
  return await out.save({ useObjectStreams: true });
}

async function drawRasterSheets(out: PDFDocument, options: PrintToPdfOptions): Promise<void> {
  const total = options.sheets.length;
  for (const [index, sheet] of options.sheets.entries()) {
    options.signal?.throwIfAborted();
    const png = await renderSheet(sheet, {
      ...options.render,
      engine: options.engine,
      doc: options.doc,
    });
    const image = await out.embedPng(png);
    const page = out.addPage([sheet.width, sheet.height]);
    page.drawImage(image, { x: 0, y: 0, width: sheet.width, height: sheet.height });
    options.onProgress?.(index + 1, total);
    await yieldMacrotask();
  }
}

async function drawVectorSheets(out: PDFDocument, options: PrintToPdfOptions): Promise<void> {
  // The engine is the source of truth for bytes, so the pages that get embedded are the ones a
  // save would produce right now — not the ones that were on disk when the document opened.
  const bytes = await options.engine.save(options.doc);
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const total = options.sheets.length;
  const embedded = new Map<string, Awaited<ReturnType<PDFDocument['embedPage']>>>();

  for (const [index, sheet] of options.sheets.entries()) {
    options.signal?.throwIfAborted();
    const page = out.addPage([sheet.width, sheet.height]);
    for (const placement of sheet.placements) {
      if (placement.page < 0) continue;
      const sourcePage = source.getPage(placement.page);
      if (!sourcePage) continue;
      const key = keyOf(placement);
      let form = embedded.get(key);
      if (!form) {
        form = placement.clip
          ? await out.embedPage(sourcePage, {
              left: placement.clip.x0,
              bottom: placement.clip.y0,
              right: placement.clip.x1,
              top: placement.clip.y1,
            })
          : await out.embedPage(sourcePage);
        embedded.set(key, form);
      }
      draw(page, form, placement);
    }
    options.onProgress?.(index + 1, total);
    await yieldMacrotask();
  }
}

function keyOf(placement: Placement): string {
  const clip = placement.clip;
  return clip
    ? `${placement.page}:${clip.x0},${clip.y0},${clip.x1},${clip.y1}`
    : `${placement.page}`;
}

/**
 * Draws one embedded page into its footprint. `Placement.rotation` is **clockwise on the sheet**
 * (the same convention as `RenderOptions.rotation`), and pdf-lib rotates anticlockwise about the
 * drawing origin, so a clockwise quarter turn is `-90°` with the origin moved to the top-left
 * corner of the footprint.
 */
function draw(
  page: ReturnType<PDFDocument['addPage']>,
  form: Awaited<ReturnType<PDFDocument['embedPage']>>,
  placement: Placement,
): void {
  const r = placement.rotation;
  // Rotating about the drawing origin moves the footprint off it, by the width for the two
  // rotations that put the page to the left of the origin and by the height for the two that
  // put it below. Written as arithmetic rather than four near-identical branches.
  page.drawPage(form, {
    x: placement.x + (r === 180 || r === 270 ? placement.width : 0),
    y: placement.y + (r === 90 || r === 180 ? placement.height : 0),
    xScale: placement.scale,
    yScale: placement.scale,
    rotate: degrees(-r),
  });
}
