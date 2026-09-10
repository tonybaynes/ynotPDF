/**
 * Affine matrix arithmetic for content streams (M50, ADR 0018).
 *
 * A PDF matrix `[a b c d e f]` is the 3×2 form of
 *
 * ```
 * | a b 0 |
 * | c d 0 |
 * | e f 1 |
 * ```
 *
 * and a point is a **row** vector multiplied from the left: `[x y 1] · M`. So `A · B` means
 * "A first, then B", which is the opposite way round from the column convention most graphics
 * APIs use — get it backwards and every nested `cm` lands somewhere interesting.
 */

import { IDENTITY, type PdfMatrix, type PdfPoint, type PdfRect } from '@shared/pdf';

export { IDENTITY };

/** `a` then `b` — the matrix that applies `a` first. */
export function multiply(a: PdfMatrix, b: PdfMatrix): PdfMatrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

/** Determinant of the linear part. Zero means the matrix collapses the plane. */
export function determinant(m: PdfMatrix): number {
  return m[0] * m[3] - m[1] * m[2];
}

/** The inverse, or `null` when the matrix is singular. */
export function invert(m: PdfMatrix): PdfMatrix | null {
  const det = determinant(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}

/** Transforms a point. */
export function apply(m: PdfMatrix, p: PdfPoint): PdfPoint {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** The axis-aligned box that contains a transformed rectangle's four corners. */
export function applyToRect(m: PdfMatrix, r: PdfRect): PdfRect {
  const corners = [
    apply(m, { x: r.x0, y: r.y0 }),
    apply(m, { x: r.x1, y: r.y0 }),
    apply(m, { x: r.x1, y: r.y1 }),
    apply(m, { x: r.x0, y: r.y1 }),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Translation. */
export function translation(dx: number, dy: number): PdfMatrix {
  return [1, 0, 0, 1, dx, dy];
}

/** Scale about `origin` (the page origin when omitted). */
export function scaling(sx: number, sy: number, origin?: PdfPoint): PdfMatrix {
  if (!origin) return [sx, 0, 0, sy, 0, 0];
  return [sx, 0, 0, sy, origin.x - sx * origin.x, origin.y - sy * origin.y];
}

/** Rotation by `degrees` anticlockwise about `origin` (the page origin when omitted). */
export function rotation(degrees: number, origin?: PdfPoint): PdfMatrix {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const m: PdfMatrix = [cos, sin, -sin, cos, 0, 0];
  if (!origin) return m;
  return [
    cos,
    sin,
    -sin,
    cos,
    origin.x - (cos * origin.x - sin * origin.y),
    origin.y - (sin * origin.x + cos * origin.y),
  ];
}

/**
 * The same transform seen from inside a frame: the `M` with `M · frame = frame · outer`, which
 * in this row-vector convention is `frame · outer · frame⁻¹` (the familiar `C⁻¹ D C` of the
 * column convention, read the other way round).
 *
 * This is what turns "move this 10 pt down the page" into the `cm` to write *inside* the
 * `q … Q` that already sits under a rotation or a scale. Returns `outer` unchanged when the
 * frame is singular, which is the least-wrong answer for a degenerate matrix.
 */
export function conjugate(outer: PdfMatrix, frame: PdfMatrix): PdfMatrix {
  const inverse = invert(frame);
  if (!inverse) return outer;
  return multiply(multiply(frame, outer), inverse);
}

/** Whether two matrices agree to within `epsilon` in every component. */
export function matrixEquals(a: PdfMatrix, b: PdfMatrix, epsilon = 1e-9): boolean {
  return a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= epsilon);
}

/** Whether a matrix is the identity to within `epsilon`. */
export function isIdentity(m: PdfMatrix, epsilon = 1e-9): boolean {
  return matrixEquals(m, IDENTITY, epsilon);
}

/**
 * The scale factors and rotation a matrix carries, for the properties panel.
 *
 * `rotate` is degrees anticlockwise; `scaleX`/`scaleY` are the lengths of the transformed unit
 * vectors, so a flip shows as a negative one. A skewed matrix has no honest single rotation —
 * the value returned is the x axis's, which is what every editor shows.
 */
export function decompose(m: PdfMatrix): {
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotate: number;
  readonly skewed: boolean;
} {
  const scaleX = Math.hypot(m[0], m[1]);
  const scaleY = Math.hypot(m[2], m[3]);
  const rotate = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  // The two axes are perpendicular in an unskewed matrix, so their dot product is zero.
  const dot = m[0] * m[2] + m[1] * m[3];
  const skewed = scaleX > 1e-9 && scaleY > 1e-9 && Math.abs(dot / (scaleX * scaleY)) > 1e-6;
  return {
    scaleX,
    scaleY: determinant(m) < 0 ? -scaleY : scaleY,
    rotate,
    skewed,
  };
}
