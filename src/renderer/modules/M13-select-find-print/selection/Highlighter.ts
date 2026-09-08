/**
 * Draws selection and search highlights into the page text layer (M13).
 *
 * The rectangles are put in the layer M00 reserved for exactly this and positioned in the page's
 * own CSS pixels, so they scroll with the page for free: a repaint is only needed when the zoom,
 * the rotation, the layout or the set of mounted pages changes.
 *
 * **Why drawn rectangles rather than the browser's own selection.** A text layer of transparent
 * spans would give `::selection` for free, but a selection colour drawn *over* the page hides the
 * words underneath unless it is translucent, and translucency is not available to us — overlays
 * are opaque here (CLAUDE.md). Drawing the rectangles ourselves lets them blend with the paper
 * (`multiply` on a light page, `screen` on a dark one), which keeps the text readable *and* the
 * highlight fully opaque. It also means the selection model is ours, so column select,
 * cross-page runs and "n of m" all work the same way on every platform.
 */

import type { PdfRect } from '@shared/pdf';
import type { DocumentView } from '@view/DocumentView';

/** What a highlight is for; the CSS gives each its own token. */
export type HighlightKind = 'selection' | 'find' | 'find-current';

export interface Highlight {
  readonly page: number;
  readonly rect: PdfRect;
  readonly kind: HighlightKind;
}

interface PaneBinding {
  readonly view: DocumentView;
  readonly dispose: () => void;
}

export class Highlighter {
  private readonly panes: PaneBinding[] = [];
  private highlights: ReadonlyArray<Highlight> = [];
  private frame = 0;
  private disposed = false;

  /** Watches a pane so the highlights follow its scrolling and zooming. */
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

  /** Replaces every highlight. */
  set(highlights: ReadonlyArray<Highlight>): void {
    this.highlights = highlights;
    this.schedule();
  }

  get current(): ReadonlyArray<Highlight> {
    return this.highlights;
  }

  clear(): void {
    this.set([]);
  }

  /** Coalesces repaints into one per frame. */
  schedule(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  /** Repaints now. Exposed so a command can be sure the DOM is up to date before it reads it. */
  paint(): void {
    if (this.disposed) return;
    const byPage = new Map<number, Highlight[]>();
    for (const h of this.highlights) {
      const list = byPage.get(h.page);
      if (list) list.push(h);
      else byPage.set(h.page, [h]);
    }
    for (const { view } of this.panes) {
      for (const rect of view.layoutTable.rects) {
        const pageView = view.pageView(rect.page);
        if (!pageView) continue;
        const layer = pageView.layers.text;
        const wanted = byPage.get(rect.page) ?? [];
        const key = signature(
          wanted,
          pageView.widthPx,
          pageView.heightPx,
          pageView.transform.rotation,
        );
        if (layer.dataset['highlights'] === key) continue;
        layer.dataset['highlights'] = key;
        layer.replaceChildren();
        for (const h of wanted) {
          const box = pageView.transform.rectToDevice(h.rect);
          if (box.width <= 0 && box.height <= 0) continue;
          const el = document.createElement('div');
          el.className = `text-highlight text-highlight-${h.kind}`;
          el.style.left = `${box.left}px`;
          el.style.top = `${box.top}px`;
          el.style.width = `${Math.max(1, box.width)}px`;
          el.style.height = `${Math.max(1, box.height)}px`;
          layer.append(el);
        }
      }
    }
  }

  /** Scrolls a highlight into view — how "next hit" moves the reader. */
  reveal(view: DocumentView, page: number, rect: PdfRect): void {
    view.goToPage(page);
    const pageView = view.pageView(page);
    if (!pageView) return;
    const box = pageView.transform.rectToDevice(rect);
    const pageRect = view.layoutTable.rects.find((r) => r.page === page);
    if (!pageRect) return;
    const scroller = view.scroller;
    const targetTop = pageRect.y + box.top - scroller.clientHeight / 3;
    const targetLeft = pageRect.x + box.left - scroller.clientWidth / 3;
    const needsHorizontal =
      box.left < scroller.scrollLeft - pageRect.x ||
      box.left + box.width > scroller.scrollLeft - pageRect.x + scroller.clientWidth;
    view.setScroll({
      left: needsHorizontal ? Math.max(0, targetLeft) : scroller.scrollLeft,
      top: Math.max(0, targetTop),
    });
    this.paint();
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const pane of this.panes.splice(0)) {
      pane.dispose();
      for (const rect of pane.view.layoutTable.rects) {
        const layer = pane.view.pageView(rect.page)?.layers.text;
        if (!layer) continue;
        layer.replaceChildren();
        delete layer.dataset['highlights'];
      }
    }
  }
}

/** A cheap identity for a page's highlights, so an unchanged page is not rebuilt. */
function signature(
  highlights: ReadonlyArray<Highlight>,
  width: number,
  height: number,
  rotation: number,
): string {
  const parts = highlights.map(
    (h) =>
      `${h.kind}:${round(h.rect.x0)},${round(h.rect.y0)},${round(h.rect.x1)},${round(h.rect.y1)}`,
  );
  return `${round(width)}x${round(height)}r${rotation}|${parts.join('|')}`;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
