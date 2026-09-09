/**
 * Model annotation → what the overlay draws and hit-tests (M30). Pure.
 *
 * The rule that decides whether the overlay draws an annotation at all is here, and it is the one
 * design decision in this module worth stating twice:
 *
 * > PDFium builds an appearance stream for Highlight, Underline, Squiggly, StrikeOut and Text as
 * > it loads a page, so those are already in the tile raster. FreeText and Caret get nothing from
 * > it. An annotation edited in this session has had its appearance dropped by the edit, whatever
 * > its subtype. **The overlay draws exactly the annotations the raster does not carry** — draw
 * > both and it appears twice; draw neither and it vanishes.
 *
 * Everything here is in PDF page space, so a zoom or a rotation is a repaint and not a re-layout.
 */

import {
  calloutOf,
  familyFor,
  intentOf,
  layoutFreeText,
  noteIcon,
  quads,
  rotateOf,
  styleOf,
  textBoxOf,
  type IconStep,
} from '@engine/appearance';
import type { ModelAnnotation } from '@core/model';
import type { PdfPoint, PdfRect } from '@shared/pdf';
import type { AnnotationShape, HandleSet, LayerAnnotation, ShapeStep } from '@view/AnnotationLayer';

/** The annotation families M30 owns. Shapes, ink and stamps are M31's. */
export function isOurs(a: ModelAnnotation): boolean {
  return (
    a.family === 'markup' || a.family === 'note' || a.family === 'freeText' || a.subtype === 'Caret'
  );
}

/** Subtypes PDFium draws for itself as a page loads, so the raster already has them. */
const RASTERISED = new Set(['Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Text']);

/**
 * Whether the overlay has to draw this annotation.
 *
 * `edited` is the set of annotations this session created or changed: an edit makes PDFium drop
 * the appearance stream it had, so the raster no longer carries it whatever its subtype. For
 * everything else the file's own `/AP` decides — which is what `extra.hasAP` reports.
 */
export function drawnByOverlay(
  a: ModelAnnotation,
  edited: ReadonlySet<string>,
  raster = true,
): boolean {
  if (!isOurs(a)) return false;
  if (a.flags.hidden || a.flags.noView) return false;
  // With the raster not drawing annotations at all (M32, ADR 0017) there is nothing to collide
  // with, so the overlay draws the lot — including the subtypes PDFium would have drawn.
  if (!raster) return true;
  // An edit drops the appearance stream, but PDFium rebuilds one for the subtypes it knows the
  // moment the page reloads — so those go back into the raster on their own, and a note gets
  // ours pushed in explicitly. Only the ones PDFium never draws are left for the overlay.
  if (RASTERISED.has(a.subtype)) return false;
  return edited.has(a.id) || a.extra['hasAP'] !== true;
}

/** How much of an annotation the reader may drag. */
export function handlesFor(a: ModelAnnotation): HandleSet {
  if (a.family === 'markup') return 'none';
  if (a.family === 'note') return 'move';
  if (a.subtype === 'Caret') return 'move';
  if (a.family === 'freeText') {
    return intentOf(a.extra) === 'FreeTextCallout' ? 'callout' : 'box';
  }
  return 'move';
}

/** The rectangles a pointer must be inside to hit the annotation. */
export function hitRects(a: ModelAnnotation): PdfRect[] {
  if (a.family === 'markup' && a.quadPoints.length >= 8) {
    const list = quads(a.quadPoints).map((q) => ({
      x0: Math.min(q.ul.x, q.ur.x, q.ll.x, q.lr.x),
      y0: Math.min(q.ul.y, q.ur.y, q.ll.y, q.lr.y),
      x1: Math.max(q.ul.x, q.ur.x, q.ll.x, q.lr.x),
      y1: Math.max(q.ul.y, q.ur.y, q.ll.y, q.lr.y),
    }));
    if (list.length > 0) return list;
  }
  return [a.rect];
}

/** A CSS font stack for a PDF family, so the overlay's text matches the appearance stream. */
export function cssFamily(family: string): string {
  const known = familyFor(family);
  if (known.standard !== null) {
    switch (known.standard) {
      case 'Times-Roman':
        return '"Liberation Serif", "Times New Roman", Times, serif';
      case 'Courier':
        return '"Liberation Mono", "Courier New", Courier, monospace';
      case 'Symbol':
      case 'ZapfDingbats':
        return 'serif';
      default:
        return '"Liberation Sans", Arial, Helvetica, sans-serif';
    }
  }
  const quoted = family.includes(' ') ? `"${family}"` : family;
  return `${quoted}, "Liberation Sans", Arial, sans-serif`;
}

