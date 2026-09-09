/**
 * Shape geometry and appearance (M31): rectangles, ellipses, lines with their endings, polygons,
 * polylines and cloudy borders.
 *
 * Everything the overlay paints and everything the writer bakes comes from **one** list of
 * drawings per annotation, `shapeDrawings()`, in the shared `PathOp` vocabulary — so a cloud on
 * screen and a cloud in the file are the same arcs, and an arrow head is at the same angle in
 * both. The generators at the bottom are that list run through the `ContentBuilder`.
 *
 * Geometry is PDF page space, points, origin bottom-left. A rectangle's stroke sits *inside*
 * `/Rect` (inset by half its width, as PDF 12.5.6.8 has it); a polygon's vertices are on the
 * path; a line ends where its `/L` says.
 */

import type { PdfPoint, PdfRect } from '@shared/pdf';
import { ContentBuilder, type PathOp } from './content';
import type { AppearanceGenerator, AppearanceInput, AppearanceStream } from './types';

/** PDF's own default when `/BS /W` is absent. */
const DEFAULT_BORDER = 1;
/** Black, for an annotation that names no colour — the same fallback every viewer makes. */
const DEFAULT_COLOR = 0x000000;

/** The line-ending styles PDF 12.5.6.7 names, plus the ones Foxit offers. */
export const LINE_ENDINGS = [
  'None',
  'OpenArrow',
  'ClosedArrow',
  'Circle',
  'Square',
  'Diamond',
  'Slash',
  'Butt',
  'ROpenArrow',
  'RClosedArrow',
] as const;

export type LineEnding = (typeof LINE_ENDINGS)[number];

/** The wording the panel and the palette use for each ending — never the bare PDF name. */
export const LINE_ENDING_LABELS: Readonly<Record<LineEnding, string>> = {
  None: 'None',
  OpenArrow: 'Open arrow',
  ClosedArrow: 'Closed arrow',
  Circle: 'Circle',
  Square: 'Square',
  Diamond: 'Diamond',
  Slash: 'Slash',
  Butt: 'Butt',
  ROpenArrow: 'Reversed open arrow',
  RClosedArrow: 'Reversed closed arrow',
};

export function isLineEnding(value: unknown): value is LineEnding {
  return typeof value === 'string' && (LINE_ENDINGS as ReadonlyArray<string>).includes(value);
}

/** `[start, end]` endings from an annotation's `extra`, defaulting to none. */
export function lineEndingsOf(extra: Readonly<Record<string, unknown>>): [LineEnding, LineEnding] {
  const raw = extra['lineEndings'];
  if (Array.isArray(raw) && raw.length === 2) {
    const [a, b] = raw;
    return [isLineEnding(a) ? a : 'None', isLineEnding(b) ? b : 'None'];
  }
  return ['None', 'None'];
}

/** Cloud intensity from `extra.cloudy`: 0 (not cloudy), 1 or 2. */
export function cloudIntensityOf(extra: Readonly<Record<string, unknown>>): number {
  const raw = extra['cloudy'];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(2, raw);
}

/** A dash pattern from `extra.dashArray`, dropping anything that is not a positive number. */
export function dashOf(extra: Readonly<Record<string, unknown>>): number[] {
  const raw = extra['dashArray'];
  return Array.isArray(raw)
    ? raw.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
    : [];
}

// ---- primitive geometry -----------------------------------------------------------------------

/** Kappa: the circle-to-Bézier constant, `4/3 * (sqrt(2) - 1)`. */
const KAPPA = 0.5522847498307936;

/**
 * A circular arc from `from` to `to` (radians, anticlockwise positive) as Bézier segments of at
 * most a quarter turn each. Emits a move to the arc's start unless `continuing`.
 */
export function arcOps(
  center: PdfPoint,
  radius: number,
  from: number,
  to: number,
  continuing = false,
): PathOp[] {
  const ops: PathOp[] = [];
  const total = to - from;
  const segments = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2) - 1e-9));
  const step = total / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  let angle = from;
  const start = { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
  if (!continuing) ops.push({ op: 'M', ...start });
  for (let i = 0; i < segments; i++) {
    const next = angle + step;
    const p0 = { x: Math.cos(angle), y: Math.sin(angle) };
    const p3 = { x: Math.cos(next), y: Math.sin(next) };
    ops.push({
      op: 'C',
      x1: center.x + radius * (p0.x - k * p0.y),
      y1: center.y + radius * (p0.y + k * p0.x),
      x2: center.x + radius * (p3.x + k * p3.y),
      y2: center.y + radius * (p3.y - k * p3.x),
      x: center.x + radius * p3.x,
      y: center.y + radius * p3.y,
    });
    angle = next;
  }
  return ops;
}

