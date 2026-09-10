/**
 * Layout assertions (M04) — what `toBeVisible()` does not tell you.
 *
 * The operator found five defects by hand in three days that four thousand tests had passed
 * over, and three of them were layout: a start page clipped into the bottom half of the window
 * with its top unreachable, a pane cutting its contents off at the reader's UI scale, and two
 * rows of tabs. Every one of them satisfied `expect(locator).toBeVisible()`, because *visible*
 * says an element has a box on screen — not that a person can read it, reach it or use it.
 *
 * These four helpers say the rest. Each one **names the offending element and both numbers**:
 * a failure that reads "something is clipped" costs the next reader an afternoon.
 *
 * ```ts
 * await expectNothingClipped(app.page.locator('body'));
 * await expectInsideWindow(app.page.locator('#ribbon'));
 * await expectNoOverlap(app.page.locator('#ribbon'), app.page.locator('#doc-area'));
 * await expectReadable(app.page.locator('#pane-left'));
 * ```
 *
 * See `docs/adr/0019-ui-journey-harness.md`.
 */

import { expect, type Locator, type Page } from '@playwright/test';

/** Sub-pixel slack: layout arithmetic lands a fraction of a pixel out all over the place. */
const SLACK = 1.5;

/**
 * Opt-outs. An element carrying `data-allow-clip` (or inside one) is deliberately truncated —
 * a one-line bookmark title with the whole text in its tooltip, say — and is not a defect.
 */
const ALLOW_CLIP = '[data-allow-clip]';

export interface ClipOptions {
  /** Extra selectors to leave alone, on top of `data-allow-clip`. */
  readonly ignore?: ReadonlyArray<string>;
}

export interface ReadableOptions extends ClipOptions {
  /** Contrast floor. The project rule is 4.5:1 for text (PLAN.md §3.2). */
  readonly minContrast?: number;
  /**
   * Check the contrast of the text as well as the translucency (default true).
   *
   * Turn it off over the *document*: the colours of an annotation, and of the page under it,
   * were chosen by whoever made the file and are not this app's to police. The translucency half
   * still applies there, because that half is about what this app draws over them.
   */
  readonly contrast?: boolean;
}

/** One offending element, as the browser side reports it. */
interface Offence {
  readonly what: string;
  readonly where: string;
  readonly detail: string;
}

/**
 * Turns the browser side's answer into lines and asserts there are none.
 *
 * The array is the assertion, so the diff names every offender; the joined message is what
 * Playwright puts at the top of the failure, where it is read first.
 */
function expectNone(title: string, offences: ReadonlyArray<Offence>): void {
  const lines = offences.map((o) => `${title}: ${o.where} — ${o.what} (${o.detail})`);
  expect(lines, lines.join('\n')).toEqual([]);
}

// ---- clipping ----------------------------------------------------------------------------------

/**
 * Nothing inside `scope` is cut off.
 *
 * An element whose content is wider or taller than its own box is clipped, **unless** it is a
 * deliberate scroll container (`overflow: auto | scroll`) — and a scroll container has to be
 * *reachable*: `scrollTop`/`scrollLeft` must return to 0, and the first child's top-left must
 * not sit above or left of the container's own once it has.
 *
 * That last rule is defect 1 (2026-09-10) in one line. `.empty-state` centred its content with
 * `justify-content: center` while scrolling; content taller than the box then overflows at
 * *both* ends and the top can never be scrolled to. The element was visible the whole time.
 */