/** The shapes the overlay paints for one annotation. Empty when the raster carries it. */
export function shapesFor(a: ModelAnnotation): AnnotationShape[] {
  switch (a.family) {
    case 'markup':
      return markupShapes(a);
    case 'note':
      return noteShapes(a);
    case 'freeText':
      return freeTextShapes(a);
    default:
      return a.subtype === 'Caret' ? caretShapes(a) : [];
  }
}

function markupShapes(a: Extract<ModelAnnotation, { family: 'markup' }>): AnnotationShape[] {
  const list = quads(a.quadPoints);
  const colour = a.color ?? 0x000000;
  if (list.length === 0) return [];
  if (a.subtype === 'Highlight') {
    return [
      {
        kind: 'path',
        steps: list.flatMap((q): ShapeStep[] => [
          { op: 'M', x: q.ul.x, y: q.ul.y },
          { op: 'L', x: q.ur.x, y: q.ur.y },
          { op: 'L', x: q.lr.x, y: q.lr.y },
          { op: 'L', x: q.ll.x, y: q.ll.y },
          { op: 'Z' },
        ]),
        stroke: null,
        fill: colour,
        width: 0,
        blend: 'multiply',
      },
    ];
  }
  const at = a.subtype === 'StrikeOut' ? 0.5 : 1 / 16;
  const steps: ShapeStep[] = [];
  let width = 1;
  for (const q of list) {
    const height = Math.hypot(q.ul.x - q.ll.x, q.ul.y - q.ll.y);
    width = Math.max(0.5, height / 14);
    const from = lerp(q.ll, q.ul, at);
    const to = lerp(q.lr, q.ur, at);
    if (a.subtype === 'Squiggly') {
      const amplitude = Math.max(1, height / 8);
      const upFrom = lerp(q.ll, q.ul, (amplitude * 2) / Math.max(height, 1e-6));
      const upTo = lerp(q.lr, q.ur, (amplitude * 2) / Math.max(height, 1e-6));
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      const step = length > 0 ? (amplitude * 1.5) / length : 1;
      steps.push({ op: 'M', x: from.x, y: from.y });
      let up = true;
      for (let t = step; t < 1; t += step) {
        const p = up ? lerp(upFrom, upTo, t) : lerp(from, to, t);
        steps.push({ op: 'L', x: p.x, y: p.y });
        up = !up;
      }
      width = Math.max(0.5, amplitude / 3);
      continue;
    }
    steps.push({ op: 'M', x: from.x, y: from.y }, { op: 'L', x: to.x, y: to.y });
  }
  return [{ kind: 'path', steps, stroke: colour, fill: null, width, round: true }];
}

function noteShapes(a: Extract<ModelAnnotation, { family: 'note' }>): AnnotationShape[] {
  const icon = noteIcon(a.icon);
  const colour = a.color ?? 0xffd400;
  const size = Math.min(a.rect.x1 - a.rect.x0, a.rect.y1 - a.rect.y0);
  const width = Math.max(0.5, size / 14);
  const box: PdfRect = {
    x0: a.rect.x0 + width,
    y0: a.rect.y0 + width,
    x1: a.rect.x1 - width,
    y1: a.rect.y1 - width,
  };
  const out: AnnotationShape[] = [];
  let steps: ShapeStep[] = [];
  const flush = (fill: boolean): void => {
    if (steps.length === 0) return;
    out.push({
      kind: 'path',
      steps,
      stroke: fill ? null : colour,
      fill: fill ? colour : null,
      width,
      round: true,
    });
    steps = [];
  };
  for (const step of icon.steps) {
    switch (step.op) {
      case 'move':
      case 'line':
        steps.push({ op: step.op === 'move' ? 'M' : 'L', ...inBox(step, box) });
        break;
      case 'curve': {
        const p1 = inBox({ x: step.x1, y: step.y1 }, box);
        const p2 = inBox({ x: step.x2, y: step.y2 }, box);
        const p = inBox({ x: step.x, y: step.y }, box);
        steps.push({ op: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y });
        break;
      }
      case 'close':
        steps.push({ op: 'Z' });
        break;
      case 'fill':
        flush(true);
        break;
      case 'stroke':
        flush(false);
        break;
    }
  }
  flush(false);
  return out;
}

function inBox(p: { readonly x: number; readonly y: number }, box: PdfRect): PdfPoint {
  return { x: box.x0 + p.x * (box.x1 - box.x0), y: box.y0 + p.y * (box.y1 - box.y0) };
}