/** The four corners of a rect, anticlockwise from the bottom-left. */
export function rectPoints(r: PdfRect): PdfPoint[] {
  return [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 },
  ];
}

/** `count` points around the ellipse inscribed in `r`, anticlockwise from the right. */
export function ellipsePoints(r: PdfRect, count: number): PdfPoint[] {
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;
  const rx = (r.x1 - r.x0) / 2;
  const ry = (r.y1 - r.y0) / 2;
  const out: PdfPoint[] = [];
  const n = Math.max(4, Math.floor(count));
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return out;
}

/** An ellipse inscribed in `r`, as four Béziers. */
export function ellipseOps(r: PdfRect): PathOp[] {
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;
  const rx = (r.x1 - r.x0) / 2;
  const ry = (r.y1 - r.y0) / 2;
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  return [
    { op: 'M', x: cx - rx, y: cy },
    { op: 'C', x1: cx - rx, y1: cy + oy, x2: cx - ox, y2: cy + ry, x: cx, y: cy + ry },
    { op: 'C', x1: cx + ox, y1: cy + ry, x2: cx + rx, y2: cy + oy, x: cx + rx, y: cy },
    { op: 'C', x1: cx + rx, y1: cy - oy, x2: cx + ox, y2: cy - ry, x: cx, y: cy - ry },
    { op: 'C', x1: cx - ox, y1: cy - ry, x2: cx - rx, y2: cy - oy, x: cx - rx, y: cy },
    { op: 'Z' },
  ];
}

/** A closed polygon through `points`. */
export function polygonOps(points: ReadonlyArray<PdfPoint>, close = true): PathOp[] {
  const ops: PathOp[] = points.map((p, i) => ({ op: i === 0 ? 'M' : 'L', x: p.x, y: p.y }));
  if (close && points.length > 1) ops.push({ op: 'Z' });
  return ops;
}

/** Signed area of a polygon: positive when the points run anticlockwise. */
export function signedArea(points: ReadonlyArray<PdfPoint>): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a && b) sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * The radius of one cloud bump, from the `/BE /I` intensity. Acrobat's two settings are about
 * 6 and 10 points; anything between is interpolated so a stored 1.5 means what it says.
 */
export function cloudRadius(intensity: number): number {
  const i = Math.max(0.25, Math.min(2, intensity));
  return 2 + 4 * i;
}

/** How far a bump sticks out beyond the edge it sits on — what a rect must be padded by. */
export function cloudOverhang(intensity: number): number {
  return cloudRadius(intensity) * (1 - Math.cos(CLOUD_SWEEP / 2 - Math.PI / 2)) + 0.5;
}

/** Each bump is a little more than a semicircle, so neighbours overlap the way Acrobat's do. */
const CLOUD_SWEEP = (200 * Math.PI) / 180;

/**
 * A cloudy border around a polygon: arcs of radius `cloudRadius(intensity)` along every edge,
 * bulging outward. Outward is decided from the polygon's winding, so a rect drawn either way
 * round still puffs out rather than in.
 *
 * The chord of each bump is fixed by the radius and the sweep, and every edge takes a whole
 * number of bumps, stretched a little so they meet at the corners — a corner with half a bump
 * on it looks torn.
 */
