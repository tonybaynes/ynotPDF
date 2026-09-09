/**
 * Model annotation → what the overlay draws and hit-tests, for M31's families. Pure.
 *
 * The rule from M30 still holds — **the overlay draws exactly the annotations the raster does
 * not carry** — but M31's families fall on both sides of it in ways M30's did not:
 *
 * - **Square, Circle and Ink** PDFium can create, and the service pushes our own appearance into
 *   it the moment one is made or changed (`DrawingService.pushAppearance`), so the raster always
 *   carries them and the overlay only ever draws their handles.
 * - **Line, Polygon and PolyLine** PDFium refuses to create, so they exist only in the model
 *   until a save, and the overlay draws them until a reopen reads an `/AP` back.
 * - **Stamp and FileAttachment** keep their `/AP` through a move (M31, ADR 0015), so the file's
 *   own `hasAP` is the whole rule for them: drawn by the overlay only while the file has none.
 *   The service clears `hasAP` when it drops the stream for a visual change.
 * - **Area highlight** is a `Highlight` PDFium draws itself; only its handles are the overlay's.
 *
 * Everything here is in PDF page space, so a zoom or a rotation is a repaint and not a re-layout.
 */

import type { ModelAnnotation } from '@core/model';
import {
  applyMatrix,
  attachmentIconDrawings,
  inkDrawings,
  matrixScale,
  shapeDrawings,
  stampMatrix,
  stampRotationOf,
  stampSizeOf,
  type ShapeDrawing,
  type StampDrawing,
} from '@engine/appearance';
import { toAppearanceInput } from '@modules/M21-save/plan';
import type { PdfRect } from '@shared/pdf';
import type {
  AnnotationShape,
  HandleSet,
  LayerAnnotation,
  ShapePath,
  ShapeStep,
} from '@view/AnnotationLayer';

/** `/IT` of an area highlight — a Highlight drawn over a rectangle rather than words. */
export const AREA_HIGHLIGHT_INTENT = 'AreaHighlight';

/** The annotations M31 owns. */
export function isDrawing(a: ModelAnnotation): boolean {
  switch (a.family) {
    case 'shape':
    case 'ink':
    case 'stamp':
    case 'fileAttachment':
      return true;
    case 'markup':
      return a.subtype === 'Highlight' && a.extra['intent'] === AREA_HIGHLIGHT_INTENT;
    default:
      return false;
  }
}

/** Subtypes whose appearance is always in the raster: PDFium's own, or the one we pushed. */
const RASTERISED = new Set(['Square', 'Circle', 'Ink', 'Highlight']);

/** Whether the overlay has to draw this annotation (see the file comment). */
export function drawnByOverlay(a: ModelAnnotation, edited: ReadonlySet<string>): boolean {
  if (!isDrawing(a)) return false;
  if (a.flags.hidden || a.flags.noView) return false;
  if (RASTERISED.has(a.subtype)) return false;
  if (a.family === 'stamp' || a.family === 'fileAttachment') return a.extra['hasAP'] !== true;
  return edited.has(a.id) || a.extra['hasAP'] !== true;
}

/** How much of an annotation the reader may drag. */
export function handlesFor(a: ModelAnnotation): HandleSet {
  switch (a.family) {
    case 'shape':
      return a.subtype === 'Square' || a.subtype === 'Circle' ? 'box' : 'vertices';
    case 'ink':
    case 'stamp':
      return 'box';
    case 'fileAttachment':
      return 'move';
    case 'markup':
      return 'box';
    default:
      return 'move';
  }
}

/** The rectangles a pointer must be inside to hit the annotation. */
export function hitRects(a: ModelAnnotation): PdfRect[] {
  return [a.rect];
}

/** A drawing as the layer paints it. */
function toShapePath(d: ShapeDrawing): ShapePath {
  return {
    kind: 'path',
    steps: d.ops,
    stroke: d.stroke,
    fill: d.fill,
    width: d.width,
    round: true,
    ...(d.dash && d.dash.length > 0 ? { dash: d.dash } : {}),
  };
}