export async function expectNothingClipped(
  scope: Locator,
  options: ClipOptions = {},
): Promise<void> {
  const offences = await scope.evaluate(
    (root, { slack, allowClip, ignore }) => {
      const out: Offence[] = [];
      const describe = (el: Element): string => {
        const id = el.id ? `#${el.id}` : '';
        const cls =
          typeof el.className === 'string' && el.className
            ? `.${el.className.trim().split(/\s+/).join('.')}`
            : '';
        const host = el.closest('[id]');
        const within = host && host !== el ? ` in #${host.id}` : '';
        return `${el.tagName.toLowerCase()}${id}${cls}${within}`;
      };
      const skip = (el: Element): boolean =>
        el.closest(allowClip) !== null || ignore.some((sel) => el.closest(sel) !== null);
      /**
       * The visually-hidden idiom — a 1×1 absolutely-positioned box with `clip: rect(0 0 0 0)`.
       * `.sr-only`, the QAT's labels and the whole ribbon in compact mode use it: the text is
       * *meant* to overflow a box nobody looks at, and the reader gets it from the icon and the
       * tooltip instead. `clip` is the tell; nothing else in this app sets it.
       */
      const visuallyHidden = (s: CSSStyleDeclaration): boolean =>
        s.getPropertyValue('clip') !== 'auto';

      const all = [root, ...root.querySelectorAll('*')];
      for (const node of all) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.getClientRects().length === 0) continue;
        if (skip(node)) continue;
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden') continue;
        if (visuallyHidden(style)) continue;
        const scrollsX = style.overflowX === 'auto' || style.overflowX === 'scroll';
        const scrollsY = style.overflowY === 'auto' || style.overflowY === 'scroll';
        // Only a box that actually *clips* can cut anything off. Content spilling out of an
        // `overflow: visible` box is still painted and still readable — whether it then leaves
        // the window is `expectInsideWindow`'s question, not this one. Getting this wrong is
        // how the check drowns in noise: every absolutely-positioned thumbnail cell and every
        // page root reports a two-pixel "overflow" that is pure integer rounding.
        const clipsX = style.overflowX === 'hidden' || style.overflowX === 'clip';
        const clipsY = style.overflowY === 'hidden' || style.overflowY === 'clip';
        const overX = node.clientWidth > 0 && node.scrollWidth > node.clientWidth + slack;
        const overY = node.clientHeight > 0 && node.scrollHeight > node.clientHeight + slack;

        // Truncation with the whole string one hover away is a design choice — a long bookmark
        // title cut to one line. Truncation with nowhere to read the rest is a defect.
        const truncates =
          style.textOverflow === 'ellipsis' && node.closest('[title]:not([title=""])') !== null;
        // A text field scrolls to the caret by design, and Chrome's `scrollWidth` for one is a
        // few pixels over its `clientWidth` even when the value fits — measured, not assumed:
        // "100%" is 27 px in a 30 px box and the input still reports 33.
        const textField = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;

        if (overX && clipsX && !truncates && !textField) {
          out.push({
            what: 'content is cut off at the right edge of its box',
            where: describe(node),
            detail:
              `scrollWidth ${node.scrollWidth} > clientWidth ${node.clientWidth} ` +
              `(overflow-x: ${style.overflowX})`,
          });
        }
        if (overY && clipsY) {
          out.push({
            what: 'content is cut off at the bottom of its box',
            where: describe(node),
            detail:
              `scrollHeight ${node.scrollHeight} > clientHeight ${node.clientHeight} ` +
              `(overflow-y: ${style.overflowY})`,
          });
        }

        // A scroll container that overflows has to be reachable in the direction it overflows.
        if (!(scrollsX && overX) && !(scrollsY && overY)) continue;
        const wasTop = node.scrollTop;
        const wasLeft = node.scrollLeft;
        node.scrollTop = 0;
        node.scrollLeft = 0;
        const top = node.scrollTop;
        const left = node.scrollLeft;
        const box = node.getBoundingClientRect();
        // The first child that is actually laid out: a panel host keeps every panel it has ever
        // mounted and hides all but one, and a `display: none` box reports a rect of all zeros.
        const first = Array.from(node.children).find((c) => c.getClientRects().length > 0);
        const child = first?.getBoundingClientRect() ?? null;
        node.scrollTop = wasTop;
        node.scrollLeft = wasLeft;

        if (scrollsY && overY && top > slack) {
          out.push({
            what: 'a scroll container cannot be scrolled back to the top',
            where: describe(node),
            detail: `scrollTop stuck at ${top}`,
          });
        }
        if (scrollsX && overX && left > slack) {
          out.push({
            what: 'a scroll container cannot be scrolled back to the left',
            where: describe(node),
            detail: `scrollLeft stuck at ${left}`,
          });
        }
        // The content box, not the border box: the first child starts inside the padding.
        const contentTop = box.top + node.clientTop + Number.parseFloat(style.paddingTop || '0');
        const contentLeft =
          box.left + node.clientLeft + Number.parseFloat(style.paddingLeft || '0');
        if (child && scrollsY && overY && child.top < contentTop - slack) {
          out.push({
            what: 'the top of a scrolling box is above its scroll origin, so it can never be reached',
            where: describe(node),
            detail: `first child top ${Math.round(child.top)} vs content top ${Math.round(contentTop)}`,
          });
        }
        if (child && scrollsX && overX && child.left < contentLeft - slack) {
          out.push({
            what: 'the left of a scrolling box is left of its scroll origin, so it can never be reached',
            where: describe(node),
            detail: `first child left ${Math.round(child.left)} vs content left ${Math.round(contentLeft)}`,
          });
        }
      }
      return out;
    },
    { slack: SLACK, allowClip: ALLOW_CLIP, ignore: options.ignore ?? [] },
  );
  expectNone('clipped', offences);
}

