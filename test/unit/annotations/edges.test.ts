/**
 * The corners of M30's pure code: the cases a reader reaches once a year and a regression reaches
 * every time. Text at exactly 45°, an ink annotation on the clipboard, a note whose icon has gone,
 * a settings store with no bridge behind it.
 */

import { describe, expect, it } from 'vitest';
import { ContentBuilder } from '@engine/appearance/content';
import {
  appearanceInput,
  defaultAppearanceService,
  metricFont,
  type AppearanceFont,
} from '@engine/appearance';
import { toModelAnnotation, type ModelAnnotation } from '@core/model';
import type { ModelId } from '@core/Ids';
import type { AnnotationSubtype } from '@engine/PdfEngine';
import type { PdfRect } from '@shared/pdf';
import { buildPageText } from '@view/TextLayer';
import { quadsForSpan, quadsForSpans } from '@modules/M30-markup-annotations/quads';
import {
  cssFamily,
  drawnByOverlay,
  hitRects,
  shapesFor,
  toLayerAnnotation,
} from '@modules/M30-markup-annotations/shapes';
import { decodeAnnotations, encodeAnnotations } from '@modules/M30-markup-annotations/clipboard';
import {
  ipcSettingsStorage,
  memorySettingsStorage,
  readSettings,
  readToolDefaults,
  factoryDefaults,
} from '@modules/M30-markup-annotations/settings';
import { must } from '../find/helpers';

const RECT: PdfRect = { x0: 0, y0: 0, x1: 100, y1: 40 };

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

describe('the content builder’s newer parts', () => {
  it('places each line at its own point, and skips empty ones', () => {
    const b = new ContentBuilder();
    b.textLinesAt(
      [
        { text: 'one', x: 10, y: 100 },
        { text: '', x: 10, y: 88 },
        { text: 'two', x: 20, y: 76 },
      ],
      { font: 'Helvetica', size: 12 },
    );
    const content = b.build();
    expect((content.match(/Tj/g) ?? []).length).toBe(2);
    expect(content).toContain('1 0 0 1 10 100 Tm');
    expect(content).toContain('1 0 0 1 20 76 Tm');
  });

  it('nothing but empty lines paints nothing at all', () => {
    const b = new ContentBuilder();
    b.textLinesAt([{ text: '', x: 0, y: 0 }], { font: 'Helvetica', size: 12 });
    expect(b.isEmpty).toBe(true);
  });

  it('the same face asked for twice shares one resource name; a different one does not', () => {
    const b = new ContentBuilder();
    const verdana: AppearanceFont = { baseFont: 'Verdana', fallback: 'Helvetica' };
    expect(b.fontName('Helvetica')).toBe(b.fontName('Helvetica'));
    expect(b.fontName(verdana)).toBe(b.fontName({ ...verdana }));
    expect(b.fontName(verdana)).not.toBe(b.fontName('Helvetica'));
    expect(Object.keys(b.resources.fonts).length).toBe(2);
    expect(metricFont(verdana)).toBe('Helvetica');
  });

  it('a dash pattern of zeros is a solid line, not an invisible one', () => {
    const b = new ContentBuilder();
    b.dash([0, 0]);
    expect(b.build()).toBe('[] 0 d');
  });
});

describe('quads at the awkward angles', () => {
  it('text at exactly 45° falls back to the boxes it was given', () => {
    const angle = Math.PI / 4;
    const cos = Math.cos(angle);
    const chars: PdfRect[] = [0, 1, 2].map((i) => ({
      x0: 100 + i * 6 * cos,
      y0: 100 + i * 6 * cos,
      x1: 100 + i * 6 * cos + 11,
      y1: 100 + i * 6 * cos + 11,
    }));
    const text = buildPageText(0, [
      {
        text: 'abc',
        rect: { x0: 100, y0: 100, x1: 130, y1: 130 },
        chars,
        origin: { x: 100, y: 100 },
        matrix: [cos, cos, -cos, cos, 100, 100],
        fontName: 'Helvetica',
        fontSize: 10,
        color: 0,
        objectIndex: 0,
        angle,
      },
    ]);
    const list = quadsForSpan(text, { start: 0, end: text.text.length });
    // It still produces a quad — the point is that it does not divide by nearly nothing.
    expect(list.length).toBe(1);
    const quad = must(list[0], 'quad');
    for (const corner of [quad.ul, quad.ur, quad.ll, quad.lr]) {
      expect(Number.isFinite(corner.x)).toBe(true);
      expect(Number.isFinite(corner.y)).toBe(true);
    }
  });

  it('several spans on one page contribute their quads in order', () => {
    const text = buildPageText(0, [
      {
        text: 'abcdef',
        rect: { x0: 0, y0: 0, x1: 60, y1: 10 },
        chars: [0, 1, 2, 3, 4, 5].map((i) => ({ x0: i * 10, y0: 0, x1: i * 10 + 10, y1: 10 })),
        origin: { x: 0, y: 0 },
        matrix: [1, 0, 0, 1, 0, 0],
        fontName: 'Helvetica',
        fontSize: 10,
        color: 0,
        objectIndex: 0,
      },
    ]);
    const list = quadsForSpans(text, [
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ]);
    expect(list.length).toBe(2);
    expect(list[0]?.ul.x).toBeCloseTo(0, 4);
    expect(list[1]?.ul.x).toBeCloseTo(40, 4);
  });
});

