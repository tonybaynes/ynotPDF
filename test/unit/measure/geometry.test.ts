/**
 * M33's geometry: segment intersection, polygon area (shoelace), point-to-segment distance and
 * the lengths built on them. The brief names these four by name, and every measurement in the
 * app is one of them, so they are tested against numbers worked out by hand.
 */

import { describe, expect, it } from 'vitest';
import type { PdfPoint } from '@shared/pdf';
import {
  boundsOf,
  constrainAngle,
  cornersOf,
  midpoint,
  nearestOnSegment,
  offsetPoints,
  offsetRect,
  pathLength,
  perimeter,
  pointPathDistance,
  pointSegmentDistance,
  polygonArea,
  rectContains,
  rectsOverlap,
  samePoint,
  scalePoints,
  segmentIntersection,
  shoelace,
  windowAround,
} from '@modules/M33-measuring-tools/geometry';

const p = (x: number, y: number): PdfPoint => ({ x, y });

describe('point to segment', () => {
  it('is the perpendicular distance when the foot is inside the segment', () => {
    expect(pointSegmentDistance(p(5, 3), p(0, 0), p(10, 0))).toBeCloseTo(3, 12);
    expect(nearestOnSegment(p(5, 3), p(0, 0), p(10, 0))).toEqual({ point: p(5, 0), t: 0.5 });
  });

  it('is the distance to the nearer end when the foot is outside it', () => {
    expect(pointSegmentDistance(p(-4, 3), p(0, 0), p(10, 0))).toBeCloseTo(5, 12);
    expect(pointSegmentDistance(p(14, 0), p(0, 0), p(10, 0))).toBeCloseTo(4, 12);
    expect(nearestOnSegment(p(-4, 3), p(0, 0), p(10, 0)).t).toBe(0);
    expect(nearestOnSegment(p(99, 0), p(0, 0), p(10, 0)).t).toBe(1);
  });

  it('treats a zero-length segment as its own point', () => {
    expect(pointSegmentDistance(p(3, 4), p(0, 0), p(0, 0))).toBeCloseTo(5, 12);
    expect(nearestOnSegment(p(3, 4), p(1, 1), p(1, 1))).toEqual({ point: p(1, 1), t: 0 });
  });

  it('finds the nearest segment of a polyline, and nothing at all in an empty one', () => {
    const path = [p(0, 0), p(10, 0), p(10, 10)];
    expect(pointPathDistance(p(11, 5), path)).toBeCloseTo(1, 12);
    expect(pointPathDistance(p(0, 0), [])).toBe(Number.POSITIVE_INFINITY);
    expect(pointPathDistance(p(0, 0), [p(1, 1)])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('segment intersection', () => {
  it('finds a true crossing', () => {
    expect(segmentIntersection(p(0, 0), p(10, 10), p(0, 10), p(10, 0))).toEqual(p(5, 5));
    expect(segmentIntersection(p(-5, 0), p(5, 0), p(0, -5), p(0, 5))).toEqual(p(0, 0));
  });

  it('counts a touch at an end as a crossing', () => {
    expect(segmentIntersection(p(0, 0), p(10, 0), p(10, 0), p(10, 10))).toEqual(p(10, 0));
  });

  it('is null when the lines would cross outside one of the segments', () => {
    expect(segmentIntersection(p(0, 0), p(1, 0), p(5, -5), p(5, 5))).toBeNull();
    expect(segmentIntersection(p(0, 0), p(10, 0), p(3, 1), p(3, 5))).toBeNull();
  });

  it('is null for parallel segments, collinear ones included', () => {
    expect(segmentIntersection(p(0, 0), p(10, 0), p(0, 3), p(10, 3))).toBeNull();
    // Two segments lying on top of each other have no single crossing point to offer.
    expect(segmentIntersection(p(0, 0), p(10, 0), p(4, 0), p(14, 0))).toBeNull();
  });
});

describe('area and length', () => {
  it('measures a rectangle by the shoelace, whichever way it is wound', () => {
    const anticlockwise = [p(0, 0), p(50, 0), p(50, 20), p(0, 20)];
    expect(shoelace(anticlockwise)).toBeCloseTo(1000, 9);
    expect(shoelace([...anticlockwise].reverse())).toBeCloseTo(-1000, 9);
    expect(polygonArea(anticlockwise)).toBeCloseTo(1000, 9);
    expect(polygonArea([...anticlockwise].reverse())).toBeCloseTo(1000, 9);
  });

  it('measures a 3-4-5 triangle', () => {
    const triangle = [p(0, 0), p(60, 0), p(0, 45)];
    expect(polygonArea(triangle)).toBeCloseTo(1350, 9);
    expect(perimeter(triangle)).toBeCloseTo(180, 9);
  });

  it('measures an L shape, where a bounding box would be wrong', () => {
    const l = [p(0, 0), p(20, 0), p(20, 10), p(10, 10), p(10, 20), p(0, 20)];
    expect(polygonArea(l)).toBeCloseTo(300, 9);
  });

  it('has no area with fewer than three points', () => {
    expect(polygonArea([])).toBe(0);
    expect(polygonArea([p(0, 0)])).toBe(0);
    expect(polygonArea([p(0, 0), p(10, 0)])).toBe(0);
  });

  it('adds up a polyline, and does not close one', () => {
    expect(pathLength([p(0, 0), p(3, 4), p(3, 14)])).toBeCloseTo(15, 9);
    expect(pathLength([p(0, 0)])).toBe(0);
    // `perimeter` closes a polygon; `pathLength` does not.
    expect(perimeter([p(0, 0), p(3, 0), p(3, 4)])).toBeCloseTo(12, 9);
    expect(pathLength([p(0, 0), p(3, 0), p(3, 4)])).toBeCloseTo(7, 9);
  });
});

describe('the helpers the tools and the provider use', () => {
  it('finds a midpoint, a bounding box and the corners of a rect', () => {
    expect(midpoint(p(0, 0), p(10, 20))).toEqual(p(5, 10));
    expect(boundsOf([p(1, 2), p(5, 0)])).toEqual({ x0: 1, y0: 0, x1: 5, y1: 2 });
    expect(boundsOf([p(1, 1)], 2)).toEqual({ x0: -1, y0: -1, x1: 3, y1: 3 });
    expect(boundsOf([])).toBeNull();
    expect(cornersOf({ x0: 0, y0: 0, x1: 2, y1: 1 })).toEqual([p(0, 0), p(2, 0), p(2, 1), p(0, 1)]);
  });

  it('knows whether a point is in a rect and whether two rects meet', () => {
    const r = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(rectContains(r, p(5, 5))).toBe(true);
    expect(rectContains(r, p(10, 10))).toBe(true);
    expect(rectContains(r, p(11, 5))).toBe(false);
    expect(rectsOverlap(r, { x0: 10, y0: 10, x1: 20, y1: 20 })).toBe(true);
    expect(rectsOverlap(r, { x0: 11, y0: 0, x1: 20, y1: 10 })).toBe(false);
    expect(windowAround(p(5, 5), 2)).toEqual({ x0: 3, y0: 3, x1: 7, y1: 7 });
  });

  it('moves and scales geometry without dividing by zero', () => {
    expect(offsetRect({ x0: 0, y0: 0, x1: 1, y1: 1 }, 2, 3)).toEqual({
      x0: 2,
      y0: 3,
      x1: 3,
      y1: 4,
    });
    expect(offsetPoints([p(0, 0), p(1, 1)], 5, -5)).toEqual([p(5, -5), p(6, -4)]);
    const from = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(scalePoints([p(0, 0), p(10, 10)], from, { x0: 0, y0: 0, x1: 20, y1: 20 })).toEqual([
      p(0, 0),
      p(20, 20),
    ]);
    // A source rect with no height would divide by zero: that axis keeps a factor of 1, so the
    // point moves with the new rect's origin rather than becoming NaN.
    const flat = { x0: 0, y0: 5, x1: 10, y1: 5 };
    expect(scalePoints([p(5, 5)], flat, { x0: 0, y0: 0, x1: 20, y1: 4 })).toEqual([p(10, 0)]);
  });

  it('compares points with a tolerance', () => {
    expect(samePoint(p(0, 0), p(0.0000001, 0))).toBe(true);
    expect(samePoint(p(0, 0), p(1, 0))).toBe(false);
    expect(samePoint(p(0, 0), p(1, 0), 2)).toBe(true);
  });

  it('constrains a drag to the nearest 45°', () => {
    expect(constrainAngle(p(0, 0), p(10, 1))).toEqual(p(10.04987562112089, 0));
    const diagonal = constrainAngle(p(0, 0), p(10, 9));
    expect(diagonal.x).toBeCloseTo(diagonal.y, 9);
    // A drag that has not moved is left where it is.
    expect(constrainAngle(p(3, 3), p(3, 3))).toEqual(p(3, 3));
  });
});
