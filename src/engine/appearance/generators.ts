/**
 * Appearance generators (M21) — one per annotation family.
 *
 * PDFium synthesises `/AP` for Highlight, Underline, StrikeOut, Squiggly, Square, Circle, Ink,
 * Text and Popup when it loads a page, so a file we save through it usually carries those
 * already. It does **not** synthesise Line, Polygon, PolyLine, FreeText, FileAttachment or
 * Caret — those annotations reach other viewers as bare dictionaries and are drawn by guesswork,
 * or not at all. These generators fill the gap, and cover the markup and shape families too so a
 * file that arrived from a viewer which never generated them is repaired on save.
 *
 * Every generator draws in page space (the same space as `/Rect`) and the writer emits an
 * identity `/Matrix`, so the stream's coordinates are the annotation's own — no transform to get
 * wrong.
 */

import type { PdfPoint, PdfRect } from '@shared/pdf';
import { ContentBuilder } from './content';
import { textWidth, wrapText } from './metrics';
import type {
  AppearanceGenerator,
  AppearanceInput,
  AppearanceStream,
  StandardFontName,
} from './types';

/** PDF's own default when `/BS /W` is absent. */
const DEFAULT_BORDER = 1;
/** Black, for an annotation that names no colour — the same fallback every viewer makes. */
const DEFAULT_COLOR = 0x000000;

function strokeWidth(input: AppearanceInput): number {
  const w = input.borderWidth ?? DEFAULT_BORDER;
  return w > 0 ? w : 0;
}

function strokeColor(input: AppearanceInput): number {
  return input.color ?? DEFAULT_COLOR;
}

/** Applies `/CA` as a graphics state when it is anything but fully opaque. */
function applyOpacity(builder: ContentBuilder, input: AppearanceInput, blendMode?: string): void {
  const alpha = input.opacity;
  const opaque = alpha === null || alpha >= 1;
  if (opaque && blendMode === undefined) return;
  builder.graphicsState({
    ...(opaque ? {} : { fillAlpha: alpha, strokeAlpha: alpha }),
    ...(blendMode === undefined ? {} : { blendMode }),
  });
}

