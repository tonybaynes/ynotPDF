/**
 * M30's appearance work: the note icons, the free-text style strings, the quad-aware markup, the
 * caret, and the mapping from model keys to PDF dictionary entries.
 *
 * Everything here is pure, so it runs in Node with no PDF and no engine. What the *file* ends up
 * saying is proved by `roundtrip.test.ts` beside this, and what a reader sees by
 * `test/e2e/annotations.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_DICT_MAPPINGS,
  DEFAULT_FREE_TEXT_STYLE,
  DEFAULT_NOTE_ICON,
  NOTE_ICONS,
  appearanceFontFor,
  appearanceInput,
  buildDefaultAppearance,
  buildDefaultStyle,
  calloutNumbers,
  calloutOf,
  caretRectAt,
  createAppearanceService,
  defaultAppearanceService,
  dictEntries,
  dictMapping,
  engineWritableKeys,
  familyFor,
  intentOf,
  isNonEmbeddedFont,
  layoutFreeText,
  measureFreeText,
  metricFont,
  noteIcon,
  noteRectAt,
  paddingOf,
  parseDefaultAppearance,
  parseDefaultStyle,
  logicalBox,
  quadFromRect,
  quadNumbers,
  rotateOf,
  rotatePoint,
  styleOf,
  styledStandardFont,
  textBoxOf,
  type FreeTextStyle,
} from '@engine/appearance';
import type { PdfRect } from '@shared/pdf';

const service = defaultAppearanceService;
const RECT: PdfRect = { x0: 100, y0: 500, x1: 300, y1: 560 };

describe('note icons', () => {
  it('every icon in the catalogue draws something', () => {
    for (const item of NOTE_ICONS) {
      const stream = service.generate(
        appearanceInput({
          subtype: 'Text',
          rect: noteRectAt({ x: 10, y: 40 }),
          color: 0x112233,
          extra: { icon: item.name },
        }),
      );
      expect(stream, item.name).not.toBeNull();
      expect(stream?.content, item.name).toMatch(/[Sf]$/m);
    }
  });

  it('needs no font resource, which is what lets it go straight into PDFium', () => {
    const stream = service.generate(
      appearanceInput({ subtype: 'Text', rect: noteRectAt({ x: 0, y: 20 }) }),
    );
    expect(Object.keys(stream?.resources.fonts ?? {})).toEqual([]);
    expect(Object.keys(stream?.resources.extGState ?? {})).toEqual([]);
  });

  it('two different icons draw different content', () => {
    const of = (icon: string): string =>
      service.generate(
        appearanceInput({ subtype: 'Text', rect: noteRectAt({ x: 0, y: 20 }), extra: { icon } }),
      )?.content ?? '';
    expect(of('Key')).not.toEqual(of('Star'));
    expect(of('Comment').length).toBeGreaterThan(20);
  });

  it('an unknown icon name falls back to Comment rather than drawing nothing', () => {
    expect(noteIcon('NoSuchIcon').name).toBe(DEFAULT_NOTE_ICON);
    expect(noteIcon(null).name).toBe(DEFAULT_NOTE_ICON);
    expect(noteIcon('key').name).toBe('Key');
  });

  it('a note is 20 points square, anchored at the point that was clicked', () => {
    expect(noteRectAt({ x: 50, y: 700 })).toEqual({ x0: 50, y0: 680, x1: 70, y1: 700 });
  });

  it('a zero-sized note draws nothing rather than an empty stream', () => {
    expect(
      service.generate(appearanceInput({ subtype: 'Text', rect: { x0: 5, y0: 5, x1: 5, y1: 5 } })),
    ).toBeNull();
  });
});

describe('the free-text style strings', () => {
  const style: FreeTextStyle = {
    family: 'Times New Roman',
    size: 14,
    bold: true,
    italic: false,
    color: 0x0b5cd6,
    align: 1,
    lineSpacing: 1.5,
  };

  it('a `/DA` round-trips through its own parser', () => {
    const da = buildDefaultAppearance(style);
    expect(da).toContain('/TiBo 14 Tf');
    const back = parseDefaultAppearance(da);
    expect(back.family).toBe('Times New Roman');
    expect(back.bold).toBe(true);
    expect(back.size).toBe(14);
    expect(back.color).toBe(0x0b5cd6);
  });

  it('a `/DS` round-trips through its own parser, including what `/DA` cannot say', () => {
    const back = parseDefaultStyle(buildDefaultStyle(style));
    expect(back).toEqual(style);
  });

  it('reads a `/DA` written by another editor, keeping the defaults it does not mention', () => {
    const back = parseDefaultAppearance('0 g /Helv 9 Tf');
    expect(back.size).toBe(9);
    expect(back.color).toBe(0x000000);
    expect(back.align).toBe(DEFAULT_FREE_TEXT_STYLE.align);
  });

  it('understands the three colour operators a `/DA` may use', () => {
    expect(parseDefaultAppearance('1 0 0 rg /Helv 12 Tf').color).toBe(0xff0000);
    expect(parseDefaultAppearance('0.5 g /Helv 12 Tf').color).toBe(0x808080);
    // CMYK: pure cyan.
    expect(parseDefaultAppearance('1 0 0 0 k /Helv 12 Tf').color).toBe(0x00ffff);
  });

  it('`/DS` wins over `/DA` where the two disagree, because it says more', () => {
    const merged = styleOf({
      defaultAppearance: buildDefaultAppearance({ ...style, size: 8 }),
      defaultStyle: buildDefaultStyle({ ...style, size: 30 }),
    });
    expect(merged.size).toBe(30);
  });

  it('still honours the loose keys M21’s generator read before `/DA` existed', () => {
    const merged = styleOf({ font: 'Courier-Bold', fontSize: 7, textColor: 0x00ff00 });
    expect(merged.family).toBe('Courier New');
    expect(merged.bold).toBe(true);
    expect(merged.size).toBe(7);
    expect(merged.color).toBe(0x00ff00);
  });

  it('a base family embeds nothing; a system family is named but not embedded', () => {
    const base = appearanceFontFor({ ...DEFAULT_FREE_TEXT_STYLE, family: 'Helvetica' });
    expect(isNonEmbeddedFont(base)).toBe(false);
    const system = appearanceFontFor({ ...DEFAULT_FREE_TEXT_STYLE, family: 'Verdana', bold: true });
    expect(isNonEmbeddedFont(system)).toBe(true);
    expect(system).toEqual({ baseFont: 'Verdana,Bold', fallback: 'Helvetica-Bold' });
    // It is still laid out with metrics we have, which is the whole compromise.
    expect(metricFont(system)).toBe('Helvetica-Bold');
  });

  it('maps a system family on to the nearest standard metrics by its name', () => {
    expect(familyFor('Consolas').metrics).toBe('Courier');
    expect(familyFor('Georgia').metrics).toBe('Times-Roman');
    expect(familyFor('Segoe UI').metrics).toBe('Helvetica');
  });

  it('picks the bold and italic faces of a standard family', () => {
    expect(styledStandardFont('Times-Roman', true, true)).toBe('Times-BoldItalic');
    expect(styledStandardFont('Helvetica', false, true)).toBe('Helvetica-Oblique');
    expect(styledStandardFont('Courier', true, false)).toBe('Courier-Bold');
    // Symbol and ZapfDingbats have no variants at all.
    expect(styledStandardFont('Symbol', true, true)).toBe('Symbol');
  });
});

describe('free-text layout', () => {
  const box: PdfRect = { x0: 0, y0: 0, x1: 200, y1: 100 };

  it('aligns each line on its own, which is what `/Q` means', () => {
    const text = 'short\nand a much longer line here';
    const left = layoutFreeText(text, box, { ...DEFAULT_FREE_TEXT_STYLE, align: 0 });
    const centre = layoutFreeText(text, box, { ...DEFAULT_FREE_TEXT_STYLE, align: 1 });
    const right = layoutFreeText(text, box, { ...DEFAULT_FREE_TEXT_STYLE, align: 2 });
    expect(left[0]?.x).toBeLessThan(centre[0]?.x ?? 0);
    expect(centre[0]?.x).toBeLessThan(right[0]?.x ?? 0);
    // Right-aligned, every line ends on the same edge — which is the property alignment is for.
    const rightEdges = right.map((l) => l.x + l.width);
    for (const edge of rightEdges) expect(edge).toBeCloseTo(rightEdges[0] ?? 0, 4);
    // Left-aligned, every line starts on the same edge instead.
    for (const line of left) expect(line.x).toBeCloseTo(left[0]?.x ?? 0, 4);
  });

  it('line spacing changes the gap between baselines and nothing else', () => {
    const tight = layoutFreeText('a\nb', box, { ...DEFAULT_FREE_TEXT_STYLE, lineSpacing: 1 });
    const loose = layoutFreeText('a\nb', box, { ...DEFAULT_FREE_TEXT_STYLE, lineSpacing: 2 });
    expect((tight[0]?.y ?? 0) - (tight[1]?.y ?? 0)).toBeCloseTo(12, 4);
    expect((loose[0]?.y ?? 0) - (loose[1]?.y ?? 0)).toBeCloseTo(24, 4);
    expect(tight[0]?.y).toBeCloseTo(loose[0]?.y ?? 0, 4);
  });

  it('measures the box a piece of text needs', () => {
    const one = measureFreeText('one line', DEFAULT_FREE_TEXT_STYLE, 400);
    const many = measureFreeText(
      'a much longer piece of text that has to wrap several times over',
      DEFAULT_FREE_TEXT_STYLE,
      120,
    );
    expect(many.height).toBeGreaterThan(one.height * 2);
    expect(one.width).toBeGreaterThan(0);
  });
});

describe('the free-text appearance', () => {
  it('a typewriter draws its words and no box, whatever colours the file gives it', () => {
    const stream = service.generate(
      appearanceInput({
        subtype: 'FreeText',
        rect: RECT,
        contents: 'Hello',
        color: 0xff0000,
        interiorColor: 0x00ff00,
        borderWidth: 3,
        extra: { intent: 'FreeTextTypewriter' },
      }),
    );
    expect(stream?.content).toContain('Tj');
    // The only rectangle is the clip that keeps overflowing text inside the box; nothing is
    // stroked or filled, so a typewriter is words on the page and nothing else.
    expect(stream?.content.split('\n')).toContain('W');
    expect(stream?.content).not.toMatch(/^[BSf]$/m);
    expect(stream?.content).not.toContain('RG');
  });

  it('a text box draws its border and its fill', () => {
    const stream = service.generate(
      appearanceInput({
        subtype: 'FreeText',
        rect: RECT,
        contents: 'Hello',
        color: 0x000000,
        interiorColor: 0xffffff,
        borderWidth: 2,
      }),
    );
    expect(stream?.content).toContain(' re');
    expect(stream?.content).toContain('B');
  });

  it('a callout draws its leader line and an arrow head, and grows its BBox to reach them', () => {
    const stream = service.generate(
      appearanceInput({
        subtype: 'FreeText',
        rect: RECT,
        contents: 'Look here',
        color: 0x0b5cd6,
        borderWidth: 1,
        extra: {
          intent: 'FreeTextCallout',
          callout: [20, 400, 60, 430, 100, 430],
          lineEnding: 'OpenArrow',
        },
      }),
    );
    expect(stream?.content).toContain('20 400 m');
    expect(stream?.bbox.x0).toBeLessThan(20);
    expect(stream?.bbox.y0).toBeLessThan(400);
    // Two extra strokes for the arrow head, on top of the leader line and the box.
    expect((stream?.content.match(/\bS\b/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('a callout with `/LE /None` draws the line without a head', () => {
    const withHead = service.generate(
      appearanceInput({
        subtype: 'FreeText',
        rect: RECT,
        color: 0x000000,
        contents: 'x',
        extra: { intent: 'FreeTextCallout', callout: [20, 400, 60, 430, 100, 430] },
      }),
    );
    const without = service.generate(
      appearanceInput({
        subtype: 'FreeText',
        rect: RECT,
        color: 0x000000,
        contents: 'x',
        extra: {
          intent: 'FreeTextCallout',
          callout: [20, 400, 60, 430, 100, 430],
          lineEnding: 'None',
        },
      }),
    );
    expect((withHead?.content.match(/\bS\b/g) ?? []).length).toBeGreaterThan(
      (without?.content.match(/\bS\b/g) ?? []).length,
    );
  });

  it('`/RD` insets the text box inside `/Rect`, as the spec has it', () => {
    const inset = textBoxOf(RECT, { padding: [10, 5, 10, 5] });
    expect(inset).toEqual({ x0: 110, y0: 505, x1: 290, y1: 555 });
    // Padding that would invert the box is ignored rather than obeyed.
    expect(textBoxOf(RECT, { padding: [500, 500, 500, 500] })).toEqual(RECT);
    expect(paddingOf({})).toEqual([0, 0, 0, 0]);
  });

  it('a system family reaches the resources as a non-embedded font', () => {
    const style = { ...DEFAULT_FREE_TEXT_STYLE, family: 'Verdana' };
    const stream = service.generate(
      appearanceInput({
        subtype: 'FreeText',
        rect: RECT,
        contents: 'Hello',
        extra: { defaultAppearance: buildDefaultAppearance(style) },
      }),
    );
    const fonts = Object.values(stream?.resources.fonts ?? {});
    expect(fonts.length).toBe(1);
    expect(isNonEmbeddedFont(fonts[0] ?? 'Helvetica')).toBe(true);
  });

  it('reads the intent and the leader line back out of a model bag', () => {
    expect(intentOf({ intent: 'FreeTextCallout' })).toBe('FreeTextCallout');
    expect(intentOf({ intent: 'Nonsense' })).toBe('FreeText');
    expect(calloutOf({ callout: [1, 2, 3, 4, 5, 6] })).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 5, y: 6 },
    ]);
    expect(calloutNumbers([{ x: 1, y: 2 }])).toEqual([1, 2]);
    // Fewer than two points is not a leader line.
    expect(calloutOf({ callout: [1, 2] })).toEqual([]);
  });
});

describe('rotated free text', () => {
  const box: PdfRect = { x0: 0, y0: 0, x1: 200, y1: 100 };

  it('reads `/Rotate` as one of the four right angles, and nothing else', () => {
    expect(rotateOf({ rotate: 90 })).toBe(90);
    expect(rotateOf({ rotate: 450 })).toBe(90);
    expect(rotateOf({ rotate: -90 })).toBe(270);
    expect(rotateOf({ rotate: 47 })).toBe(90);
    expect(rotateOf({})).toBe(0);
    expect(rotateOf({ rotate: 'sideways' })).toBe(0);
  });

  it('at 90° the words wrap to the box’s height, not its width', () => {
    expect(logicalBox(box, 0)).toEqual(box);
    // Same centre, sides swapped.
    expect(logicalBox(box, 90)).toEqual({ x0: 50, y0: -50, x1: 150, y1: 150 });
    expect(logicalBox(box, 180)).toEqual(box);
  });

  it('turns a point about a centre, anticlockwise', () => {
    const turned = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90);
    expect(turned.x).toBeCloseTo(0, 6);
    expect(turned.y).toBeCloseTo(10, 6);
  });

  it('a turned box lays its lines out along the other axis', () => {
    const text = 'one two three four five six seven eight nine ten';
    const flat = layoutFreeText(text, box, DEFAULT_FREE_TEXT_STYLE, 2, 0);
    const turned = layoutFreeText(text, box, DEFAULT_FREE_TEXT_STYLE, 2, 90);
    // The box is twice as wide as it is tall, so turning it makes the lines shorter and more.
    expect(turned.length).toBeGreaterThan(flat.length);
    // And the successive baselines now step across the page rather than down it.
    expect(Math.abs((turned[0]?.y ?? 0) - (turned[1]?.y ?? 0))).toBeLessThan(0.001);
    expect(Math.abs((turned[0]?.x ?? 0) - (turned[1]?.x ?? 0))).toBeGreaterThan(1);
  });

  it('the appearance stream carries the rotation as a text matrix', () => {
    const stream = service.generate(
      appearanceInput({
        subtype: 'FreeText',
        rect: RECT,
        contents: 'sideways',
        color: 0x000000,
        borderWidth: 1,
        extra: { rotate: 90 },
      }),
    );
    // cos 90 = 0, sin 90 = 1: the `cm` reads `0 1 -1 0 …`.
    expect(stream?.content).toMatch(/0 1 -1 0 [-\d.]+ [-\d.]+ cm/);
  });

  it('no rotation means no matrix at all', () => {
    const stream = service.generate(
      appearanceInput({ subtype: 'FreeText', rect: RECT, contents: 'flat', color: 0x000000 }),
    );
    expect(stream?.content).not.toContain(' cm');
  });
});

describe('quad-aware text markup', () => {
  /** A quad rotated 90°: the words run up the page. */
  const rotated = quadNumbers({
    ul: { x: 90, y: 500 },
    ur: { x: 90, y: 560 },
    ll: { x: 100, y: 500 },
    lr: { x: 100, y: 560 },
  });

  it('a highlight fills the quad itself, not the box that contains it', () => {
    const stream = service.generate(
      appearanceInput({
        subtype: 'Highlight',
        rect: { x0: 90, y0: 500, x1: 100, y1: 560 },
        color: 0xffe14d,
        quadPoints: rotated,
      }),
    );
    // Four corners of the parallelogram, closed — not a `re` rectangle.
    expect(stream?.content).toContain('90 500 m');
    expect(stream?.content).toContain('h');
    expect(stream?.content).not.toContain(' re');
  });

  it('an underline over rotated text runs along the line, not across the page', () => {
    const stream = service.generate(
      appearanceInput({
        subtype: 'Underline',
        rect: { x0: 90, y0: 500, x1: 100, y1: 560 },
        color: 0x0b5cd6,
        quadPoints: rotated,
      }),
    );
    // From the foot of the quad to its far end: the two points share an x, not a y.
    const points = [...(stream?.content.matchAll(/([\d.]+) ([\d.]+) [ml]/g) ?? [])].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
    expect(points.length).toBe(2);
    expect(points[0]?.x).toBeCloseTo(points[1]?.x ?? 0, 3);
    expect(Math.abs((points[0]?.y ?? 0) - (points[1]?.y ?? 0))).toBeCloseTo(60, 3);
  });

  it('markup with no quads still marks its whole rect', () => {
    for (const subtype of ['Highlight', 'Underline', 'StrikeOut', 'Squiggly'] as const) {
      const stream = service.generate(appearanceInput({ subtype, rect: RECT, color: 0x00ff00 }));
      expect(stream, subtype).not.toBeNull();
    }
    expect(quadFromRect({ x0: 0, y0: 0, x1: 10, y1: 5 })).toEqual({
      ul: { x: 0, y: 5 },
      ur: { x: 10, y: 5 },
      ll: { x: 0, y: 0 },
      lr: { x: 10, y: 0 },
    });
  });

  it('a highlight stays opaque unless the *file* said otherwise', () => {
    const ours = service.generate(
      appearanceInput({ subtype: 'Highlight', rect: RECT, color: 0xffe14d }),
    );
    const state = Object.values(ours?.resources.extGState ?? {})[0];
    expect(state?.blendMode).toBe('Multiply');
    expect(state?.fillAlpha).toBeUndefined();

    const theirs = service.generate(
      appearanceInput({ subtype: 'Highlight', rect: RECT, color: 0xffe14d, opacity: 0.4 }),
    );
    expect(Object.values(theirs?.resources.extGState ?? {})[0]?.fillAlpha).toBe(0.4);
  });

  it('a caret is drawn inside its `/RD` padding', () => {
    const rect = caretRectAt({ x: 100, y: 500 }, 12);
    expect(rect.y0).toBe(500);
    expect(rect.x1 - rect.x0).toBeGreaterThan(0);
    const stream = service.generate(
      appearanceInput({
        subtype: 'Caret',
        rect,
        color: 0x000000,
        extra: { padding: [1, 1, 1, 1] },
      }),
    );
    expect(stream?.content).toContain('f');
    expect(
      service.generate(appearanceInput({ subtype: 'Caret', rect: { x0: 0, y0: 0, x1: 0, y1: 0 } })),
    ).toBeNull();
  });
});

