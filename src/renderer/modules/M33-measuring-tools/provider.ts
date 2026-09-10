/**
 * M33's `AnnotationProvider` (ADR 0015, extended by ADR 0018): how a measurement joins M30's
 * overlay, selection and properties panel.
 *
 * It registers at priority 10 so it takes measurements back off M31's provider, which claims the
 * whole `shape` family and would otherwise have drawn a dimension as a plain line.
 *
 * The pure parts are in `overlay.ts` and `geometry.ts`; the panel's sections are in `panel.ts`.
 * What needs the service is here: re-measuring after a move or a resize, which is the one thing a
 * measurement does that an ordinary shape does not.
 */

import type { ModelAnnotation, AnnotationPatch } from '@core/model';
import { measureRectFor, shapeRectFor } from '@engine/appearance';
import type { PdfPoint, PdfRect } from '@shared/pdf';
import { toAppearanceInput } from '@modules/M21-save/plan';
import { vertexIndexOf } from '@view/AnnotationLayer';
import type { AnnotationProvider } from '@modules/M30-markup-annotations/AnnotationService';
import { offsetPoints, offsetRect, scalePoints } from './geometry';
import type { MeasureService } from './MeasureService';
import { isMeasureAnnotation, toLayerAnnotation } from './overlay';
import { describeMeasurement, mountMeasureSections } from './panel';
import { MEASURE_TOOL_IDS } from './tools';

/** The `/Rect` a measurement needs: what the shape needs, grown to hold the leaders and caption. */
export function measurementRect(a: ModelAnnotation, vertices: ReadonlyArray<PdfPoint>): PdfRect {
  if (a.family !== 'shape') return a.rect;
  const base = shapeRectFor(
    a.subtype as 'Line' | 'Polygon' | 'PolyLine',
    vertices,
    a.borderWidth ?? 1,
    a.extra,
  );
  return measureRectFor({ ...toAppearanceInput(a), vertices, rect: base }, base);
}

/** A move: the rect and the measured points travel together, so the value does not change. */
export function moveMeasurement(a: ModelAnnotation, dx: number, dy: number): AnnotationPatch {
  const rect = offsetRect(a.rect, dx, dy);
  if (a.family !== 'shape') return { rect };
  return { rect, vertices: offsetPoints(a.vertices, dx, dy) };
}

/**
 * A resize: the points are scaled into the new box and the rect then follows *them*, leaders and
 * caption included — the caption grows with the number, so the box the handle drew is not the
 * box the annotation ends up with.
 */
export function resizeMeasurement(a: ModelAnnotation, rect: PdfRect): AnnotationPatch | null {
  if (a.family !== 'shape') return null;
  const vertices = scalePoints(a.vertices, a.rect, rect);
  return { vertices, rect: measurementRect(a, vertices) };
}

/** A vertex handle dragged: that measured point moves, and the value is re-read from the rest. */
export function dragMeasurementVertex(
  a: ModelAnnotation,
  handle: string,
  to: PdfPoint,
): AnnotationPatch | null {
  if (a.family !== 'shape') return null;
  const index = vertexIndexOf(handle);
  if (index === null || index >= a.vertices.length) return null;
  const vertices = a.vertices.map((p, i) => (i === index ? to : p));
  return { vertices, rect: measurementRect(a, vertices) };
}

/** The provider, bound to the live service. */
export function measureProvider(service: MeasureService): AnnotationProvider {
  return {
    id: 'M33',
    // Higher than M31's default 0: a measurement is a shape, and both providers claim it.
    priority: 10,
    creationTools: MEASURE_TOOL_IDS,
    owns: isMeasureAnnotation,
    toLayer: toLayerAnnotation,
    movePatch: moveMeasurement,
    resizePatch: resizeMeasurement,
    handlePatch: dragMeasurementVertex,
    afterChange: (a) => service.afterChange(a),
    panel: (a, refresh) => mountMeasureSections(service, a, refresh),
    describe: describeMeasurement,
  };
}
