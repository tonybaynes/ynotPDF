/**
 * The stamp palette (M31): a left-dock panel of every stamp the reader can place — favourites
 * first, then the catalogue by category, then the custom ones — each as a tile with its picture
 * on paper-white and its name beside it. Clicking a tile makes it the stamp tool's stamp and picks
 * up the tool; the star beside a tile marks it a favourite.
 *
 * The previews are the same drawings the appearance stream uses, put through an SVG with its y
 * axis flipped, so what the palette shows is what the page will get.
 */

import { button, el } from '@app/dom';
import { icon } from '@app/icons';
import { isDynamicStamp, type StampDrawing } from '@engine/appearance';
import {
  stampEntryId,
  stampEntryLabel,
  type DrawingService,
  type StampEntry,
} from './DrawingService';
import { pngDataUrl } from './stampImport';
import { TOOL_ID } from './tools';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A hex colour for an SVG attribute. The digits are document content, never chrome. */
function hex(colour: number): string {
  // ynot-allow-color: a stamp's colour is what the file will carry, not a theme choice.
  return `#${(colour & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * The picture of a catalogue stamp as inline SVG, in its own box. The drawing is in PDF space
 * (y up), so the group is flipped and every text is flipped back.
 */
export function stampPreview(drawing: StampDrawing): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${drawing.width} ${drawing.height}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('transform', `translate(0 ${drawing.height}) scale(1 -1)`);
  for (const d of drawing.drawings) {
    const path = document.createElementNS(SVG_NS, 'path');
    const parts: string[] = [];
    for (const op of d.ops) {
      if (op.op === 'Z') parts.push('Z');
      else if (op.op === 'C') {
        parts.push(`C${r(op.x1)} ${r(op.y1)} ${r(op.x2)} ${r(op.y2)} ${r(op.x)} ${r(op.y)}`);
      } else parts.push(`${op.op}${r(op.x)} ${r(op.y)}`);
    }
    path.setAttribute('d', parts.join(' '));
    path.setAttribute('fill', d.fill === null ? 'none' : hex(d.fill));
    path.setAttribute('stroke', d.stroke === null ? 'none' : hex(d.stroke));
    path.setAttribute('stroke-width', String(d.width));
    path.setAttribute('stroke-linejoin', 'round');
    group.append(path);
  }
  for (const t of drawing.texts) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(r(t.x)));
    text.setAttribute('y', String(r(-t.y)));
    text.setAttribute('transform', 'scale(1 -1)');
    text.setAttribute('font-family', '"Liberation Sans", Arial, Helvetica, sans-serif');
    text.setAttribute('font-weight', 'bold');
    text.setAttribute('font-size', String(t.size));
    text.setAttribute('fill', hex(t.color));
    text.setAttribute('xml:space', 'preserve');
    text.textContent = t.text;
    group.append(text);
  }
  svg.append(group);
  return svg;
}

function r(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The picture of any entry: SVG for a catalogue stamp, an `<img>` for a custom one. */
export function entryPreview(service: DrawingService, entry: StampEntry): Element {
  if (entry.kind === 'catalogue') return stampPreview(service.drawingFor(entry.definition).drawing);
  return el('img', { src: pngDataUrl(entry.stamp.data), alt: '' });
}

/** Mounts the panel. Returns a disposer, as `PanelSpec.mount` requires. */
export function mountStampPanel(host: HTMLElement, service: DrawingService): () => void {
  const root = el('div.stamp-panel', { id: 'stamp-panel' });
  const bar = el('div.nav-toolbar', { role: 'toolbar', 'aria-label': 'Stamps' });
  const add = button(
    'btn',
    { id: 'stamp-add', title: 'Make a stamp from a picture, the clipboard or a PDF page' },
    icon('plus'),
    'Custom stamp…',
  );
  add.addEventListener('click', () => {
    void service.shellServices.run('draw.stampCustom');
  });
  bar.append(add);
  const scroll = el('div.stamp-panel-scroll', { 'data-panel-scroll': 'stamps' });
  root.append(bar, scroll);
  host.append(root);

  const render = (): void => {
    scroll.replaceChildren();
    const all = service.allStamps();
    const chosen = service.defaults('stamp').stampId;
    const favourites = all.filter((e) => service.isFavourite(stampEntryId(e)));
    if (favourites.length > 0) scroll.append(group('Favourites', favourites));
    for (const category of service.catalogue.categories) {
      const entries = all.filter(
        (e) => e.kind === 'catalogue' && e.definition.category === category.id,
      );
      if (entries.length > 0) scroll.append(group(category.label, entries));
    }
    const custom = all.filter((e) => e.kind === 'custom');
    scroll.append(
      group(
        'Custom',
        custom,
        custom.length === 0
          ? 'No custom stamps yet. Make one from a picture, the clipboard or a PDF page.'
          : null,
      ),
    );

    function group(
      title: string,
      entries: ReadonlyArray<StampEntry>,
      empty: string | null = null,
    ): HTMLElement {
      const section = el('section.stamp-group');
      section.append(el('h3.stamp-group-title', null, title));
      if (entries.length === 0 && empty !== null) {
        section.append(el('p.stamp-panel-empty', null, empty));
        return section;
      }
      const grid = el('div.stamp-grid', { role: 'list' });
      for (const entry of entries) grid.append(tile(entry, stampEntryId(entry) === chosen));
      section.append(grid);
      return section;
    }

    function tile(entry: StampEntry, pressed: boolean): HTMLElement {
      const id = stampEntryId(entry);
      const label = stampEntryLabel(entry);
      const item = el('div', { role: 'listitem' });
      const b = button(
        'stamp-tile',
        {
          'aria-pressed': pressed ? 'true' : 'false',
          'data-stamp': id,
          title: `Place the ${label} stamp`,
        },
        el('span.stamp-tile-picture', null, entryPreview(service, entry)),
      );
      const name = el('span.stamp-tile-name');
      const text = el(
        'span.stamp-tile-label',
        null,
        label +
          (entry.kind === 'catalogue' && isDynamicStamp(entry.definition) ? ' (dynamic)' : ''),
      );
      const star = button(
        'stamp-star',
        {
          'aria-pressed': service.isFavourite(id) ? 'true' : 'false',
          'aria-label': service.isFavourite(id)
            ? `Remove ${label} from favourites`
            : `Add ${label} to favourites`,
          title: 'Favourite',
        },
        icon('star'),
      );
      star.addEventListener('click', (e) => {
        e.stopPropagation();
        void service.toggleFavourite(id);
      });
      name.append(text, star);
      b.append(name);
      b.addEventListener('click', () => {
        void service.setDefaults('stamp', { stampId: id }).then(() => {
          service.shellServices.registry
            .service<{ activate(id: string): void }>('tools')
            .activate(TOOL_ID.stamp);
        });
      });
      if (entry.kind === 'custom') {
        b.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          void service.shellServices.run('draw.stampRemove', { stamp: id, confirm: true });
        });
      }
      item.append(b);
      return item;
    }
  };

  const unsubscribe = service.subscribe(render);
  render();
  return () => {
    unsubscribe();
    root.remove();
  };
}
