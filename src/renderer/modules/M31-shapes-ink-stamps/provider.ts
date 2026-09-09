/**
 * M31's `AnnotationProvider` (ADR 0015): how shapes, ink, stamps and file attachments join M30's
 * overlay, selection and properties panel.
 *
 * The pure parts — what is drawn, how geometry moves and scales — are in `overlay.ts` and
 * `geometry.ts`; the panel sections are in `panel.ts`. This file is the wiring, and the two
 * decisions that need the service: a stamp's picture (which lives in the service's cache or the
 * document's `custom.xobjects`), and pushing a changed shape's appearance into the live page.
 */

import type { ModelAnnotation, AnnotationPatch } from '@core/model';
import { inkRect, shapeRectFor, stampSizeOf } from '@engine/appearance';
import type { PdfPoint, PdfRect } from '@shared/pdf';
import { vertexIndexOf } from '@view/AnnotationLayer';
import type { AnnotationProvider } from '@modules/M30-markup-annotations/AnnotationService';
import type { DrawingService } from './DrawingService';
import { offsetPoints, offsetRect, quadOfRect, scalePoints } from './geometry';
import { isDrawing, toLayerAnnotation } from './overlay';
import { mountDrawingSections, describeDrawing } from './panel';
import { DRAWING_TOOL_IDS } from './tools';

/** A move: the rect and every point the family keeps beside it. */
export function moveDrawing(a: ModelAnnotation, dx: number, dy: number): AnnotationPatch {
  const rect = offsetRect(a.rect, dx, dy);
  switch (a.family) {
    case 'shape':
      return { rect, vertices: offsetPoints(a.vertices, dx, dy) };
    case 'ink':
      return { rect, paths: a.paths.map((p) => offsetPoints(p, dx, dy)) };
    case 'markup':
      return { rect, quadPoints: quadOfRect(rect) };
    default:
      return { rect };
  }
}

/**
 * A resize: the rect, with the geometry scaled into it. A line, a polygon or a polyline scales
 * its points from the old rect to the new and takes the rect that then contains them (heads and
 * stroke included), so the box the reader sees always fits what it holds.
 */
export function resizeDrawing(a: ModelAnnotation, rect: PdfRect): AnnotationPatch | null {
  switch (a.family) {
    case 'shape': {
      if (a.subtype === 'Square' || a.subtype === 'Circle') return { rect };
      const vertices = scalePoints(a.vertices, a.rect, rect);
      return {
        vertices,
        rect: shapeRectFor(a.subtype, vertices, a.borderWidth ?? 1, a.extra),
      };
    }
    case 'ink': {
      const paths = a.paths.map((p) => scalePoints(p, a.rect, rect));
      const pressures = a.extra['pressures'];
      return {
        paths,
        rect: inkRect(paths, a.borderWidth ?? 1, Array.isArray(pressures) ? [] : null),
      };
    }
    case 'stamp': {
      // Aspect is kept: the fitted picture decides the rect, not the handle.
      const size = stampSizeOf(a.extra);
      if (!size) return { rect };
      return { rect };
    }
    case 'markup':
      return { rect, quadPoints: quadOfRect(rect) };
    case 'fileAttachment':
      return null;
    default:
      return { rect };
  }
}

/** A vertex handle dragged: that point moves, and the rect follows the points. */
export function dragVertex(
  a: ModelAnnotation,
  handle: string,
  to: PdfPoint,
): AnnotationPatch | null {
  if (a.family !== 'shape') return null;
  const index = vertexIndexOf(handle);
  if (index === null || index >= a.vertices.length) return null;
  const vertices = a.vertices.map((p, i) => (i === index ? to : p));
  if (a.subtype === 'Square' || a.subtype === 'Circle') return null;
  return { vertices, rect: shapeRectFor(a.subtype, vertices, a.borderWidth ?? 1, a.extra) };
}

/** The provider, bound to the live service. */
export function drawingProvider(service: DrawingService): AnnotationProvider {
  return {
    id: 'M31',
    creationTools: DRAWING_TOOL_IDS,
    owns: isDrawing,
    toLayer: (a, page, options) =>
      toLayerAnnotation(a, page, options, a.family === 'stamp' ? service.stampPicture(a) : null),
    movePatch: moveDrawing,
    resizePatch: resizeDrawing,
    handlePatch: dragVertex,
    afterChange: (a) => service.afterChange(a),
    panel: (a, refresh) => mountDrawingSections(service, a, refresh),
    describe: (a) => describeDrawing(service, a),
    open: (a) => {
      if (a.family !== 'fileAttachment') return false;
      const id = service.attachmentOf(a);
      if (!id) return false;
      void service.shellServices.run('attachments.open', { attachment: id });
      return true;
    },
  };
}
