/**
 * What the overlay draws, what it lets you grab, and where a handle drag lands (M30).
 *
 * The one rule everything here turns on: **the overlay draws exactly the annotations the raster
 * does not carry.** Getting it wrong in one direction draws a highlight twice; in the other, a
 * typewriter note vanishes. Both are checked, for a file's annotations and for ones this session
 * has edited.
 */

import { describe, expect, it } from 'vitest';
import type { AnnotationSubtype } from '@engine/PdfEngine';
import { toModelAnnotation, type ModelAnnotation } from '@core/model';
import type { ModelId } from '@core/Ids';
import type { PdfRect } from '@shared/pdf';
import {
  BOX_HANDLES,
  handlePoints,
  hitsAnnotation,
  resizeRect,
  type LayerAnnotation,
} from '@view/AnnotationLayer';
import {
  cssFamily,
  drawnByOverlay,
  handlesFor,
  hitRects,
  isOurs,
  shapesFor,
  toLayerAnnotation,
} from '@modules/M30-markup-annotations/shapes';
import { buildDefaultAppearance, DEFAULT_FREE_TEXT_STYLE, quadNumbers } from '@engine/appearance';
import { must } from '../find/helpers';

const RECT: PdfRect = { x0: 100, y0: 500, x1: 300, y1: 560 };

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

const NOTHING: ReadonlySet<string> = new Set();
const EDITED: ReadonlySet<string> = new Set(['an-1']);

describe('which annotations are ours', () => {
  it('claims markup, notes, free text and the caret, and leaves the rest', () => {
    for (const subtype of [
      'Highlight',
      'Underline',
      'Squiggly',
      'StrikeOut',
      'Text',
      'FreeText',
      'Caret',
    ] as const) {
      expect(isOurs(annotation(subtype)), subtype).toBe(true);
    }
    for (const subtype of ['Square', 'Ink', 'Stamp', 'Widget', 'Link', 'FileAttachment'] as const) {
      expect(isOurs(annotation(subtype)), subtype).toBe(false);
    }
  });
});

describe('who draws what', () => {
  it('PDFium draws the markup family and notes, so the overlay does not', () => {
    for (const subtype of ['Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Text'] as const) {
      expect(drawnByOverlay(annotation(subtype), NOTHING), subtype).toBe(false);
      // Even after an edit: reloading the page makes PDFium build the appearance again.
      expect(drawnByOverlay(annotation(subtype), EDITED), subtype).toBe(false);
    }
  });

  it('free text and carets are the overlay’s, because PDFium draws neither', () => {
    for (const subtype of ['FreeText', 'Caret'] as const) {
      expect(drawnByOverlay(annotation(subtype), NOTHING), subtype).toBe(true);
    }
  });

  it('a free text the file already drew is left to the raster', () => {
    const saved = annotation('FreeText', { extra: { hasAP: true } });
    expect(drawnByOverlay(saved, NOTHING)).toBe(false);
    // Until this session edits it, at which point PDFium drops the stream and never rebuilds it.
    expect(drawnByOverlay(saved, EDITED)).toBe(true);
  });

  it('a hidden annotation is drawn by nobody', () => {
    const hidden = annotation('FreeText', {
      flags: { hidden: true, print: true, noView: false, readOnly: false, locked: false },
    });
    expect(drawnByOverlay(hidden, EDITED)).toBe(false);
  });

  it('an annotation nobody draws contributes no shapes to the layer', () => {
    const layer = toLayerAnnotation(annotation('Highlight'), 3, { edited: NOTHING });
    expect(layer.shapes).toEqual([]);
    expect(layer.page).toBe(3);
  });
});

