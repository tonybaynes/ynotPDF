/**
 * `PageView` — one page's DOM: the layer stack plus its transform (M00 typed shell).
 * M11 adds tile rendering, M13 the text layer, M30+ annotation editing.
 */

import type { PageIndex, PageSize, Rotation } from '@shared/pdf';
import { createPageLayers, resizeLayers, type PageLayers } from './Layers';
import { PageTransform } from './Viewport';

export interface PageViewOptions {
  readonly index: PageIndex;
  readonly size: PageSize;
  readonly scale: number;
  readonly rotation?: Rotation;
}

export class PageView {
  readonly index: PageIndex;
  readonly layers: PageLayers;
  private size: PageSize;
  private scale: number;
  private rotation: Rotation;
  private transformCache: PageTransform;

  constructor(options: PageViewOptions) {
    this.index = options.index;
    this.size = options.size;
    this.scale = options.scale;
    this.rotation = options.rotation ?? 0;
    const root = document.createElement('div');
    root.dataset['page'] = String(options.index);
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', `Page ${options.index + 1}`);
    this.layers = createPageLayers(root);
    this.transformCache = new PageTransform(this.size, this.scale, this.rotation);
    this.layout();
  }

  get element(): HTMLElement {
    return this.layers.root;
  }

  get transform(): PageTransform {
    return this.transformCache;
  }

  /** Updates scale/rotation/size and re-lays-out the layers. */
  update(patch: Partial<Pick<PageViewOptions, 'size' | 'scale' | 'rotation'>>): void {
    if (patch.size) this.size = patch.size;
    if (patch.scale !== undefined) this.scale = patch.scale;
    if (patch.rotation !== undefined) this.rotation = patch.rotation;
    this.transformCache = new PageTransform(this.size, this.scale, this.rotation);
    this.layout();
  }

  private layout(): void {
    const t = this.transformCache;
    resizeLayers(this.layers, t.widthPx, t.heightPx, globalThis.devicePixelRatio || 1);
  }

  /** Removes the page from the DOM. */
  dispose(): void {
    this.layers.root.remove();
  }
}