describe('the dictionary mapping', () => {
  it('names every key M30, M31, M32, M33 and M53 write, and only those', () => {
    const keys = ANNOTATION_DICT_MAPPINGS.map((m) => m.key).sort();
    expect(keys).toEqual([
      'align',
      'attachmentName',
      'callout',
      'caption',
      'captionOffset',
      'captionPosition',
      'cloudy',
      'dashArray',
      'defaultAppearance',
      'defaultStyle',
      'icon',
      'inReplyTo',
      'intent',
      'leaderExtend',
      'leaderLength',
      'leaderOffset',
      'lineEnding',
      'lineEndings',
      'linkAction',
      'linkBorderArray',
      'linkHighlight',
      'measure',
      'padding',
      'replyType',
      'richContents',
      'rotate',
      'stateModel',
    ]);
  });

  it('only strings and names are writable through PDFium', () => {
    for (const [modelKey] of engineWritableKeys()) {
      const mapping = dictMapping(modelKey);
      expect(mapping?.kind === 'string' || mapping?.kind === 'name', modelKey).toBe(true);
    }
    // The numbers and arrays go through the write plan instead.
    expect(dictMapping('callout')?.engineWritable).toBe(false);
    expect(dictMapping('align')?.engineWritable).toBe(false);
  });

  it('turns a model bag into typed dictionary entries', () => {
    const entries = dictEntries({
      icon: 'Key',
      align: 1,
      callout: [1, 2, 3, 4],
      defaultAppearance: '0 g /Helv 12 Tf',
      unknownKey: 'ignored',
    });
    expect(entries['Name']).toEqual({ kind: 'name', value: 'Key' });
    expect(entries['Q']).toEqual({ kind: 'number', value: 1 });
    expect(entries['CL']).toEqual({ kind: 'numbers', value: [1, 2, 3, 4] });
    expect(entries['DA']).toEqual({ kind: 'string', value: '0 g /Helv 12 Tf' });
    expect(Object.keys(entries)).not.toContain('unknownKey');
  });

  it('a value that has gone away is a removal, not an omission', () => {
    const entries = dictEntries({ icon: null, defaultStyle: '' });
    expect(entries['Name']).toBeNull();
    expect(entries['DS']).toBeNull();
  });

  it('an array with anything but numbers in it is dropped rather than half-written', () => {
    const entries = dictEntries({ callout: [1, 'two', 3] });
    expect(entries['CL']).toBeUndefined();
  });

  it('`skipEngineWritable` leaves the plan only what the engine could not do', () => {
    const entries = dictEntries({ icon: 'Key', align: 2 }, { skipEngineWritable: true });
    expect(Object.keys(entries)).toEqual(['Q']);
  });
});

describe('the service registry', () => {
  it('a module can replace a generator and put the old one back', () => {
    const own = createAppearanceService();
    const restore = own.register('Text', () => null);
    expect(own.generate(appearanceInput({ subtype: 'Text', rect: RECT }))).toBeNull();
    restore();
    expect(own.generate(appearanceInput({ subtype: 'Text', rect: RECT }))).not.toBeNull();
  });

  it('covers every subtype M30 creates', () => {
    for (const subtype of [
      'Highlight',
      'Underline',
      'Squiggly',
      'StrikeOut',
      'Text',
      'FreeText',
      'Caret',
    ] as const) {
      expect(service.has(subtype), subtype).toBe(true);
    }
  });
});
