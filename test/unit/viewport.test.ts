import { describe, expect, it } from 'vitest';
import type { PageSize } from '@shared/pdf';
import { mmToPt, normalizeRect, ptToMm, rectHeight, rectWidth } from '@shared/pdf';
import { clampZoom, PageTransform, stepZoom } from '@view/Viewport';

const a4: PageSize = {
  width: 595,
  height: 842,
  rotation: 0,
  cropBox: { x0: 0, y0: 0, x1: 595, y1: 842 },
  mediaBox: { x0: 0, y0: 0, x1: 595, y1: 842 },
};

describe('PageTransform', () => {
  it('maps page space (origin bottom-left) to device space (origin top-left)', () => {
    const t = new PageTransform(a4, 2);
    expect(t.widthPx).toBe(1190);
    expect(t.heightPx).toBe(1684);
    expect(t.toDevice({ x: 0, y: 842 })).toEqual({ x: 0, y: 0 });
    expect(t.toDevice({ x: 0, y: 0 })).toEqual({ x: 0, y: 1684 });
    expect(t.toPage({ x: 0, y: 0 })).toEqual({ x: 0, y: 842 });
  });

  it('round-trips through every rotation', () => {
    for (const rot of [0, 90, 180, 270] as const) {
      const t = new PageTransform({ ...a4, rotation: rot }, 1.5);
      const p = { x: 100, y: 200 };
      const d = t.toDevice(p);
      const back = t.toPage(d);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.y).toBeGreaterThanOrEqual(0);
    }
    const r90 = new PageTransform(a4, 1, 90);
    expect(r90.widthPx).toBe(842);
    expect(r90.heightPx).toBe(595);
    // Top-left of the unrotated page ends up top-right after 90° clockwise.
    expect(r90.toDevice({ x: 0, y: 842 })).toEqual({ x: 842, y: 0 });
  });

  it('converts rects', () => {
    const t = new PageTransform(a4, 1);
    expect(t.rectToDevice({ x0: 10, y0: 10, x1: 110, y1: 60 })).toEqual({
      left: 10,
      top: 782,
      width: 100,
      height: 50,
    });
  });
});

describe('zoom helpers', () => {
  it('clamps and steps', () => {
    expect(clampZoom(0)).toBe(0.01);
    expect(clampZoom(100)).toBe(64);
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(64, 1)).toBe(64);
    expect(stepZoom(0.01, -1)).toBe(0.01);
    expect(stepZoom(1.1, 1)).toBe(1.25);
  });
});

describe('pdf helpers', () => {
  it('normalises rects and converts units', () => {
    const r = normalizeRect({ x0: 10, y0: 20, x1: 0, y1: 5 });
    expect(r).toEqual({ x0: 0, y0: 5, x1: 10, y1: 20 });
    expect(rectWidth(r)).toBe(10);
    expect(rectHeight(r)).toBe(15);
    expect(mmToPt(25.4)).toBeCloseTo(72);
    expect(ptToMm(72)).toBeCloseTo(25.4);
  });
});
