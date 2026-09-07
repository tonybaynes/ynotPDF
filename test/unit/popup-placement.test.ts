import { describe, expect, it } from 'vitest';
import { placePopup } from '@app/popup';

const viewport = { width: 1000, height: 600 };

describe('popup placement', () => {
  it('places below the anchor by default, aligned to its start', () => {
    const p = placePopup(
      { x: 100, y: 50, width: 80, height: 30 },
      { width: 200, height: 150 },
      viewport,
    );
    expect(p.placement).toBe('below');
    expect(p.x).toBe(100);
    expect(p.y).toBe(82);
    expect(p.maxHeight).toBe(150);
  });

  it('flips above when there is more room above than below', () => {
    const p = placePopup(
      { x: 100, y: 500, width: 80, height: 30 },
      { width: 200, height: 300 },
      viewport,
    );
    expect(p.placement).toBe('above');
    expect(p.y + p.maxHeight).toBeLessThanOrEqual(500);
  });

  it('clamps to the viewport and shrinks when neither side fits', () => {
    const p = placePopup(
      { x: 900, y: 300, width: 80, height: 30 },
      { width: 300, height: 900 },
      viewport,
    );
    expect(p.x + p.maxWidth).toBeLessThanOrEqual(viewport.width);
    expect(p.maxHeight).toBeLessThan(900);
    expect(p.y).toBeGreaterThanOrEqual(0);
  });

  it('places submenus to the right and flips left near the edge', () => {
    const right = placePopup(
      { x: 100, y: 100, width: 150, height: 24 },
      { width: 200, height: 100 },
      viewport,
      'right',
    );
    expect(right.placement).toBe('right');
    expect(right.x).toBe(252);
    const left = placePopup(
      { x: 850, y: 100, width: 150, height: 24 },
      { width: 200, height: 100 },
      viewport,
      'right',
    );
    expect(left.placement).toBe('left');
    expect(left.x + left.maxWidth).toBeLessThanOrEqual(850);
  });

  it('supports end alignment', () => {
    const p = placePopup(
      { x: 500, y: 50, width: 100, height: 30 },
      { width: 200, height: 50 },
      viewport,
      'below',
      'end',
    );
    expect(p.x).toBe(400);
  });
});