describe('shapes', () => {
  it('a highlight is one closed quad per group of eight numbers, in multiply', () => {
    const quadPoints = [
      ...quadNumbers({
        ul: { x: 100, y: 560 },
        ur: { x: 300, y: 560 },
        ll: { x: 100, y: 500 },
        lr: { x: 300, y: 500 },
      }),
      ...quadNumbers({
        ul: { x: 100, y: 490 },
        ur: { x: 200, y: 490 },
        ll: { x: 100, y: 470 },
        lr: { x: 200, y: 470 },
      }),
    ];
    const shapes = shapesFor(annotation('Highlight', { quadPoints, color: 0xffe14d }));
    const path = must(shapes[0], 'path');
    expect(path.kind).toBe('path');
    if (path.kind !== 'path') return;
    expect(path.blend).toBe('multiply');
    expect(path.fill).toBe(0xffe14d);
    expect(path.steps.filter((s) => s.op === 'Z').length).toBe(2);
  });

  it('an underline is a stroke, not a fill', () => {
    const shapes = shapesFor(
      annotation('Underline', {
        quadPoints: quadNumbers({
          ul: { x: 0, y: 10 },
          ur: { x: 50, y: 10 },
          ll: { x: 0, y: 0 },
          lr: { x: 50, y: 0 },
        }),
        color: 0x0b5cd6,
      }),
    );
    const path = must(shapes[0], 'path');
    if (path.kind !== 'path') throw new Error('expected a path');
    expect(path.fill).toBeNull();
    expect(path.stroke).toBe(0x0b5cd6);
    expect(path.width).toBeGreaterThan(0);
  });

  it('a note draws its icon, scaled into its rect', () => {
    const shapes = shapesFor(annotation('Text', { extra: { icon: 'Key' } }));
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) {
      if (shape.kind !== 'path') continue;
      for (const step of shape.steps) {
        if (step.op === 'Z') continue;
        expect(step.x).toBeGreaterThanOrEqual(RECT.x0);
        expect(step.x).toBeLessThanOrEqual(RECT.x1);
      }
    }
  });

  it('a text box draws its frame and its words; a typewriter only its words', () => {
    const extra = { defaultAppearance: buildDefaultAppearance(DEFAULT_FREE_TEXT_STYLE) };
    const box = shapesFor(
      annotation('FreeText', {
        contents: 'Hello',
        color: 0x000000,
        interiorColor: 0xffffff,
        borderWidth: 1,
        extra,
      }),
    );
    expect(box.filter((s) => s.kind === 'path').length).toBe(1);
    expect(box.filter((s) => s.kind === 'text').length).toBe(1);

    const typewriter = shapesFor(
      annotation('FreeText', {
        contents: 'Hello',
        color: 0x000000,
        interiorColor: 0xffffff,
        borderWidth: 1,
        extra: { ...extra, intent: 'FreeTextTypewriter' },
      }),
    );
    expect(typewriter.filter((s) => s.kind === 'path').length).toBe(0);
    expect(typewriter.filter((s) => s.kind === 'text').length).toBe(1);
  });

  it('a callout draws its leader line and its arrow head as well as its box', () => {
    const shapes = shapesFor(
      annotation('FreeText', {
        contents: 'Look',
        color: 0x0b5cd6,
        borderWidth: 1,
        extra: { intent: 'FreeTextCallout', callout: [20, 400, 60, 430, 100, 430] },
      }),
    );
    // Leader line, arrow head, frame, text.
    expect(shapes.length).toBe(4);
  });

  it('maps the base families on to font stacks a browser has', () => {
    expect(cssFamily('Times New Roman')).toContain('serif');
    expect(cssFamily('Courier New')).toContain('monospace');
    expect(cssFamily('Helvetica')).toContain('sans-serif');
    expect(cssFamily('Segoe UI')).toContain('"Segoe UI"');
  });
});

