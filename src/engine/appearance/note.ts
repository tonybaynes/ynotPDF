/**
 * Sticky-note icons (M30).
 *
 * PDFium *does* synthesise an appearance for a `Text` annotation, and it is the same yellow
 * square whatever `/Name` says — it also rewrites `/Rect` to 20 × 20 while it is at it. So the
 * icons are drawn here instead, and the stream is pushed straight into the live document through
 * `PdfEngine.setAnnotationAppearance` (ADR 0013) as well as written on save. Because every icon
 * is pure vector, the stream needs no font resource, which is what makes that possible at all.
 *
 * Each icon is defined once in a **unit square** — x and y in 0..1, y up — and scaled into the
 * annotation's rect, so the same definition serves the appearance stream and the SVG the
 * annotation layer draws while the note is being placed.
 */

import type { PdfRect } from '@shared/pdf';
import { ContentBuilder } from './content';
import { normaliseRect, type AppearanceGenerator } from './types';

/** One drawing step in the unit square. */
export type IconStep =
  | { readonly op: 'move'; readonly x: number; readonly y: number }
  | { readonly op: 'line'; readonly x: number; readonly y: number }
  | {
      readonly op: 'curve';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly op: 'close' }
  /** Ends the current subpath group: `fill` paints it, `stroke` outlines it. */
  | { readonly op: 'fill' }
  | { readonly op: 'stroke' };

/** A note icon: what it is called, what the reader sees, and how it is drawn. */
export interface NoteIcon {
  /** `/Name` as written to the file. */
  readonly name: string;
  /** Label in the picker. */
  readonly label: string;
  readonly steps: ReadonlyArray<IconStep>;
}

const m = (x: number, y: number): IconStep => ({ op: 'move', x, y });
const l = (x: number, y: number): IconStep => ({ op: 'line', x, y });
const c = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): IconStep => ({
  op: 'curve',
  x1,
  y1,
  x2,
  y2,
  x,
  y,
});
const close: IconStep = { op: 'close' };
const fill: IconStep = { op: 'fill' };
const stroke: IconStep = { op: 'stroke' };

/** A rounded speech bubble with a tail, the shape every "comment" icon is. */
function bubble(): IconStep[] {
  return [
    m(0.08, 0.42),
    c(0.08, 0.72, 0.28, 0.9, 0.5, 0.9),
    c(0.72, 0.9, 0.92, 0.72, 0.92, 0.42),
    c(0.92, 0.24, 0.72, 0.1, 0.5, 0.1),
    l(0.34, 0.1),
    l(0.18, 0.02),
    l(0.22, 0.12),
    c(0.13, 0.2, 0.08, 0.31, 0.08, 0.42),
    close,
  ];
}

function circlePath(cx: number, cy: number, r: number): IconStep[] {
  const k = r * 0.5522847498307936;
  return [
    m(cx - r, cy),
    c(cx - r, cy + k, cx - k, cy + r, cx, cy + r),
    c(cx + k, cy + r, cx + r, cy + k, cx + r, cy),
    c(cx + r, cy - k, cx + k, cy - r, cx, cy - r),
    c(cx - k, cy - r, cx - r, cy - k, cx - r, cy),
    close,
  ];
}

/** Horizontal rules, as a "lines of text" motif inside a page or a bubble. */
function rules(ys: ReadonlyArray<number>, x0: number, x1: number): IconStep[] {
  const out: IconStep[] = [];
  for (const y of ys) {
    out.push(m(x0, y), l(x1, y));
  }
  out.push(stroke);
  return out;
}

/** A dog-eared page outline. */
function page(): IconStep[] {
  return [
    m(0.2, 0.05),
    l(0.2, 0.95),
    l(0.62, 0.95),
    l(0.8, 0.77),
    l(0.8, 0.05),
    close,
    stroke,
    m(0.62, 0.95),
    l(0.62, 0.77),
    l(0.8, 0.77),
    stroke,
  ];
}

