/**
 * What the overlay draws for M31's families, what it lets you grab, and how the provider's
 * patches move and scale their geometry.
 */

import { describe, expect, it } from 'vitest';
import type { AnnotationSubtype } from '@engine/PdfEngine';
import { toModelAnnotation, type ModelAnnotation } from '@core/model';
import type { ModelId } from '@core/Ids';
import { endingSize, STAMP_KEY, STAMP_SIZE, stampDrawing } from '@engine/appearance';
import { handlePoints } from '@view/AnnotationLayer';
import {
  AREA_HIGHLIGHT_INTENT,
  drawnByOverlay,
  handlesFor,
  hitRects,
  isDrawing,
  shapesFor,
  toLayerAnnotation,
} from '@modules/M31-shapes-ink-stamps/overlay';
import {
  dragVertex,
  drawingProvider,
  moveDrawing,
  resizeDrawing,
} from '@modules/M31-shapes-ink-stamps/provider';
import type { DrawingService } from '@modules/M31-shapes-ink-stamps/DrawingService';
import { must } from '../find/helpers';

const RECT = { x0: 100, y0: 500, x1: 300, y1: 560 };

function annotation(
  subtype: AnnotationSubtype,
  patch: Partial<Parameters<typeof toModelAnnotation>[2]> = {},
): ModelAnnotation {
  return toModelAnnotation('an-1' as ModelId, 'pg-1' as ModelId, {
    id: 'a0.0',
    page: 0,
    subtype,
    rect: RECT,
    flags: { hidden: false, print: true, noView: false, readOnly: false, locked: false },
    ...patch,
  });
}

const EDITED = new Set(['an-1']);
const NONE = new Set<string>();

describe('who owns what', () => {
  it('owns the shapes, ink, stamps, attachments and an area highlight, not the rest', () => {
    for (const subtype of [
      'Square',
      'Circle',
      'Line',
      'Polygon',
      'PolyLine',
      'Ink',
      'Stamp',
      'FileAttachment',
    ] as const) {
      expect(isDrawing(annotation(subtype)), subtype).toBe(true);
    }
    expect(isDrawing(annotation('Highlight', { extra: { intent: AREA_HIGHLIGHT_INTENT } }))).toBe(
      true,
    );
    expect(isDrawing(annotation('Highlight'))).toBe(false);
    for (const subtype of ['Text', 'FreeText', 'Underline', 'Link', 'Widget'] as const) {
      expect(isDrawing(annotation(subtype)), subtype).toBe(false);
    }
  });
});

describe('what the overlay draws', () => {
  it('never draws what the raster carries: squares, circles, ink and highlights', () => {
    for (const subtype of ['Square', 'Circle', 'Ink'] as const) {
      expect(drawnByOverlay(annotation(subtype), EDITED), subtype).toBe(false);
    }
    expect(
      drawnByOverlay(annotation('Highlight', { extra: { intent: AREA_HIGHLIGHT_INTENT } }), EDITED),
    ).toBe(false);
  });

  it('draws a line, a polygon and a polyline until the file has an appearance, or when edited', () => {
    for (const subtype of ['Line', 'Polygon', 'PolyLine'] as const) {
      expect(drawnByOverlay(annotation(subtype), NONE), subtype).toBe(true);
      expect(drawnByOverlay(annotation(subtype, { extra: { hasAP: true } }), NONE), subtype).toBe(
        false,
      );
      expect(drawnByOverlay(annotation(subtype, { extra: { hasAP: true } }), EDITED), subtype).toBe(
        true,
      );
    }
  });

  it('draws a stamp and an attachment only while the file has no appearance, edited or not', () => {
    for (const subtype of ['Stamp', 'FileAttachment'] as const) {
      expect(drawnByOverlay(annotation(subtype), EDITED), subtype).toBe(true);
      expect(drawnByOverlay(annotation(subtype, { extra: { hasAP: true } }), EDITED), subtype).toBe(
        false,
      );
      expect(drawnByOverlay(annotation(subtype, { extra: { hasAP: false } }), NONE), subtype).toBe(
        true,
      );
    }
  });

  it('draws nothing hidden, and nothing that is not its', () => {
    const hidden = annotation('Line', {
      flags: { hidden: true, print: true, noView: false, readOnly: false, locked: false },
    });
    expect(drawnByOverlay(hidden, EDITED)).toBe(false);
    expect(drawnByOverlay(annotation('Text'), EDITED)).toBe(false);
  });
});

