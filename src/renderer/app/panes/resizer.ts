/**
 * Pane splitter (M02): a vertical `role="separator"` between a pane and the document area.
 * Pointer drag (with capture, so Playwright and touch both work) and keyboard (arrows resize by
 * 16 px, Shift+arrows by 64 px, Home/End to min/max) both go through `setWidth`, so persistence
 * and clamping live in one place.
 */

import { el } from '../dom';
import { PANE_MAX_WIDTH, PANE_MIN_WIDTH } from '../ui/UiState';

export interface ResizerOptions {
  /** Which side of the document area the pane sits on. */
  readonly side: 'left' | 'right';
  readonly label: string;
  readonly getWidth: () => number;
  readonly setWidth: (width: number) => void;
  /** Double-click / Enter collapses or expands. */
  readonly onToggle?: () => void;
}

export function createResizer(options: ResizerOptions): HTMLElement {
  const handle = el('div.pane-resizer', {
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': options.label,
    'aria-valuemin': PANE_MIN_WIDTH,
    'aria-valuemax': PANE_MAX_WIDTH,
    'aria-valuenow': options.getWidth(),
    tabindex: 0,
    'data-side': options.side,
  });
  const sync = (): void => {
    handle.setAttribute('aria-valuenow', String(options.getWidth()));
  };

  let startX = 0;
  let startWidth = 0;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startWidth = options.getWidth();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing-pane');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    const delta = e.clientX - startX;
    options.setWidth(startWidth + (options.side === 'left' ? delta : -delta));
    sync();
  });
  const end = (e: PointerEvent): void => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    handle.releasePointerCapture(e.pointerId);
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing-pane');
    sync();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => {
    options.onToggle?.();
  });
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 64 : 16;
    const grow = options.side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = options.side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key === grow) options.setWidth(options.getWidth() + step);
    else if (e.key === shrink) options.setWidth(options.getWidth() - step);
    else if (e.key === 'Home') options.setWidth(PANE_MIN_WIDTH);
    else if (e.key === 'End') options.setWidth(PANE_MAX_WIDTH);
    else if (e.key === 'Enter') options.onToggle?.();
    else return;
    e.preventDefault();
    sync();
  });
  return handle;
}
