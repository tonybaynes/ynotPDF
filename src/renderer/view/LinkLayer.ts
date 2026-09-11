/**
 * `LinkLayer` — the overlay that makes a document's links visible and clickable (M53, ADR 0020).
 *
 * Two jobs, and they are deliberately the same layer. A **reader** needs the link area to take
 * the click, and nothing else on the page to lose one; an **editor** needs to see where the
 * links are, which means a dashed outline while the link tool is chosen. Both are the same set
 * of rectangles.
 *
 * The layer itself never takes a pointer event — only the rectangles on it do — and it is raised
 * above the tool layer for the same reason M60's widget layer is: a click anywhere but on a link
 * still reaches the active tool, and the hand still pans the page.
 *
 * Colours are theme tokens in the stylesheet; nothing here is translucent.
 */

import type { PdfRect } from '@shared/pdf';
import type { DocumentView } from './DocumentView';
import type { PageView } from './PageView';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One link as the layer draws it. */
export interface LayerLink {
  readonly id: string;
  readonly rect: PdfRect;
  /** What it does, in words, for the tooltip and the screen reader. */
  readonly label: string;
  /** Drawn with a border the file asks for, rather than only the editing outline. */
  readonly visible: boolean;
}

/** How the layer behaves right now. */
export type LinkLayerMode = 'read' | 'edit';

interface PaneBinding {
  readonly view: DocumentView;
  readonly dispose: () => void;
}

interface PageState {
  links: ReadonlyArray<LayerLink>;
  selected: ReadonlySet<string>;
}

export interface LinkLayerHandlers {
  /** A click on a link in read mode. */
  onFollow?(id: string): void;
  /** A click on a link in edit mode. */
  onSelect?(id: string, additive: boolean): void;
  /** A double click on a link in edit mode. */
  onOpen?(id: string): void;
}

export class LinkLayer {
  private readonly panes: PaneBinding[] = [];
  private readonly pages = new Map<number, PageState>();
  private mode: LinkLayerMode = 'read';
  private outlines = true;
  private handlers: LinkLayerHandlers = {};
  private frame = 0;
  private disposed = false;
  /** The rectangle being dragged out right now, if any. */
  private draft: { page: number; rect: PdfRect } | null = null;

  /** Follows a pane: a scroll or a resize repaints the links on the pages it shows. */
  attach(view: DocumentView): () => void {
    const onScroll = (): void => {
      this.schedule();
    };
    view.scroller.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(() => {
      this.schedule();
    });
    observer.observe(view.scroller);
    const binding: PaneBinding = {
      view,
      dispose: () => {
        view.scroller.removeEventListener('scroll', onScroll);
        observer.disconnect();
      },
    };
    this.panes.push(binding);
    this.schedule();
    return () => {
      binding.dispose();
      this.wipe(view);
      const index = this.panes.indexOf(binding);
      if (index >= 0) this.panes.splice(index, 1);
    };
  }

  /** Coalesces repaints into one animation frame, as the object layer does. */
  private schedule(): void {
    if (this.frame !== 0 || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  setHandlers(handlers: LinkLayerHandlers): void {
    this.handlers = handlers;
  }

  /** `edit` outlines every link and sends clicks to `onSelect`; `read` follows them. */
  setMode(mode: LinkLayerMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.schedule();
  }

  /** Whether the dashed outlines are drawn at all in edit mode (a preference). */
  setOutlines(on: boolean): void {
    if (this.outlines === on) return;
    this.outlines = on;
    this.schedule();
  }

  setLinks(page: number, links: ReadonlyArray<LayerLink>): void {
    const state = this.pages.get(page) ?? { links: [], selected: new Set<string>() };
    this.pages.set(page, { ...state, links });
    this.schedule();
  }

  /** The rectangle a drag is making, drawn as a dashed outline until the pointer comes up. */
  setDraft(draft: { readonly page: number; readonly rect: PdfRect } | null): void {
    this.draft = draft ? { page: draft.page, rect: draft.rect } : null;
    this.schedule();
  }

  setSelection(page: number, ids: ReadonlySet<string>): void {
    const state = this.pages.get(page) ?? { links: [], selected: new Set<string>() };
    this.pages.set(page, { ...state, selected: ids });
    this.schedule();
  }

  /** The links the layer holds for a page. */
  linksOn(page: number): ReadonlyArray<LayerLink> {
    return this.pages.get(page)?.links ?? [];
  }

  clear(): void {
    this.pages.clear();
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    for (const pane of this.panes.splice(0)) {
      pane.dispose();
      this.wipe(pane.view);
    }
    this.pages.clear();
  }

  /** Repaints every visible page of every bound pane. */
  draw(): void {
    if (this.disposed) return;
    for (const pane of this.panes) {
      const drawn = new Set<number>();
      for (const rect of pane.view.layoutTable.rects) {
        const pageView = pane.view.pageView(rect.page);
        if (!pageView) continue;
        drawn.add(rect.page);
        this.drawPage(pageView, rect.page);
      }
      // A page that scrolled out of view keeps its DOM; clearing it costs nothing and stops a
      // stale outline reappearing when it scrolls back before the next read.
      for (const page of this.pages.keys()) {
        if (drawn.has(page) || this.draft?.page === page) continue;
        const pageView = pane.view.pageView(page);
        if (pageView) pageView.layers.link.replaceChildren();
      }
    }
  }

  private wipe(view: DocumentView): void {
    for (const rect of view.layoutTable.rects) {
      view.pageView(rect.page)?.layers.link.replaceChildren();
    }
  }

  private drawPage(pageView: PageView, page: number): void {
    const layer = pageView.layers.link;
    layer.replaceChildren();
    const state = this.pages.get(page);
    layer.dataset['mode'] = this.mode;
    if (this.draft?.page === page) {
      const box = pageView.transform.rectToDevice(this.draft.rect);
      const draft = document.createElementNS(SVG_NS, 'rect');
      draft.setAttribute('x', String(box.left));
      draft.setAttribute('y', String(box.top));
      draft.setAttribute('width', String(Math.max(1, box.width)));
      draft.setAttribute('height', String(Math.max(1, box.height)));
      draft.setAttribute('class', 'link-draft');
      layer.append(draft);
    }
    if (!state || state.links.length === 0) return;
    for (const link of state.links) {
      const box = pageView.transform.rectToDevice(link.rect);
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(box.left));
      rect.setAttribute('y', String(box.top));
      rect.setAttribute('width', String(Math.max(1, box.width)));
      rect.setAttribute('height', String(Math.max(1, box.height)));
      rect.setAttribute('class', 'link-area');
      rect.dataset['linkId'] = link.id;
      if (state.selected.has(link.id)) rect.dataset['selected'] = 'true';
      if (link.visible) rect.dataset['bordered'] = 'true';
      if (!this.outlines) rect.dataset['quiet'] = 'true';
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = link.label;
      rect.append(title);
      rect.addEventListener('click', (event) => {
        event.stopPropagation();
        if (this.mode === 'edit') {
          this.handlers.onSelect?.(link.id, event.shiftKey || event.ctrlKey || event.metaKey);
        } else {
          this.handlers.onFollow?.(link.id);
        }
      });
      rect.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        this.handlers.onOpen?.(link.id);
      });
      layer.append(rect);
    }
  }
}