describe('handles and hits', () => {
  it('gives boxes a box, polygons their corners, attachments a move', () => {
    expect(handlesFor(annotation('Square'))).toBe('box');
    expect(handlesFor(annotation('Circle'))).toBe('box');
    expect(handlesFor(annotation('Line'))).toBe('vertices');
    expect(handlesFor(annotation('Polygon'))).toBe('vertices');
    expect(handlesFor(annotation('Ink'))).toBe('box');
    expect(handlesFor(annotation('Stamp'))).toBe('box');
    expect(handlesFor(annotation('FileAttachment'))).toBe('move');
    expect(handlesFor(annotation('Highlight', { extra: { intent: AREA_HIGHLIGHT_INTENT } }))).toBe(
      'box',
    );
    expect(handlesFor(annotation('Text'))).toBe('move');
    expect(hitRects(annotation('Line'))).toEqual([RECT]);
  });

  it('a polygon’s layer annotation carries its points, one handle each', () => {
    const points = [
      { x: 100, y: 500 },
      { x: 300, y: 500 },
      { x: 200, y: 560 },
    ];
    const layer = toLayerAnnotation(annotation('Polygon', { paths: [points] }), 0, {
      edited: NONE,
    });
    expect(layer.vertices).toEqual(points);
    expect(handlePoints(layer).map((h) => h.id)).toEqual(['v0', 'v1', 'v2']);
    expect(layer.shapes.length).toBeGreaterThan(0);
    const hidden = toLayerAnnotation(annotation('Polygon', { paths: [points] }), 0, {
      edited: NONE,
      hidden: true,
    });
    expect(hidden.hidden).toBe(true);
  });
});

describe('the shapes', () => {
  it('a shape, an ink and an attachment become paths', () => {
    expect(shapesFor(annotation('Square', { color: 0, borderWidth: 1 }))[0]?.kind).toBe('path');
    expect(
      shapesFor(
        annotation('Ink', {
          paths: [
            [
              { x: 1, y: 1 },
              { x: 5, y: 5 },
            ],
          ],
        }),
      )[0]?.kind,
    ).toBe('path');
    const pin = shapesFor(annotation('FileAttachment', { extra: { icon: 'Tag' } }));
    expect(pin.length).toBeGreaterThan(0);
    expect(pin.every((s) => s.kind === 'path')).toBe(true);
    expect(shapesFor(annotation('Text'))).toEqual([]);
  });

  it('a stamp with a known drawing becomes turned paths and text; with a picture, an image', () => {
    const drawing = stampDrawing(['APPROVED'], 0x1f6e43);
    const stamp = annotation('Stamp', {
      rect: { x0: 0, y0: 0, x1: drawing.width, y1: drawing.height },
      extra: { [STAMP_KEY]: 'k', [STAMP_SIZE]: [drawing.width, drawing.height], rotate: 90 },
    });
    const shapes = shapesFor(stamp, { kind: 'drawing', drawing });
    expect(shapes.some((s) => s.kind === 'path')).toBe(true);
    const text = shapes.find((s) => s.kind === 'text');
    expect(text?.kind === 'text' && text.rotate).toBe(90);
    const image = shapesFor(stamp, { kind: 'image', href: 'data:image/png;base64,AA==' });
    expect(image[0]?.kind).toBe('image');
    expect(image[0]?.kind === 'image' && image[0].rotate).toBe(90);
    expect(shapesFor(stamp, null)).toEqual([]);
    expect(shapesFor(annotation('Stamp'), { kind: 'drawing', drawing })).toEqual([]);
  });
});

