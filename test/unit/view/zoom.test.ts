/**
 * Zoom maths (M11). The important one is the acceptance line "zoom to cursor keeps the point
 * under the cursor stationary (±1 px)": `zoomAboutPoint` is where that is decided, so it is
 * tested here over a spread of zooms and anchors, and again through the real DOM in
 * `test/e2e/viewer.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  bucketKey,
  bucketZoom,
  clampFactor,
  clampPercent,
  factor,
  fitZoom,
  MAX_PERCENT,
  MIN_PERCENT,
  percent,
  stepPercent,
  wheelZoom,
  ZOOM_LADDER,
  zoomAboutPoint,
  zoomToRect,
} from '@view/zoom';

const A4 = { width: 595, height: 842 };
const viewport = { width: 1000, height: 700, gap: 16, padding: 16 };

describe('percent and factor', () => {
  it('clamps to Foxit’s 1 %..6400 %', () => {
    expect(clampPercent(0)).toBe(MIN_PERCENT);
    expect(clampPercent(99999)).toBe(MAX_PERCENT);
    expect(clampPercent(Number.NaN)).toBe(100);
    expect(factor(200)).toBe(2);
    expect(percent(1.5)).toBe(150);
  });

  it('walks the ladder and stops at both ends', () => {
    expect(stepPercent(100, 1)).toBe(125);
    expect(stepPercent(100, -1)).toBe(75);
    expect(stepPercent(MAX_PERCENT, 1)).toBe(MAX_PERCENT);
    expect(stepPercent(MIN_PERCENT, -1)).toBe(MIN_PERCENT);
    // Every rung is reachable going up from the bottom.
    const walked: number[] = [];
    let z = MIN_PERCENT;
    for (let i = 0; i < 40 && z < MAX_PERCENT; i++) {
      z = stepPercent(z, 1);
      walked.push(z);
    }
    expect(walked).toEqual(ZOOM_LADDER.filter((p) => p > MIN_PERCENT));
  });
});

describe('zoom buckets', () => {
  it('rounds to an eighth of an octave, so a pinch does not thrash the cache', () => {
    expect(bucketZoom(1)).toBeCloseTo(1, 10);
    expect(bucketKey(1)).toBe(0);
    expect(bucketKey(2)).toBe(8);
    expect(bucketKey(0.5)).toBe(-8);
    expect(bucketZoom(0)).toBe(1);
  });

  it('never puts the bucket more than ~4.5 % away from the real zoom', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 64, noNaN: true }), (z) => {
        const bucket = bucketZoom(z);
        expect(Math.abs(bucket - z) / z).toBeLessThan(0.05);
      }),
    );
  });

  it('gives the same key to zooms in the same bucket', () => {
    expect(bucketKey(1.0)).toBe(bucketKey(1.02));
  });
});

describe('fit modes', () => {
  it('fit width uses the available width', () => {
    const z = fitZoom([A4], 'continuous', 'width', viewport);
    expect(z).toBe(clampFactor((viewport.width - 32) / A4.width));
  });

  it('fit page never needs a horizontal scrollbar', () => {
    const z = fitZoom([A4], 'continuous', 'page', viewport);
    expect(A4.width * z).toBeLessThanOrEqual(viewport.width - 32 + 1);
    expect(A4.height * z).toBeLessThanOrEqual(viewport.height - 32 + 1);
  });

  it('facing modes fit two pages plus the gap', () => {
    const single = fitZoom([A4], 'continuous', 'width', viewport);
    const facing = fitZoom([A4, A4], 'facing', 'width', viewport);
    expect(facing).toBeLessThan(single);
  });

  it('subtracts the scrollbar so fit width really fits', () => {
    const withBar = fitZoom([A4], 'continuous', 'width', { ...viewport, scrollbar: 15 });
    expect(withBar).toBeLessThan(fitZoom([A4], 'continuous', 'width', viewport));
  });

  it('rotation swaps the page before fitting', () => {
    const upright = fitZoom([A4], 'continuous', 'width', viewport);
    const turned = fitZoom([A4], 'continuous', 'width', viewport, 90);
    expect(turned).toBeLessThan(upright);
  });

  it('an empty document fits at 1', () => {
    expect(fitZoom([], 'continuous', 'page', viewport)).toBe(1);
  });
});

describe('zoom about a point', () => {
  /** Where a content point ends up on screen, given a scroll and a content offset. */
  const screenOf = (content: number, zoom: number, scroll: number, offset: number): number =>
    content * zoom - scroll + offset;

  it('keeps the point under the cursor within a pixel', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 32, noNaN: true }),
        fc.double({ min: 0.05, max: 32, noNaN: true }),
        fc.double({ min: 0, max: 4000, noNaN: true }),
        fc.double({ min: 0, max: 900, noNaN: true }),
        fc.double({ min: 0, max: 200, noNaN: true }),
        (oldZoom, newZoom, scrollTop, anchorY, offsetY) => {
          const scroll = { left: 0, top: scrollTop };
          const anchor = { x: 0, y: anchorY };
          // The content point currently under the anchor.
          const contentY = (scrollTop + anchorY - offsetY) / oldZoom;
          const next = zoomAboutPoint(
            scroll,
            anchor,
            oldZoom,
            newZoom,
            { x: 0, y: offsetY },
            { x: 0, y: offsetY },
          );
          const after = screenOf(contentY, newZoom, next.top, offsetY);
          expect(Math.abs(after - anchorY)).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it('accounts for the content re-centring when it grows', () => {
    // At 1× the content is narrower than the viewport, so it is centred; at 2× it is not.
    const next = zoomAboutPoint(
      { left: 0, top: 0 },
      { x: 500, y: 0 },
      1,
      2,
      { x: 200, y: 0 },
      { x: 0, y: 0 },
    );
    // Content x under the cursor was 300; at 2× it is at 600, and must still appear at 500.
    expect(next.left).toBe(100);
  });

  it('is a no-op at the same zoom', () => {
    const scroll = { left: 40, top: 90 };
    expect(zoomAboutPoint(scroll, { x: 10, y: 10 }, 2, 2)).toEqual(scroll);
  });

  it('survives a zero old zoom rather than returning NaN', () => {
    const next = zoomAboutPoint({ left: 0, top: 0 }, { x: 5, y: 5 }, 0, 2);
    expect(Number.isFinite(next.left)).toBe(true);
    expect(Number.isFinite(next.top)).toBe(true);
  });
});

