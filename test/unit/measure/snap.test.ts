/**
 * M33's snapping: which of the points near the pointer a measurement should actually take.
 *
 * The acceptance line is "snap picks the nearest vertex within tolerance"; the rest of these
 * cover the other three kinds, the tie-break between them, and the tolerance itself.
 */

import { describe, expect, it } from 'vitest';
import type { PdfPoint } from '@shared/pdf';
import { anySnapKind, rectPath, segmentsNear, snapAt } from '@modules/M33-measuring-tools/snap';
import { SNAP_LABELS } from '@modules/M33-measuring-tools/settings';

const p = (x: number, y: number): PdfPoint => ({ x, y });

const ALL = { endpoints: true, midpoints: true, intersections: true, paths: true };
const NONE = { endpoints: false, midpoints: false, intersections: false, paths: false };

/** A 100 x 100 box and a diagonal across it, as two polylines. */
const BOX: PdfPoint[] = [p(0, 0), p(100, 0), p(100, 100), p(0, 100), p(0, 0)];
const DIAGONAL: PdfPoint[] = [p(0, 0), p(100, 100)];

describe('snapAt', () => {
  it('picks the nearest vertex within tolerance', () => {
    const found = snapAt(p(98, 3), [BOX], 6, { ...NONE, endpoints: true });
    expect(found?.kind).toBe('endpoints');
    expect(found?.point).toEqual(p(100, 0));
    expect(found?.label).toBe(SNAP_LABELS.endpoints);
  });

  it('finds nothing when the nearest vertex is further away than the tolerance', () => {
    expect(snapAt(p(90, 10), [BOX], 6, { ...NONE, endpoints: true })).toBeNull();
    expect(snapAt(p(98, 3), [BOX], 0, ALL)).toBeNull();
  });

  it('finds a midpoint', () => {
    const found = snapAt(p(52, 2), [BOX], 6, { ...NONE, midpoints: true });
    expect(found?.kind).toBe('midpoints');
    expect(found?.point).toEqual(p(50, 0));
  });

  it('finds where two segments cross', () => {
    const cross: PdfPoint[][] = [
      [p(0, 50), p(100, 50)],
      [p(50, 0), p(50, 100)],
    ];
    const found = snapAt(p(52, 48), cross, 6, { ...NONE, intersections: true });
    expect(found?.kind).toBe('intersections');
    expect(found?.point).toEqual(p(50, 50));
  });

  it('finds the nearest point anywhere along a path', () => {
    const found = snapAt(p(37, 3), [BOX], 6, { ...NONE, paths: true });
    expect(found?.kind).toBe('paths');
    expect(found?.point).toEqual(p(37, 0));
  });

  it('prefers a vertex to an intersection to a midpoint to a point on a path, at equal distance', () => {
    // The corner at (0,0) is a vertex of the box, an end of the diagonal, and on both paths.
    const found = snapAt(p(0, 0), [BOX, DIAGONAL], 6, ALL);
    expect(found?.kind).toBe('endpoints');
    expect(found?.point).toEqual(p(0, 0));
    // With endpoints off, the crossing at the same place wins over the path.
    const next = snapAt(p(0, 0), [BOX, DIAGONAL], 6, { ...ALL, endpoints: false });
    expect(next?.kind).toBe('intersections');
  });

  it('prefers a nearer candidate of a weaker kind to a further vertex', () => {
    // (60,0) is on the path and 0 away; the nearest vertex, (100,0), is 40 away.
    const found = snapAt(p(60, 0), [BOX], 6, ALL);
    expect(found?.kind).toBe('paths');
    expect(found?.point).toEqual(p(60, 0));
  });

  it('is null when nothing is switched on, and says so cheaply', () => {
    expect(snapAt(p(0, 0), [BOX], 6, NONE)).toBeNull();
    expect(anySnapKind(NONE)).toBe(false);
    expect(anySnapKind({ ...NONE, paths: true })).toBe(true);
  });

  it('is null when there is nothing on the page near the pointer', () => {
    expect(snapAt(p(500, 500), [BOX], 6, ALL)).toBeNull();
    expect(snapAt(p(0, 0), [], 6, ALL)).toBeNull();
    expect(snapAt(p(0, 0), [[p(1, 1)]], 6, ALL)).toBeNull();
  });
});

describe('the window', () => {
  it('only offers segments whose box comes near the pointer', () => {
    const near = segmentsNear([BOX], { x0: -5, y0: -5, x1: 5, y1: 5 });
    // The bottom edge and the left edge both reach the corner; the far two do not.
    expect(near).toHaveLength(2);
    const far = segmentsNear([BOX], { x0: 200, y0: 200, x1: 210, y1: 210 });
    expect(far).toHaveLength(0);
  });

  it('turns a rect into a closed path, first point repeated', () => {
    const path = rectPath({ x0: 0, y0: 0, x1: 10, y1: 5 });
    expect(path).toHaveLength(5);
    expect(path[0]).toEqual(path[4]);
  });
});

describe('performance guards', () => {
  it('still answers on a page with a great many segments', () => {
    const paths: PdfPoint[][] = [];
    for (let i = 0; i < 400; i++) paths.push([p(i, 0), p(i, 200)]);
    const started = Date.now();
    const found = snapAt(p(199.5, 100), paths, 4, ALL);
    expect(found).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