// ---- inside the window --------------------------------------------------------------------------

/**
 * Everything visible inside `scope` lies within the window, and the body never scrolls sideways.
 *
 * Elements inside a scrolling ancestor are that container's business — {@link
 * expectNothingClipped} covers whether they can be reached — so only elements the *viewport*
 * itself positions are checked.
 */
export async function expectInsideWindow(scope: Locator, options: ClipOptions = {}): Promise<void> {
  const offences = await scope.evaluate(
    (root, { slack, allowClip, ignore }) => {
      const out: Offence[] = [];
      const describe = (el: Element): string => {
        const id = el.id ? `#${el.id}` : '';
        const cls =
          typeof el.className === 'string' && el.className
            ? `.${el.className.trim().split(/\s+/).join('.')}`
            : '';
        return `${el.tagName.toLowerCase()}${id}${cls}`;
      };
      const scrolled = (el: HTMLElement): boolean => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          const x = s.overflowX === 'auto' || s.overflowX === 'scroll';
          const y = s.overflowY === 'auto' || s.overflowY === 'scroll';
          if (x && p.scrollWidth > p.clientWidth + 1) return true;
          if (y && p.scrollHeight > p.clientHeight + 1) return true;
        }
        return false;
      };
      const w = window.innerWidth;
      const h = window.innerHeight;
      for (const node of [root, ...root.querySelectorAll('*')]) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.getClientRects().length === 0) continue;
        if (node.closest(allowClip) !== null) continue;
        if (ignore.some((sel) => node.closest(sel) !== null)) continue;
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden') continue;
        // Visually hidden (`clip: rect(0 0 0 0)`): a 1x1 box parked wherever the layout put it,
        // which no reader ever sees. See `expectNothingClipped`.
        if (style.getPropertyValue('clip') !== 'auto') continue;
        if (scrolled(node)) continue;
        const r = node.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const over: string[] = [];
        if (r.left < -slack) over.push(`left ${Math.round(r.left)}`);
        if (r.top < -slack) over.push(`top ${Math.round(r.top)}`);
        if (r.right > w + slack) over.push(`right ${Math.round(r.right)} > ${w}`);
        if (r.bottom > h + slack) over.push(`bottom ${Math.round(r.bottom)} > ${h}`);
        if (over.length > 0) {
          out.push({
            what: 'is outside the window',
            where: describe(node),
            detail: `${over.join(', ')} (window ${w}x${h})`,
          });
        }
      }
      const body = document.body;
      if (body.scrollWidth > w + slack) {
        out.push({
          what: 'the window scrolls sideways',
          where: 'body',
          detail: `scrollWidth ${body.scrollWidth} > innerWidth ${w}`,
        });
      }
      return out;
    },
    { slack: SLACK, allowClip: ALLOW_CLIP, ignore: options.ignore ?? [] },
  );
  expectNone('outside', offences);
}

