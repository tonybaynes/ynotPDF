/**
 * The appearance service (M21): the generators, the content-stream emitter, the font metrics,
 * and the one thing that matters at the end — that an annotation without an `/AP` gets one and
 * comes back out of the engine drawn.
 */

import { describe, expect, it } from 'vitest';
import { Encodings, Font } from '@pdf-lib/standard-fonts';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFPageLeaf, PDFRef } from 'pdf-lib';
import {
  AppearanceService,
  appearanceInput,
  createAppearanceService,
  defaultAppearanceService,
  PDFIUM_GENERATES,
  quadRects,
} from '@engine/appearance';
import { ContentBuilder, num, pdfString, rgbComponents } from '@engine/appearance/content';
import { glyphWidth, textWidth, wrapText } from '@engine/appearance/metrics';
import type { StandardFontName } from '@engine/appearance/types';
import { emptyWritePlan, type WritePlan } from '@engine/Writer';
import { FullRewriteWriter } from '@engine/writers/FullRewriteWriter';
import type { PdfRect } from '@shared/pdf';
import { engine } from '../engine/helpers';

describe('number and string formatting', () => {
  it('never writes an exponent, which a PDF cannot read', () => {
    expect(num(1e-7)).toBe('0');
    expect(num(0.123456789)).toBe('0.1235');
    expect(num(-0)).toBe('0');
    expect(num(Number.NaN)).toBe('0');
    expect(num(Number.POSITIVE_INFINITY)).toBe('0');
    expect(num(1.5)).toBe('1.5');
    expect(num(-2.25)).toBe('-2.25');
    expect(num(42)).toBe('42');
    // A value big enough that `String()` would reach exponent notation is clamped instead.
    for (const value of [1e21, -1e21, 1e300, Number.MAX_SAFE_INTEGER]) {
      expect(num(value), String(value)).not.toMatch(/e/i);
    }
  });

  it('escapes the three characters that would end a literal string early', () => {
    expect(pdfString('a(b)c\\d')).toBe('(a\\(b\\)c\\\\d)');
    expect(pdfString('line\nbreak')).toBe('(line\\nbreak)');
    // Outside Latin-1 there is no WinAnsi glyph, so a placeholder is honest about it.
    expect(pdfString('日')).toBe('(?)');
  });

  it('splits a packed colour into components', () => {
    expect(rgbComponents(0xff0000)).toEqual([1, 0, 0]);
    expect(rgbComponents(0x000000)).toEqual([0, 0, 0]);
    const [, g] = rgbComponents(0x008000);
    expect(g).toBeCloseTo(128 / 255, 5);
  });
});

describe('font metrics', () => {
  const FONTS: ReadonlyArray<StandardFontName> = [
    'Helvetica',
    'Helvetica-Bold',
    'Helvetica-Oblique',
    'Helvetica-BoldOblique',
    'Times-Roman',
    'Times-Bold',
    'Times-Italic',
    'Times-BoldItalic',
    'Courier',
  ];

  /**
   * The tables in `metrics.ts` were generated from `@pdf-lib/standard-fonts`. This is the check
   * that they still agree with it, so a copy-and-paste slip would fail the build rather than
   * quietly move every wrapped line by a few points.
   */
  it.each(FONTS)('%s matches the AFM metrics exactly', (name) => {
    const font = Font.load(name);
    const encoding = Encodings.WinAnsi;
    for (let code = 32; code <= 255; code++) {
      if (!encoding.canEncodeUnicodeCodePoint(code)) continue;
      const glyph = encoding.encodeUnicodeCodePoint(code);
      const expected = font.getWidthOfGlyph(glyph.name);
      if (!expected) continue;
      expect(glyphWidth(name, code), `${name} code ${code}`).toBe(expected);
    }
  });

  it('measures a string in points', () => {
    // "AV" in Helvetica at 12pt: 667 + 667 thousandths of an em.
    expect(textWidth('AV', 'Helvetica', 12)).toBeCloseTo((667 + 667) * 0.012, 5);
    expect(textWidth('', 'Helvetica', 12)).toBe(0);
    // Courier is monospaced, so ten characters are ten times one.
    expect(textWidth('0123456789', 'Courier', 10)).toBeCloseTo(6 * 10, 5);
  });

  it('falls back to the space width for a glyph the encoding does not have', () => {
    expect(glyphWidth('Helvetica', 0x4e00)).toBe(glyphWidth('Helvetica', 32));
    // Symbol has no Latin text table; it measures as Courier rather than as zero.
    expect(glyphWidth('Symbol', 65)).toBeGreaterThan(0);
  });

  it('wraps on words, keeps blank lines, and breaks a word that cannot fit', () => {
    const lines = wrapText('the quick brown fox', 'Helvetica', 12, 60);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(textWidth(line, 'Helvetica', 12)).toBeLessThanOrEqual(60);

    expect(wrapText('a\n\nb', 'Helvetica', 12, 500)).toEqual(['a', '', 'b']);

    const broken = wrapText('Llanfairpwllgwyngyll', 'Helvetica', 12, 30);
    expect(broken.length).toBeGreaterThan(1);
    for (const line of broken) expect(textWidth(line, 'Helvetica', 12)).toBeLessThanOrEqual(30);
    expect(broken.join('')).toBe('Llanfairpwllgwyngyll');
  });
});

