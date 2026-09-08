/**
 * The loupe (M11) — Foxit's magnifier window. A small floating, draggable, **opaque** panel
 * that shows the area under the pointer at a higher zoom.
 *
 * It magnifies what is already on screen (the page canvas) rather than asking the engine for a
 * second render: at 2–8× over an already-crisp tile that is what the eye wants, and it costs
 * nothing while the pointer sweeps across the page. The window is keyboard-movable and closes
 * with Escape, because every control in this app has a keyboard path.
 */

import { button, el } from '@app/dom';
import { icon } from '@app/icons';
import type { DocumentView } from './DocumentView';

export interface LoupeOptions {
  readonly view: DocumentView;
  /** Magnification over the current zoom. */
  readonly factor?: number;
  readonly width?: number;
  readonly height?: number;
  readonly onClose?: () => void;
}

export const LOUPE_FACTORS: ReadonlyArray<number> = [2, 4, 8];

export class Loupe {
  readonly element: HTMLElement;
  private readonly canvas = el('canvas');
  private readonly view: DocumentView;
  private readonly onClose: (() => void) | undefined;
  private readonly label = el('span');
  private factorValue: number;
  private readonly disposers: Array<() => void> = [];
  private lastPoint: { x: number; y: number } | null = null;

  constructor(options: LoupeOptions) {
    this.view = options.view;
    this.onClose = options.onClose;
    this.factorValue = options.factor ?? 2;
    const width = options.width ?? 280;
    const height = options.height ?? 200;
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    const close = button('icon-btn viewer-loupe-close', { 'aria-label': 'Close loupe' }, icon('x'));
    close.addEventListener('click', () => {
      this.close();
    });
    this.label.textContent = `${this.factorValue}×`;
    const title = el(
      'div.viewer-loupe-title',
      null,
      icon('search'),
      el('span', null, 'Loupe'),
      this.label,
      close,
    );
    this.element = el(
      'div.viewer-loupe',
      { role: 'dialog', 'aria-label': 'Loupe', tabindex: -1 },
      title,
      this.canvas,
    );
    this.element.style.left = '24px';
    this.element.style.top = '96px';
    document.body.append(this.element);

    this.installDrag(title);
    this.installKeys();
    const track = (e: PointerEvent): void => {
      this.update(e.clientX, e.clientY);
    };
    this.view.scroller.addEventListener('pointermove', track);
    this.disposers.push(() => {
      this.view.scroller.removeEventListener('pointermove', track);
    });
    this.element.focus();
  }

  get factor(): number {
    return this.factorValue;
  }

  setFactor(factor: number): void {
    this.factorValue = Math.min(16, Math.max(1.5, factor));
    this.label.textContent = `${this.factorValue}×`;
    if (this.lastPoint) this.update(this.lastPoint.x, this.lastPoint.y);
  }

  /** Cycles 2× → 4× → 8× → 2×, which is the whole of Foxit's loupe zoom control. */
  cycleFactor(): number {
    const index = LOUPE_FACTORS.indexOf(this.factorValue);
    this.setFactor(LOUPE_FACTORS[(index + 1) % LOUPE_FACTORS.length] ?? 2);
    return this.factorValue;
  }

  /** Redraws for a pointer position in client coordinates. */
  update(clientX: number, clientY: number): void {
    this.lastPoint = { x: clientX, y: clientY };
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const hit = this.view.hitTest(clientX, clientY);
    ctx.save();
    ctx.fillStyle = readToken('--page-paper');
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    if (!hit) return;
    const page = this.view.pageView(hit.page);
    if (!page) return;
    const source = page.layers.raster;
    const box = source.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    // Where the pointer sits inside the canvas, in the canvas's own device pixels.
    const sx = ((clientX - box.left) / box.width) * source.width;
    const sy = ((clientY - box.top) / box.height) * source.height;
    const scale = (source.width / box.width) * this.factorValue;
    const sw = this.canvas.width / scale;
    const sh = this.canvas.height / scale;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      source,
      sx - sw / 2,
      sy - sh / 2,
      sw,
      sh,
      0,
      0,
      this.canvas.width,
      this.canvas.height,
    );
    // Crosshair so the reader knows exactly what is under the pointer.
    ctx.save();
    ctx.strokeStyle = readToken('--accent');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(this.canvas.width / 2, 0);
    ctx.lineTo(this.canvas.width / 2, this.canvas.height);
    ctx.moveTo(0, this.canvas.height / 2);
    ctx.lineTo(this.canvas.width, this.canvas.height / 2);
    ctx.stroke();
    ctx.restore();
  }

  close(): void {
    for (const d of this.disposers.splice(0)) d();
    this.element.remove();
    this.onClose?.();
  }

  private installDrag(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const box = this.element.getBoundingClientRect();
      const dx = e.clientX - box.left;
      const dy = e.clientY - box.top;
      const move = (ev: PointerEvent): void => {
        this.element.style.left = `${ev.clientX - dx}px`;
        this.element.style.top = `${ev.clientY - dy}px`;
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  private installKeys(): void {
    const onKey = (e: KeyboardEvent): void => {
      const step = e.shiftKey ? 32 : 8;
      const move = (dx: number, dy: number): void => {
        e.preventDefault();
        const box = this.element.getBoundingClientRect();
        this.element.style.left = `${box.left + dx}px`;
        this.element.style.top = `${box.top + dy}px`;
      };
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.key === 'ArrowLeft') move(-step, 0);
      else if (e.key === 'ArrowRight') move(step, 0);
      else if (e.key === 'ArrowUp') move(0, -step);
      else if (e.key === 'ArrowDown') move(0, step);
      else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        this.cycleFactor();
      }
    };
    this.element.addEventListener('keydown', onKey);
    this.disposers.push(() => {
      this.element.removeEventListener('keydown', onKey);
    });
  }
}

/** Reads a theme token as a colour string; the canvas cannot use `var()` directly. */
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'currentColor';
}