describe('marquee zoom', () => {
  it('fits the rectangle and centres it', () => {
    const { zoom, scroll } = zoomToRect({ x: 100, y: 200, width: 200, height: 100 }, 1, {
      width: 800,
      height: 400,
    });
    expect(zoom).toBe(clampFactor(Math.min(800 / 200, 400 / 100)));
    // The rectangle's centre (200, 250) scaled by the zoom sits at the viewport centre.
    expect(scroll.left).toBeCloseTo(200 * zoom - 400, 6);
    expect(scroll.top).toBeCloseTo(250 * zoom - 200, 6);
  });

  it('does not divide by zero on a degenerate rectangle', () => {
    const { zoom } = zoomToRect({ x: 0, y: 0, width: 0, height: 0 }, 1, { width: 10, height: 10 });
    expect(Number.isFinite(zoom)).toBe(true);
  });
});

describe('wheel zoom', () => {
  it('goes up for a negative delta and down for a positive one, symmetrically', () => {
    expect(wheelZoom(1, -100)).toBeGreaterThan(1);
    expect(wheelZoom(1, 100)).toBeLessThan(1);
    expect(wheelZoom(1, -400)).toBeCloseTo(2, 2);
    expect(wheelZoom(1, 400)).toBeCloseTo(0.5, 2);
  });

  it('stays inside the range however hard the wheel is spun', () => {
    expect(percent(wheelZoom(64, -100000))).toBe(MAX_PERCENT);
    expect(percent(wheelZoom(0.01, 100000))).toBe(MIN_PERCENT);
  });
});
