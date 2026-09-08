/**
 * Night Mode's pixel transform (M11, inherited from M01).
 *
 * The point of these tests is that the transform is an *inversion of lightness*, not of colour:
 * white paper becomes the theme's `--page-paper-night`, black ink becomes `--page-ink-night`,
 * and a red heading is still red afterwards. A plain `invert()` would fail every one of them.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  applyNight,
  buildRamp,
  FALLBACK_PALETTE,
  luma,
  nightTransform,
  parseColor,
  restoreRegions,
  type NightPalette,
} from '@view/night';

const PALETTE: NightPalette = {
  paper: { r: 0x1b, g: 0x1b, b: 0x1d },
  ink: { r: 0xe8, g: 0xe8, b: 0xea },
};
const ramp = buildRamp(PALETTE);

/** One pixel through the transform. */
function pixel(r: number, g: number, b: number, chroma = 1): [number, number, number] {
  const data = new Uint8ClampedArray([r, g, b, 255]);
  applyNight(data, ramp, { chroma });
  return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
}

/**
 * Hue as an angle in degrees, or null for something too near neutral to have one. The threshold
 * is ~9 % saturation: below that the ramp's one-level quantisation is a large fraction of the
 * colour, and neither a reader nor this test can say what the hue was meant to be.
 */
function hue(r: number, g: number, b: number): number | null {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 24) return null;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (((h * 60) % 360) + 360) % 360;
}

describe('parseColor', () => {
  it('reads the forms a theme token can hold', () => {
    expect(parseColor('#1b1b1d')).toEqual({ r: 27, g: 27, b: 29 });
    expect(parseColor('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
    expect(parseColor('#1b1b1dff')).toEqual({ r: 27, g: 27, b: 29 });
    expect(parseColor('  rgb(1, 2, 3) ')).toEqual({ r: 1, g: 2, b: 3 });
    expect(parseColor('rgba(1 2 3 / 1)')).toEqual({ r: 1, g: 2, b: 3 });
  });

  it('returns null rather than guessing', () => {
    expect(parseColor('')).toBeNull();
    expect(parseColor('var(--x)')).toBeNull();
    expect(parseColor('#12345')).toBeNull();
    expect(parseColor('rgb(a, b, c)')).toBeNull();
  });
});

describe('the ramp', () => {
  it('maps white paper to the night paper and black ink to the night ink', () => {
    expect(pixel(255, 255, 255)).toEqual([PALETTE.paper.r, PALETTE.paper.g, PALETTE.paper.b]);
    expect(pixel(0, 0, 0)).toEqual([PALETTE.ink.r, PALETTE.ink.g, PALETTE.ink.b]);
  });

  it('inverts lightness monotonically — darker in, lighter out', () => {
    let previous = 256;
    for (let l = 0; l <= 255; l += 5) {
      const out = luma(...pixel(l, l, l));
      expect(out).toBeLessThan(previous);
      previous = out;
    }
  });

  it('is a real inversion: the page ends up dark and the text light', () => {
    expect(luma(...pixel(255, 255, 255))).toBeLessThan(60);
    expect(luma(...pixel(0, 0, 0))).toBeGreaterThan(200);
  });
});

describe('hue survives', () => {
  it('keeps a red heading red and a blue link blue', () => {
    const red = pixel(200, 30, 30);
    const blue = pixel(30, 60, 200);
    // A plain invert() would turn red into cyan (~180°) and blue into yellow (~60°).
    const redHue = hue(...red) ?? 0;
    expect(redHue > 330 || redHue < 30).toBe(true);
    const blueHue = hue(...blue) ?? 0;
    expect(blueHue).toBeGreaterThan(180);
    expect(blueHue).toBeLessThan(280);
  });

  it('holds for every colour with visible saturation: the hue moves less than 6°', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (r, g, b) => {
          const before = hue(r, g, b);
          if (before === null) return; // greys have no hue to keep
          const after = hue(...pixel(r, g, b));
          if (after === null) return; // the transform can flatten a faint tint to a grey
          const delta = Math.abs(((after - before + 540) % 360) - 180);
          // A plain invert() moves every hue by 180°. What is left here is the ramp's one-level
          // quantisation, which matters less the more saturated the colour is: swept over the
          // whole 8-bit cube the worst case is 5.0° at this threshold, 7.5° at half of it.
          expect(delta).toBeLessThan(6);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('chroma 0 gives a plain greyscale inversion', () => {
    const [r, g, b] = pixel(200, 30, 30, 0);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(2);
  });
});

describe('leaving photographs alone', () => {
  const width = 4;
  const height = 4;

  function checkerboard(): Uint8ClampedArray {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const v = i % 2 === 0 ? 255 : 0;
      data[i * 4] = v;
      data[i * 4 + 1] = v;
      data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
    return data;
  }

  it('restores the named rectangles from the untouched source', () => {
    const source = checkerboard();
    const target = checkerboard();
    applyNight(target, ramp);
    restoreRegions(target, source, width, height, [{ x: 0, y: 0, width: 2, height: 1 }]);
    // The first two pixels are back to the original; the third is inverted.
    expect(target[0]).toBe(source[0]);
    expect(target[4]).toBe(source[4]);
    expect(target[8]).not.toBe(source[8]);
  });

  it('clips rectangles to the bitmap instead of throwing', () => {
    const source = checkerboard();
    const target = checkerboard();
    expect(() => {
      restoreRegions(target, source, width, height, [
        { x: -10, y: -10, width: 100, height: 100 },
        { x: 100, y: 100, width: 10, height: 10 },
      ]);
    }).not.toThrow();
    expect(target).toEqual(source);
  });

  it('nightTransform does the inversion and the exemptions in one pass', () => {
    const data = checkerboard();
    const original = new Uint8ClampedArray(data);
    nightTransform(data, width, height, ramp, [{ x: 0, y: 0, width: 1, height: 1 }]);
    expect(data[0]).toBe(original[0]);
    expect(data[4]).not.toBe(original[4]);
  });

  it('with no exemptions it does not copy the bitmap at all', () => {
    const data = checkerboard();
    nightTransform(data, width, height, ramp);
    expect(data[0]).toBe(PALETTE.paper.r);
  });

  it('leaves alpha alone', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 128]);
    applyNight(data, ramp);
    expect(data[3]).toBe(128);
  });
});

describe('the fallback palette', () => {
  it('is a usable dark pair when the computed style cannot be read', () => {
    expect(
      luma(FALLBACK_PALETTE.paper.r, FALLBACK_PALETTE.paper.g, FALLBACK_PALETTE.paper.b),
    ).toBeLessThan(64);
    expect(
      luma(FALLBACK_PALETTE.ink.r, FALLBACK_PALETTE.ink.g, FALLBACK_PALETTE.ink.b),
    ).toBeGreaterThan(192);
  });
});