export function cloudOps(points: ReadonlyArray<PdfPoint>, intensity: number): PathOp[] {
  if (points.length < 2) return [];
  const radius = cloudRadius(intensity);
  const chord = 2 * radius * Math.sin(CLOUD_SWEEP / 2);
  const outwardRight = signedArea(points) > 0 ? 1 : -1;
  const ops: PathOp[] = [];
  let first = true;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) continue;
    const bumps = Math.max(1, Math.round(length / chord));
    const ux = dx / length;
    const uy = dy / length;
    // The outward normal: to the right of travel for an anticlockwise polygon.
    const nx = uy * outwardRight;
    const ny = -ux * outwardRight;
    const seg = length / bumps;
    const r = seg / (2 * Math.sin(CLOUD_SWEEP / 2));
    // The arc's centre sits on the outward side of the chord, because the sweep exceeds 180°.
    const drop = r * Math.cos(CLOUD_SWEEP / 2);
    for (let k = 0; k < bumps; k++) {
      const sx = a.x + ux * seg * k;
      const sy = a.y + uy * seg * k;
      const mx = sx + ux * (seg / 2);
      const my = sy + uy * (seg / 2);
      const center = { x: mx + nx * drop, y: my + ny * drop };
      const startAngle = Math.atan2(sy - center.y, sx - center.x);
      // Travel from the start point to the end point going *outward*, which is the long way
      // round when the centre is on the outward side: the sweep is signed by the winding.
      const sweep = -CLOUD_SWEEP * outwardRight;
      ops.push(...arcOps(center, r, startAngle, startAngle + sweep, !first));
      first = false;
    }
  }
  if (ops.length > 0) ops.push({ op: 'Z' });
  return ops;
}

// ---- line endings -----------------------------------------------------------------------------

/** What one ending draws, and how much of the line it covers. */
export interface EndingDrawing {
  readonly ops: ReadonlyArray<PathOp>;
  /** Filled with the interior colour (a closed head, a circle, a square, a diamond). */
  readonly closed: boolean;
  /** How far the line itself should stop short of the tip, so it does not show through a head. */
  readonly trim: number;
}

/** The size of an ending for a stroke width: PDF viewers scale heads with the line. */
export function endingSize(width: number): number {
  return Math.max(6, 6 * Math.max(width, 0.5));
}

/**
 * The drawing of one line ending at `tip`, for a line arriving from `from`. `kind` is the PDF
 * name; the reversed arrows point back along the line, as the spec draws them.
 */
export function lineEndingDrawing(
  kind: LineEnding,
  tip: PdfPoint,
  from: PdfPoint,
  width: number,
): EndingDrawing | null {
  if (kind === 'None') return null;
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return null;
  // Unit vector along the line towards the tip, and its normal.
  const ux = dx / length;
  const uy = dy / length;
  const nx = -uy;
  const ny = ux;
  const size = endingSize(width);
  const at = (along: number, across: number): PdfPoint => ({
    x: tip.x + ux * along + nx * across,
    y: tip.y + uy * along + ny * across,
  });
  const spread = Math.PI / 6;
  const wing = size * Math.tan(spread);
  switch (kind) {
    case 'OpenArrow':
      return {
        ops: [{ op: 'M', ...at(-size, wing) }, { op: 'L', ...tip }, { op: 'L', ...at(-size, -wing) }],
        closed: false,
        trim: 0,
      };
    case 'ClosedArrow':
      return {
        ops: [
          { op: 'M', ...tip },
          { op: 'L', ...at(-size, wing) },
          { op: 'L', ...at(-size, -wing) },
          { op: 'Z' },
        ],
        closed: true,
        trim: size * 0.75,
      };
    case 'ROpenArrow':
      return {
        ops: [
          { op: 'M', ...at(0, wing) },
          { op: 'L', ...at(-size, 0) },
          { op: 'L', ...at(0, -wing) },
        ],
        closed: false,
        trim: 0,
      };
    case 'RClosedArrow':
      return {
        ops: [
          { op: 'M', ...at(-size, 0) },
          { op: 'L', ...at(0, wing) },
          { op: 'L', ...at(0, -wing) },
          { op: 'Z' },
        ],
        closed: true,
        trim: 0,
      };
    case 'Circle': {
      const r = size / 2;
      const center = at(-r, 0);
      return { ops: arcOps(center, r, 0, Math.PI * 2).concat({ op: 'Z' }), closed: true, trim: r };
    }
    case 'Square': {
      const h = size / 2;
      return {
        ops: [
          { op: 'M', ...at(0, h) },
          { op: 'L', ...at(-size, h) },
          { op: 'L', ...at(-size, -h) },
          { op: 'L', ...at(0, -h) },
          { op: 'Z' },
        ],
        closed: true,
        trim: h,
      };
    }
    case 'Diamond': {
      const h = size / 2;
      return {
        ops: [
          { op: 'M', ...tip },
          { op: 'L', ...at(-h, h) },
          { op: 'L', ...at(-size, 0) },
          { op: 'L', ...at(-h, -h) },
          { op: 'Z' },
        ],
        closed: true,
        trim: h,
      };
    }
    case 'Slash': {
      // A stroke at 30° to the line, crossing it at the tip.
      const along = size * 0.5;
      const across = size * 0.87;
      return {
        ops: [{ op: 'M', ...at(-along, across) }, { op: 'L', ...at(along, -across) }],
        closed: false,
        trim: 0,
      };
    }
    case 'Butt': {
      const h = size / 2;
      return {
        ops: [{ op: 'M', ...at(0, h) }, { op: 'L', ...at(0, -h) }],
        closed: false,
        trim: 0,
      };
    }
    case 'None':
      return null;
  }
}

