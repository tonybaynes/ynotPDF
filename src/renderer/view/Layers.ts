/**
 * Page overlay layers (M00 typed shell). Bottom → top:
 *
 * 1. `raster`  — `<canvas>`: the engine's bitmap tiles (M11).
 * 2. `text`    — `<div>`: invisible text spans for selection/search hit-testing (M13).
 * 3. `annot`   — `<svg>`: annotations being created/edited (M30+); committed ones are baked
 *                into appearance streams and drawn by the raster layer.
 * 4. `widget`  — `<div>`: live form-field widgets (M60).
 * 5. `object`  — `<svg>`: page-object selection handles (M50).
 * 6. `tool`    — `<div>`: the active tool's pointer surface, always on top.
 *
 * All layers are absolutely positioned to the page box and inherit theme tokens from the
 * document; no colour literals here (theme/ owns colours).
 */

export const LAYER_NAMES = [
  'raster',
  'text',
  'annot',
  'link',
  'widget',
  'object',
  'tool',
] as const;
export type LayerName = (typeof LAYER_NAMES)[number];

export interface PageLayers {
  readonly root: HTMLElement;
  readonly raster: HTMLCanvasElement;
  readonly text: HTMLDivElement;
  readonly annot: SVGSVGElement;
  readonly link: SVGSVGElement;
  readonly widget: HTMLDivElement;
  readonly object: SVGSVGElement;
  readonly tool: HTMLDivElement;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Creates the layer stack for one page inside `root` (which becomes `position: relative`). */
export function createPageLayers(root: HTMLElement): PageLayers {
  root.classList.add('page');
  const raster = document.createElement('canvas');
  const text = document.createElement('div');
  const annot = document.createElementNS(SVG_NS, 'svg');
  const link = document.createElementNS(SVG_NS, 'svg');
  const widget = document.createElement('div');
  const object = document.createElementNS(SVG_NS, 'svg');
  const tool = document.createElement('div');
  const all: Record<LayerName, Element> = { raster, text, annot, link, widget, object, tool };
  for (const name of LAYER_NAMES) {
    const el = all[name];
    el.classList.add('layer', `layer-${name}`);
    el.setAttribute('data-layer', name);
    root.append(el);
  }
  text.setAttribute('aria-hidden', 'true');
  return { root, raster, text, annot, link, widget, object, tool };
}

/**
 * Sizes the page box and every vector layer to the displayed page (CSS pixels).
 *
 * The raster canvas is deliberately *not* sized here: at high zoom a whole-page canvas would be
 * hundreds of megapixels, so `PageView` keeps it as a moving window over the visible part of the
 * page (see `PageView.setVisible`). Everything else covers the page exactly.
 */
export function resizeLayers(layers: PageLayers, widthPx: number, heightPx: number): void {
  layers.root.style.width = `${widthPx}px`;
  layers.root.style.height = `${heightPx}px`;
  for (const svg of [layers.annot, layers.link, layers.object]) {
    svg.setAttribute('viewBox', `0 0 ${widthPx} ${heightPx}`);
    svg.setAttribute('width', String(widthPx));
    svg.setAttribute('height', String(heightPx));
  }
}
