/**
 * Stamps (M31): the catalogue reads, every stamp draws, the tokens resolve, and the matrix that
 * fits a picture into a rect at an angle is right — which is what a placement's appearance is.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appearanceInput,
  applyMatrix,
  defaultAppearanceService,
  drawingBounds,
  isDynamicStamp,
  matrixScale,
  parseStampCatalogue,
  resolveStampTokens,
  roundedRectOps,
  STAMP_KEY,
  STAMP_SIZE,
  stampDrawing,
  stampForm,
  stampKey,
  stampMatrix,
  stampRectAt,
  stampRotationOf,
  stampSizeOf,
  transformOps,
} from '@engine/appearance';
import { must } from '../find/helpers';

const catalogue = parseStampCatalogue(
  JSON.parse(readFileSync(join(process.cwd(), 'resources', 'stamps', 'catalogue.json'), 'utf8')),
);

describe('the catalogue', () => {
  it('reads every stamp, with unique ids and known categories', () => {
    expect(catalogue.stamps.length).toBeGreaterThanOrEqual(20);
    const ids = new Set(catalogue.stamps.map((s) => s.id));
    expect(ids.size).toBe(catalogue.stamps.length);
    const categories = new Set(catalogue.categories.map((c) => c.id));
    for (const stamp of catalogue.stamps)
      expect(categories.has(stamp.category), stamp.id).toBe(true);
    // The set the brief lists is there.
    for (const id of [
      'Approved',
      'Confidential',
      'Draft',
      'Final',
      'ForComment',
      'SignHere',
      'Void',
      'Completed',
      'Reviewed',
      'Received',
      'Revised',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('every stamp in the catalogue has its vector PDF beside it', () => {
    for (const stamp of catalogue.stamps) {
      const bytes = readFileSync(join(process.cwd(), 'resources', 'stamps', `${stamp.id}.pdf`));
      expect(bytes.subarray(0, 5).toString('latin1'), stamp.id).toBe('%PDF-');
    }
  });

  it('drops malformed entries rather than throwing', () => {
    const parsed = parseStampCatalogue({
      categories: [{ id: 'x', label: 'X' }, { id: 3 }, null],
      stamps: [
        { id: 'A', label: 'A', lines: ['A'], color: 'zz' },
        { id: 'B' },
        'nope',
        { id: 'C', label: 'C', lines: [] },
      ],
    });
    expect(parsed.categories.length).toBe(1);
    expect(parsed.stamps.length).toBe(1);
    expect(parsed.stamps[0]?.color).toBe(0);
    expect(parsed.stamps[0]?.category).toBe('business');
    expect(parseStampCatalogue(null).stamps).toEqual([]);
  });

  it('knows which stamps are dynamic', () => {
    const dynamic = catalogue.stamps.filter(isDynamicStamp);
    expect(dynamic.length).toBeGreaterThan(0);
    expect(dynamic.every((s) => s.category === 'dynamic')).toBe(true);
    expect(catalogue.stamps.filter((s) => s.category === 'dynamic').every(isDynamicStamp)).toBe(
      true,
    );
  });
});

describe('dynamic tokens', () => {
  const now = new Date('2026-09-09T14:05:00Z');

  it('resolves name, initials, date and time in en-GB', () => {
    const line = resolveStampTokens('By {name} ({initials}) on {date} at {time}', {
      name: 'Tony Baynes',
      initials: 'TB',
      now,
    });
    expect(line).toContain('Tony Baynes');
    expect(line).toContain('(TB)');
    expect(line).toContain('2026');
    expect(line).toMatch(/\d{1,2}:\d{2}/);
  });

  it('says so when there is no name', () => {
    expect(resolveStampTokens('{name} {initials}', { name: '', initials: '', now })).toBe(
      'Unnamed —',
    );
  });
});

describe('the drawing', () => {
  it('sizes the box to its longest line and grows for a second line', () => {
    const one = stampDrawing(['DRAFT'], 0x0b5cd6);
    const long = stampDrawing(['NOT FOR PUBLIC RELEASE'], 0x0b5cd6);
    const two = stampDrawing(['APPROVED', 'by someone on a day'], 0x0b5cd6);
    expect(long.width).toBeGreaterThan(one.width);
    expect(two.height).toBeGreaterThan(one.height);
    expect(one.texts[0]?.text).toBe('DRAFT');
    expect(two.texts[1]?.size).toBeLessThan(must(two.texts[0], 'big').size);
    // Centred: the text starts inside the box and ends inside it.
    const t = must(one.texts[0], 'text');
    expect(t.x).toBeGreaterThan(0);
    expect(t.x).toBeLessThan(one.width / 2);
    expect(drawingBounds(one).x1).toBeLessThanOrEqual(one.width);
  });

  it('the form is a rounded border and bold text in its own box, with one font', () => {
    const drawing = stampDrawing(['APPROVED'], 0x1f6e43);
    const form = stampForm(drawing);
    expect(form.bbox).toEqual({ x0: 0, y0: 0, x1: drawing.width, y1: drawing.height });
    expect(form.content).toContain('BT');
    expect(form.content).toContain('(APPROVED) Tj');
    expect(form.content).toMatch(/ c$/m);
    expect(Object.values(form.resources.fonts)).toEqual(['Helvetica-Bold']);
  });

  it('a rounded rect with no room for a radius is a plain one', () => {
    expect(roundedRectOps({ x0: 0, y0: 0, x1: 10, y1: 10 }, 0).length).toBe(5);
    expect(
      roundedRectOps({ x0: 0, y0: 0, x1: 10, y1: 10 }, 3).filter((o) => o.op === 'C').length,
    ).toBe(4);
  });

  it('keys the same text and colour to the same picture, and different ones apart', () => {
    expect(stampKey('Approved', ['APPROVED'], 1)).toBe(stampKey('Approved', ['APPROVED'], 1));
    expect(stampKey('Approved', ['APPROVED'], 1)).not.toBe(stampKey('Approved', ['APPROVED'], 2));
    expect(stampKey('Approved', ['APPROVED', 'by A'], 1)).not.toBe(
      stampKey('Approved', ['APPROVED', 'by B'], 1),
    );
    expect(stampKey('Approved', ['APPROVED'], 1)).toMatch(/^stamp:Approved:[0-9a-f]+$/);
  });
});

describe('placing', () => {
  const size = { width: 200, height: 50 };

  it('fits the picture into the rect, keeping its aspect, unturned', () => {
    const m = stampMatrix({ x0: 100, y0: 100, x1: 300, y1: 300 }, size, 0);
    expect(matrixScale(m)).toBeCloseTo(1, 6);
    // Centred: the picture's centre lands on the rect's centre.
    const centre = applyMatrix(m, { x: 100, y: 25 });
    expect(centre.x).toBeCloseTo(200, 6);
    expect(centre.y).toBeCloseTo(200, 6);
  });

  it('turned a quarter, the picture’s width fits the rect’s height', () => {
    const m = stampMatrix({ x0: 0, y0: 0, x1: 100, y1: 400 }, size, 90);
    expect(matrixScale(m)).toBeCloseTo(2, 6);
    const corner = applyMatrix(m, { x: 200, y: 0 });
    // The picture's far right end has gone up, not right.
    expect(corner.y).toBeGreaterThan(300);
    const ops = transformOps(
      [{ op: 'M', x: 0, y: 0 }, { op: 'C', x1: 1, y1: 1, x2: 2, y2: 2, x: 3, y: 3 }, { op: 'Z' }],
      m,
    );
    expect(ops[2]).toEqual({ op: 'Z' });
    expect(ops[1]?.op).toBe('C');
  });

  it('the rect for a centre, a scale and a turn is the turned box', () => {
    const flat = stampRectAt({ x: 0, y: 0 }, size, 1, 0);
    expect(flat).toEqual({ x0: -100, y0: -25, x1: 100, y1: 25 });
    const turned = stampRectAt({ x: 0, y: 0 }, size, 1, 90);
    expect(turned.x1).toBeCloseTo(25, 6);
    expect(turned.y1).toBeCloseTo(100, 6);
    // The matrix that fits the same picture into that rect gives the scale back.
    expect(matrixScale(stampMatrix(turned, size, 90))).toBeCloseTo(1, 6);
  });

  it('reads the size and the turn from the extras, strictly', () => {
    expect(stampSizeOf({ [STAMP_SIZE]: [10, 20] })).toEqual({ width: 10, height: 20 });
    expect(stampSizeOf({ [STAMP_SIZE]: [10] })).toBeNull();
    expect(stampSizeOf({ [STAMP_SIZE]: [0, 20] })).toBeNull();
    expect(stampSizeOf({})).toBeNull();
    expect(stampRotationOf({ rotate: 45 })).toBe(45);
    expect(stampRotationOf({})).toBe(0);
  });

  it('the appearance draws the shared XObject, or nothing without a key', () => {
    const rect = { x0: 10, y0: 10, x1: 210, y1: 60 };
    const stream = defaultAppearanceService.generate(
      appearanceInput({
        subtype: 'Stamp',
        rect,
        extra: { [STAMP_KEY]: 'stamp:Approved:1', [STAMP_SIZE]: [200, 50], rotate: 0 },
      }),
    );
    expect(stream?.content).toContain('/Fm1 Do');
    expect(stream?.resources.xobjects).toEqual({ Fm1: 'stamp:Approved:1' });
    expect(stream?.bbox).toEqual(rect);
    expect(
      defaultAppearanceService.generate(
        appearanceInput({ subtype: 'Stamp', rect, extra: { [STAMP_SIZE]: [200, 50] } }),
      ),
    ).toBeNull();
    expect(
      defaultAppearanceService.generate(
        appearanceInput({
          subtype: 'Stamp',
          rect: { x0: 0, y0: 0, x1: 0, y1: 0 },
          extra: { [STAMP_KEY]: 'k', [STAMP_SIZE]: [1, 1] },
        }),
      ),
    ).toBeNull();
    const faint = defaultAppearanceService.generate(
      appearanceInput({
        subtype: 'Stamp',
        rect,
        opacity: 0.5,
        extra: { [STAMP_KEY]: 'k', [STAMP_SIZE]: [200, 50] },
      }),
    );
    expect(faint?.content).toContain('gs');
  });
});