describe('the provider’s patches', () => {
  const points = [
    { x: 100, y: 500 },
    { x: 300, y: 500 },
  ];

  it('moves the rect and the points together, and an area highlight’s quad with it', () => {
    const line = moveDrawing(annotation('Line', { paths: [points] }), 10, -5);
    expect(line.rect?.x0).toBe(110);
    expect(line.vertices?.[0]).toEqual({ x: 110, y: 495 });
    const ink = moveDrawing(annotation('Ink', { paths: [points] }), 1, 1);
    expect(ink.paths?.[0]?.[1]).toEqual({ x: 301, y: 501 });
    const area = moveDrawing(
      annotation('Highlight', { extra: { intent: AREA_HIGHLIGHT_INTENT } }),
      5,
      0,
    );
    expect(area.quadPoints?.[0]).toBe(105);
    expect(moveDrawing(annotation('Stamp'), 1, 2).rect).toEqual({
      x0: 101,
      y0: 502,
      x1: 301,
      y1: 562,
    });
  });

  it('resizes a line by scaling its points and refitting the rect around heads and stroke', () => {
    const arrow = annotation('Line', {
      paths: [points],
      borderWidth: 2,
      extra: { lineEndings: ['None', 'OpenArrow'] },
    });
    const patch = must(resizeDrawing(arrow, { x0: 100, y0: 500, x1: 500, y1: 560 }), 'patch');
    expect(patch.vertices?.[1]?.x).toBe(500);
    expect(must(patch.rect, 'rect').x1).toBeGreaterThan(500 + endingSize(2) - 1);
  });

  it('resizes a box by its rect alone, scales ink, and refuses for an attachment', () => {
    const to = { x0: 0, y0: 0, x1: 50, y1: 50 };
    expect(resizeDrawing(annotation('Square'), to)).toEqual({ rect: to });
    expect(resizeDrawing(annotation('Stamp', { extra: { [STAMP_SIZE]: [2, 1] } }), to)).toEqual({
      rect: to,
    });
    const ink = must(resizeDrawing(annotation('Ink', { paths: [points] }), to), 'ink');
    expect(ink.paths?.[0]?.[1]?.x).toBeCloseTo(50, 6);
    expect(resizeDrawing(annotation('FileAttachment'), to)).toBeNull();
    const area = must(
      resizeDrawing(annotation('Highlight', { extra: { intent: AREA_HIGHLIGHT_INTENT } }), to),
      'area',
    );
    expect(area.quadPoints?.length).toBe(8);
    expect(resizeDrawing(annotation('Text'), to)).toEqual({ rect: to });
  });

  it('drags one corner of a polygon and refits the rect; refuses for anything else', () => {
    const polygon = annotation('Polygon', { paths: [[...points, { x: 200, y: 560 }]] });
    const patch = must(dragVertex(polygon, 'v2', { x: 200, y: 700 }), 'patch');
    expect(patch.vertices?.[2]).toEqual({ x: 200, y: 700 });
    expect(must(patch.rect, 'rect').y1).toBeGreaterThan(700);
    expect(dragVertex(polygon, 'v9', { x: 0, y: 0 })).toBeNull();
    expect(dragVertex(polygon, 'nw', { x: 0, y: 0 })).toBeNull();
    expect(dragVertex(annotation('Square'), 'v0', { x: 0, y: 0 })).toBeNull();
    expect(dragVertex(annotation('Ink'), 'v0', { x: 0, y: 0 })).toBeNull();
  });
});

describe('the provider itself', () => {
  const calls: string[] = [];
  const drawing = stampDrawing(['DRAFT'], 0x465063);
  const fake = {
    stampPicture: (a: ModelAnnotation) =>
      a.extra['stampKey'] === 'known' ? { kind: 'drawing' as const, drawing } : null,
    afterChange: (a: ModelAnnotation) => {
      calls.push(`after:${a.subtype}`);
      return Promise.resolve();
    },
    attachmentOf: (a: ModelAnnotation) => (a.contents === 'has file' ? ('att-1' as ModelId) : null),
    stampEntry: () => null,
    shellServices: {
      run: (id: string, args: Record<string, unknown>) => {
        calls.push(`run:${id}:${String(args['attachment'])}`);
        return Promise.resolve();
      },
    },
  };
  const provider = drawingProvider(fake as unknown as DrawingService);

  it('owns the drawing families and names every creation tool', () => {
    expect(provider.owns(annotation('Line'))).toBe(true);
    expect(provider.owns(annotation('Text'))).toBe(false);
    expect(provider.creationTools?.has('tool.pencil')).toBe(true);
    expect(provider.creationTools?.has('tool.hand')).toBe(false);
  });

  it('draws a stamp with the picture the service knows, and nothing for one it does not', () => {
    const size = { [STAMP_SIZE]: [drawing.width, drawing.height] };
    const known = annotation('Stamp', { extra: { [STAMP_KEY]: 'known', ...size } });
    const unknown = annotation('Stamp', { extra: { [STAMP_KEY]: 'other', ...size } });
    expect(provider.toLayer(known, 0, { edited: NONE }).shapes.length).toBeGreaterThan(0);
    expect(provider.toLayer(unknown, 0, { edited: NONE }).shapes).toEqual([]);
    expect(provider.toLayer(annotation('Line'), 2, { edited: NONE }).page).toBe(2);
  });

  it('patches through the pure functions and reports a change to the service', async () => {
    expect(provider.movePatch(annotation('Square'), 1, 1).rect?.x0).toBe(101);
    expect(provider.resizePatch(annotation('Square'), RECT)).toEqual({ rect: RECT });
    expect(provider.handlePatch?.(annotation('Square'), 'v0', { x: 0, y: 0 })).toBeNull();
    await provider.afterChange?.(annotation('Ink'));
    expect(calls).toContain('after:Ink');
  });

  it('describes a drawing, and opens an attachment through M12 when it has a file', () => {
    expect(provider.describe?.(annotation('Polygon'))).toBe('Polygon');
    expect(provider.describe?.(annotation('Stamp'))).toBe('Stamp');
    expect(provider.open?.(annotation('Square'))).toBe(false);
    expect(provider.open?.(annotation('FileAttachment'))).toBe(false);
    expect(provider.open?.(annotation('FileAttachment', { contents: 'has file' }))).toBe(true);
    expect(calls).toContain('run:attachments.open:att-1');
  });
});
