/**
 * `AnnotationLayer` — the SVG overlay M00 reserved on every page, filled in by M30.
 *
 * It does two jobs and knows about neither tools nor commands:
 *
 * 1. **Draws what the raster cannot.** PDFium builds an appearance stream for Highlight,
 *    Underline, Squiggly, StrikeOut and Text as it loads a page, so those are already in the
 *    tiles. FreeText and Caret get nothing from it, and an annotation the reader has just edited
 *    has had its appearance dropped — those are drawn here, from shapes the caller hands over in
 *    **page space**, so a zoom or a rotation is a repaint and never a re-layout.
 * 2. **Draws and hit-tests the selection.** Handles, the marquee, and the geometry that says
 *    which handle is under the pointer. The controller above turns that into commands.
 *
 * It lives in `view/` rather than in M30's folder because M31's shapes and ink, M33's
 * measurements and M82's signatures all need exactly this, and three copies of a resize handle is
 * three sets of rounding bugs.
 *
 * Colours here are **PDF content colours**, not theme tokens: an annotation's colour is written
 * into the file and must not change when the reader changes theme. The chrome the layer adds —
 * handles, the selection outline, the marquee — is themed, and lives in the stylesheet.
 */

import type { PdfPoint, PdfRect } from '@shared/pdf';
import type { DocumentView } from './DocumentView';
import type { PageView } from './PageView';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One step of a path, in page space (points, origin bottom-left). */
export type ShapeStep =
  | { readonly op: 'M' | 'L'; readonly x: number; readonly y: number }
  | {
      readonly op: 'C';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly op: 'Z' };

/** A path the layer paints. Widths and coordinates are in points; the layer scales them. */
export interface ShapePath {
  readonly kind: 'path';
  readonly steps: ReadonlyArray<ShapeStep>;
  /** Stroke colour `0xRRGGBB`, or null for none. */
  readonly stroke: number | null;
  readonly fill: number | null;
  /** Stroke width in points. */
  readonly width: number;
  readonly dash?: ReadonlyArray<number>;
  /**
   * `multiply` for a highlight: fully opaque paint that darkens the paper and leaves the ink,
   * which is how a highlight stays readable without the transparency the app never uses.
   */
  readonly blend?: 'multiply';
  readonly round?: boolean;
}

/** A run of text the layer paints, positioned by its baseline in page space. */
export interface ShapeText {
  readonly kind: 'text';
  readonly lines: ReadonlyArray<{ readonly text: string; readonly x: number; readonly y: number }>;
  /** Font size in points. */
  readonly size: number;
  readonly color: number;
  /** CSS font family stack. */
  readonly family: string;
  readonly bold: boolean;
  readonly italic: boolean;
  /**
   * `/Rotate`: how far the glyphs are turned, anticlockwise in page space. The line origins are
   * already in their turned places; this is the orientation of the glyphs on each of them.
   *
   * The sign flips on the way to the screen — device y grows downwards — and the page's own
   * rotation does not enter into it, because that is a rigid map the transform has already
   * applied to the origin.
   */
  readonly rotate?: number;
}

/**
 * A picture the layer paints — a custom stamp's image while it is being placed or edited (M31).
 * `href` is a `data:` URL the caller built; the layer never fetches anything.
 */
export interface ShapeImage {
  readonly kind: 'image';
  readonly href: string;
  /** Where the picture's own box lands, in page space, before rotation. */
  readonly rect: PdfRect;
  /** Degrees anticlockwise about the rect's centre, in page space. */
  readonly rotate?: number;
}

export type AnnotationShape = ShapePath | ShapeText | ShapeImage;

/**
 * Which handles an annotation offers. `vertices` (M31) gives one handle per point of
 * `LayerAnnotation.vertices` — a polygon's corners — instead of the eight box handles.
 */
export type HandleSet = 'none' | 'move' | 'box' | 'callout' | 'vertices';