// ---- what a shape draws ------------------------------------------------------------------------

/** One painted path: its ops, colours and stroke. Colours are `0xRRGGBB` or null for none. */
export interface ShapeDrawing {
  readonly ops: ReadonlyArray<PathOp>;
  readonly stroke: number | null;
  readonly fill: number | null;
  readonly width: number;
  readonly dash?: ReadonlyArray<number>;
}

function strokeWidth(input: AppearanceInput): number {
  const w = input.borderWidth ?? DEFAULT_BORDER;
  return w > 0 ? w : 0;
}

function strokeColor(input: AppearanceInput): number {
  return input.color ?? DEFAULT_COLOR;
}

function withDash(
  drawing: Omit<ShapeDrawing, 'dash'>,
  dash: ReadonlyArray<number>,
): ShapeDrawing {
  return dash.length > 0 ? { ...drawing, dash } : drawing;
}

/**
 * The drawings of a shape annotation, in painting order. Empty when there is nothing to paint —
 * a rect too small for its own border, a polygon with two points, a border of width 0 with no
 * fill.
 */
export function shapeDrawings(input: AppearanceInput): ShapeDrawing[] {
  switch (input.subtype) {
    case 'Square':
    case 'Circle':
      return boxDrawings(input);
    case 'Line':
      return lineDrawings(input);
    case 'Polygon':
      return polygonDrawings(input);
    case 'PolyLine':
      return polylineDrawings(input);
    default:
      return [];
  }
}

function boxDrawings(input: AppearanceInput): ShapeDrawing[] {
  const width = strokeWidth(input);
  const inset = width / 2;
  const box: PdfRect = {
    x0: input.rect.x0 + inset,
    y0: input.rect.y0 + inset,
    x1: input.rect.x1 - inset,
    y1: input.rect.y1 - inset,
  };
  if (box.x1 <= box.x0 || box.y1 <= box.y0) return [];
  const stroke = width > 0 ? strokeColor(input) : null;
  const fill = input.interiorColor;
  if (stroke === null && fill === null) return [];
  const cloudy = cloudIntensityOf(input.extra);
  let ops: PathOp[];
  if (cloudy > 0) {
    // A cloud sits inside the rect too: the bumps overhang the polygon they sit on.
    const overhang = cloudOverhang(cloudy);
    const inner: PdfRect = {
      x0: box.x0 + overhang,
      y0: box.y0 + overhang,
      x1: box.x1 - overhang,
      y1: box.y1 - overhang,
    };
    if (inner.x1 <= inner.x0 || inner.y1 <= inner.y0) return [];
    const perimeter =
      input.subtype === 'Circle'
        ? Math.PI * ((inner.x1 - inner.x0) / 2 + (inner.y1 - inner.y0) / 2)
        : 2 * (inner.x1 - inner.x0 + inner.y1 - inner.y0);
    const points =
      input.subtype === 'Circle'
        ? ellipsePoints(inner, Math.max(8, Math.round(perimeter / (cloudRadius(cloudy) * 1.9))))
        : rectPoints(inner);
    ops = cloudOps(points, cloudy);
  } else {
    ops = input.subtype === 'Circle' ? ellipseOps(box) : polygonOps(rectPoints(box));
  }
  return [withDash({ ops, stroke, fill, width }, dashOf(input.extra))];
}