// ---- no overlap ---------------------------------------------------------------------------------

/**
 * Two regions do not overlap — the window chrome against the content it must not sit on top of.
 *
 * Defect 4 was Electron drawing its application menu inside the window, above the ribbon, so
 * the reader saw two rows of tabs. Nothing looked at the chrome; this is how you look at it.
 */
export async function expectNoOverlap(a: Locator, b: Locator): Promise<void> {
  const [ra, rb] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  expect(ra, `${String(a)} has no box to compare`).not.toBeNull();
  expect(rb, `${String(b)} has no box to compare`).not.toBeNull();
  if (!ra || !rb) return;
  const overlapX = Math.min(ra.x + ra.width, rb.x + rb.width) - Math.max(ra.x, rb.x);
  const overlapY = Math.min(ra.y + ra.height, rb.y + rb.height) - Math.max(ra.y, rb.y);
  const overlaps = overlapX > SLACK && overlapY > SLACK;
  expect(
    overlaps,
    `${String(a)} ${JSON.stringify(ra)} overlaps ${String(b)} ${JSON.stringify(rb)} ` +
      `by ${Math.round(overlapX)}x${Math.round(overlapY)} px`,
  ).toBe(false);
}

// ---- readable ------------------------------------------------------------------------------------

/**
 * Text inside `scope` clears the contrast floor, and nothing anywhere in it is translucent.
 *
 * The translucency half is the modal rule from `CLAUDE.md` — no `opacity < 1`, no `rgba()`
 * alpha, no `backdrop-filter` — which four specs each carried their own copy of. This is that
 * copy, in one place: `annotations`, `comments`, `drawing` and `preferences` call it now.
 *
 * The contrast half compares each element's own text colour against the first opaque background
 * behind it. Elements painted over a gradient or an image are skipped: there is no single
 * background colour to compare against, and the theme tests own the token pairs anyway.
 */
