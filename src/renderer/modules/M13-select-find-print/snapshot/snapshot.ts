/**
 * Snapshot (M13): a marquee over part of a page becomes a bitmap at a chosen resolution, on the
 * clipboard, in a file, or both — Foxit's camera tool.
 *
 * The size arithmetic is separated from the rendering so the acceptance test can state what a
 * snapshot of a known rectangle at a known DPI must measure, and check it, without a canvas.
 */

import type { DocHandle, PdfEngine } from '@engine/PdfEngine';
import type { PdfRect } from '@shared/pdf';
import { canvasToPng, context2d, makeCanvas } from '../canvas';

/** Pixel size of a snapshot of `rect` at `dpi`. */
export function snapshotPixelSize(
  rect: PdfRect,
  dpi: number,
): { readonly width: number; readonly height: number; readonly scale: number } {
  const scale = dpi / 72;
  return {
    width: Math.max(1, Math.round(Math.abs(rect.x1 - rect.x0) * scale)),
    height: Math.max(1, Math.round(Math.abs(rect.y1 - rect.y0) * scale)),
    scale,
  };
}

/** Normalises a marquee and clamps it to the page box. */
export function clampRegion(rect: PdfRect, page: PdfRect): PdfRect {
  const x0 = Math.max(page.x0, Math.min(rect.x0, rect.x1));
  const x1 = Math.min(page.x1, Math.max(rect.x0, rect.x1));
  const y0 = Math.max(page.y0, Math.min(rect.y0, rect.y1));
  const y1 = Math.min(page.y1, Math.max(rect.y0, rect.y1));
  return { x0, y0, x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

export interface SnapshotRequest {
  readonly engine: PdfEngine;
  readonly doc: DocHandle;
  readonly page: number;
  readonly rect: PdfRect;
  readonly dpi: number;
  readonly annotations: boolean;
  readonly forms: boolean;
  readonly grayscale: boolean;
}

export interface SnapshotResult {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** Renders the region and encodes it as PNG. */
export async function renderSnapshot(request: SnapshotRequest): Promise<SnapshotResult> {
  const { scale } = snapshotPixelSize(request.rect, request.dpi);
  const result = await request.engine.render(request.doc, request.page, scale, request.rect, {
    annotations: request.annotations,
    forms: request.forms,
    grayscale: request.grayscale,
    printing: false,
  });
  const bitmap = result.bitmap;
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  const ctx = context2d(canvas);
  if (!ctx) throw new Error('No 2D context for the snapshot');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await canvasToPng(canvas);
  return { png, width: canvas.width, height: canvas.height };
}

/** A file name a snapshot should default to. */
export function snapshotFileName(documentTitle: string, page: number): string {
  const base = documentTitle.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/gu, '-') || 'snapshot';
  return `${base}-page-${page + 1}.png`;
}
