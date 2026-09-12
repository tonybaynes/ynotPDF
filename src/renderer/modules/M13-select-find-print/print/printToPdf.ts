/**
 * "Print to PDF" (M13). It runs the *same* imposition as the printer path, so a booklet saved to
 * a file folds the same way as one that came out of the machine — that is the whole point of
 * keeping the imposition pure.
 *
 * Two routes, chosen by the dialog's **Print as image** switch:
 *
 * - **off (default): vector.** Each source page is embedded as a Form XObject and drawn into its
 *   place. The text stays text, so the result is searchable and sharp at any zoom — and the
 *   acceptance test can read the imposition back out of the file with `textRuns`. Printable
 *   annotation and widget appearances are baked into an isolated snapshot first.
 * - **on: raster.** Each sheet is the rendered bitmap the printer would have received, so
 *   everything visible on screen — annotations, widgets, Night Mode off — is in the file. Bigger,
 *   and no text.
 *
 * Greyscale uses PDFium's raster colour conversion, as described in the dialog.
 */

import { PDFDocument, PDFName, degrees, rgb } from 'pdf-lib';
import { effectiveBox, readRotation } from '@engine/ops/pdfdoc';
import { intersectRect } from '@engine/geometry';
import { bakePrintAppearances } from './appearances';
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
  /** Materialised model + engine snapshot supplied by the document-facing caller. */
  readonly bytes?: Uint8Array;
  readonly onProgress?: (done: number, total: number) => void;
  readonly signal?: AbortSignal;
}

/** Builds the imposed document and returns its bytes. */
export async function printToPdf(options: PrintToPdfOptions): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  const out = await PDFDocument.create();
  out.setProducer('ynotPDF');
  out.setCreator('ynotPDF');
  if (options.title) out.setTitle(options.title);

  if (options.asImage || options.render.grayscale) {
    // PDFium performs colour conversion; arbitrary ICC/pattern colours cannot be converted by
    // changing a handful of content operators. The dialog explicitly describes this raster route.
    if (options.bytes) {
      const snapshot = await options.engine.open(options.bytes.slice());
      try {
        await drawRasterSheets(out, { ...options, doc: snapshot });
      } finally {
        await options.engine.close(snapshot);
      }
    } else await drawRasterSheets(out, options);
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
  const bytes = options.bytes ?? (await options.engine.save(options.doc, { removeSecurity: true }));
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  options.signal?.throwIfAborted();
  const wanted = new Set(
    options.sheets.flatMap((sheet) =>
      sheet.placements.filter((p) => p.page >= 0).map((p) => p.page),
    ),
  );
  bakePrintAppearances(source, wanted, options.render);
  // embedPage ignores /Rotate and defaults to MediaBox. Normalize the visible crop into
  // displayed page coordinates before applying n-up/booklet rotations or displayed tile clips.
  const normalized = await PDFDocument.create();
  const normalizedPages = new Map<number, ReturnType<PDFDocument['addPage']>>();
  for (const index of wanted) {
    options.signal?.throwIfAborted();
    const original = source.getPage(index);
    if (!original.node.get(PDFName.of('Contents'))) {
      original.node.set(
        PDFName.of('Contents'),
        source.context.register(source.context.flateStream('')),
      );
    }
    const box = intersectRect(
      effectiveBox(original.node, 'crop'),
      effectiveBox(original.node, 'media'),
    );
    const rotation = readRotation(original.node) as Placement['rotation'];
    const swap = rotation === 90 || rotation === 270;
    const width = swap ? box.y1 - box.y0 : box.x1 - box.x0;
    const height = swap ? box.x1 - box.x0 : box.y1 - box.y0;
    const form = await normalized.embedPage(original, {
      left: box.x0,
      bottom: box.y0,
      right: box.x1,
      top: box.y1,
    });
    const page = normalized.addPage([width, height]);
    draw(page, form, { page: index, x: 0, y: 0, width, height, scale: 1, rotation });
    normalizedPages.set(index, page);
  }
  // Complete nested embedders before these pages themselves are copied into the output.
  await normalized.flush();
  const total = options.sheets.length;
  const embedded = new Map<string, Awaited<ReturnType<PDFDocument['embedPage']>>>();

  for (const [index, sheet] of options.sheets.entries()) {
    options.signal?.throwIfAborted();
    const page = out.addPage([sheet.width, sheet.height]);
    for (const placement of sheet.placements) {
      if (placement.page < 0) continue;
      const sourcePage = normalizedPages.get(placement.page);
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
      if (placement.border)
        page.drawRectangle({
          x: placement.x,
          y: placement.y,
          width: placement.width,
          height: placement.height,
          borderWidth: 0.5,
          borderColor: rgb(0, 0, 0), // ynot-allow-color: printed rule on paper, not interface chrome
        });
      if (placement.label)
        page.drawText(placement.label, {
          x: placement.x + 4,
          y: placement.y + 4,
          size: 8,
          color: rgb(0, 0, 0), // ynot-allow-color: printed tile label
        });
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
