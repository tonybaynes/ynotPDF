/**
 * Model annotation → what the overlay draws and hit-tests, for a measurement (M33). Pure.
 *
 * The rule M30 set and M31 kept still holds — **the overlay draws exactly what the raster does
 * not** — and every measurement falls on the same side of it: a `Line`, a `Polygon` and a
 * `PolyLine` are three of the subtypes PDFium refuses to create, so a measurement exists only in
 * the model until a save bakes its appearance, and the overlay draws it until a reopen reads that
 * appearance back.
 *
 * What is drawn is the same list the writer bakes — `measureDrawings` for the leaders and the
 * caption, `shapeDrawings` for a polygon's or a polyline's outline — so the screen and the file
 * cannot drift apart.
 */

import type { ModelAnnotation } from '@core/model';
import {
  isMeasurement,
  measureDrawings,
  measureIntentOf,
  measurementOf,
  shapeDrawings,
  type MeasureIntent,
  type Measurement,
  type ShapeDrawing,
} from '@engine/appearance';
import { toAppearanceInput } from '@modules/M21-save/plan';
import type { PdfRect } from '@shared/pdf';
import type { AnnotationShape, HandleSet, LayerAnnotation, ShapePath } from '@view/AnnotationLayer';

/** The annotations M33 owns: a shape with a dimension `/IT` on the subtype that intent belongs to. */
export function isMeasureAnnotation(a: ModelAnnotation): boolean {
  return a.family === 'shape' && isMeasurement(a.subtype, a.extra);
}

/** The intent of a measurement annotation, or null when it is not one. */
export function intentOf(a: ModelAnnotation): MeasureIntent | null {
  return isMeasureAnnotation(a) ? measureIntentOf(a.extra) : null;
}

/** What one measurement says, or null when the annotation is not a measurement. */
export function measurementFor(a: ModelAnnotation): Measurement | null {
  if (!isMeasureAnnotation(a) || a.family !== 'shape') return null;
  return measurementOf({ subtype: a.subtype, vertices: a.vertices, extra: a.extra });
}

/**
 * Whether the overlay has to draw this one.
 *
 * PDFium creates none of `Line`, `Polygon` or `PolyLine`, so until a save there is nothing in the
 * raster to collide with; after a reopen the file's own `/AP` is in the raster and drawing it
 * again would double every stroke. `edited` is this session's touched set, which is what says the
 * model has moved on from whatever the file holds.
 */
export function drawnByOverlay(
  a: ModelAnnotation,
  edited: ReadonlySet<string>,
  raster = true,
): boolean {
  if (!isMeasureAnnotation(a)) return false;
  if (a.flags.hidden || a.flags.noView) return false;
  // With a comment filter on, M32 turns the raster's annotations off entirely (ADR 0017).
  if (!raster) return true;
  return edited.has(a.id) || a.extra['hasAP'] !== true;
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

/** The shapes the overlay paints for one measurement: the outline, the leaders and the caption. */
export function shapesFor(a: ModelAnnotation): AnnotationShape[] {
  if (a.family !== 'shape') return [];
  const input = toAppearanceInput(a);
  const drawn = measureDrawings(input);
  if (!drawn) return [];
  // A distance draws its own line, offset by `/LL` and broken for an inline caption; the other
  // two keep the plain outline and gain only the caption.
  const paths = a.subtype === 'Line' ? drawn.paths : [...shapeDrawings(input), ...drawn.paths];
  const out: AnnotationShape[] = paths.map(toShapePath);
  const caption = drawn.caption;
  if (caption && caption.text !== '') {
    out.push({
      kind: 'text',
      lines: [{ text: caption.text, x: caption.x, y: caption.y }],
      size: caption.size,
      color: caption.color,
      family: '"Liberation Sans", Arial, Helvetica, sans-serif',
      bold: false,
      italic: false,
      ...(caption.rotate === 0 ? {} : { rotate: caption.rotate }),
    });
  }
  return out;
}

/** How much of a measurement the reader may drag: one handle per measured point. */
export function handlesFor(_a: ModelAnnotation): HandleSet {
  return 'vertices';
}

/** The rectangles a pointer must be inside to hit it. */
export function hitRects(a: ModelAnnotation): PdfRect[] {
  return [a.rect];
}

/** One model annotation as the layer wants it. */
export function toLayerAnnotation(
  a: ModelAnnotation,
  page: number,
  options: {
    readonly edited: ReadonlySet<string>;
    readonly hidden?: boolean;
    readonly raster?: boolean;
  },
): LayerAnnotation {
  const draws = drawnByOverlay(a, options.edited, options.raster ?? true);
  const vertices = a.family === 'shape' ? a.vertices : [];
  return {
    id: a.id,
    page,
    rect: a.rect,
    shapes: draws ? shapesFor(a) : [],
    hit: hitRects(a),
    handles: handlesFor(a),
    ...(vertices.length > 0 ? { vertices } : {}),
    ...(options.hidden ? { hidden: true } : {}),
  };
}
