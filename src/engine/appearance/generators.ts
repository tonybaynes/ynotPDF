/**
 * Appearance generators (M21) — what is left here after the families moved out.
 *
 * PDFium synthesises `/AP` for Highlight, Underline, StrikeOut, Squiggly, Square, Circle, Ink,
 * Text and Popup when it loads a page, so a file we save through it usually carries those
 * already. It does **not** synthesise Line, Polygon, PolyLine, FreeText, FileAttachment, Stamp or
 * Caret — those annotations reach other viewers as bare dictionaries and are drawn by guesswork,
 * or not at all. The generators fill the gap, and cover the rest too so a file that arrived from
 * a viewer which never generated them is repaired on save.
 *
 * Text markup, free text and the caret live in `markup.ts`, `freetext.ts` and `note.ts` (M30,
 * ADR 0013); the shapes in `shapes.ts`, ink in `ink.ts` and stamps in `stamp.ts` (M31, ADR 0015).
 * What remains here is the file-attachment pin and the quad helper the markup family shares.
 *
 * Every generator draws in page space (the same space as `/Rect`) and the writer emits an
 * identity `/Matrix`, so the stream's coordinates are the annotation's own — no transform to get
 * wrong.
 */

import type { PdfRect } from '@shared/pdf';
import { ContentBuilder } from './content';
import type { AppearanceGenerator, AppearanceInput, AppearanceStream } from './types';

/** Applies `/CA` as a graphics state when it is anything but fully opaque. */
function applyOpacity(builder: ContentBuilder, input: AppearanceInput): void {
  const alpha = input.opacity;
  if (alpha === null || alpha >= 1) return;
  builder.graphicsState({ fillAlpha: alpha, strokeAlpha: alpha });
}

/** The stream's BBox: the annotation rect, grown by a little so a stroke is not clipped. */
function bboxFor(input: AppearanceInput): PdfRect {
  const pad = 0.5;
  return {
    x0: input.rect.x0 - pad,
    y0: input.rect.y0 - pad,
    x1: input.rect.x1 + pad,
    y1: input.rect.y1 + pad,
  };
}

function finish(input: AppearanceInput, builder: ContentBuilder): AppearanceStream | null {
  if (builder.isEmpty) return null;
  return { bbox: bboxFor(input), content: builder.build(), resources: builder.resources };
}

/** Each group of eight quad numbers, as its bounding rectangle. */
export function quadRects(quadPoints: ReadonlyArray<number>): PdfRect[] {
  const rects: PdfRect[] = [];
  for (let i = 0; i + 7 < quadPoints.length; i += 8) {
    const xs = [quadPoints[i], quadPoints[i + 2], quadPoints[i + 4], quadPoints[i + 6]];
    const ys = [quadPoints[i + 1], quadPoints[i + 3], quadPoints[i + 5], quadPoints[i + 7]];
    const numbers = (list: (number | undefined)[]): number[] =>
      list.filter((n): n is number => typeof n === 'number');
    const x = numbers(xs);
    const y = numbers(ys);
    if (x.length < 4 || y.length < 4) continue;
    rects.push({
      x0: Math.min(...x),
      y0: Math.min(...y),
      x1: Math.max(...x),
      y1: Math.max(...y),
    });
  }
  return rects;
}

// ---- small marks -------------------------------------------------------------------------------

/** The icons a file attachment may show (`/Name`), and the words the panel uses for them. */
export const ATTACHMENT_ICONS = ['PushPin', 'Paperclip', 'Graph', 'Tag'] as const;
export type AttachmentIcon = (typeof ATTACHMENT_ICONS)[number];
export const ATTACHMENT_ICON_LABELS: Readonly<Record<AttachmentIcon, string>> = {
  PushPin: 'Push pin',
  Paperclip: 'Paper clip',
  Graph: 'Graph',
  Tag: 'Tag',
};

export function isAttachmentIcon(value: unknown): value is AttachmentIcon {
  return typeof value === 'string' && (ATTACHMENT_ICONS as ReadonlyArray<string>).includes(value);
}

/**
 * `/FileAttachment`: the icon `/Name` asks for, drawn to fill the rect. PDFium draws nothing for
 * these. Four icons, as the PDF spec names them; anything else is the push pin.
 */
export const fileAttachmentAppearance: AppearanceGenerator = (input) => {
  const { x0, y0, x1, y1 } = input.rect;
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const b = new ContentBuilder();
  const at = (fx: number, fy: number): [number, number] => [x0 + fx * w, y0 + fy * h];
  const colour = input.color ?? 0x000000;
  b.save();
  applyOpacity(b, input);
  b.fillColor(colour)
    .strokeColor(colour)
    .lineWidth(Math.max(0.5, Math.min(w, h) / 12))
    .lineCap(1)
    .lineJoin(1);
  const icon = isAttachmentIcon(input.extra['icon']) ? input.extra['icon'] : 'PushPin';
  switch (icon) {
    case 'Paperclip':
      // A clip: an outer loop and an inner one, open at the top.
      b.moveTo(...at(0.3, 0.15));
      b.lineTo(...at(0.3, 0.75));
      b.curveTo(...at(0.3, 0.95), ...at(0.7, 0.95), ...at(0.7, 0.75));
      b.lineTo(...at(0.7, 0.3));
      b.curveTo(...at(0.7, 0.15), ...at(0.5, 0.15), ...at(0.5, 0.3));
      b.lineTo(...at(0.5, 0.7));
      b.stroke();
      break;
    case 'Graph':
      // Axes and a rising line.
      b.moveTo(...at(0.15, 0.85));
      b.lineTo(...at(0.15, 0.15));
      b.lineTo(...at(0.85, 0.15));
      b.stroke();
      b.moveTo(...at(0.25, 0.3));
      b.lineTo(...at(0.45, 0.55));
      b.lineTo(...at(0.6, 0.4));
      b.lineTo(...at(0.85, 0.8));
      b.stroke();
      break;
    case 'Tag':
      // A luggage tag with its hole.
      b.moveTo(...at(0.15, 0.6));
      b.lineTo(...at(0.45, 0.9));
      b.lineTo(...at(0.9, 0.45));
      b.lineTo(...at(0.6, 0.15));
      b.lineTo(...at(0.15, 0.6));
      b.closePath().fill();
      b.moveTo(...at(0.3, 0.6));
      b.lineTo(...at(0.36, 0.66));
      b.stroke();
      break;
    case 'PushPin':
      // Head of the pin.
      b.moveTo(...at(0.3, 0.55));
      b.lineTo(...at(0.7, 0.55));
      b.lineTo(...at(0.62, 0.95));
      b.lineTo(...at(0.38, 0.95));
      b.closePath().fill();
      // Body and point.
      b.moveTo(...at(0.5, 0.55));
      b.lineTo(...at(0.5, 0.05));
      b.stroke();
      b.moveTo(...at(0.22, 0.5));
      b.lineTo(...at(0.78, 0.5));
      b.stroke();
      break;
  }
  b.restore();
  return finish(input, b);
};
