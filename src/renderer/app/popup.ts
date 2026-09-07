/**
 * Popups (M02): dropdown menus, galleries, colour pickers, context menus, key tips and the
 * command palette all open through here. A popup is positioned DOM in the same document —
 * never a portal to another window — with an opaque `--bg-panel` surface, a `--border-strong`
 * outline and the theme's solid `--elevation`.
 *
 * Behaviour: Escape closes the top-most popup; a pointer-down outside every open popup closes
 * them all; focus leaving the chain closes it; closing returns focus to the anchor. Nested
 * popups (submenus) form a chain, so a click inside a child keeps its parents open.
 *
 * `placePopup` is the pure placement maths and is unit-tested.
 */

import { el } from './dom';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export type Placement = 'below' | 'above' | 'right' | 'left';

export interface Placed {
  readonly x: number;
  readonly y: number;
  /** The placement actually used after flipping. */
  readonly placement: Placement;
  /** Popup max height/width if it had to shrink to fit. */
  readonly maxHeight: number;
  readonly maxWidth: number;
}

const GAP = 2;
const MARGIN = 4;

/**
 * Places a popup of `size` next to `anchor` inside `viewport`. Preferred placement is tried
 * first, flipped to the opposite side when it would overflow, and finally clamped so the popup
 * always stays inside the viewport (shrinking if even the larger side is too small).
 */
export function placePopup(
  anchor: Rect,
  size: Size,
  viewport: Size,
  preferred: Placement = 'below',
  align: 'start' | 'end' = 'start',
): Placed {
  const spaceBelow = viewport.height - (anchor.y + anchor.height) - MARGIN;
  const spaceAbove = anchor.y - MARGIN;
  const spaceRight = viewport.width - (anchor.x + anchor.width) - MARGIN;
  const spaceLeft = anchor.x - MARGIN;

  let placement = preferred;
  if (preferred === 'below' && size.height > spaceBelow && spaceAbove > spaceBelow)
    placement = 'above';
  else if (preferred === 'above' && size.height > spaceAbove && spaceBelow > spaceAbove)
    placement = 'below';
  else if (preferred === 'right' && size.width > spaceRight && spaceLeft > spaceRight)
    placement = 'left';
  else if (preferred === 'left' && size.width > spaceLeft && spaceRight > spaceLeft)
    placement = 'right';

  let x: number;
  let y: number;
  let maxHeight = size.height;
  let maxWidth = size.width;
  if (placement === 'below' || placement === 'above') {
    const avail = placement === 'below' ? spaceBelow : spaceAbove;
    maxHeight = Math.max(0, Math.min(size.height, avail));
    y = placement === 'below' ? anchor.y + anchor.height + GAP : anchor.y - GAP - maxHeight;
    x = align === 'start' ? anchor.x : anchor.x + anchor.width - size.width;
  } else {
    const avail = placement === 'right' ? spaceRight : spaceLeft;
    maxWidth = Math.max(0, Math.min(size.width, avail));
    x = placement === 'right' ? anchor.x + anchor.width + GAP : anchor.x - GAP - maxWidth;
    y = align === 'start' ? anchor.y : anchor.y + anchor.height - size.height;
  }
  // Clamp into the viewport on the cross axis (and both axes after a shrink).
  maxWidth = Math.min(maxWidth, viewport.width - 2 * MARGIN);
  maxHeight = Math.min(maxHeight, viewport.height - 2 * MARGIN);
  x = Math.max(MARGIN, Math.min(x, viewport.width - maxWidth - MARGIN));
  y = Math.max(MARGIN, Math.min(y, viewport.height - maxHeight - MARGIN));
  return { x, y, placement, maxHeight, maxWidth };
}

export interface PopupOptions {
  /** Element or point to anchor to. */
  readonly anchor: HTMLElement | { x: number; y: number };
  readonly content: HTMLElement;
  readonly placement?: Placement;
  readonly align?: 'start' | 'end';
  /** ARIA role of the popup container (`menu`, `dialog`, `listbox`, `grid`). */
  readonly role?: string;
  readonly label?: string;
  /** Extra class on the popup container. */
  readonly className?: string;
  /** Parent popup (submenus) — keeps the chain open while the child is open. */
  readonly parent?: PopupHandle | null;
  /** Called after the popup is removed. */
  readonly onClose?: (reason: PopupCloseReason) => void;
  /** Where focus goes when the popup closes (default: the anchor element). */
  readonly restoreFocusTo?: HTMLElement | null;
  /** Focus the first focusable child on open (default true). */
  readonly autoFocus?: boolean;
  /** Keep open when a click lands outside (palette-style popups close only via Esc/select). */
  readonly closeOnOutsideClick?: boolean;
}

export type PopupCloseReason = 'escape' | 'outside' | 'select' | 'blur' | 'programmatic';

export interface PopupHandle {
  readonly element: HTMLElement;
  readonly parent: PopupHandle | null;
  readonly anchorElement: HTMLElement | null;
  close(reason?: PopupCloseReason): void;
  /** Re-run placement (content changed size). */
  reposition(): void;
  readonly isOpen: boolean;
}