describe('shapes at the edges', () => {
  it('a caret draws its proof-reading mark', () => {
    const shapes = shapesFor(annotation('Caret'));
    const path = must(shapes[0], 'path');
    if (path.kind !== 'path') throw new Error('expected a path');
    expect(path.fill).not.toBeNull();
    expect(path.steps.length).toBeGreaterThan(4);
  });

  it('a caret with no area draws nothing', () => {
    expect(shapesFor(annotation('Caret', { rect: { x0: 5, y0: 5, x1: 5, y1: 5 } }))).toEqual([]);
  });

  it('markup with no quads at all draws nothing rather than a guess', () => {
    expect(shapesFor(annotation('Highlight'))).toEqual([]);
    expect(hitRects(annotation('Highlight'))).toEqual([RECT]);
  });

  it('a squiggly draws a zigzag, which is more points than a plain rule', () => {
    const quadPoints = [0, 12, 200, 12, 0, 0, 200, 0];
    const squiggly = shapesFor(annotation('Squiggly', { quadPoints }));
    const underline = shapesFor(annotation('Underline', { quadPoints }));
    const a = must(squiggly[0], 'squiggly');
    const b = must(underline[0], 'underline');
    if (a.kind !== 'path' || b.kind !== 'path') throw new Error('expected paths');
    expect(a.steps.length).toBeGreaterThan(b.steps.length);
  });

  it('a callout with only a tip has no leader line to draw', () => {
    const shapes = shapesFor(
      annotation('FreeText', {
        color: 0x000000,
        borderWidth: 1,
        contents: 'x',
        extra: { intent: 'FreeTextCallout', callout: [10, 10] },
      }),
    );
    // The frame and the text, and nothing else.
    expect(shapes.length).toBe(2);
  });

  it('a dashed border reaches the layer as a dash pattern', () => {
    const shapes = shapesFor(
      annotation('FreeText', {
        color: 0x000000,
        borderWidth: 2,
        extra: { borderStyle: 'dashed' },
      }),
    );
    const path = must(shapes[0], 'path');
    if (path.kind !== 'path') throw new Error('expected a path');
    expect(path.dash).toEqual([6, 4]);
  });

  it('the annotation being edited is hidden, so its text is not drawn twice', () => {
    const layer = toLayerAnnotation(annotation('FreeText'), 0, {
      edited: new Set(['an-1']),
      hidden: true,
    });
    expect(layer.hidden).toBe(true);
  });

  it('a symbol font falls back to something a browser has', () => {
    expect(cssFamily('Symbol')).toBe('serif');
    expect(cssFamily('ZapfDingbats')).toBe('serif');
  });

  it('an annotation that is not ours is drawn by nobody', () => {
    expect(drawnByOverlay(annotation('Square'), new Set(['an-1']))).toBe(false);
  });
});

describe('the clipboard at the edges', () => {
  it('carries an ink annotation’s strokes and a shape’s vertices', () => {
    const ink = annotation('Ink', {
      paths: [
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      ],
    });
    const [back] = decodeAnnotations(encodeAnnotations([{ annotation: ink, page: 0 }]));
    const decoded = must(back, 'item').annotation;
    expect('paths' in decoded ? decoded.paths.length : 0).toBe(1);
  });

  it('a page that is not a number lands on the first one', () => {
    const payload = `ynotPDF annotations v1\n${JSON.stringify([
      { subtype: 'Text', rect: { x0: 0, y0: 0, x1: 1, y1: 1 }, page: 'three' },
      { subtype: 'Text', rect: { x0: 0, y0: 0, x1: 1, y1: 1 }, page: -4 },
    ])}`;
    expect(decodeAnnotations(payload).map((i) => i.page)).toEqual([0, 0]);
  });

  it('an entry that is not an object at all is dropped', () => {
    const payload = `ynotPDF annotations v1\n${JSON.stringify([null, 3, 'x'])}`;
    expect(decodeAnnotations(payload)).toEqual([]);
  });

  it('keeps the flags an annotation was locked with', () => {
    const locked = annotation('Text', {
      flags: { hidden: false, print: true, noView: false, readOnly: false, locked: true },
    });
    const [back] = decodeAnnotations(encodeAnnotations([{ annotation: locked, page: 0 }]));
    expect(must(back, 'item').annotation.flags.locked).toBe(true);
  });
});

describe('settings without a bridge', () => {
  it('reading through the IPC storage outside Electron gives the defaults back', async () => {
    const storage = ipcSettingsStorage();
    await expect(storage.set('annot.keepToolSelected', true)).resolves.toBeUndefined();
    expect(await storage.get('annot.keepToolSelected')).toBeUndefined();
    const settings = await readSettings(storage);
    expect(settings.keepToolSelected).toBe(false);
  });

  it('an unset tool falls back to the factory defaults', async () => {
    const storage = memorySettingsStorage();
    expect(await readToolDefaults(storage, 'callout')).toEqual(factoryDefaults('callout'));
  });
});

describe('a note whose icon the file names and we do not draw', () => {
  it('still draws, as a Comment', () => {
    const stream = defaultAppearanceService.generate(
      appearanceInput({
        subtype: 'Text',
        rect: { x0: 0, y0: 0, x1: 20, y1: 20 },
        extra: { icon: 'SomeFoxitIconWeHaveNeverHeardOf' },
      }),
    );
    expect(stream).not.toBeNull();
    expect(shapesFor(annotation('Text', { extra: { icon: 'Nonsense' } })).length).toBeGreaterThan(
      0,
    );
  });
});
