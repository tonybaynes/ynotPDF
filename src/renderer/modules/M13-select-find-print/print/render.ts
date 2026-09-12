/**
 * Rasterising a sheet (M13). One sheet becomes one PNG at the chosen DPI: the engine renders
 * each placed page, the canvas puts it where the imposition says, and the bytes go to main.
 *
 * Sheet space is PDF points with the origin at the bottom-left; canvas space is device pixels
 * with the origin at the top-left. The flip happens once, here, so nothing upstream has to carry
 * a y-down twin of every rule.
 */

import type { DocHandle, PdfEngine, RenderOptions } from '@engine/PdfEngine';
import { canvasToPng, context2d, makeCanvas } from '../canvas';
import type { Placement, Sheet } from './imposition';

export interface SheetRenderOptions {
  readonly engine: PdfEngine;
  readonly doc: DocHandle;
  /** Dots per inch of the output bitmap. */
  readonly dpi: number;
  readonly annotations: boolean;
  readonly forms: boolean;
  readonly grayscale: boolean;
  /** Largest allowed edge in pixels, so a 1200-DPI A0 cannot ask for a bitmap that will not fit. */
  readonly maxEdge?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_MAX_EDGE = 12000;

/** Pixels per point at a DPI. */
export function pixelsPerPoint(dpi: number): number {
  return dpi / 72;
}

/** The scale, in pixels per point, that keeps a sheet inside `maxEdge`. */
export function sheetScale(sheet: Sheet, dpi: number, maxEdge = DEFAULT_MAX_EDGE): number {
  const wanted = pixelsPerPoint(dpi);
  const longest = Math.max(sheet.width, sheet.height) * wanted;
  return longest <= maxEdge ? wanted : maxEdge / Math.max(sheet.width, sheet.height);
}

/** Renders one sheet to PNG bytes. */
export async function renderSheet(sheet: Sheet, options: SheetRenderOptions): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  const scale = sheetScale(sheet, options.dpi, options.maxEdge ?? DEFAULT_MAX_EDGE);
  const width = Math.max(1, Math.round(sheet.width * scale));
  const height = Math.max(1, Math.round(sheet.height * scale));
  const canvas = makeCanvas(width, height);
  const ctx = context2d(canvas);
  if (!ctx) throw new Error('No 2D context for the print sheet');
  // Paper is white; the theme's page colour is a *screen* affordance and has no business here.
  ctx.fillStyle = '#ffffff'; // ynot-allow-color: the colour of paper, not of the interface
  ctx.fillRect(0, 0, width, height);

  for (const placement of sheet.placements) {
    options.signal?.throwIfAborted();
    if (placement.page < 0) continue;
    await drawPlacement(ctx, sheet, placement, scale, options);
  }
  options.signal?.throwIfAborted();
  return await canvasToPng(canvas);
}

async function drawPlacement(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  sheet: Sheet,
  placement: Placement,
  scale: number,
  options: SheetRenderOptions,
): Promise<void> {
  const renderOptions: RenderOptions = {
    annotations: options.annotations,
    forms: options.forms,
    grayscale: options.grayscale,
    printing: true,
    rotation: placement.rotation,
  };
  // Device pixels per point of the *source* page.
  const pageScale = placement.scale * scale;
  const result = await options.engine.render(
    options.doc,
    placement.page,
    pageScale,
    placement.clip
      ? {
          x0: placement.clip.x0,
          y0: placement.clip.y0,
          x1: placement.clip.x1,
          y1: placement.clip.y1,
        }
      : undefined,
    renderOptions,
  );
  const dx = placement.x * scale;
  const dy = (sheet.height - placement.y - placement.height) * scale;
  const dw = placement.width * scale;
  const dh = placement.height * scale;
  try {
    options.signal?.throwIfAborted();
    ctx.drawImage(result.bitmap, dx, dy, dw, dh);
  } finally {
    result.bitmap.close();
  }

  if (placement.border) {
    ctx.save();
    ctx.strokeStyle = '#000000'; // ynot-allow-color: a printed rule on paper, not interface chrome
    ctx.lineWidth = Math.max(1, scale * 0.5);
    ctx.strokeRect(dx, dy, dw, dh);
    ctx.restore();
  }
  if (placement.label) {
    ctx.save();
    ctx.fillStyle = '#000000'; // ynot-allow-color: printed tile marks
    ctx.font = `${Math.round(8 * scale)}px sans-serif`;
    ctx.fillText(placement.label, dx + 4 * scale, dy + dh - 4 * scale);
    ctx.restore();
  }
}