function diagonal(rect: PdfRect): PdfPoint[] {
  return [
    { x: rect.x0, y: rect.y0 },
    { x: rect.x1, y: rect.y1 },
  ];
}

function lineDrawings(input: AppearanceInput): ShapeDrawing[] {
  const points = input.vertices.length >= 2 ? input.vertices.slice(0, 2) : diagonal(input.rect);
  const [from, to] = points;
  if (!from || !to) return [];
  // A zero-width line is invisible; PDF's own default is 1, so draw that rather than nothing.
  const width = strokeWidth(input) > 0 ? strokeWidth(input) : DEFAULT_BORDER;
  const stroke = strokeColor(input);
  const [startKind, endKind] = lineEndingsOf(input.extra);
  const start = lineEndingDrawing(startKind, from, to, width);
  const end = lineEndingDrawing(endKind, to, from, width);
  const dash = dashOf(input.extra);
  const out: ShapeDrawing[] = [];
  // The line stops short of a closed head so the stroke does not poke through the fill.
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const ux = length > 0 ? (to.x - from.x) / length : 0;
  const uy = length > 0 ? (to.y - from.y) / length : 0;
  const a = { x: from.x + ux * (start?.trim ?? 0), y: from.y + uy * (start?.trim ?? 0) };
  const b = { x: to.x - ux * (end?.trim ?? 0), y: to.y - uy * (end?.trim ?? 0) };
  out.push(
    withDash(
      { ops: [{ op: 'M', ...a }, { op: 'L', ...b }], stroke, fill: null, width },
      dash,
    ),
  );
  for (const head of [start, end]) {
    if (!head) continue;
    out.push({
      ops: head.ops,
      stroke,
      fill: head.closed ? (input.interiorColor ?? null) : null,
      width,
    });
  }
  return out;
}

function polygonDrawings(input: AppearanceInput): ShapeDrawing[] {
  if (input.vertices.length < 3) return [];
  const width = strokeWidth(input);
  const stroke = width > 0 ? strokeColor(input) : null;
  const fill = input.interiorColor;
  if (stroke === null && fill === null) return [];
  const cloudy = cloudIntensityOf(input.extra);
  const ops = cloudy > 0 ? cloudOps(input.vertices, cloudy) : polygonOps(input.vertices);
  return [withDash({ ops, stroke, fill, width }, dashOf(input.extra))];
}

function polylineDrawings(input: AppearanceInput): ShapeDrawing[] {
  if (input.vertices.length < 2) return [];
  const width = strokeWidth(input) > 0 ? strokeWidth(input) : DEFAULT_BORDER;
  const stroke = strokeColor(input);
  const [startKind, endKind] = lineEndingsOf(input.extra);
  const first = input.vertices[0];
  const second = input.vertices[1];
  const last = input.vertices[input.vertices.length - 1];
  const beforeLast = input.vertices[input.vertices.length - 2];
  const out: ShapeDrawing[] = [
    withDash(
      { ops: polygonOps(input.vertices, false), stroke, fill: null, width },
      dashOf(input.extra),
    ),
  ];
  const heads = [
    first && second ? lineEndingDrawing(startKind, first, second, width) : null,
    last && beforeLast ? lineEndingDrawing(endKind, last, beforeLast, width) : null,
  ];
  for (const head of heads) {
    if (!head) continue;
    out.push({
      ops: head.ops,
      stroke,
      fill: head.closed ? (input.interiorColor ?? null) : null,
      width,
    });
  }
  return out;
}

// ---- bounds ------------------------------------------------------------------------------------