export async function expectReadable(scope: Locator, options: ReadableOptions = {}): Promise<void> {
  const offences = await scope.evaluate(
    (root, { minContrast, checkContrast, allowClip, ignore }) => {
      const out: Offence[] = [];
      const describe = (el: Element): string => {
        const id = el.id ? `#${el.id}` : '';
        const cls =
          typeof el.className === 'string' && el.className
            ? `.${el.className.trim().split(/\s+/).join('.')}`
            : '';
        return `${el.tagName.toLowerCase()}${id}${cls}`;
      };

      /** `rgb(r g b / a)` or `rgba(r, g, b, a)` → channels, or null when it is not a colour. */
      const parse = (value: string): [number, number, number, number] | null => {
        const m = /\(([^)]*)\)/.exec(value);
        if (!m) return null;
        const parts = (m[1] ?? '')
          .split(/[,/]/)
          .map((p) => p.trim())
          .filter((p) => p !== '');
        if (parts.length < 3) return null;
        const n = (raw: string): number =>
          raw.endsWith('%') ? (Number.parseFloat(raw) / 100) * 255 : Number.parseFloat(raw);
        const alphaRaw = parts[3];
        const alpha =
          alphaRaw === undefined
            ? 1
            : alphaRaw.endsWith('%')
              ? Number.parseFloat(alphaRaw) / 100
              : Number.parseFloat(alphaRaw);
        const rgb: [number, number, number, number] = [
          n(parts[0] ?? '0'),
          n(parts[1] ?? '0'),
          n(parts[2] ?? '0'),
          Number.isNaN(alpha) ? 1 : alpha,
        ];
        return rgb.some((c) => Number.isNaN(c)) ? null : rgb;
      };

      const luminance = (r: number, g: number, b: number): number => {
        const channel = (c: number): number => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const ratio = (fg: [number, number, number], bg: [number, number, number]): number => {
        const a = luminance(fg[0], fg[1], fg[2]);
        const b = luminance(bg[0], bg[1], bg[2]);
        const [hi, lo] = a > b ? [a, b] : [b, a];
        return (hi + 0.05) / (lo + 0.05);
      };

      // ---- translucency: the modal rule --------------------------------------------------------
      const COLOUR_PROPS = [
        'color',
        'background-color',
        'border-top-color',
        'border-right-color',
        'border-bottom-color',
        'border-left-color',
        'outline-color',
        'fill',
        'stroke',
      ];
      const nodes = [root, ...root.querySelectorAll('*')];
      for (const node of nodes) {
        if (!(node instanceof Element)) continue;
        if (node.closest(allowClip) !== null) continue;
        if (ignore.some((sel) => node.closest(sel) !== null)) continue;
        const style = getComputedStyle(node);
        if (Number.parseFloat(style.opacity) < 1) {
          out.push({
            what: 'is translucent',
            where: describe(node),
            detail: `opacity ${style.opacity}`,
          });
        }
        if (style.backdropFilter && style.backdropFilter !== 'none') {
          out.push({
            what: 'uses a backdrop filter',
            where: describe(node),
            detail: style.backdropFilter,
          });
        }
        for (const prop of COLOUR_PROPS) {
          const parsed = parse(style.getPropertyValue(prop));
          // Fully transparent is "paint nothing", not translucency: SVG `fill: none` computes
          // to `rgba(0, 0, 0, 0)`.
          if (parsed && parsed[3] > 0 && parsed[3] < 1) {
            out.push({
              what: `has a translucent ${prop}`,
              where: describe(node),
              detail: style.getPropertyValue(prop),
            });
          }
        }
      }

      // ---- contrast -----------------------------------------------------------------------------
      if (!checkContrast) return out;
      const backgroundOf = (el: Element): [number, number, number] | null => {
        for (let p: Element | null = el; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (s.backgroundImage !== 'none') return null;
          const c = parse(s.backgroundColor);
          if (c?.[3] === 1) return [c[0], c[1], c[2]];
        }
        return null;
      };
      const hasOwnText = (el: Element): boolean => {
        for (const child of el.childNodes) {
          if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== '') {
            return true;
          }
        }
        return false;
      };
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.closest(allowClip) !== null) continue;
        if (ignore.some((sel) => node.closest(sel) !== null)) continue;
        if (!hasOwnText(node)) continue;
        if (node.getClientRects().length === 0) continue;
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden') continue;
        const fg = parse(style.color);
        // Deliberately invisible text: the viewer's text layer sits over the raster so a
        // selection can be made, and is transparent by design.
        if (!fg || fg[3] === 0) continue;
        const bg = backgroundOf(node);
        if (!bg) continue;
        const r = ratio([fg[0], fg[1], fg[2]], bg);
        if (r < minContrast) {
          out.push({
            what: 'text is below the contrast floor',
            where: describe(node),
            detail:
              `${r.toFixed(2)}:1 (needs ${minContrast}:1) — ` +
              `${style.color} on rgb(${bg.map(Math.round).join(', ')}), ` +
              `text "${(node.textContent ?? '').trim().slice(0, 40)}"`,
          });
        }
      }
      return out;
    },
    {
      minContrast: options.minContrast ?? 4.5,
      checkContrast: options.contrast ?? true,
      allowClip: ALLOW_CLIP,
      ignore: options.ignore ?? [],
    },
  );
  expectNone('unreadable', offences);
}

/**
 * The whole window at once: nothing clipped, nothing outside it, and the chrome not sitting on
 * the document. Every journey ends with this.
 */
export async function expectWindowSound(page: Page, options: ClipOptions = {}): Promise<void> {
  const body = page.locator('body');
  await expectNothingClipped(body, options);
  await expectInsideWindow(body, options);
}