describe('the content builder', () => {
  it('shares one graphics state between identical requests', () => {
    const b = new ContentBuilder();
    b.graphicsState({ fillAlpha: 0.5 });
    b.graphicsState({ fillAlpha: 0.5 });
    b.graphicsState({ fillAlpha: 0.25 });
    expect(Object.keys(b.resources.extGState)).toHaveLength(2);
    expect(
      b
        .build()
        .split('\n')
        .filter((l) => l.endsWith('gs')),
    ).toHaveLength(3);
  });

  it('names each font once', () => {
    const b = new ContentBuilder();
    b.text('a', { font: 'Helvetica', size: 10, x: 0, y: 0 });
    b.text('b', { font: 'Helvetica', size: 10, x: 0, y: 0 });
    b.text('c', { font: 'Times-Roman', size: 10, x: 0, y: 0 });
    expect(Object.values(b.resources.fonts).sort()).toEqual(['Helvetica', 'Times-Roman']);
  });

  it('an ellipse is four Béziers and closes', () => {
    const b = new ContentBuilder();
    b.ellipse({ x0: 0, y0: 0, x1: 10, y1: 10 });
    const ops = b.build().split('\n');
    expect(ops.filter((o) => o.endsWith(' c'))).toHaveLength(4);
    expect(ops.at(-1)).toBe('h');
  });

  it('a polyline of fewer than two points draws nothing', () => {
    const b = new ContentBuilder();
    b.polyline([{ x: 1, y: 1 }]);
    expect(b.isEmpty).toBe(true);
  });
});

describe('quad points', () => {
  it('turns each group of eight numbers into a rectangle', () => {
    // Top-left, top-right, bottom-left, bottom-right — the order the spec uses.
    expect(quadRects([10, 30, 100, 30, 10, 10, 100, 10])).toEqual([
      { x0: 10, y0: 10, x1: 100, y1: 30 },
    ]);
  });

  it('ignores a trailing partial quad rather than inventing one', () => {
    expect(quadRects([10, 30, 100, 30, 10, 10, 100])).toEqual([]);
  });
});