/** The bounding box of a list of ops, or null when they place nothing. */
export function opsBounds(ops: ReadonlyArray<PathOp>): PdfRect | null {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  const take = (x: number, y: number): void => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const op of ops) {
    if (op.op === 'Z') continue;
    take(op.x, op.y);
    if (op.op === 'C') {
      take(op.x1, op.y1);
      take(op.x2, op.y2);
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/** The bounding box of some points, grown by `pad` on every side. */
export function pointsBounds(points: ReadonlyArray<PdfPoint>, pad = 0): PdfRect | null {
  if (points.length === 0) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    x0: Math.min(...xs) - pad,
    y0: Math.min(...ys) - pad,
    x1: Math.max(...xs) + pad,
    y1: Math.max(...ys) + pad,
  };
}

/**
 * The `/Rect` a line, polyline or polygon needs to contain everything it draws: its points, its
 * stroke, and any heads on its ends. Used by the tools when they create or reshape one.
 */
export function shapeRectFor(
  subtype: 'Line' | 'Polygon' | 'PolyLine',
  vertices: ReadonlyArray<PdfPoint>,
  width: number,
  extra: Readonly<Record<string, unknown>>,
): PdfRect {
  const w = width > 0 ? width : DEFAULT_BORDER;
  const [startKind, endKind] = subtype === 'Polygon' ? ['None', 'None'] : lineEndingsOf(extra);
  const hasHeads = startKind !== 'None' || endKind !== 'None';
  const cloudy = subtype === 'Polygon' ? cloudIntensityOf(extra) : 0;
  const pad = w / 2 + 1 + (hasHeads ? endingSize(w) : 0) + (cloudy > 0 ? cloudOverhang(cloudy) : 0);
  return pointsBounds(vertices, pad) ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
}

// ---- generators --------------------------------------------------------------------------------

/** Applies `/CA` as a graphics state when it is anything but fully opaque. */
function applyOpacity(builder: ContentBuilder, input: AppearanceInput): void {
  const alpha = input.opacity;
  if (alpha === null || alpha >= 1) return;
  builder.graphicsState({ fillAlpha: alpha, strokeAlpha: alpha });
}

/** The stream's BBox: the rect and everything drawn, grown by half the stroke plus a little. */
function bboxFor(input: AppearanceInput, drawings: ReadonlyArray<ShapeDrawing>): PdfRect {
  let box = input.rect;
  let pad = 0.5;
  for (const d of drawings) {
    pad = Math.max(pad, d.width / 2 + 0.5);
    const b = opsBounds(d.ops);
    if (!b) continue;
    box = {
      x0: Math.min(box.x0, b.x0),
      y0: Math.min(box.y0, b.y0),
      x1: Math.max(box.x1, b.x1),
      y1: Math.max(box.y1, b.y1),
    };
  }
  return { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad };
}

/** Paints a list of drawings. Shared by every shape generator. */
export function paintDrawings(
  input: AppearanceInput,
  drawings: ReadonlyArray<ShapeDrawing>,
): AppearanceStream | null {
  if (drawings.length === 0) return null;
  const b = new ContentBuilder();
  b.save();
  applyOpacity(b, input);
  for (const d of drawings) {
    const stroked = d.stroke !== null && d.width > 0;
    const filled = d.fill !== null;
    if (!stroked && !filled) continue;
    b.save();
    if (stroked && d.stroke !== null) {
      b.strokeColor(d.stroke).lineWidth(d.width).lineCap(1).lineJoin(1);
      if (d.dash && d.dash.length > 0) b.dash(d.dash);
    }
    if (filled && d.fill !== null) b.fillColor(d.fill);
    b.path(d.ops);
    if (stroked && filled) b.fillAndStroke();
    else if (filled) b.fill();
    else b.stroke();
    b.restore();
  }
  b.restore();
  if (b.isEmpty) return null;
  return { bbox: bboxFor(input, drawings), content: b.build(), resources: b.resources };
}

const shapeGenerator: AppearanceGenerator = (input) => paintDrawings(input, shapeDrawings(input));

/** `/Square`: the rect inset by half the border, cloudy when `/BE` says so. */
export const squareAppearance: AppearanceGenerator = shapeGenerator;
/** `/Circle`: an ellipse inscribed in the inset rect, cloudy when `/BE` says so. */
export const circleAppearance: AppearanceGenerator = shapeGenerator;
/** `/Line`: `/L`, with the `/LE` endings drawn at its own angle. */
export const lineAppearance: AppearanceGenerator = shapeGenerator;
/** `/Polygon`: closed, filled with `/IC`, cloudy when `/BE` says so. */
export const polygonAppearance: AppearanceGenerator = shapeGenerator;
/** `/PolyLine`: open, never filled, with `/LE` endings. */
export const polylineAppearance: AppearanceGenerator = shapeGenerator;