/** One annotation as the layer sees it. */
export interface LayerAnnotation {
  readonly id: string;
  readonly page: number;
  readonly rect: PdfRect;
  /** Shapes to paint, in order. Empty when the raster already carries the annotation. */
  readonly shapes: ReadonlyArray<AnnotationShape>;
  /**
   * The area the pointer must be inside to hit it. Quads for text markup (so the gaps between
   * lines are not part of it), otherwise the rect.
   */
  readonly hit: ReadonlyArray<PdfRect>;
  readonly handles: HandleSet;
  /** A callout's leader line, for its two extra handles. */
  readonly callout?: ReadonlyArray<PdfPoint>;
  /** A polygon's or polyline's points, for `handles: 'vertices'` (M31). */
  readonly vertices?: ReadonlyArray<PdfPoint>;
  /**
   * Handles a provider names itself, beside whatever `handles` gives — a measurement's caption,
   * which is neither a corner of the box nor one of the measured points (M33).
   *
   * The id is the provider's own: it reaches `AnnotationProvider.handlePatch` unchanged, and it
   * becomes the handle's `data-handle` attribute and the `annot-handle-<id>` class, so a
   * stylesheet can give it a shape of its own.
   */
  readonly extraHandles?: ReadonlyArray<HandlePoint>;
  /** Hidden while its inline editor is open, so the two never draw the same text twice. */
  readonly hidden?: boolean;
}

/** The eight box handles, plus the two a callout adds. */
export const BOX_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
export type BoxHandle = (typeof BOX_HANDLES)[number];
/** A vertex handle is `v<index>` (M31). */
export type VertexHandle = `v${number}`;
/**
 * A handle's id. The named ones are the layer's own; anything else is a provider's, from
 * `LayerAnnotation.extraHandles`, and is passed through untouched (M33).
 */
export type HandleId = BoxHandle | 'tip' | 'knee' | VertexHandle | (string & {});

