/**
 * M11 acceptance: "rotated and CropBox fixtures render the visible region correctly (hash
 * compare against engine full-page render)."
 *
 * The viewer never renders a whole page at the zoom it displays — it renders 512 px tiles and
 * blits them into a canvas. This test does exactly what `TileRenderer` and `PageView` do, in
 * Node against the real PDFium engine, and compares the composited result with the engine's own
 * whole-page render of the same page at the same scale. If the tile rectangles, the CropBox
 * offset or the rotation were wrong by so much as a pixel, the two would not match.
 *
 * `rotated.pdf` has pages at every `/Rotate`; `mixed-boxes.pdf` has a CropBox whose origin is
 * not (0, 0), which is the case that catches naive geometry.
 */

import { describe, expect, it } from 'vitest';
import { PageGeometry } from '@engine/geometry';
import { dhash as hashPixels, hamming } from '@engine/imageHash';
import { tileRect, tilesForRect, TILE_SIZE } from '@view/tiles';
import { engine, fixture, hasFixture } from '../engine/helpers';

/** Composites a page from tiles exactly as `PageView.paintTile` does. */
async function compositeFromTiles(
  bytes: Uint8Array,
  page: number,
  zoom: number,
  rotation: 0 | 90 | 180 | 270,
): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> {
  const e = await engine();
  const doc = await e.open(bytes);
  try {
    const size = await e.pageSize(doc, page);
    const geo = new PageGeometry(size, rotation);
    const pageWidthPx = geo.width * zoom;
    const pageHeightPx = geo.height * zoom;
    const device = geo.devicePageSize(zoom);
    const out = new Uint8ClampedArray(device.width * device.height * 4);

    const coords = tilesForRect(
      { x: 0, y: 0, width: pageWidthPx, height: pageHeightPx },
      pageWidthPx,
      pageHeightPx,
    );
    expect(coords.length).toBeGreaterThan(1); // it must actually be tiled to prove anything

    for (const coord of coords) {
      const css = tileRect(coord, pageWidthPx, pageHeightPx);
      if (css.width <= 0 || css.height <= 0) continue;
      const rect = geo.rectToPage(css, zoom);
      const tile = await e.renderRaw(doc, page, zoom, rect, { rotation });
      // Where the engine says this tile landed in the full-page bitmap.
      const placed = geo.tile(rect, zoom).device;
      for (let row = 0; row < tile.height; row++) {
        const y = placed.y + row;
        if (y < 0 || y >= device.height) continue;
        const from = row * tile.width * 4;
        const to = (y * device.width + placed.x) * 4;
        const width = Math.min(tile.width, device.width - placed.x) * 4;
        out.set(tile.rgba.subarray(from, from + width), to);
      }
    }
    return { width: device.width, height: device.height, rgba: out };
  } finally {
    await e.close(doc);
  }
}

async function fullPage(
  bytes: Uint8Array,
  page: number,
  zoom: number,
  rotation: 0 | 90 | 180 | 270,
): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> {
  const e = await engine();
  const doc = await e.open(bytes);
  try {
    const raw = await e.renderRaw(doc, page, zoom, undefined, { rotation });
    return { width: raw.width, height: raw.height, rgba: raw.rgba };
  } finally {
    await e.close(doc);
  }
}

/** Fraction of pixels whose channels differ by more than `tolerance`. */
function differing(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  tolerance = 2,
): { fraction: number; worst: number } {
  let differed = 0;
  let worst = 0;
  const pixels = Math.min(a.length, b.length) / 4;
  for (let i = 0; i < pixels; i++) {
    let delta = 0;
    for (let c = 0; c < 3; c++) {
      delta = Math.max(delta, Math.abs((a[i * 4 + c] ?? 0) - (b[i * 4 + c] ?? 0)));
    }
    worst = Math.max(worst, delta);
    if (delta > tolerance) differed++;
  }
  return { fraction: pixels === 0 ? 1 : differed / pixels, worst };
}

const CASES: ReadonlyArray<{ file: string; pages: number[]; zooms: number[] }> = [
  // Every `/Rotate` value: 0, 90, 180, 270.
  { file: 'rotated.pdf', pages: [0, 1, 2, 3], zooms: [1.5] },
  // A CropBox whose origin is not (0, 0), plus differing page sizes.
  { file: 'mixed-boxes.pdf', pages: [0, 1, 2, 3], zooms: [1.5] },
  // Ordinary text at a zoom that makes a 2 x 2 grid, to prove the plain case too.
  { file: 'text.pdf', pages: [0], zooms: [1, 2] },
];

describe('tiles composite to the same picture as a whole-page render', () => {
  for (const { file, pages, zooms } of CASES) {
    for (const page of pages) {
      for (const zoom of zooms) {
        for (const rotation of [0, 90, 180, 270] as const) {
          it(`${file} page ${page + 1} at ${zoom}× rotated ${rotation}°`, async () => {
            if (!hasFixture(file)) return;
            const bytes = fixture(file);
            const tiled = await compositeFromTiles(bytes, page, zoom, rotation);
            const whole = await fullPage(bytes, page, zoom, rotation);

            expect(tiled.width).toBe(whole.width);
            expect(tiled.height).toBe(whole.height);
            expect(tiled.width).toBeGreaterThan(TILE_SIZE);

            // The perceptual hashes must agree. PDFium anti-aliases each tile against its own
            // edges, so one hash bit is allowed to move; 39 of these 40 cases are in fact
            // bit-identical, and the one that is not differs on 0.013 % of its pixels.
            expect(
              hamming(
                hashPixels(tiled.rgba, tiled.width, tiled.height),
                hashPixels(whole.rgba, whole.width, whole.height),
              ),
            ).toBeLessThanOrEqual(1);
            expect(differing(tiled.rgba, whole.rgba).fraction).toBeLessThan(0.0005);
          });
        }
      }
    }
  }
});