/**
 * The icon catalogue. The first seven `/Name` values are the ones PDF 12.5.6.4 lists; the rest
 * are Foxit's, written with the same names Foxit writes so a file round-trips between the two.
 */
export const NOTE_ICONS: ReadonlyArray<NoteIcon> = [
  {
    name: 'Comment',
    label: 'Comment',
    steps: [...bubble(), stroke, ...rules([0.5, 0.38], 0.24, 0.76)],
  },
  {
    name: 'Note',
    label: 'Note',
    steps: [...page(), ...rules([0.75, 0.62, 0.49, 0.36, 0.23], 0.3, 0.7)],
  },
  {
    name: 'Key',
    label: 'Key',
    steps: [
      ...circlePath(0.32, 0.68, 0.2),
      stroke,
      m(0.44, 0.55),
      l(0.86, 0.13),
      stroke,
      m(0.72, 0.27),
      l(0.84, 0.39),
      stroke,
      m(0.6, 0.39),
      l(0.72, 0.51),
      stroke,
    ],
  },
  {
    name: 'Help',
    label: 'Help',
    steps: [
      ...circlePath(0.5, 0.5, 0.44),
      stroke,
      m(0.35, 0.66),
      c(0.35, 0.82, 0.65, 0.82, 0.65, 0.64),
      c(0.65, 0.5, 0.5, 0.5, 0.5, 0.36),
      stroke,
      ...circlePath(0.5, 0.22, 0.05),
      fill,
    ],
  },
  {
    name: 'Paragraph',
    label: 'Paragraph',
    steps: [
      m(0.68, 0.92),
      l(0.38, 0.92),
      c(0.18, 0.92, 0.18, 0.5, 0.38, 0.5),
      l(0.52, 0.5),
      l(0.52, 0.08),
      stroke,
      m(0.68, 0.92),
      l(0.68, 0.08),
      stroke,
    ],
  },
  {
    name: 'NewParagraph',
    label: 'New paragraph',
    steps: [
      m(0.5, 0.95),
      l(0.16, 0.35),
      l(0.84, 0.35),
      close,
      stroke,
      m(0.24, 0.2),
      l(0.76, 0.2),
      stroke,
      m(0.24, 0.06),
      l(0.76, 0.06),
      stroke,
    ],
  },
  {
    name: 'Insert',
    label: 'Insert',
    steps: [m(0.5, 0.95), l(0.1, 0.1), l(0.9, 0.1), close, stroke],
  },
  {
    name: 'Check',
    label: 'Check',
    steps: [m(0.12, 0.52), l(0.4, 0.18), l(0.9, 0.82), stroke],
  },
  { name: 'Circle', label: 'Circle', steps: [...circlePath(0.5, 0.5, 0.44), stroke] },
  {
    name: 'Cross',
    label: 'Cross',
    steps: [m(0.12, 0.12), l(0.88, 0.88), stroke, m(0.88, 0.12), l(0.12, 0.88), stroke],
  },
  {
    name: 'Star',
    label: 'Star',
    steps: [
      m(0.5, 0.97),
      l(0.62, 0.61),
      l(0.99, 0.61),
      l(0.69, 0.39),
      l(0.81, 0.03),
      l(0.5, 0.25),
      l(0.19, 0.03),
      l(0.31, 0.39),
      l(0.01, 0.61),
      l(0.38, 0.61),
      close,
      stroke,
    ],
  },
  {
    name: 'RightArrow',
    label: 'Right arrow',
    steps: [m(0.06, 0.5), l(0.9, 0.5), stroke, m(0.6, 0.8), l(0.94, 0.5), l(0.6, 0.2), stroke],
  },
  {
    name: 'UpArrow',
    label: 'Up arrow',
    steps: [m(0.5, 0.06), l(0.5, 0.9), stroke, m(0.2, 0.6), l(0.5, 0.94), l(0.8, 0.6), stroke],
  },
];

/** The default icon a new note gets — the one Foxit and Acrobat both start from. */
export const DEFAULT_NOTE_ICON = 'Comment';