/** The stream's BBox: the annotation rect, grown by half the stroke so a border is not clipped. */
function bboxFor(input: AppearanceInput): PdfRect {
  const pad = strokeWidth(input) / 2 + 0.5;
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

/** A dash pattern from `/BS /D`, when the caller passed one through `extra`. */
function dashArray(input: AppearanceInput): ReadonlyArray<number> {
  const value = input.extra['dashArray'];
  return Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number') : [];
}

function applyStroke(builder: ContentBuilder, input: AppearanceInput): boolean {
  const width = strokeWidth(input);
  if (width <= 0) return false;
  builder.strokeColor(strokeColor(input)).lineWidth(width).lineCap(1).lineJoin(1);
  const dashes = dashArray(input);
  if (dashes.length > 0) builder.dash(dashes);
  return true;
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

/** Quads if the annotation has them, else the whole rect — a markup annotation always draws. */
function markupRects(input: AppearanceInput): PdfRect[] {
  const quads = quadRects(input.quadPoints);
  return quads.length > 0 ? quads : [input.rect];
}

// ---- shapes ------------------------------------------------------------------------------------

/** `/Square`: the rect inset by half the border so the stroke sits inside `/Rect`. */
export const squareAppearance: AppearanceGenerator = (input) => {
  const b = new ContentBuilder();
  const width = strokeWidth(input);
  const inset = width / 2;
  const box: PdfRect = {
    x0: input.rect.x0 + inset,
    y0: input.rect.y0 + inset,
    x1: input.rect.x1 - inset,
    y1: input.rect.y1 - inset,
  };
  if (box.x1 <= box.x0 || box.y1 <= box.y0) return null;
  b.save();
  applyOpacity(b, input);
  const stroked = applyStroke(b, input);
  if (input.interiorColor !== null) b.fillColor(input.interiorColor);
  b.rect(box);
  paint(b, stroked, input.interiorColor !== null);
  b.restore();
  return finish(input, b);
};

/** `/Circle`: an ellipse inscribed in the inset rect. */
export const circleAppearance: AppearanceGenerator = (input) => {
  const b = new ContentBuilder();
  const inset = strokeWidth(input) / 2;
  const box: PdfRect = {
    x0: input.rect.x0 + inset,
    y0: input.rect.y0 + inset,
    x1: input.rect.x1 - inset,
    y1: input.rect.y1 - inset,
  };
  if (box.x1 <= box.x0 || box.y1 <= box.y0) return null;
  b.save();
  applyOpacity(b, input);
  const stroked = applyStroke(b, input);
  if (input.interiorColor !== null) b.fillColor(input.interiorColor);
  b.ellipse(box);
  paint(b, stroked, input.interiorColor !== null);
  b.restore();
  return finish(input, b);
};

/** `/Line`: `/L` when the caller passed it through `vertices`, else the rect's diagonal. */
export const lineAppearance: AppearanceGenerator = (input) => {
  const points = input.vertices.length >= 2 ? input.vertices.slice(0, 2) : diagonal(input.rect);
  const b = new ContentBuilder();
  b.save();
  applyOpacity(b, input);
  if (!applyStroke(b, input)) {
    // A zero-width line is invisible; PDF's own default is 1, so draw that rather than nothing.
    b.strokeColor(strokeColor(input)).lineWidth(DEFAULT_BORDER).lineCap(1);
  }
  b.polyline(points).stroke();
  b.restore();
  return finish(input, b);
};

/** `/Polygon`: a closed figure, filled with `/IC` when it has one. */
export const polygonAppearance: AppearanceGenerator = (input) => {
  if (input.vertices.length < 3) return null;
  const b = new ContentBuilder();
  b.save();
  applyOpacity(b, input);
  const stroked = applyStroke(b, input);
  if (input.interiorColor !== null) b.fillColor(input.interiorColor);
  b.polyline(input.vertices).closePath();
  paint(b, stroked, input.interiorColor !== null);
  b.restore();
  return finish(input, b);
};

/** `/PolyLine`: the same, open and never filled. */
export const polylineAppearance: AppearanceGenerator = (input) => {
  if (input.vertices.length < 2) return null;
  const b = new ContentBuilder();
  b.save();
  applyOpacity(b, input);
  if (!applyStroke(b, input)) b.strokeColor(strokeColor(input)).lineWidth(DEFAULT_BORDER);
  b.polyline(input.vertices).stroke();
  b.restore();
  return finish(input, b);
};

/** `/Ink`: every stroke as a round-capped, round-joined polyline. A single point draws a dot. */
export const inkAppearance: AppearanceGenerator = (input) => {
  const strokes = input.paths.filter((p) => p.length > 0);
  if (strokes.length === 0) return null;
  const b = new ContentBuilder();
  const width = strokeWidth(input) > 0 ? strokeWidth(input) : DEFAULT_BORDER;
  b.save();
  applyOpacity(b, input);
  b.strokeColor(strokeColor(input)).lineWidth(width).lineCap(1).lineJoin(1);
  const dashes = dashArray(input);
  if (dashes.length > 0) b.dash(dashes);
  for (const stroke of strokes) {
    const first = stroke[0];
    if (!first) continue;
    if (stroke.length === 1) {
      // A round cap on a zero-length segment is the dot the user drew.
      b.moveTo(first.x, first.y).lineTo(first.x, first.y);
    } else {
      b.polyline(stroke);
    }
    b.stroke();
  }
  b.restore();
  return finish(input, b);
};

// ---- text markup -------------------------------------------------------------------------------

/** `/Highlight`: the quads filled in Multiply so the text underneath still reads. */
export const highlightAppearance: AppearanceGenerator = (input) => {
  const b = new ContentBuilder();
  b.save();
  applyOpacity(b, input, 'Multiply');
  b.fillColor(input.color ?? 0xffff00);
  for (const r of markupRects(input)) b.rect(r);
  b.fill();
  b.restore();
  return finish(input, b);
};

/** `/Underline`: a rule along the bottom sixteenth of each quad. */
export const underlineAppearance: AppearanceGenerator = (input) =>
  ruleAppearance(input, (r) => r.y0 + (r.y1 - r.y0) / 16);

/** `/StrikeOut`: the same rule through the middle. */
export const strikeOutAppearance: AppearanceGenerator = (input) =>
  ruleAppearance(input, (r) => (r.y0 + r.y1) / 2);

function ruleAppearance(
  input: AppearanceInput,
  atY: (rect: PdfRect) => number,
): AppearanceStream | null {
  const rects = markupRects(input);
  if (rects.length === 0) return null;
  const b = new ContentBuilder();
  b.save();
  applyOpacity(b, input);
  b.strokeColor(strokeColor(input)).lineCap(0);
  for (const r of rects) {
    const height = r.y1 - r.y0;
    b.lineWidth(Math.max(0.5, height / 14));
    const y = atY(r);
    b.moveTo(r.x0, y).lineTo(r.x1, y).stroke();
  }
  b.restore();
  return finish(input, b);
}

/** `/Squiggly`: a zigzag along the bottom of each quad, one wave per 1.5× its amplitude. */
export const squigglyAppearance: AppearanceGenerator = (input) => {
  const rects = markupRects(input);
  if (rects.length === 0) return null;
  const b = new ContentBuilder();
  b.save();
  applyOpacity(b, input);
  b.strokeColor(strokeColor(input)).lineCap(1).lineJoin(1);
  for (const r of rects) {
    const height = r.y1 - r.y0;
    const amplitude = Math.max(1, height / 8);
    b.lineWidth(Math.max(0.5, amplitude / 3));
    const base = r.y0 + amplitude;
    const step = amplitude * 1.5;
    b.moveTo(r.x0, base);
    let up = true;
    for (let x = r.x0 + step; x < r.x1; x += step) {
      b.lineTo(x, up ? base + amplitude : base);
      up = !up;
    }
    b.stroke();
  }
  b.restore();
  return finish(input, b);
};

// ---- free text ---------------------------------------------------------------------------------

const FREE_TEXT_PADDING = 2;
const DEFAULT_FONT_SIZE = 12;

/**
 * `/FreeText`: the box (filled with `/IC`, bordered with `/C`) and the note's text wrapped
 * inside it. PDFium generates nothing for this subtype, so without it a typewriter note is
 * invisible everywhere but here.
 */
export const freeTextAppearance: AppearanceGenerator = (input) => {
  const b = new ContentBuilder();
  const width = strokeWidth(input);
  const inset = width / 2;
  const box: PdfRect = {
    x0: input.rect.x0 + inset,
    y0: input.rect.y0 + inset,
    x1: input.rect.x1 - inset,
    y1: input.rect.y1 - inset,
  };
  b.save();
  applyOpacity(b, input);
  if (box.x1 > box.x0 && box.y1 > box.y0 && (input.interiorColor !== null || width > 0)) {
    if (input.interiorColor !== null) b.fillColor(input.interiorColor);
    const stroked = input.color !== null && width > 0;
    if (stroked) b.strokeColor(strokeColor(input)).lineWidth(width);
    b.rect(box);
    paint(b, stroked, input.interiorColor !== null);
  }

  const text = input.contents ?? '';
  if (text !== '') {
    const font = freeTextFont(input);
    const size = freeTextSize(input);
    const inner = box.x1 - box.x0 - 2 * FREE_TEXT_PADDING;
    const lines = wrapText(text, font, size, Math.max(inner, size));
    const leading = size * 1.2;
    // Clip to the box: a note whose text outgrew it should be cut off, not spill onto the page.
    b.save();
    b.rect(box).push('W').push('n');
    b.fillColor(textColor(input));
    b.textLines(lines, {
      font,
      size,
      x: box.x0 + FREE_TEXT_PADDING,
      y: box.y1 - FREE_TEXT_PADDING - size,
      leading,
    });
    b.restore();
  }
  b.restore();
  return finish(input, b);
};

function freeTextFont(input: AppearanceInput): StandardFontName {
  const named = input.extra['font'];
  const known: ReadonlyArray<StandardFontName> = [
    'Helvetica',
    'Helvetica-Bold',
    'Helvetica-Oblique',
    'Helvetica-BoldOblique',
    'Times-Roman',
    'Times-Bold',
    'Times-Italic',
    'Times-BoldItalic',
    'Courier',
    'Courier-Bold',
    'Courier-Oblique',
    'Courier-BoldOblique',
  ];
  return typeof named === 'string' && known.includes(named as StandardFontName)
    ? (named as StandardFontName)
    : 'Helvetica';
}

function freeTextSize(input: AppearanceInput): number {
  const size = input.extra['fontSize'];
  if (typeof size === 'number' && size > 0) return size;
  return DEFAULT_FONT_SIZE;
}

/** `/DA` sets the text colour separately from `/C`, which is the box. Default black. */
function textColor(input: AppearanceInput): number {
  const value = input.extra['textColor'];
  return typeof value === 'number' ? value : DEFAULT_COLOR;
}

// ---- small marks -------------------------------------------------------------------------------

/** `/FileAttachment`: a pushpin, drawn to fill the rect. PDFium draws nothing for these. */
export const fileAttachmentAppearance: AppearanceGenerator = (input) => {
  const { x0, y0, x1, y1 } = input.rect;
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const b = new ContentBuilder();
  const at = (fx: number, fy: number): [number, number] => [x0 + fx * w, y0 + fy * h];
  b.save();
  applyOpacity(b, input);
  b.fillColor(input.color ?? 0x000000)
    .strokeColor(input.color ?? 0x000000)
    .lineWidth(Math.max(0.5, Math.min(w, h) / 12))
    .lineJoin(1);
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
  b.restore();
  return finish(input, b);
};

/** `/Caret`: the insertion mark, a filled triangle in the lower half of the rect. */
export const caretAppearance: AppearanceGenerator = (input) => {
  const { x0, y0, x1, y1 } = input.rect;
  if (x1 <= x0 || y1 <= y0) return null;
  const b = new ContentBuilder();
  b.save();
  applyOpacity(b, input);
  b.fillColor(strokeColor(input));
  b.moveTo(x0, y0);
  b.lineTo(x1, y0);
  b.lineTo((x0 + x1) / 2, y1);
  b.closePath().fill();
  b.restore();
  return finish(input, b);
};

// ---- helpers -----------------------------------------------------------------------------------

function paint(builder: ContentBuilder, stroked: boolean, filled: boolean): void {
  if (stroked && filled) builder.fillAndStroke();
  else if (filled) builder.fill();
  else if (stroked) builder.stroke();
  else builder.endPath();
}

function diagonal(rect: PdfRect): PdfPoint[] {
  return [
    { x: rect.x0, y: rect.y0 },
    { x: rect.x1, y: rect.y1 },
  ];
}

/** Exported for the tests: the width a `/FreeText` line takes at a size. */
export { textWidth };