/** The index a vertex handle names, or null for any other handle. */
export function vertexIndexOf(id: string): number | null {
  const m = /^v(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** A handle's centre in page space, and what dragging it changes. */
export interface HandlePoint {
  readonly id: HandleId;
  readonly point: PdfPoint;
}

/** Handle size in CSS pixels — big enough to grab at 100 % with an unsteady hand. */
export const HANDLE_SIZE = 9;

/** The handles of an annotation, in page space. */
export function handlePoints(annotation: LayerAnnotation): HandlePoint[] {
  const out: HandlePoint[] = [];
  const r = annotation.rect;
  if (annotation.handles === 'box' || annotation.handles === 'callout') {
    const midX = (r.x0 + r.x1) / 2;
    const midY = (r.y0 + r.y1) / 2;
    const at: Record<BoxHandle, PdfPoint> = {
      nw: { x: r.x0, y: r.y1 },
      n: { x: midX, y: r.y1 },
      ne: { x: r.x1, y: r.y1 },
      e: { x: r.x1, y: midY },
      se: { x: r.x1, y: r.y0 },
      s: { x: midX, y: r.y0 },
      sw: { x: r.x0, y: r.y0 },
      w: { x: r.x0, y: midY },
    };
    for (const id of BOX_HANDLES) out.push({ id, point: at[id] });
  }
  if (annotation.handles === 'callout' && annotation.callout) {
    const [tip, knee] = annotation.callout;
    if (tip) out.push({ id: 'tip', point: tip });
    if (knee) out.push({ id: 'knee', point: knee });
  }
  if (annotation.handles === 'vertices' && annotation.vertices) {
    annotation.vertices.forEach((point, i) => {
      out.push({ id: `v${i}`, point });
    });
  }
  // A provider's own, whatever the handle set: they are extra, not instead (M33).
  for (const handle of annotation.extraHandles ?? []) out.push(handle);
  return out;
}

/** Applies a box-handle drag to a rect, keeping it the right way round. */
export function resizeRect(rect: PdfRect, handle: BoxHandle, to: PdfPoint): PdfRect {
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.startsWith('n');
  const south = handle.startsWith('s');
  const next = {
    x0: west ? to.x : rect.x0,
    x1: east ? to.x : rect.x1,
    y0: south ? to.y : rect.y0,
    y1: north ? to.y : rect.y1,
  };
  return {
    x0: Math.min(next.x0, next.x1),
    y0: Math.min(next.y0, next.y1),
    x1: Math.max(next.x0, next.x1),
    y1: Math.max(next.y0, next.y1),
  };
}

/** Whether a point is inside any of an annotation's hit rectangles, with a little slack. */
export function hitsAnnotation(
  annotation: LayerAnnotation,
  point: PdfPoint,
  slack: number,
): boolean {
  for (const r of annotation.hit) {
    if (
      point.x >= r.x0 - slack &&
      point.x <= r.x1 + slack &&
      point.y >= r.y0 - slack &&
      point.y <= r.y1 + slack
    ) {
      return true;
    }
  }
  return false;
}

interface PaneBinding {
  readonly view: DocumentView;
  readonly dispose: () => void;
}

/** A marquee being dragged, in page space. */
export interface Marquee {
  readonly page: number;
  readonly rect: PdfRect;
}

export class AnnotationLayer {
  private readonly panes: PaneBinding[] = [];
  private annotations: ReadonlyArray<LayerAnnotation> = [];
  private selected: ReadonlySet<string> = new Set();
  private marqueeRect: Marquee | null = null;
  private frame = 0;
  private disposed = false;

  /** Watches a pane so the drawing follows its scrolling, zooming and page mounting. */
  attach(view: DocumentView): void {
    const onScroll = (): void => {
      this.schedule();
    };
    view.scroller.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(() => {
      this.schedule();
    });
    observer.observe(view.scroller);
    this.panes.push({
      view,
      dispose: () => {
        view.scroller.removeEventListener('scroll', onScroll);
        observer.disconnect();
      },
    });
    this.schedule();
  }

  get current(): ReadonlyArray<LayerAnnotation> {
    return this.annotations;
  }

  set(annotations: ReadonlyArray<LayerAnnotation>): void {
    this.annotations = annotations;
    this.schedule();
  }

  setSelection(ids: Iterable<string>): void {
    this.selected = new Set(ids);
    this.schedule();
  }

  get selection(): ReadonlySet<string> {
    return this.selected;
  }

  setMarquee(marquee: Marquee | null): void {
    this.marqueeRect = marquee;
    this.schedule();
  }

  /** The topmost annotation under a page point — last drawn wins, as a viewer expects. */
  hitTest(page: number, point: PdfPoint, slackPoints = 2): LayerAnnotation | null {
    for (let i = this.annotations.length - 1; i >= 0; i--) {
      const a = this.annotations[i];
      if (a?.page === page && !a.hidden && hitsAnnotation(a, point, slackPoints)) return a;
    }
    return null;
  }

  /** Every annotation whose rect meets a marquee. */
  within(page: number, rect: PdfRect): LayerAnnotation[] {
    return this.annotations.filter(
      (a) =>
        a.page === page &&
        !a.hidden &&
        a.rect.x1 >= rect.x0 &&
        a.rect.x0 <= rect.x1 &&
        a.rect.y1 >= rect.y0 &&
        a.rect.y0 <= rect.y1,
    );
  }

  /**
   * The handle of a selected annotation under a page point, in CSS-pixel terms — the grab area
   * is a fixed number of pixels whatever the zoom, which is what makes a handle usable at 25 %.
   */
  handleAt(page: number, point: PdfPoint, scale: number): { id: HandleId; on: string } | null {
    const slack = HANDLE_SIZE / Math.max(scale, 1e-6);
    for (const a of this.annotations) {
      if (a.page !== page || !this.selected.has(a.id) || a.hidden) continue;
      for (const h of handlePoints(a)) {
        if (Math.abs(h.point.x - point.x) <= slack && Math.abs(h.point.y - point.y) <= slack) {
          return { id: h.id, on: a.id };
        }
      }
    }
    return null;
  }

  /** Coalesces repaints into one per frame. */
  schedule(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  /** Repaints now. Exposed so a command can read the DOM straight after changing the model. */
  paint(): void {
    if (this.disposed) return;
    const byPage = new Map<number, LayerAnnotation[]>();
    for (const a of this.annotations) {
      const list = byPage.get(a.page);
      if (list) list.push(a);
      else byPage.set(a.page, [a]);
    }
    for (const { view } of this.panes) {
      for (const rect of view.layoutTable.rects) {
        const pageView = view.pageView(rect.page);
        if (!pageView) continue;
        this.paintPage(pageView, byPage.get(rect.page) ?? []);
      }
    }
  }

  private paintPage(pageView: PageView, wanted: ReadonlyArray<LayerAnnotation>): void {
    const layer = pageView.layers.annot;
    const marquee = this.marqueeRect?.page === pageView.index ? this.marqueeRect : null;
    const key = signature(wanted, this.selected, marquee, pageView);
    if (layer.dataset['annots'] === key) return;
    layer.dataset['annots'] = key;
    layer.replaceChildren();
    const scale = pageView.transform.scale;
    const toDevice = (p: PdfPoint): { x: number; y: number } => pageView.transform.toDevice(p);

    for (const a of wanted) {
      if (a.hidden) continue;
      const group = document.createElementNS(SVG_NS, 'g');
      group.dataset['annot'] = a.id;
      group.setAttribute('class', 'annot');
      for (const shape of a.shapes) {
        group.append(
          shape.kind === 'path'
            ? pathElement(shape, toDevice, scale)
            : shape.kind === 'text'
              ? textElement(shape, toDevice, scale)
              : imageElement(shape, pageView),
        );
      }
      layer.append(group);
    }

    for (const a of wanted) {
      if (a.hidden || !this.selected.has(a.id)) continue;
      layer.append(...selectionElements(a, toDevice));
    }

    if (marquee) {
      const box = pageView.transform.rectToDevice(marquee.rect);
      const el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('class', 'annot-marquee');
      el.setAttribute('x', String(box.left));
      el.setAttribute('y', String(box.top));
      el.setAttribute('width', String(Math.max(1, box.width)));
      el.setAttribute('height', String(Math.max(1, box.height)));
      layer.append(el);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const pane of this.panes.splice(0)) {
      pane.dispose();
      for (const rect of pane.view.layoutTable.rects) {
        const layer = pane.view.pageView(rect.page)?.layers.annot;
        if (!layer) continue;
        layer.replaceChildren();
        delete layer.dataset['annots'];
      }
    }
  }
}

// ---- painting -----------------------------------------------------------------------------------

/**
 * A PDF content colour as CSS. Not a theme token on purpose: this is the colour the file says
 * the annotation is, and it must survive a theme change.
 */
function css(color: number): string {
  // ynot-allow-color: the digits come from the document, never from this file.
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

function pathElement(
  shape: ShapePath,
  toDevice: (p: PdfPoint) => { x: number; y: number },
  scale: number,
): SVGPathElement {
  const el = document.createElementNS(SVG_NS, 'path');
  const parts: string[] = [];
  for (const step of shape.steps) {
    if (step.op === 'Z') {
      parts.push('Z');
      continue;
    }
    if (step.op === 'C') {
      const a = toDevice({ x: step.x1, y: step.y1 });
      const b = toDevice({ x: step.x2, y: step.y2 });
      const c = toDevice({ x: step.x, y: step.y });
      parts.push(
        `C${round(a.x)} ${round(a.y)} ${round(b.x)} ${round(b.y)} ${round(c.x)} ${round(c.y)}`,
      );
      continue;
    }
    const p = toDevice({ x: step.x, y: step.y });
    parts.push(`${step.op}${round(p.x)} ${round(p.y)}`);
  }
  el.setAttribute('d', parts.join(' '));
  el.setAttribute('fill', shape.fill === null ? 'none' : css(shape.fill));
  el.setAttribute('stroke', shape.stroke === null ? 'none' : css(shape.stroke));
  el.setAttribute('stroke-width', String(round(Math.max(shape.width, 0) * scale)));
  if (shape.round) {
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
  }
  if (shape.dash && shape.dash.length > 0) {
    el.setAttribute('stroke-dasharray', shape.dash.map((n) => round(n * scale)).join(' '));
  }
  if (shape.blend === 'multiply') el.setAttribute('class', 'annot-multiply');
  return el;
}

function textElement(
  shape: ShapeText,
  toDevice: (p: PdfPoint) => { x: number; y: number },
  scale: number,
): SVGGElement {
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('fill', css(shape.color));
  group.setAttribute('font-family', shape.family);
  group.setAttribute('font-size', String(round(shape.size * scale)));
  if (shape.bold) group.setAttribute('font-weight', 'bold');
  if (shape.italic) group.setAttribute('font-style', 'italic');
  const turn = shape.rotate ?? 0;
  for (const line of shape.lines) {
    if (line.text === '') continue;
    const el = document.createElementNS(SVG_NS, 'text');
    const p = toDevice({ x: line.x, y: line.y });
    el.setAttribute('x', String(round(p.x)));
    el.setAttribute('y', String(round(p.y)));
    el.setAttribute('xml:space', 'preserve');
    if (turn % 360 !== 0) {
      el.setAttribute('transform', `rotate(${round(-turn)} ${round(p.x)} ${round(p.y)})`);
    }
    el.textContent = line.text;
    group.append(el);
  }
  return group;
}

/**
 * A picture placed in page space (M31). The page's own rotation is a rigid map the transform
 * already applies to the box's corners; the picture's turn is added on top, about the box's
 * centre, with the sign flipped because device y grows downwards.
 */
function imageElement(shape: ShapeImage, pageView: PageView): SVGImageElement {
  const el = document.createElementNS(SVG_NS, 'image');
  const box = pageView.transform.rectToDevice(shape.rect);
  const scale = pageView.transform.scale;
  const width = (shape.rect.x1 - shape.rect.x0) * scale;
  const height = (shape.rect.y1 - shape.rect.y0) * scale;
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  el.setAttribute('href', shape.href);
  el.setAttribute('x', String(round(cx - width / 2)));
  el.setAttribute('y', String(round(cy - height / 2)));
  el.setAttribute('width', String(round(Math.max(1, width))));
  el.setAttribute('height', String(round(Math.max(1, height))));
  el.setAttribute('preserveAspectRatio', 'none');
  const turn = (shape.rotate ?? 0) - pageView.transform.rotation;
  if (turn % 360 !== 0) {
    el.setAttribute('transform', `rotate(${round(-turn)} ${round(cx)} ${round(cy)})`);
  }
  return el;
}

function selectionElements(
  a: LayerAnnotation,
  toDevice: (p: PdfPoint) => { x: number; y: number },
): SVGElement[] {
  const out: SVGElement[] = [];
  const corners = [
    toDevice({ x: a.rect.x0, y: a.rect.y0 }),
    toDevice({ x: a.rect.x1, y: a.rect.y1 }),
  ];
  const left = Math.min(corners[0]?.x ?? 0, corners[1]?.x ?? 0);
  const top = Math.min(corners[0]?.y ?? 0, corners[1]?.y ?? 0);
  const width = Math.abs((corners[1]?.x ?? 0) - (corners[0]?.x ?? 0));
  const height = Math.abs((corners[1]?.y ?? 0) - (corners[0]?.y ?? 0));
  const outline = document.createElementNS(SVG_NS, 'rect');
  outline.setAttribute('class', 'annot-selected');
  outline.dataset['annot'] = a.id;
  outline.setAttribute('x', String(round(left)));
  outline.setAttribute('y', String(round(top)));
  outline.setAttribute('width', String(round(Math.max(1, width))));
  outline.setAttribute('height', String(round(Math.max(1, height))));
  out.push(outline);
  for (const handle of handlePoints(a)) {
    const p = toDevice(handle.point);
    const el = document.createElementNS(SVG_NS, 'rect');
    el.setAttribute('class', `annot-handle annot-handle-${handle.id}`);
    el.dataset['handle'] = handle.id;
    el.dataset['annot'] = a.id;
    el.setAttribute('x', String(round(p.x - HANDLE_SIZE / 2)));
    el.setAttribute('y', String(round(p.y - HANDLE_SIZE / 2)));
    el.setAttribute('width', String(HANDLE_SIZE));
    el.setAttribute('height', String(HANDLE_SIZE));
    out.push(el);
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A cheap identity for a page's drawing, so an unchanged page is not rebuilt every frame. */
function signature(
  wanted: ReadonlyArray<LayerAnnotation>,
  selected: ReadonlySet<string>,
  marquee: Marquee | null,
  pageView: PageView,
): string {
  const parts = wanted.map(
    (a) =>
      `${a.id}:${a.hidden ? 'h' : ''}${selected.has(a.id) ? 's' : ''}:${round(a.rect.x0)},${round(
        a.rect.y0,
      )},${round(a.rect.x1)},${round(a.rect.y1)}:${a.shapes.length}:${shapeKey(a.shapes)}:${a.handles}${(
        a.vertices ?? []
      )
        .map((v) => `${round(v.x)},${round(v.y)}`)
        .join('/')}${(a.extraHandles ?? [])
        .map((h) => `${h.id}@${round(h.point.x)},${round(h.point.y)}`)
        .join('/')}`,
  );
  const m = marquee
    ? `${round(marquee.rect.x0)},${round(marquee.rect.y0)},${round(marquee.rect.x1)},${round(marquee.rect.y1)}`
    : '';
  return `${round(pageView.widthPx)}x${round(pageView.heightPx)}r${pageView.transform.rotation}|${parts.join('|')}|${m}`;
}

/** Enough of the shapes to notice a colour, a wording or a geometry change. */
function shapeKey(shapes: ReadonlyArray<AnnotationShape>): string {
  return shapes
    .map((s) => {
      if (s.kind === 'text') {
        return `t${s.size}/${s.color}/${s.family}/${s.rotate ?? 0}/${s.bold ? 'b' : ''}${s.italic ? 'i' : ''}/${s.lines
          .map((l) => `${l.text}@${round(l.x)},${round(l.y)}`)
          .join('~')}`;
      }
      if (s.kind === 'image') {
        return `i${s.href.length}/${round(s.rect.x0)},${round(s.rect.y0)},${round(s.rect.x1)},${round(s.rect.y1)}/${s.rotate ?? 0}`;
      }
      return `p${s.stroke ?? -1}/${s.fill ?? -1}/${round(s.width)}/${s.steps.length}/${s.steps
        .map((st) => (st.op === 'Z' ? 'Z' : `${st.op}${round(st.x)},${round(st.y)}`))
        .join('')}`;
    })
    .join(';');
}
