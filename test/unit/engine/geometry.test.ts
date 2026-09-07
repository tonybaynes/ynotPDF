import { describe, expect, it } from 'vitest';
import { PageGeometry, intersectRect, normalizeRotation } from '@engine/geometry';
import { PageTransform } from '@view/Viewport';
import type { PageSize, Rotation } from '@shared/pdf';

const A4: PageSize = {
  width: 595,
  height: 842,
  rotation: 0,
  cropBox: { x0: 0, y0: 0, x1: 595, y1: 842 },
  mediaBox: { x0: 0, y0: 0, x1: 595, y1: 842 },
};

/** Offset CropBox inside a larger MediaBox with a negative origin, rotated 90°. */
const ODD: PageSize = {
  width: 700,
  height: 500,
  rotation: 90,
  cropBox: { x0: 50, y0: 100, x1: 550, y1: 800 },
  mediaBox: { x0: -50, y0: -50, x1: 650, y1: 900 },
};

describe('PageGeometry', () => {
  it('reports displayed size after /Rotate and CropBox', () => {
    const g = new PageGeometry(ODD);
    expect(g.width).toBe(700);
    expect(g.height).toBe(500);
    expect(g.box).toEqual(ODD.cropBox);
    expect(g.pageSize).toEqual(ODD);
    const extra = new PageGeometry(ODD, 90);
    expect(extra.rotation).toBe(180);
    expect(extra.width).toBe(500);
    expect(extra.pdfiumRotate).toBe(1);
  });

  it('agrees with PageTransform for every rotation', () => {
    const rotations: Rotation[] = [0, 90, 180, 270];
    for (const rot of rotations) {
      for (const extra of rotations) {
        const size = { ...ODD, rotation: rot };
        const g = new PageGeometry(size, extra);
        const t = new PageTransform(size, 1.5, extra);
        expect(g.rotation).toBe(t.rotation);
        for (const p of [
          { x: 50, y: 100 },
          { x: 550, y: 800 },
          { x: 300, y: 450 },
          { x: 0, y: 0 },
        ]) {
          const a = g.toDevice(p, 1.5);
          const b = t.toDevice(p);
          expect(a.x).toBeCloseTo(b.x, 6);
          expect(a.y).toBeCloseTo(b.y, 6);
          const back = g.toPage(a, 1.5);
          expect(back.x).toBeCloseTo(p.x, 6);
          expect(back.y).toBeCloseTo(p.y, 6);
        }
      }
    }
  });

  it('maps the CropBox corners to the device corners', () => {
    const g = new PageGeometry(ODD);
    // Unrotated top-left of the crop box (x0, y1) → with 90° cw rotation it lands top-right.
    const tl = g.toDevice({ x: 50, y: 800 }, 1);
    expect(tl).toEqual({ x: 700, y: 0 });
    const bl = g.toDevice({ x: 50, y: 100 }, 1);
    expect(bl).toEqual({ x: 0, y: 0 });
    const rect = g.rectToDevice(ODD.cropBox, 2);
    expect(rect).toEqual({ x: 0, y: 0, width: 1400, height: 1000 });
    expect(g.rectToPage(rect, 2)).toEqual(ODD.cropBox);
  });

  it('snaps tiles to whole pixels and reports what they cover', () => {
    const g = new PageGeometry(A4);
    const whole = g.tile(undefined, 1);
    expect(whole.device).toEqual({ x: 0, y: 0, width: 595, height: 842 });
    expect(whole.pageWidthPx).toBe(595);
    const quarter = g.tile({ x0: 0, y0: 421, x1: 297.5, y1: 842 }, 1);
    expect(quarter.device.x).toBe(0);
    expect(quarter.device.y).toBe(0);
    expect(quarter.device.width).toBe(298);
    expect(quarter.device.height).toBe(421);
    expect(quarter.page.y1).toBeCloseTo(842, 6);
    expect(quarter.page.x1).toBeCloseTo(298, 6);
    // Out-of-page requests are clamped, never empty.
    const outside = g.tile({ x0: 590, y0: -20, x1: 700, y1: 10 }, 1);
    expect(outside.device.x + outside.device.width).toBeLessThanOrEqual(595);
    expect(outside.device.width).toBeGreaterThanOrEqual(1);
    expect(outside.device.height).toBeGreaterThanOrEqual(1);
    // Fractional scales round the page size once so adjacent tiles share edges.
    const s = 1.3337;
    const a = g.tile({ x0: 0, y0: 0, x1: 200, y1: 842 }, s);
    const b = g.tile({ x0: 200, y0: 0, x1: 595, y1: 842 }, s);
    expect(a.device.x + a.device.width).toBeGreaterThanOrEqual(b.device.x);
    expect(b.device.x + b.device.width).toBe(a.pageWidthPx);
  });

  it('helpers: intersectRect and normalizeRotation', () => {
    expect(
      intersectRect({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 5, y0: 5, x1: 20, y1: 20 }),
    ).toEqual({
      x0: 5,
      y0: 5,
      x1: 10,
      y1: 10,
    });
    const a = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(intersectRect(a, { x0: 20, y0: 20, x1: 30, y1: 30 })).toBe(a);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(360)).toBe(0);
    expect(PageGeometry.fromBoxes(ODD.mediaBox, ODD.cropBox, 270).width).toBe(700);
  });
});
