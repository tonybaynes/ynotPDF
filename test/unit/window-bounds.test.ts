import { describe, expect, it } from 'vitest';
import { clampToDisplays, displayKey, isSavedBounds } from '../../src/main/windowBounds';

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const secondary = { workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };

describe('window bounds', () => {
  it('keys the display arrangement by id and size, order-independent, without dots', () => {
    const a = displayKey([
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      { id: 2.5, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } },
    ]);
    const b = displayKey([
      { id: 2.5, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } },
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]);
    expect(a).toBe(b);
    expect(a).not.toContain('.');
    expect(displayKey([{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 } }])).not.toBe(a);
  });

  it('keeps bounds that are visible on any display', () => {
    const saved = { x: 2000, y: 100, width: 1200, height: 800, maximized: false };
    expect(clampToDisplays(saved, [primary, secondary])).toEqual(saved);
  });

  it('centres bounds that fell off every display (monitor unplugged)', () => {
    const saved = { x: 2000, y: 100, width: 1200, height: 800, maximized: true };
    const out = clampToDisplays(saved, [primary]);
    expect(out.x).toBe(360);
    expect(out.y).toBe(120);
    expect(out.width).toBe(1200);
    expect(out.maximized).toBe(true);
    const huge = clampToDisplays(
      { x: -5000, y: -5000, width: 4000, height: 3000, maximized: false },
      [primary],
    );
    expect(huge.width).toBe(1920);
    expect(huge.height).toBe(1040);
    expect(huge.x).toBe(0);
  });

  it('validates persisted values', () => {
    expect(isSavedBounds({ x: 1, y: 2, width: 3, height: 4, maximized: false })).toBe(true);
    expect(isSavedBounds({ x: 1, y: 2, width: 3 })).toBe(false);
    expect(isSavedBounds(null)).toBe(false);
    expect(isSavedBounds('x')).toBe(false);
  });
});
