/**
 * The colour pipeline every image format shares (M92): flattening onto white, Rec. 601 grey, and
 * the two ways of getting to one bit a pixel.
 */

import { describe, expect, it } from 'vitest';
import {
  flatten,
  greyToRgba,
  luma,
  monoToGrey,
  reduce,
  reducedSize,
  toGrey,
  toMono,
  type Raster,
} from '@engine/export';

function solid(width: number, height: number, rgba: [number, number, number, number]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { data, width, height };
}

describe('flatten', () => {
  it('leaves opaque pixels alone', () => {
    const out = flatten(solid(2, 1, [10, 20, 30, 255]));
    expect([...out]).toEqual([10, 20, 30, 255, 10, 20, 30, 255]);
  });

  it('composites a translucent pixel over white, not over black', () => {
    const out = flatten(solid(1, 1, [0, 0, 0, 128]));
    // 0 × (128/255) + 255 × (127/255) = 127
    expect([out[0], out[1], out[2], out[3]]).toEqual([127, 127, 127, 255]);
  });

  it('turns a fully transparent pixel into paper, not into black', () => {
    expect([...flatten(solid(1, 1, [0, 0, 0, 0]))]).toEqual([255, 255, 255, 255]);
  });
});

describe('toGrey', () => {
  it('uses Rec. 601 weights', () => {
    expect(toGrey(solid(1, 1, [255, 0, 0, 255])).data[0]).toBe(Math.round(luma(255, 0, 0)));
    expect(toGrey(solid(1, 1, [0, 255, 0, 255])).data[0]).toBe(Math.round(luma(0, 255, 0)));
    expect(toGrey(solid(1, 1, [0, 0, 255, 255])).data[0]).toBe(Math.round(luma(0, 0, 255)));
  });

  it('keeps white white and black black', () => {
    expect(toGrey(solid(1, 1, [255, 255, 255, 255])).data[0]).toBe(255);
    expect(toGrey(solid(1, 1, [0, 0, 0, 255])).data[0]).toBe(0);
  });

  it('flattens transparency onto white on the way', () => {
    expect(toGrey(solid(1, 1, [0, 0, 0, 0])).data[0]).toBe(255);
  });
});

describe('toMono', () => {
  const ramp = (width: number): { data: Uint8Array; width: number; height: number } => {
    const data = new Uint8Array(width);
    for (let x = 0; x < width; x++) data[x] = Math.round((x / (width - 1)) * 255);
    return { data, width, height: 1 };
  };

  it('thresholds without dithering, a set bit meaning white', () => {
    const mono = toMono(
      { data: Uint8Array.from([0, 200, 100, 255]), width: 4, height: 1 },
      {
        threshold: 128,
        dither: 'none',
      },
    );
    expect(mono.stride).toBe(1);
    // pixels: black, white, black, white → 0b0101_0000
    expect(mono.data[0]).toBe(0b01010000);
  });

  it('pads every row to a byte', () => {
    const mono = toMono(ramp(9), { threshold: 128, dither: 'none' });
    expect(mono.stride).toBe(2);
    expect(mono.data.length).toBe(2);
  });

  it('never modifies the grey it was given, so a raster can be exported twice', () => {
    const grey = ramp(64);
    const before = [...grey.data];
    toMono(grey, { threshold: 128, dither: 'floyd-steinberg' });
    expect([...grey.data]).toEqual(before);
  });

  it('dithers a mid grey into about half white, where a threshold gives all or nothing', () => {
    const width = 64;
    const height = 64;
    const grey = { data: new Uint8Array(width * height).fill(128), width, height };
    const count = (mono: ReturnType<typeof toMono>): number => {
      let n = 0;
      for (const byte of mono.data) {
        for (let bit = 0; bit < 8; bit++) if ((byte >> bit) & 1) n++;
      }
      return n;
    };
    const plain = count(toMono(grey, { threshold: 128, dither: 'none' }));
    const dithered = count(toMono(grey, { threshold: 128, dither: 'floyd-steinberg' }));
    expect(plain).toBe(width * height); // 128 >= 128, so every pixel is white
    expect(dithered).toBeGreaterThan(width * height * 0.3);
    expect(dithered).toBeLessThan(width * height * 0.7);
  });
});

describe('reduce', () => {
  it('answers in the mode it was asked for, at the same size', () => {
    const raster = solid(5, 3, [12, 34, 56, 255]);
    for (const mode of ['colour', 'grey', 'mono'] as const) {
      const reduced = reduce(raster, mode);
      expect(reduced.mode).toBe(mode);
      expect(reducedSize(reduced)).toEqual({ width: 5, height: 3 });
    }
  });
});

describe('the conversions back', () => {
  it('grey → RGBA repeats the channel and makes it opaque', () => {
    expect([...greyToRgba({ data: Uint8Array.from([7]), width: 1, height: 1 })]).toEqual([
      7, 7, 7, 255,
    ]);
  });

  it('mono → grey is black and white and nothing between', () => {
    const mono = toMono(
      { data: Uint8Array.from([0, 255]), width: 2, height: 1 },
      {
        threshold: 128,
        dither: 'none',
      },
    );
    expect([...monoToGrey(mono).data]).toEqual([0, 255]);
  });
});
