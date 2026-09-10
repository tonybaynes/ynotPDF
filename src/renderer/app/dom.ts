/**
 * Tiny DOM helpers for the shell (M02). No framework: elements are created directly and kept
 * in closures; state flows in through Store subscriptions.
 */

export type Attrs = Readonly<Record<string, string | number | boolean | undefined>>;

/** `el('button.btn.primary#save', { type: 'button' }, 'Save')`. */
export function el<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}.${string}` | `${K}#${string}`,
  attrs?: Attrs | null,
  ...children: ReadonlyArray<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const [tagAndId, ...classes] = spec.split('.');
  const [tag, id] = (tagAndId ?? 'div').split('#');
  const element = document.createElement(tag as K);
  if (id) element.id = id;
  if (classes.length) element.className = classes.join(' ');
  if (attrs) setAttrs(element, attrs);
  append(element, ...children);
  return element;
}

export function setAttrs(element: Element, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) element.removeAttribute(key);
    else if (value === true) element.setAttribute(key, '');
    else element.setAttribute(key, String(value));
  }
}

export function append(
  parent: Node,
  ...children: ReadonlyArray<Node | string | null | undefined | false>
): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

/** Screen-reader-only text (the visual state is carried by an icon or colour *plus* this). */
export function srOnly(text: string): HTMLElement {
  return el('span.sr-only', null, text);
}

/** A `<button type="button">` with the given classes. */
export function button(
  classes: string,
  attrs?: Attrs | null,
  ...children: ReadonlyArray<Node | string | null | undefined | false>
): HTMLButtonElement {
  const spec = classes ? (`button.${classes}` as const) : 'button';
  const b = el(spec, { type: 'button', ...attrs });
  append(b, ...children);
  return b;
}

/** Focusable descendants in DOM order (visible ones only). */
export function focusables(root: ParentNode): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), ' +
    '[contenteditable="true"]';
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(isVisible);
}

export function isVisible(element: HTMLElement): boolean {
  if (element.hidden) return false;
  if (element.closest('[hidden]')) return false;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return element.getClientRects().length > 0;
}

/** True while the element (or something inside it) has focus. */
export function containsFocus(element: Element): boolean {
  return element.contains(document.activeElement);
}

/** Removes every child. */
export function clear(element: Element): void {
  element.replaceChildren();
}

/** The closest ancestor (or self) carrying `data-region`. */
export function regionOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>('[data-region]')?.dataset['region'] ?? null;
}

/** Simple debounce for persistence writes. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { flush(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: A | null = null;
  const wrapped = (...args: A): void => {
    last = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (last) fn(...last);
      last = null;
    }, ms);
  };
  wrapped.flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (last) fn(...last);
    last = null;
  };
  wrapped.cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    last = null;
  };
  return wrapped;
}

/**
 * The live `--ui-scale` factor (1 = 100%).
 *
 * Everything inside a pane is sized in rem, so it grows with the reader's UI scale — but a pane
 * whose width is a fixed pixel count does not, and its contents are then cut off at the edge
 * (the operator's right pane at 280 px, 2026-09-10). Pane widths are therefore stored at scale 1
 * and multiplied by this on the way to the DOM.
 */
export function uiScaleFactor(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--ui-scale');
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
