/**
 * Destinations → a view (M12). One conversion, shared by bookmarks, the destinations panel and
 * (later) links, so this is where the PDF's fit modes are pinned down.
 */

import { describe, expect, it } from 'vitest';
import {
  describeDestination,
  destinationFromView,
  destinationView,
  scrollLeftFor,
  scrollTopFor,
} from '@modules/M12-navigation-panels/destinations/navigate';

const A4 = { width: 595, height: 842 };
const WINDOW = { width: 900, height: 700 };

/** A destination with everything absent unless the test says otherwise. */
function dest(
  fit: Parameters<typeof destinationView>[0]['fit'],
  extra: Partial<Parameters<typeof destinationView>[0]> = {},
): Parameters<typeof destinationView>[0] {
  return { fit, left: null, top: null, zoom: null, rect: null, ...extra };
}

describe('destinationView', () => {
  it('XYZ turns the PDF’s bottom-left origin into a distance from the top of the page', () => {
    const view = destinationView(dest('xyz', { left: 100, top: 742, zoom: 2 }), A4, WINDOW);
    expect(view.top).toBeCloseTo(100, 5);
    expect(view.left).toBe(100);
    expect(view.zoom).toBe(2);
    expect(view.fit).toBeNull();
  });

  it('XYZ with no zoom keeps the reader’s own', () => {
    const view = destinationView(dest('xyz', { top: 842, zoom: 0 }), A4, WINDOW);
    expect(view.zoom).toBeNull();
    expect(view.top).toBe(0);
  });

  it('Fit and FitB fit the page; FitH and FitBH fit the width at a place', () => {
    expect(destinationView(dest('fit'), A4, WINDOW)).toMatchObject({ fit: 'page', top: 0 });
    expect(destinationView(dest('fitB'), A4, WINDOW)).toMatchObject({ fit: 'page' });
    const h = destinationView(dest('fitH', { top: 642 }), A4, WINDOW);
    expect(h.fit).toBe('width');
    expect(h.top).toBeCloseTo(200, 5);
    expect(destinationView(dest('fitBH', { top: 842 }), A4, WINDOW).fit).toBe('width');
  });

  it('FitV zooms so the page’s width fills the window and scrolls across', () => {
    const view = destinationView(dest('fitV', { left: 50 }), A4, WINDOW);
    expect(view.zoom).toBeCloseTo(WINDOW.width / A4.width, 5);
    expect(view.left).toBe(50);
    expect(view.top).toBe(0);
  });

  it('FitR zooms to the rectangle, whichever way round its corners are given', () => {
    const rect = { x0: 100, y0: 400, x1: 300, y1: 600 };
    const view = destinationView(dest('fitR', { rect }), A4, WINDOW);
    expect(view.zoom).not.toBeNull();
    expect(view.zoom ?? 0).toBeGreaterThan(1);
    expect(view.left).toBe(100);
    // The *top* of the rectangle, measured from the top of the page.
    expect(view.top).toBeCloseTo(842 - 600, 5);
    const flipped = destinationView(
      dest('fitR', { rect: { x0: 300, y0: 600, x1: 100, y1: 400 } }),
      A4,
      WINDOW,
    );
    expect(flipped.left).toBe(100);
    expect(flipped.top).toBeCloseTo(842 - 600, 5);
  });

  it('FitR with no rectangle, and any mode with no window, degrade to fitting the page', () => {
    expect(destinationView(dest('fitR'), A4, WINDOW).fit).toBe('page');
    expect(
      destinationView(dest('fitR', { rect: { x0: 0, y0: 0, x1: 1, y1: 1 } }), A4, {
        width: 0,
        height: 0,
      }).fit,
    ).toBe('page');
  });

  it('clamps a zoom the file made up', () => {
    expect(destinationView(dest('xyz', { zoom: 1e9 }), A4, WINDOW).zoom).toBe(64);
    expect(destinationView(dest('xyz', { zoom: 1e-9 }), A4, WINDOW).zoom).toBe(0.01);
  });
});

describe('scroll offsets', () => {
  it('turn a place on the page into a place in the scrolled content', () => {
    const view = destinationView(dest('xyz', { left: 100, top: 742 }), A4, WINDOW);
    // Page starts 300 px down the content, at 2 CSS px per point.
    expect(scrollTopFor(view, 300, 2)).toBe(300 + Math.round((100 - 4) * 2));
    expect(scrollLeftFor(view, 20, 2)).toBe(20 + Math.round((100 - 4) * 2));
  });

  it('a destination that does not ask to scroll across says so', () => {
    expect(scrollLeftFor(destinationView(dest('fit'), A4, WINDOW), 20, 2)).toBeNull();
  });

  it('never scrolls above the top of the content', () => {
    expect(scrollTopFor(destinationView(dest('fit'), A4, WINDOW), 0, 1)).toBe(0);
  });
});

describe('describing the current view as a destination', () => {
  it('records XYZ with the live zoom, in the PDF’s own coordinates', () => {
    const spec = destinationFromView({ page: A4, topPoints: 100, leftPoints: 30, zoom: 1.5 });
    expect(spec).toEqual({ fit: 'xyz', left: 30, top: 742, zoom: 1.5, rect: null });
    // And it round-trips: what came out goes back to the same place.
    const view = destinationView({ ...spec, pageId: null } as never, A4, WINDOW);
    expect(view.top).toBeCloseTo(100, 5);
    expect(view.zoom).toBe(1.5);
  });

  it('never records a negative offset or an absurd zoom', () => {
    const spec = destinationFromView({ page: A4, topPoints: 9999, leftPoints: -5, zoom: 1e9 });
    expect(spec.left).toBe(0);
    expect(spec.top).toBe(0);
    expect(spec.zoom).toBe(64);
  });
});

describe('describing a destination in words', () => {
  it('says the page and what it does there', () => {
    expect(describeDestination({ fit: 'xyz', top: 800, zoom: 1.5 }, '4')).toBe('page 4 at 150%');
    expect(describeDestination({ fit: 'xyz', top: 800, zoom: null }, '4')).toBe('page 4');
    expect(describeDestination({ fit: 'fit', top: null, zoom: null }, 'iv')).toBe(
      'page iv, fit page',
    );
    expect(describeDestination({ fit: 'fitH', top: 1, zoom: null }, '2')).toBe('page 2, fit width');
    expect(describeDestination({ fit: 'fitV', top: null, zoom: null }, '2')).toBe(
      'page 2, fit height',
    );
    expect(describeDestination({ fit: 'fitR', top: null, zoom: null }, '2')).toBe(
      'page 2, fit rectangle',
    );
    // A destination whose page has gone says so rather than saying nothing.
    expect(describeDestination({ fit: 'fit', top: null, zoom: null }, null)).toBe(
      'no page, fit page',
    );
  });
});