/** What a stamp's picture looks like, when the model knows: a drawing, or a PNG data URL. */
export type StampPicture =
  | { readonly kind: 'drawing'; readonly drawing: StampDrawing }
  | { readonly kind: 'image'; readonly href: string }
  | null;

/** The shapes the overlay paints for one annotation. */
export function shapesFor(a: ModelAnnotation, picture: StampPicture = null): AnnotationShape[] {
  switch (a.family) {
    case 'shape':
      return shapeDrawings(toAppearanceInput(a)).map(toShapePath);
    case 'ink':
      return inkDrawings(toAppearanceInput(a)).map(toShapePath);
    case 'fileAttachment':
      return attachmentIconDrawings(a.rect, a.icon, a.color ?? 0x000000).map(toShapePath);
    case 'stamp':
      return stampShapes(a, picture);
    default:
      return [];
  }
}

/**
 * A stamp as the overlay draws it: the catalogue drawing's paths and text put through the same
 * matrix the appearance stream uses, or the custom picture placed in its fitted box.
 */
function stampShapes(a: ModelAnnotation, picture: StampPicture): AnnotationShape[] {
  const size = stampSizeOf(a.extra);
  if (!picture || !size) return [];
  const rotate = stampRotationOf(a.extra);
  const m = stampMatrix(a.rect, size, rotate);
  const scale = matrixScale(m);
  if (picture.kind === 'image') {
    const cx = (a.rect.x0 + a.rect.x1) / 2;
    const cy = (a.rect.y0 + a.rect.y1) / 2;
    const w = (size.width * scale) / 2;
    const h = (size.height * scale) / 2;
    return [
      {
        kind: 'image',
        href: picture.href,
        rect: { x0: cx - w, y0: cy - h, x1: cx + w, y1: cy + h },
        ...(rotate === 0 ? {} : { rotate }),
      },
    ];
  }
  const out: AnnotationShape[] = [];
  for (const d of picture.drawing.drawings) {
    out.push({
      kind: 'path',
      steps: d.ops.map((op): ShapeStep => {
        if (op.op === 'Z') return op;
        const p = applyMatrix(m, { x: op.x, y: op.y });
        if (op.op === 'C') {
          const c1 = applyMatrix(m, { x: op.x1, y: op.y1 });
          const c2 = applyMatrix(m, { x: op.x2, y: op.y2 });
          return { op: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: p.x, y: p.y };
        }
        return { op: op.op, x: p.x, y: p.y };
      }),
      stroke: d.stroke,
      fill: d.fill,
      width: d.width * scale,
      round: true,
    });
  }
  const byStyle = new Map<
    number,
    { size: number; lines: { text: string; x: number; y: number }[] }
  >();
  for (const t of picture.drawing.texts) {
    const origin = applyMatrix(m, { x: t.x, y: t.y });
    const key = t.size;
    const bucket = byStyle.get(key) ?? { size: t.size * scale, lines: [] };
    bucket.lines.push({ text: t.text, x: origin.x, y: origin.y });
    byStyle.set(key, bucket);
  }
  const colour = picture.drawing.texts[0]?.color ?? 0x000000;
  for (const bucket of byStyle.values()) {
    out.push({
      kind: 'text',
      lines: bucket.lines,
      size: bucket.size,
      color: colour,
      family: '"Liberation Sans", Arial, Helvetica, sans-serif',
      bold: true,
      italic: false,
      ...(rotate === 0 ? {} : { rotate }),
    });
  }
  return out;
}

/** One model annotation as the layer wants it. */
export function toLayerAnnotation(
  a: ModelAnnotation,
  page: number,
  options: { readonly edited: ReadonlySet<string>; readonly hidden?: boolean },
  picture: StampPicture = null,
): LayerAnnotation {
  const draws = drawnByOverlay(a, options.edited);
  const vertices = a.family === 'shape' ? a.vertices : [];
  return {
    id: a.id,
    page,
    rect: a.rect,
    shapes: draws ? shapesFor(a, picture) : [],
    hit: hitRects(a),
    handles: handlesFor(a),
    ...(vertices.length > 0 ? { vertices } : {}),
    ...(options.hidden ? { hidden: true } : {}),
  };
}