function freeTextShapes(a: Extract<ModelAnnotation, { family: 'freeText' }>): AnnotationShape[] {
  const style = styleOf(a.extra);
  const intent = intentOf(a.extra);
  const box = textBoxOf(a.rect, a.extra);
  const width = a.borderWidth ?? 1;
  const out: AnnotationShape[] = [];

  if (intent === 'FreeTextCallout') {
    const points = calloutOf(a.extra);
    if (points.length >= 2) {
      const steps: ShapeStep[] = points.map((p, i) => ({
        op: i === 0 ? ('M' as const) : ('L' as const),
        x: p.x,
        y: p.y,
      }));
      out.push({
        kind: 'path',
        steps,
        stroke: a.color ?? 0x000000,
        fill: null,
        width: width > 0 ? width : 1,
      });
      const [tip, next] = points;
      if (tip && next) out.push(arrowHead(tip, next, a.color ?? 0x000000, width));
    }
  }

  const stroked = intent !== 'FreeTextTypewriter' && a.color !== null && width > 0;
  const filled = intent !== 'FreeTextTypewriter' && a.interiorColor !== null;
  if (stroked || filled) {
    const inset = width / 2;
    const frame: PdfRect = {
      x0: box.x0 + inset,
      y0: box.y0 + inset,
      x1: box.x1 - inset,
      y1: box.y1 - inset,
    };
    if (frame.x1 > frame.x0 && frame.y1 > frame.y0) {
      out.push({
        kind: 'path',
        steps: rectSteps(frame),
        stroke: stroked ? (a.color ?? 0x000000) : null,
        fill: filled ? a.interiorColor : null,
        width,
        ...(a.extra['borderStyle'] === 'dashed' ? { dash: [width * 3, width * 2] } : {}),
      });
    }
  }

  const text = a.contents ?? '';
  if (text !== '') {
    const rotate = rotateOf(a.extra);
    out.push({
      kind: 'text',
      lines: layoutFreeText(text, box, style, undefined, rotate).map((l) => ({
        text: l.text,
        x: l.x,
        y: l.y,
      })),
      size: style.size,
      color: style.color,
      family: cssFamily(style.family),
      bold: style.bold,
      italic: style.italic,
      ...(rotate === 0 ? {} : { rotate }),
    });
  }
  return out;
}

function caretShapes(a: ModelAnnotation): AnnotationShape[] {
  const { x0, y0, x1, y1 } = a.rect;
  if (x1 <= x0 || y1 <= y0) return [];
  const at = (fx: number, fy: number): { x: number; y: number } => ({
    x: x0 + fx * (x1 - x0),
    y: y0 + fy * (y1 - y0),
  });
  const points = [at(0, 0), at(0.5, 1), at(1, 0), at(0.72, 0), at(0.5, 0.42), at(0.28, 0)];
  return [
    {
      kind: 'path',
      steps: [
        ...points.map((p, i) => ({
          op: i === 0 ? ('M' as const) : ('L' as const),
          x: p.x,
          y: p.y,
        })),
        { op: 'Z' as const },
      ],
      stroke: null,
      fill: a.color ?? 0x000000,
      width: 0,
    },
  ];
}

function arrowHead(tip: PdfPoint, from: PdfPoint, colour: number, width: number): AnnotationShape {
  const dx = from.x - tip.x;
  const dy = from.y - tip.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const size = Math.max(4, (width > 0 ? width : 1) * 4);
  const spread = Math.PI / 7;
  const cos = Math.cos(spread);
  const sin = Math.sin(spread);
  return {
    kind: 'path',
    steps: [
      { op: 'M', x: tip.x + size * (ux * cos - uy * sin), y: tip.y + size * (ux * sin + uy * cos) },
      { op: 'L', x: tip.x, y: tip.y },
      {
        op: 'L',
        x: tip.x + size * (ux * cos + uy * sin),
        y: tip.y + size * (-ux * sin + uy * cos),
      },
    ],
    stroke: colour,
    fill: null,
    width: width > 0 ? width : 1,
  };
}

function rectSteps(r: PdfRect): ShapeStep[] {
  return [
    { op: 'M', x: r.x0, y: r.y0 },
    { op: 'L', x: r.x1, y: r.y0 },
    { op: 'L', x: r.x1, y: r.y1 },
    { op: 'L', x: r.x0, y: r.y1 },
    { op: 'Z' },
  ];
}

function lerp(a: PdfPoint, b: PdfPoint, t: number): PdfPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** One model annotation as the layer wants it. */
export function toLayerAnnotation(
  a: ModelAnnotation,
  page: number,
  options: {
    readonly edited: ReadonlySet<string>;
    readonly hidden?: boolean;
    readonly raster?: boolean;
  } = { edited: new Set() },
): LayerAnnotation {
  const draws = drawnByOverlay(a, options.edited, options.raster ?? true);
  const callout = a.family === 'freeText' ? calloutOf(a.extra) : [];
  return {
    id: a.id,
    page,
    rect: a.rect,
    shapes: draws ? shapesFor(a) : [],
    hit: hitRects(a),
    handles: handlesFor(a),
    ...(callout.length > 0 ? { callout } : {}),
    ...(options.hidden ? { hidden: true } : {}),
  };
}

/** Re-exported so callers do not have to reach into the engine for an icon's step type. */
export type { IconStep };