const stack: PopupHandle[] = [];
let listenersInstalled = false;

function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  document.addEventListener(
    'pointerdown',
    (e) => {
      const target = e.target as Node | null;
      // Close every popup that neither contains the target nor is an ancestor of one that does.
      for (const p of [...stack].reverse()) {
        if (!p.isOpen) continue;
        if (target && (p.element.contains(target) || descendantContains(p, target))) continue;
        if (target && p.anchorElement?.contains(target)) continue;
        if (!(p as PopupImpl).options.closeOnOutsideClick) continue;
        p.close('outside');
      }
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      const top = topPopup();
      if (!top) return;
      e.preventDefault();
      e.stopPropagation();
      top.close('escape');
    },
    true,
  );
  window.addEventListener('resize', () => {
    for (const p of stack) p.reposition();
  });
}

function descendantContains(parent: PopupHandle, target: Node): boolean {
  return stack.some((p) => p !== parent && isDescendant(p, parent) && p.element.contains(target));
}

function isDescendant(p: PopupHandle, ancestor: PopupHandle): boolean {
  let cur = p.parent;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

/** The most recently opened popup still open. */
export function topPopup(): PopupHandle | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const p = stack[i];
    if (p?.isOpen) return p;
  }
  return null;
}

/** Closes every open popup (used when a command runs or focus jumps regions). */
export function closeAllPopups(reason: PopupCloseReason = 'programmatic'): void {
  for (const p of [...stack].reverse()) p.close(reason);
}

class PopupImpl implements PopupHandle {
  readonly element: HTMLElement;
  readonly parent: PopupHandle | null;
  readonly anchorElement: HTMLElement | null;
  private open = true;
  private readonly focusOut: (e: FocusEvent) => void;
  readonly options: PopupOptions;

  constructor(options: PopupOptions) {
    this.options = options;
    this.parent = options.parent ?? null;
    this.anchorElement = options.anchor instanceof HTMLElement ? options.anchor : null;
    this.element = el('div.popup', {
      role: options.role ?? 'dialog',
      'aria-label': options.label,
      tabindex: -1,
    });
    if (options.className) this.element.classList.add(...options.className.split(' '));
    this.element.append(options.content);
    document.body.append(this.element);
    this.anchorElement?.setAttribute('aria-expanded', 'true');
    this.reposition();
    // Focus leaving the whole chain closes it (keyboard users tabbing away).
    this.focusOut = (e: FocusEvent): void => {
      const next = e.relatedTarget as Node | null;
      if (!next) return;
      if (this.element.contains(next) || descendantContains(this, next)) return;
      if (this.anchorElement?.contains(next)) return;
      this.close('blur');
    };
    this.element.addEventListener('focusout', this.focusOut);
    if (options.autoFocus !== false) {
      const first = this.element.querySelector<HTMLElement>(
        '[tabindex="0"], button:not([disabled]), input, select, [role="menuitem"], [role="option"]',
      );
      (first ?? this.element).focus();
    }
  }

  get isOpen(): boolean {
    return this.open;
  }

  reposition(): void {
    const anchor = this.options.anchor;
    const rect: Rect =
      anchor instanceof HTMLElement
        ? (() => {
            const r = anchor.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height };
          })()
        : { x: anchor.x, y: anchor.y, width: 0, height: 0 };
    this.element.style.maxHeight = '';
    this.element.style.maxWidth = '';
    const size = { width: this.element.offsetWidth, height: this.element.offsetHeight };
    const placed = placePopup(
      rect,
      size,
      { width: window.innerWidth, height: window.innerHeight },
      this.options.placement ?? 'below',
      this.options.align ?? 'start',
    );
    this.element.style.left = `${placed.x}px`;
    this.element.style.top = `${placed.y}px`;
    if (placed.maxHeight < size.height) this.element.style.maxHeight = `${placed.maxHeight}px`;
    if (placed.maxWidth < size.width) this.element.style.maxWidth = `${placed.maxWidth}px`;
    this.element.dataset['placement'] = placed.placement;
  }

  close(reason: PopupCloseReason = 'programmatic'): void {
    if (!this.open) return;
    this.open = false;
    // Children first.
    for (const p of [...stack].reverse()) if (p !== this && isDescendant(p, this)) p.close(reason);
    const hadFocus = this.element.contains(document.activeElement);
    this.element.removeEventListener('focusout', this.focusOut);
    this.element.remove();
    const idx = stack.indexOf(this);
    if (idx >= 0) stack.splice(idx, 1);
    this.anchorElement?.setAttribute('aria-expanded', 'false');
    const restore = this.options.restoreFocusTo ?? this.anchorElement;
    if (hadFocus && restore && reason !== 'blur') restore.focus();
    this.options.onClose?.(reason);
  }
}

/** Opens a popup. See {@link PopupOptions}. */
export function openPopup(options: PopupOptions): PopupHandle {
  installListeners();
  const popup = new PopupImpl({ closeOnOutsideClick: true, ...options });
  stack.push(popup);
  return popup;
}

/** Number of open popups (tests). */
export function openPopupCount(): number {
  return stack.filter((p) => p.isOpen).length;
}
