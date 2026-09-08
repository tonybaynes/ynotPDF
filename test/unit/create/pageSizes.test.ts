/**
 * Page-size presets and geometry (M91): the data file, points, orientation and margins.
 */

import { describe, expect, it } from 'vitest';
import {
  choiceToPortraitPoints,
  DEFAULT_PAGE_SIZE_ID,
  findPreset,
  marginsToPoints,
  orient,
  PAGE_SIZE_PRESETS,
  resolvePageSize,
  sizeInInches,
} from '@shared/pageSizes';
import { mmToPt } from '@shared/pdf';

const A4 = { width: mmToPt(210), height: mmToPt(297) };

describe('page-size presets', () => {
  it('come from the data file and include A4 and Letter', () => {
    expect(PAGE_SIZE_PRESETS.length).toBeGreaterThan(5);
    expect(findPreset('A4')).toMatchObject({ id: 'A4', widthMm: 210, heightMm: 297 });
    expect(findPreset('Letter')).toMatchObject({ id: 'Letter', widthMm: 215.9, heightMm: 279.4 });
    expect(findPreset(DEFAULT_PAGE_SIZE_ID)).toBeDefined();
    for (const p of PAGE_SIZE_PRESETS) {
      expect(p.id).not.toBe('');
      expect(p.label).not.toBe('');
      expect(p.group).not.toBe('');
      expect(p.widthMm).toBeGreaterThan(0);
      expect(p.heightMm).toBeGreaterThan(0);
    }
  });

  it('report an unknown id as undefined', () => {
    expect(findPreset('Nope')).toBeUndefined();
    expect(findPreset('')).toBeUndefined();
  });
});

describe('choiceToPortraitPoints', () => {
  it('turns A4 into 595.28 × 841.89 points', () => {
    const size = choiceToPortraitPoints({ kind: 'preset', id: 'A4' });
    expect(size.width).toBeCloseTo(595.28, 1);
    expect(size.height).toBeCloseTo(841.89, 1);
  });

  it('falls back to A4 for an unknown preset', () => {
    expect(choiceToPortraitPoints({ kind: 'preset', id: 'Nope' })).toEqual(A4);
  });

  it('normalises a custom size to portrait and never below a millimetre', () => {
    const size = choiceToPortraitPoints({ kind: 'custom', widthMm: 100, heightMm: 50 });
    expect(size.width).toBeCloseTo(mmToPt(50), 5);
    expect(size.height).toBeCloseTo(mmToPt(100), 5);
    const tiny = choiceToPortraitPoints({ kind: 'custom', widthMm: 0, heightMm: -5 });
    expect(tiny.width).toBeCloseTo(mmToPt(1), 5);
    expect(tiny.height).toBeCloseTo(mmToPt(1), 5);
  });
});

describe('orient', () => {
  it('keeps portrait and swaps for landscape', () => {
    expect(orient(A4, 'portrait')).toEqual(A4);
    expect(orient(A4, 'landscape')).toEqual({ width: A4.height, height: A4.width });
    // A landscape input is normalised first, so "portrait" is always upright.
    expect(orient({ width: A4.height, height: A4.width }, 'portrait')).toEqual(A4);
  });

  it('follows the content aspect in auto', () => {
    expect(orient(A4, 'auto', 1.5)).toEqual({ width: A4.height, height: A4.width });
    expect(orient(A4, 'auto', 1)).toEqual(A4);
    expect(orient(A4, 'auto', 0.5)).toEqual(A4);
    expect(orient(A4, 'auto')).toEqual(A4);
  });
});

describe('marginsToPoints', () => {
  it('converts millimetres to points', () => {
    const m = marginsToPoints({ top: 10, right: 20, bottom: 30, left: 40 }, A4);
    expect(m.top).toBeCloseTo(mmToPt(10), 5);
    expect(m.right).toBeCloseTo(mmToPt(20), 5);
    expect(m.bottom).toBeCloseTo(mmToPt(30), 5);
    expect(m.left).toBeCloseTo(mmToPt(40), 5);
  });

  it('clamps huge margins to under half the page and negatives to zero', () => {
    const m = marginsToPoints({ top: 1000, right: 1000, bottom: -5, left: -1 }, A4);
    expect(m.top).toBeLessThan(A4.height / 2);
    expect(m.right).toBeLessThan(A4.width / 2);
    expect(m.top).toBeCloseTo(A4.height / 2 - 1, 5);
    expect(m.right).toBeCloseTo(A4.width / 2 - 1, 5);
    expect(m.bottom).toBe(0);
    expect(m.left).toBe(0);
  });
});

describe('resolvePageSize', () => {
  it('combines the choice and the orientation', () => {
    expect(resolvePageSize({ kind: 'preset', id: 'A4' }, 'portrait')).toEqual(A4);
    expect(resolvePageSize({ kind: 'preset', id: 'A4' }, 'landscape')).toEqual({
      width: A4.height,
      height: A4.width,
    });
    const letter = resolvePageSize({ kind: 'preset', id: 'Letter' }, 'auto', 2);
    expect(letter.width).toBeCloseTo(792, 1);
    expect(letter.height).toBeCloseTo(612, 1);
    const custom = resolvePageSize({ kind: 'custom', widthMm: 100, heightMm: 50 }, 'landscape');
    expect(custom.width).toBeCloseTo(mmToPt(100), 5);
    expect(custom.height).toBeCloseTo(mmToPt(50), 5);
  });
});

describe('sizeInInches', () => {
  it('divides points by 72', () => {
    expect(sizeInInches({ width: 612, height: 792 })).toEqual({ width: 8.5, height: 11 });
    expect(sizeInInches({ width: 72, height: 36 })).toEqual({ width: 1, height: 0.5 });
  });
});