describe('the generators', () => {
  const service = defaultAppearanceService;

  it('covers every subtype PDFium leaves undrawn', () => {
    for (const subtype of ['Line', 'Polygon', 'PolyLine', 'FreeText', 'FileAttachment', 'Caret']) {
      expect(PDFIUM_GENERATES.has(subtype as never)).toBe(false);
      expect(service.has(subtype as never), subtype).toBe(true);
    }
  });

  it('draws a square with its border inside the rect', () => {
    const stream = service.generate(
      appearanceInput({
        subtype: 'Square',
        rect: { x0: 0, y0: 0, x1: 100, y1: 50 },
        color: 0xff0000,
        interiorColor: 0x0000ff,
        borderWidth: 4,
      }),
    );
    expect(stream).not.toBeNull();
    // Inset by half the stroke, so the 4pt border sits inside 0..100 (M31 draws the four sides
    // as a path, so a cloudy border and a plain one come from the same list of corners).
    expect(stream?.content).toContain('2 2 m');
    expect(stream?.content).toContain('98 48 l');
    // Filled and stroked, in one operator.
    expect(stream?.content).toContain('B');
    expect(stream?.bbox.x0).toBeLessThan(0);
  });

  it('a shape too small for its own border draws nothing rather than inside out', () => {
    const input = appearanceInput({
      subtype: 'Square',
      rect: { x0: 0, y0: 0, x1: 2, y1: 2 },
      borderWidth: 8,
    });
    expect(service.generate(input)).toBeNull();
    expect(service.generate({ ...input, subtype: 'Circle' })).toBeNull();
  });

  it('a highlight multiplies so the text underneath still reads', () => {
    const stream = service.generate(
      appearanceInput({
        subtype: 'Highlight',
        rect: { x0: 0, y0: 0, x1: 100, y1: 20 },
        color: 0xffff00,
        opacity: 0.4,
        quadPoints: [0, 20, 100, 20, 0, 0, 100, 0],
      }),
    );
    expect(stream?.content).toContain('gs');
    const state = Object.values(stream?.resources.extGState ?? {})[0];
    expect(state?.blendMode).toBe('Multiply');
    expect(state?.fillAlpha).toBe(0.4);
  });

  it('markup with no quads still draws over its whole rect', () => {
    for (const subtype of ['Highlight', 'Underline', 'StrikeOut', 'Squiggly'] as const) {
      const stream = service.generate(
        appearanceInput({ subtype, rect: { x0: 0, y0: 0, x1: 80, y1: 12 }, color: 0x00ff00 }),
      );
      expect(stream, subtype).not.toBeNull();
    }
  });

  it('underline and strike-out are at different heights', () => {
    const rect = { x0: 0, y0: 0, x1: 100, y1: 20 };
    const under = service.generate(appearanceInput({ subtype: 'Underline', rect }));
    const strike = service.generate(appearanceInput({ subtype: 'StrikeOut', rect }));
    expect(under?.content).toContain('0 1.25 m');
    expect(strike?.content).toContain('0 10 m');
  });

  it('a single ink point is a dot, not nothing', () => {
    const stream = service.generate(
      appearanceInput({
        subtype: 'Ink',
        rect: { x0: 0, y0: 0, x1: 10, y1: 10 },
        paths: [[{ x: 5, y: 5 }]],
        borderWidth: 3,
      }),
    );
    expect(stream?.content).toContain('1 J');
    expect(stream?.content).toContain('5 5 m');
    expect(stream?.content).toContain('5 5 l');
  });

  it('ink with no strokes draws nothing', () => {
    expect(
      service.generate(
        appearanceInput({ subtype: 'Ink', rect: { x0: 0, y0: 0, x1: 10, y1: 10 }, paths: [] }),
      ),
    ).toBeNull();
  });

  it('a line falls back to the rect diagonal when it has no vertices', () => {
    const stream = service.generate(
      appearanceInput({ subtype: 'Line', rect: { x0: 1, y0: 2, x1: 30, y1: 40 } }),
    );
    expect(stream?.content).toContain('1 2 m');
    expect(stream?.content).toContain('30 40 l');
  });

  it('a polygon needs three points and a polyline two', () => {
    const two = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(
      service.generate(
        appearanceInput({
          subtype: 'Polygon',
          rect: { x0: 0, y0: 0, x1: 10, y1: 10 },
          vertices: two,
        }),
      ),
    ).toBeNull();
    expect(
      service.generate(
        appearanceInput({
          subtype: 'PolyLine',
          rect: { x0: 0, y0: 0, x1: 10, y1: 10 },
          vertices: two,
        }),
      ),
    ).not.toBeNull();
  });

  it('free text wraps inside its box, clips to it and asks for a font', () => {
    const stream = service.generate(
      appearanceInput({
        subtype: 'FreeText',
        rect: { x0: 0, y0: 0, x1: 120, y1: 60 },
        contents: 'The quick brown fox jumps over the lazy dog',
        interiorColor: 0xffffff,
        borderWidth: 1,
        color: 0x000000,
        extra: { fontSize: 10 },
      }),
    );
    expect(stream?.content).toContain('BT');
    expect(stream?.content).toContain('W');
    expect(Object.values(stream?.resources.fonts ?? {})).toEqual(['Helvetica']);
    // Wrapped: more than one `Tj`.
    expect((stream?.content.match(/Tj/g) ?? []).length).toBeGreaterThan(1);
  });

  it('free text with nothing in it and no box draws nothing', () => {
    expect(
      service.generate(
        appearanceInput({
          subtype: 'FreeText',
          rect: { x0: 0, y0: 0, x1: 100, y1: 40 },
          borderWidth: 0,
        }),
      ),
    ).toBeNull();
  });

  it('a circle is an ellipse in the inset rect, filled and stroked', () => {
    const stream = service.generate(
      appearanceInput({
        subtype: 'Circle',
        rect: { x0: 0, y0: 0, x1: 100, y1: 60 },
        color: 0x00ff00,
        interiorColor: 0xffffff,
        borderWidth: 2,
      }),
    );
    // Four Béziers, closed, then filled and stroked in one go.
    expect((stream?.content.match(/ c$/gm) ?? []).length).toBe(4);
    expect(stream?.content).toContain('B');
  });

  it('a shape with no border and no fill clears its path instead of leaving one hanging', () => {
    // Border width 0 and no interior colour: there is nothing to paint, so nothing is drawn.
    expect(
      service.generate(
        appearanceInput({
          subtype: 'Square',
          rect: { x0: 0, y0: 0, x1: 50, y1: 50 },
          borderWidth: 0,
        }),
      ),
    ).toBeNull();
  });

  it('a dash pattern reaches the stream, and zero-length dashes are dropped', () => {
    const stream = service.generate(
      appearanceInput({
        subtype: 'Square',
        rect: { x0: 0, y0: 0, x1: 50, y1: 50 },
        color: 0x000000,
        borderWidth: 1,
        extra: { dashArray: [3, 0, 2, 'nonsense'] },
      }),
    );
    expect(stream?.content).toContain('[3 2] 0 d');
  });

  it('a polyline honours a dash pattern too', () => {
    const stream = service.generate(
      appearanceInput({
        subtype: 'Ink',
        rect: { x0: 0, y0: 0, x1: 50, y1: 50 },
        paths: [
          [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
        ],
        extra: { dashArray: [4, 4] },
      }),
    );
    expect(stream?.content).toContain('[4 4] 0 d');
  });

  it('a line with no width still draws, because a PDF default border is 1 point', () => {
    for (const subtype of ['Line', 'PolyLine'] as const) {
      const stream = service.generate(
        appearanceInput({
          subtype,
          rect: { x0: 0, y0: 0, x1: 50, y1: 50 },
          borderWidth: 0,
          vertices: [
            { x: 0, y: 0 },
            { x: 50, y: 50 },
          ],
        }),
      );
      expect(stream?.content, subtype).toContain('1 w');
    }
  });

  it('a file attachment draws a pushpin, scaled to its rect', () => {
    const stream = service.generate(
      appearanceInput({
        subtype: 'FileAttachment',
        rect: { x0: 100, y0: 200, x1: 120, y1: 224 },
        color: 0x3392ff,
      }),
    );
    expect(stream).not.toBeNull();
    expect(stream?.content).toContain('f');
    expect(stream?.content).toContain('S');
    // Drawn where the annotation is, not at the origin.
    expect(stream?.content).toMatch(/1[01]\d(\.\d+)? 2\d\d(\.\d+)? m/);
  });

  it('a file attachment with no area draws nothing', () => {
    expect(
      service.generate(
        appearanceInput({
          subtype: 'FileAttachment',
          rect: { x0: 10, y0: 10, x1: 10, y1: 10 },
        }),
      ),
    ).toBeNull();
  });

  it('a caret is a filled triangle, and a flat one draws nothing', () => {
    const stream = service.generate(
      appearanceInput({
        subtype: 'Caret',
        rect: { x0: 0, y0: 0, x1: 10, y1: 20 },
        color: 0x112233,
      }),
    );
    expect(stream?.content).toContain('5 20 l');
    expect(stream?.content).toContain('f');
    expect(
      service.generate(appearanceInput({ subtype: 'Caret', rect: { x0: 5, y0: 5, x1: 5, y1: 5 } })),
    ).toBeNull();
  });

  it('free text picks a named standard font and falls back for anything else', () => {
    const withFont = service.generate(
      appearanceInput({
        subtype: 'FreeText',
        rect: { x0: 0, y0: 0, x1: 200, y1: 60 },
        contents: 'Typed',
        extra: { font: 'Times-Bold', fontSize: 14, textColor: 0x112233 },
      }),
    );
    expect(Object.values(withFont?.resources.fonts ?? {})).toEqual(['Times-Bold']);

    const unknown = service.generate(
      appearanceInput({
        subtype: 'FreeText',
        rect: { x0: 0, y0: 0, x1: 200, y1: 60 },
        contents: 'Typed',
        extra: { font: 'Comic Sans', fontSize: -3 },
      }),
    );
    expect(Object.values(unknown?.resources.fonts ?? {})).toEqual(['Helvetica']);
  });

  it('an unregistered subtype returns null rather than throwing', () => {
    expect(
      service.generate(
        appearanceInput({ subtype: 'Sound', rect: { x0: 0, y0: 0, x1: 10, y1: 10 } }),
      ),
    ).toBeNull();
  });
});

describe('the registry', () => {
  it('a module can register its own generator and take it back', () => {
    const service = new AppearanceService();
    expect(service.has('Stamp')).toBe(false);
    const undo = service.register('Stamp', () => ({
      bbox: { x0: 0, y0: 0, x1: 1, y1: 1 },
      content: '0 0 1 1 re f',
      resources: { extGState: {}, fonts: {} },
    }));
    expect(service.subtypes()).toEqual(['Stamp']);
    undo();
    expect(service.has('Stamp')).toBe(false);
  });

  it('replacing a generator restores the previous one', () => {
    const service = createAppearanceService();
    const before = service.generate(
      appearanceInput({ subtype: 'Square', rect: { x0: 0, y0: 0, x1: 10, y1: 10 } }),
    );
    const undo = service.register('Square', () => null);
    expect(
      service.generate(
        appearanceInput({ subtype: 'Square', rect: { x0: 0, y0: 0, x1: 10, y1: 10 } }),
      ),
    ).toBeNull();
    undo();
    expect(
      service.generate(
        appearanceInput({ subtype: 'Square', rect: { x0: 0, y0: 0, x1: 10, y1: 10 } }),
      ),
    ).toEqual(before);
  });
});

describe('the writer attaches what the generators draw', () => {
  /**
   * A one-page document with one bare `/Line` annotation and no `/AP`.
   *
   * Built with pdf-lib rather than through the engine because `FPDFPage_CreateAnnot` refuses the
   * subtypes PDFium cannot draw — which is precisely the set the generators exist for, so the
   * only way to test them end to end is to make the annotation ourselves.
   */
  async function documentWithBareLine(rect: PdfRect): Promise<Uint8Array> {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const page = pdf.addPage([595, 842]);
    const annot = pdf.context.obj({});
    annot.set(PDFName.of('Type'), PDFName.of('Annot'));
    annot.set(PDFName.of('Subtype'), PDFName.of('Line'));
    annot.set(PDFName.of('Rect'), pdf.context.obj([rect.x0, rect.y0, rect.x1, rect.y1]));
    annot.set(PDFName.of('L'), pdf.context.obj([rect.x0, rect.y0, rect.x1, rect.y1]));
    annot.set(PDFName.of('F'), pdf.context.obj(4));
    page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(annot)]));
    return pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
  }

  /** The first page's first annotation dictionary. */
  async function firstAnnotation(bytes: Uint8Array): Promise<{ pdf: PDFDocument; dict: PDFDict }> {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const leaves: PDFPageLeaf[] = [];
    pdf.catalog.Pages().traverse((node) => {
      if (node instanceof PDFPageLeaf) leaves.push(node);
    });
    const annots = leaves[0]?.lookupMaybe(PDFName.of('Annots'), PDFArray);
    const dict = pdf.context.lookupMaybe(annots?.get(0), PDFDict);
    if (!dict) throw new Error('the fixture should carry one annotation');
    return { pdf, dict };
  }

  const RECT: PdfRect = { x0: 50, y0: 50, x1: 250, y1: 150 };

  function planForLine(replace: boolean, rect: PdfRect = RECT): WritePlan {
    return {
      ...emptyWritePlan(1),
      pages: [
        {
          source: 0,
          annotations: [
            {
              index: 0,
              subtype: 'Line',
              rect,
              appearance: {
                input: appearanceInput({
                  subtype: 'Line',
                  rect,
                  color: 0x3392ff,
                  borderWidth: 2,
                  vertices: [
                    { x: rect.x0, y: rect.y0 },
                    { x: rect.x1, y: rect.y1 },
                  ],
                }),
                replace,
              },
            },
          ],
        },
      ],
    };
  }

  it('a Line annotation with no /AP gets one, and it is a form XObject', async () => {
    const base = await documentWithBareLine(RECT);
    const result = await new FullRewriteWriter().write({ bytes: base, plan: planForLine(false) });
    expect(result.appearances).toBe(1);
    expect(result.applied).toContain('annotations');
    expect(result.warnings).toEqual([]);

    const { pdf, dict } = await firstAnnotation(result.bytes);
    const ap = dict.lookupMaybe(PDFName.of('AP'), PDFDict);
    const normal = ap?.get(PDFName.of('N'));
    expect(normal).toBeInstanceOf(PDFRef);
    const form = pdf.context.lookup(normal);
    const formDict = (form as { dict?: PDFDict }).dict;
    expect(formDict?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText()).toBe('Form');
    expect(formDict?.lookupMaybe(PDFName.of('BBox'), PDFArray)?.size()).toBe(4);
    expect(formDict?.lookupMaybe(PDFName.of('Matrix'), PDFArray)?.size()).toBe(6);

    // And the engine can open what we wrote, which is the only proof that matters.
    const eng = await engine();
    const handle = await eng.open(result.bytes.slice());
    const annotations = await eng.annotations(handle, 0);
    await eng.close(handle);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.subtype).toBe('Line');
  });

  it('an /AP that is already there is left alone unless the plan says to replace it', async () => {
    const base = await documentWithBareLine(RECT);
    const once = await new FullRewriteWriter().write({ bytes: base, plan: planForLine(false) });
    expect(once.appearances).toBe(1);

    // Second pass over the file we just wrote: it has an /AP now, so nothing is generated.
    const again = await new FullRewriteWriter().write({
      bytes: once.bytes.slice(),
      plan: planForLine(false),
    });
    expect(again.appearances).toBe(0);

    // Unless the plan says the annotation changed, in which case the stale one is replaced.
    const replaced = await new FullRewriteWriter().write({
      bytes: once.bytes.slice(),
      plan: planForLine(true),
    });
    expect(replaced.appearances).toBe(1);
  });

  it('an annotation that has moved is left alone rather than written to the wrong one', async () => {
    const base = await documentWithBareLine(RECT);
    // The plan names a rectangle that is not the one in the file: a mismatch, so nothing is done.
    const result = await new FullRewriteWriter().write({
      bytes: base,
      plan: planForLine(true, { x0: 0, y0: 0, x1: 10, y1: 10 }),
    });
    expect(result.appearances).toBe(0);
    expect(result.warnings.join(' ')).toMatch(/left as (it|they) (was|were)/);
  });
});
