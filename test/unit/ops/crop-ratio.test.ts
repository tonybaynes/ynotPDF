import { describe, expect, it } from 'vitest';
import { PageGeometry } from '@engine/geometry';
import { cropDrag } from '@modules/M41-merge-split-crop/cropDrag';
import {
  fitCropRatio,
  pageCropRatio,
  readCropRatio,
  usableCrop,
} from '@modules/M41-merge-split-crop/cropRatio';

describe('crop ratio validation', () => {
  it.each(['', '0', '-1', 'NaN', 'Infinity', '1e309', '1001', '0.001'])(
    'rejects custom component %s',
    (value) => {
      for (const [width, height] of [
        [value, '1'],
        ['1', value],
      ] as const)
        expect(readCropRatio({ mode: 'custom', width, height })).toBeUndefined();
    },
  );
  it('distinguishes free, fixed, valid custom and invalid modes', () => {
    expect(readCropRatio({ mode: 'free', width: '', height: '' })).toBeNull();
    expect(readCropRatio({ mode: 'wide', width: '', height: '' })).toBe(16 / 9);
    expect(readCropRatio({ mode: 'custom', width: '2.5', height: '1.25' })).toBe(2);
    expect(readCropRatio({ mode: 'missing', width: '1', height: '1' })).toBeUndefined();
    expect(readCropRatio({ mode: 'custom', width: '1000', height: '0.01' })).toBeUndefined();
    expect(readCropRatio({ mode: 'custom', width: '1', height: '100' })).toBe(0.01);
    expect(readCropRatio({ mode: 'custom', width: '100', height: '1' })).toBe(100);
  });
});

describe('crop geometry', () => {
  const bounds = { x0: 35, y0: -20, x1: 435, y1: 580 };
  it.each([0, 90, 180, 270] as const)(
    'fits a displayed 16:9 rectangle at %s degrees on a cropped, offset page',
    (rotation) => {
      const geometry = PageGeometry.fromBoxes(bounds, bounds, rotation);
      const fitted = fitCropRatio(
        { x0: -100, y0: 40, x1: 900, y1: 480 },
        bounds,
        pageCropRatio(16 / 9, rotation),
      );
      const shown = geometry.rectToDevice(fitted, 1);
      expect(shown.width / shown.height).toBeCloseTo(16 / 9, 10);
      expect(fitted.x0).toBeGreaterThanOrEqual(bounds.x0);
      expect(fitted.x1).toBeLessThanOrEqual(bounds.x1);
      expect(fitted.y0).toBeGreaterThanOrEqual(bounds.y0);
      expect(fitted.y1).toBeLessThanOrEqual(bounds.y1);
      expect(geometry.rectToPage(shown, 1)).toEqual(fitted);
      expect(usableCrop(fitted)).toBe(true);
    },
  );
  it('does not distort an extreme or collapsed ratio to enforce a minimum', () => {
    const tiny = fitCropRatio({ x0: 35, y0: 0, x1: 36, y1: 10 }, bounds, 100);
    expect((tiny.x1 - tiny.x0) / (tiny.y1 - tiny.y0)).toBeCloseTo(100);
    expect(usableCrop(tiny)).toBe(false);
    expect(usableCrop(fitCropRatio({ x0: 500, y0: 0, x1: 600, y1: 100 }, bounds, 1))).toBe(false);
    expect(() => fitCropRatio(bounds, bounds, Infinity)).toThrow();
    expect(fitCropRatio(bounds, bounds, null)).toEqual(bounds);
    expect(usableCrop({ ...bounds, x0: NaN })).toBe(false);
    expect(pageCropRatio(null, 90)).toBeNull();
  });
});

describe('ratio handles', () => {
  const initial = { x: 50, y: 50, width: 100, height: 50 };
  const bounds = { width: 500, height: 500 };
  it.each(['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'])(
    'keeps %s at 2:1 within the page',
    (handle) => {
      const result = cropDrag({ x: 0, y: 0 }, { x: 250, y: 200 }, initial, handle, 2, bounds);
      expect(result.width / result.height).toBeCloseTo(2);
      expect(result.x).toBeGreaterThanOrEqual(0);
      expect(result.y).toBeGreaterThanOrEqual(0);
      expect(result.x + result.width).toBeLessThanOrEqual(500);
      expect(result.y + result.height).toBeLessThanOrEqual(500);
    },
  );
  it('can enlarge an edge without shifting its opposite edge', () => {
    const result = cropDrag({ x: 150, y: 75 }, { x: 160, y: 75 }, initial, 'e', 2, bounds);
    expect(result).toEqual({ x: 50, y: 47.5, width: 110, height: 55 });
  });
  it('clamps a backwards drag and preserves its starting corner', () => {
    expect(cropDrag({ x: 100, y: 100 }, { x: -50, y: -50 }, null, null, 2, bounds)).toEqual({
      x: 0,
      y: 50,
      width: 100,
      height: 50,
    });
    expect(cropDrag({ x: 20, y: 30 }, { x: 150, y: 90 }, null, null, null, bounds)).toEqual({
      x: 20,
      y: 30,
      width: 130,
      height: 60,
    });
  });
});