const BY_NAME = new Map(NOTE_ICONS.map((i) => [i.name.toLowerCase(), i]));

/** The Comment icon, which every unknown `/Name` falls back to. Never undefined. */
const FALLBACK_ICON: NoteIcon = { name: DEFAULT_NOTE_ICON, label: 'Comment', steps: bubble() };

/** The icon a `/Name` asks for, falling back to Comment for one we do not draw. */
export function noteIcon(name: string | null | undefined): NoteIcon {
  const found = name ? BY_NAME.get(name.toLowerCase()) : undefined;
  return found ?? BY_NAME.get(DEFAULT_NOTE_ICON.toLowerCase()) ?? FALLBACK_ICON;
}

/** The nominal size of a note in points. Acrobat, Foxit and PDFium all use 20 × 20. */
export const NOTE_SIZE = 20;

/** A 20 × 20 rect whose top-left corner is `at`, which is where a click puts a note. */
export function noteRectAt(at: { readonly x: number; readonly y: number }): PdfRect {
  return { x0: at.x, y0: at.y - NOTE_SIZE, x1: at.x + NOTE_SIZE, y1: at.y };
}

/**
 * Maps a unit-square step into a rect. Shared by the appearance stream (PDF space, y up) and by
 * the annotation layer's SVG (device space, y down) — the layer passes a flipped rect.
 */
export function iconPointsIn(
  step: IconStep,
  rect: PdfRect,
): ReadonlyArray<{ readonly x: number; readonly y: number }> {
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const at = (x: number, y: number): { x: number; y: number } => ({
    x: rect.x0 + x * w,
    y: rect.y0 + y * h,
  });
  switch (step.op) {
    case 'move':
    case 'line':
      return [at(step.x, step.y)];
    case 'curve':
      return [at(step.x1, step.y1), at(step.x2, step.y2), at(step.x, step.y)];
    default:
      return [];
  }
}

/**
 * `/Text` — the icon the reader picked, drawn into the annotation's rect.
 *
 * The icon is inset a little so a stroke of its own width is not clipped by the BBox, and the
 * stroke scales with the rect so a note stays legible if a file gives it an unusual size.
 */
export const noteAppearance: AppearanceGenerator = (input) => {
  const rect = normaliseRect(input.rect);
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  if (w <= 0 || h <= 0) return null;
  const icon = noteIcon(typeof input.extra['icon'] === 'string' ? input.extra['icon'] : null);
  const colour = input.color ?? 0xffd400;
  const lineWidth = Math.max(0.5, Math.min(w, h) / 14);
  const pad = lineWidth;
  const box: PdfRect = {
    x0: rect.x0 + pad,
    y0: rect.y0 + pad,
    x1: rect.x1 - pad,
    y1: rect.y1 - pad,
  };
  const b = new ContentBuilder();
  b.save();
  b.strokeColor(colour).fillColor(colour).lineWidth(lineWidth).lineCap(1).lineJoin(1);
  for (const step of icon.steps) {
    const points = iconPointsIn(step, box);
    switch (step.op) {
      case 'move': {
        const p = points[0];
        if (p) b.moveTo(p.x, p.y);
        break;
      }
      case 'line': {
        const p = points[0];
        if (p) b.lineTo(p.x, p.y);
        break;
      }
      case 'curve': {
        const [a, bb, cc] = points;
        if (a && bb && cc) b.curveTo(a.x, a.y, bb.x, bb.y, cc.x, cc.y);
        break;
      }
      case 'close':
        b.closePath();
        break;
      case 'fill':
        b.fill();
        break;
      case 'stroke':
        b.stroke();
        break;
    }
  }
  b.restore();
  if (b.isEmpty) return null;
  const grow = lineWidth / 2 + 0.5;
  return {
    bbox: { x0: rect.x0 - grow, y0: rect.y0 - grow, x1: rect.x1 + grow, y1: rect.y1 + grow },
    content: b.build(),
    resources: b.resources,
  };
};