describe('hit areas and handles', () => {
  it('markup is hit through its quads, so the gaps between lines are not part of it', () => {
    const quadPoints = [
      ...quadNumbers({
        ul: { x: 100, y: 560 },
        ur: { x: 300, y: 560 },
        ll: { x: 100, y: 550 },
        lr: { x: 300, y: 550 },
      }),
      ...quadNumbers({
        ul: { x: 100, y: 510 },
        ur: { x: 200, y: 510 },
        ll: { x: 100, y: 500 },
        lr: { x: 200, y: 500 },
      }),
    ];
    const rects = hitRects(annotation('Highlight', { quadPoints }));
    expect(rects.length).toBe(2);
    const layer = toLayerAnnotation(annotation('Highlight', { quadPoints }), 0, {
      edited: NOTHING,
    });
    // Inside a quad: a hit. Between the two lines: not.
    expect(hitsAnnotation(layer, { x: 150, y: 555 }, 0)).toBe(true);
    expect(hitsAnnotation(layer, { x: 150, y: 530 }, 0)).toBe(false);
  });

  it('everything else is hit through its rect', () => {
    expect(hitRects(annotation('Text'))).toEqual([RECT]);
    expect(hitRects(annotation('FreeText'))).toEqual([RECT]);
  });

  it('markup cannot be dragged, a note can be moved, free text can be resized', () => {
    expect(handlesFor(annotation('Highlight'))).toBe('none');
    expect(handlesFor(annotation('Text'))).toBe('move');
    expect(handlesFor(annotation('Caret'))).toBe('move');
    expect(handlesFor(annotation('FreeText'))).toBe('box');
    expect(handlesFor(annotation('FreeText', { extra: { intent: 'FreeTextCallout' } }))).toBe(
      'callout',
    );
  });

  it('a box offers eight handles at the places a reader expects them', () => {
    const layer: LayerAnnotation = {
      id: 'a',
      page: 0,
      rect: RECT,
      shapes: [],
      hit: [RECT],
      handles: 'box',
    };
    const points = handlePoints(layer);
    expect(points.map((p) => p.id)).toEqual([...BOX_HANDLES]);
    expect(points.find((p) => p.id === 'nw')?.point).toEqual({ x: 100, y: 560 });
    expect(points.find((p) => p.id === 'se')?.point).toEqual({ x: 300, y: 500 });
    expect(points.find((p) => p.id === 'n')?.point).toEqual({ x: 200, y: 560 });
  });

  it('a callout adds a handle for its tip and one for its knee', () => {
    const layer: LayerAnnotation = {
      id: 'a',
      page: 0,
      rect: RECT,
      shapes: [],
      hit: [RECT],
      handles: 'callout',
      callout: [
        { x: 20, y: 400 },
        { x: 60, y: 430 },
        { x: 100, y: 430 },
      ],
    };
    const ids = handlePoints(layer).map((p) => p.id);
    expect(ids).toContain('tip');
    expect(ids).toContain('knee');
    expect(handlePoints({ ...layer, handles: 'move' })).toEqual([]);
  });

  it('a handle drag moves the edges it belongs to and leaves the others', () => {
    expect(resizeRect(RECT, 'se', { x: 400, y: 450 })).toEqual({
      x0: 100,
      y0: 450,
      x1: 400,
      y1: 560,
    });
    expect(resizeRect(RECT, 'n', { x: 999, y: 600 })).toEqual({ ...RECT, y1: 600 });
    expect(resizeRect(RECT, 'w', { x: 50, y: 999 })).toEqual({ ...RECT, x0: 50 });
  });

  it('dragging a handle past the far edge flips the rect rather than inverting it', () => {
    const flipped = resizeRect(RECT, 'e', { x: 10, y: 0 });
    expect(flipped.x0).toBeLessThan(flipped.x1);
    expect(flipped).toEqual({ x0: 10, y0: 500, x1: 100, y1: 560 });
  });

  it('the slack is on both sides, so a thin caret is still grabbable', () => {
    const thin: LayerAnnotation = {
      id: 'a',
      page: 0,
      rect: { x0: 100, y0: 500, x1: 101, y1: 508 },
      shapes: [],
      hit: [{ x0: 100, y0: 500, x1: 101, y1: 508 }],
      handles: 'move',
    };
    expect(hitsAnnotation(thin, { x: 98, y: 504 }, 3)).toBe(true);
    expect(hitsAnnotation(thin, { x: 98, y: 504 }, 0)).toBe(false);
  });
});
