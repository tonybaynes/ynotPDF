/**
 * The pure parts of the custom-stamp import (M31): the white knock-out, the crop clamp and the
 * base64. The canvas and the engine render are proved by Playwright.
 */

import { describe, expect, it } from 'vitest';
import {
  clampCrop,
  knockOutWhite,
  pngDataUrl,
  toBase64,
} from '@modules/M31-shapes-ink-stamps/stampImport';

describe('white to transparent', () => {
  it('clears white, keeps colour, and fades the band between', () => {
    const rgba = new Uint8ClampedArray([
      255,
      255,
      255,
      255, // white
      0,
      0,
      0,
      255, // black
      230,
      230,
      230,
      255, // light grey, in the fade band
      255,
      200,
      200,
      255, // pink: one channel low, so it stays
      255,
      255,
      255,
      0, // already transparent
    ]);
    knockOutWhite(rgba, 240);
    expect(rgba[3]).toBe(0);
    expect(rgba[7]).toBe(255);
    expect(rgba[11]).toBeGreaterThan(0);
    expect(rgba[11]).toBeLessThan(255);
    expect(rgba[15]).toBe(255);
    expect(rgba[19]).toBe(0);
  });
});

describe('the crop', () => {
  it('defaults to the whole picture and clamps to it', () => {
    expect(clampCrop(undefined, 40, 30)).toEqual({ x: 0, y: 0, width: 40, height: 30 });
    expect(clampCrop({ x: -5, y: 10, width: 100, height: 100 }, 40, 30)).toEqual({
      x: 0,
      y: 10,
      width: 40,
      height: 20,
    });
    expect(clampCrop({ x: 39.6, y: 29.6, width: 0, height: 0 }, 40, 30)).toEqual({
      x: 39,
      y: 29,
      width: 1,
      height: 1,
    });
  });
});

describe('base64', () => {
  it('encodes bytes of any length and makes a data URL', () => {
    expect(toBase64(new Uint8Array([104, 105]))).toBe('aGk=');
    const big = new Uint8Array(70_000).fill(65);
    expect(toBase64(big).length).toBeGreaterThan(90_000);
    expect(pngDataUrl('abc')).toBe('data:image/png;base64,abc');
  });
});
