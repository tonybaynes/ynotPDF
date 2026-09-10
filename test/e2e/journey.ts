/**
 * UI-journey helpers (M04) — driving the app the way a person drives it.
 *
 * The suite drove the app through its command API and asserted that things existed; the
 * operator drove it through the UI and found five defects in three days. A stamp that would not
 * go on the page is the clearest of them: every stamp test called `draw.stamp` **with
 * coordinates**, so nothing had ever clicked a tile and then a page, and the one path a reader
 * actually takes was the one path nothing covered.
 *
 * So: a journey presses a ribbon button **by its visible label**, clicks a panel tile, clicks a
 * page. `app.run(...)` is for *setup* — opening a file, seeding an identity — never for the
 * action under test.
 *
 * ```ts
 * const j = journey(app);
 * await j.clickRibbon('comment', 'Rectangle');
 * await j.dragOnPage([80, 120], [220, 260]);
 * await j.answerIdentityIfAsked('E2E Reader');
 * ```
 *
 * **Every helper asserts the thing it clicked was actually hit.** Playwright's actionability
 * retry ends in a pass often enough that an "intercepts pointer events" goes unnoticed, so each
 * helper hit-tests the point first and says what is covering the target when it is not reachable.
 *
 * See `docs/adr/0019-ui-journey-harness.md`.
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { App } from './harness';

/** A point in page coordinates: CSS pixels from the page element's top-left corner. */
export type PagePoint = readonly [x: number, y: number];

/**
 * A point as a fraction of the page, 0–1 in each axis.
 *
 * Prefer this over pixels for anything aimed at the *content* of a page. The viewer re-fits the
 * page whenever the window around it changes, and it changes more often than you would think:
 * the first annotation opens the properties pane, which took the page from 1006x1423 to
 * 720x1019 mid-journey and left every pixel coordinate measured beforehand pointing at the
 * wrong line (M04, 2026-09-10). The aspect ratio is what survives.
 */
export type PageFraction = readonly [fx: number, fy: number];

/**
 * Asserts the point is really the target's, then clicks it.
 *
 * `elementFromPoint` answers with whatever the reader's pointer would land on. If that is not
 * the target or something inside it, the click would be intercepted — and the failure says what
 * is on top rather than timing out with "element is not stable".
 */
export async function clickHere(target: Locator, point?: { x: number; y: number }): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  expect(box, `${String(target)} has no box to click`).not.toBeNull();
  if (!box) return;
  const at = point ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const covering = await target.evaluate(
    (el, p) => {
      const hit = document.elementFromPoint(p.x, p.y);
      if (!hit) return 'nothing at all (the point is outside the window)';
      if (hit === el || el.contains(hit)) return null;
      const describe = (n: Element): string => {
        const id = n.id ? `#${n.id}` : '';
        const cls =
          typeof n.className === 'string' && n.className
            ? `.${n.className.trim().split(/\s+/).join('.')}`
            : '';
        return `${n.tagName.toLowerCase()}${id}${cls}`;
      };
      return describe(hit);
    },
    { x: at.x, y: at.y },
  );
  expect(
    covering,
    `${String(target)} is covered at (${Math.round(at.x)}, ${Math.round(at.y)}) by ${String(covering)}`,
  ).toBeNull();
  await target.page().mouse.click(at.x, at.y);
}

export interface Journey {
  /** Opens a PDF. Setup, not an action under test: the Open dialog is the OS's, not ours. */
  openDocument(path: string): Promise<void>;
  /** Selects a ribbon tab and presses a button by its **visible label**. */
  clickRibbon(tab: string, label: string): Promise<void>;
  /** Shows a left navigation panel by clicking its strip button. */
  openPanel(id: string): Promise<void>;
  /** Clicks something inside an open panel — a thumbnail, a stamp tile, a search hit. */
  clickPanelTile(panel: string, selector: string): Promise<void>;
  /** Clicks a point on a rendered page, in page coordinates. */
  clickPage(point: PagePoint, pageIndex?: number): Promise<void>;
  /** Drags across a rendered page, in page coordinates. */
  dragOnPage(from: PagePoint, to: PagePoint, pageIndex?: number): Promise<void>;
  /** Clicks a point given as a fraction of the page — see {@link PageFraction}. */
  clickPageAt(point: PageFraction, pageIndex?: number): Promise<void>;
  /** Drags between two points given as fractions of the page — see {@link PageFraction}. */
  dragOnPageAt(from: PageFraction, to: PageFraction, pageIndex?: number): Promise<void>;
  /**
   * Drags one element onto another — a thumbnail onto its new place in the order.
   *
   * `after: true` drops *past* the target rather than on it. A reorder decides "before or after"
   * from which half of the target the pointer is in, so a drop on the target's centre is a
   * no-op and reads exactly like a drag that did not work.
   */
  dragElement(from: Locator, to: Locator, options?: { readonly after?: boolean }): Promise<void>;
  /**
   * The first annotation opens the identity dialog. A journey has to answer it rather than hang
   * on it, and answering it *is* part of what a person does the first time they comment.
   */
  answerIdentityIfAsked(name: string): Promise<boolean>;
  /** The page element for an index, waiting for it to be rendered. */
  page(index?: number): Locator;
  /** The bounding box of a rendered page. */
  pageBox(index?: number): Promise<{ x: number; y: number; width: number; height: number }>;
  /** Presses a dialog's footer button by its visible label. */
  clickDialogButton(dialog: string, label: string): Promise<void>;
}

export function journey(app: App): Journey {
  const page = app.page;

  const pageLocator = (index = 0): Locator =>
    page.locator(`.viewer-content .page[data-page="${index}"]`).first();

  const pageBox = async (
    index = 0,
  ): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  }> => {
    const el = pageLocator(index);
    await el.waitFor({ state: 'visible' });
    await el.scrollIntoViewIfNeeded();
    const box = await el.boundingBox();
    expect(box, `page ${index} has no box`).not.toBeNull();
    return box ?? { x: 0, y: 0, width: 0, height: 0 };
  };

  const openDocument = async (path: string): Promise<void> => {
    const bytes = Array.from(readFileSync(path));
    await app.run('file.openBytes', { file: { path, name: basename(path), bytes } });
    // A rendered page, or a portfolio's file list: a portfolio opens on its contents rather than
    // on its cover sheet, so waiting for a page there waits forever. Polled rather than given as
    // one selector, because the portfolio's grid element is in the DOM (hidden) either way and a
    // comma selector would settle on it and then wait for it to appear.
    await expect
      .poll(
        async () => {
          const shown = async (selector: string): Promise<boolean> =>
            page
              .locator(selector)
              .first()
              .isVisible()
              .catch(() => false);
          return (
            (await shown('.viewer-content .page')) ||
            (await shown('[data-testid="portfolio-grid"]'))
          );
        },
        { timeout: 30_000, message: 'the document never appeared' },
      )
      .toBe(true);
    await page.waitForTimeout(250);
  };

  const clickRibbon = async (tab: string, label: string): Promise<void> => {
    const tabButton = page.locator(`#ribbon-tabs [data-tab="${tab}"]`);
    await expect(tabButton, `the ribbon has no "${tab}" tab`).toHaveCount(1);
    if ((await tabButton.getAttribute('aria-selected')) !== 'true') await clickHere(tabButton);
    await expect(tabButton).toHaveAttribute('aria-selected', 'true');
    const body = page.locator('#ribbon-body');
    await expect(
      body,
      'the ribbon body is closed — a minimised ribbon hides every button',
    ).toBeVisible();

    // One round trip, not one per button: the Comment tab alone has sixty of them, and a
    // per-button `textContent()` on a control that has no `.rb-label` waits out the whole
    // locator timeout before telling you so.
    const found = await body.evaluate((root, wanted) => {
      const buttons = Array.from(root.querySelectorAll('.rb-btn'));
      const labels: string[] = [];
      let onScreen = -1;
      let split = -1;
      // The group this button is in, when the group collapsed and the button is inside the
      // opener's popup rather than on the ribbon. That is where the reader finds it too.
      const collapsedIn: { group: string | null } = { group: null };
      buttons.forEach((node, i) => {
        if (!(node instanceof HTMLButtonElement)) return;
        // A collapsed group's opener carries the *group's* name, not a button's. "Comments" is
        // both the Comments-panel button and the label of the group that holds Import/Export,
        // and matching the opener pressed the wrong thing entirely.
        if (node.classList.contains('rb-collapsed-btn')) return;
        const text = (
          node.querySelector('.rb-label')?.textContent ??
          node.textContent ??
          ''
        ).trim();
        const drawn = node.getClientRects().length > 0;
        if (!node.disabled && drawn && text !== '') labels.push(text);
        // Exact, or the button's own label with a dynamic tail: "Undo" is drawn as "Undo Move
        // page" once there is something to undo (ADR 0008).
        const lower = text.toLowerCase();
        if (node.disabled || (lower !== wanted && !lower.startsWith(`${wanted} `))) return;
        if (!drawn) {
          const collapsed = node.closest('.rb-group.rb-collapsed');
          if (collapsed instanceof HTMLElement && collapsedIn.group === null) {
            collapsedIn.group = collapsed.dataset['group'] ?? null;
          }
          return;
        }
        // A split button renders the label twice — the half that carries the command wins.
        if (node.dataset['command'] !== undefined && onScreen < 0) onScreen = i;
        else if (split < 0) split = i;
      });
      // A button hidden inside a collapsed group beats a same-labelled one that is only the
      // other half of a split button: the collapsed one is the command the reader wants.
      const index = onScreen >= 0 ? onScreen : collapsedIn.group !== null ? -1 : split;
      return { index, group: collapsedIn.group, labels };
    }, label.trim().toLowerCase());

    if (found.index < 0 && found.group !== null) {
      // The group did not fit and collapsed into one large button. Open it, then press the
      // button inside — exactly the two clicks a reader makes at that window width.
      await clickHere(body.locator(`[data-rb-focus="group:${found.group}"]`));
      const popup = page.locator('.rb-group-popup').last();
      const inPopup = popup.locator('.rb-btn:not(:disabled)').filter({ hasText: label });
      await expect(
        inPopup.first(),
        `"${label}" was not in the collapsed "${found.group}" group's popup`,
      ).toBeVisible();
      await clickHere(inPopup.first());
      return;
    }
    expect(
      found.index,
      `no enabled ribbon button labelled "${label}" on the ${tab} tab — ` +
        `the tab shows: ${found.labels.join(' | ')}`,
    ).toBeGreaterThanOrEqual(0);
    await clickHere(body.locator('.rb-btn').nth(found.index));
  };

  const openPanel = async (id: string): Promise<void> => {
    const strip = page.locator(`#nav-strip button[data-panel="${id}"]`);
    await expect(strip, `there is no "${id}" panel in the navigation strip`).toHaveCount(1);
    // Clicking the panel that is already open collapses the pane, which is not what was asked.
    if ((await strip.getAttribute('aria-pressed')) !== 'true') await clickHere(strip);
    await expect(strip).toHaveAttribute('aria-pressed', 'true');
    const panel = page.locator(`#nav-host .panel[data-panel="${id}"]`);
    await expect(panel, `the "${id}" panel did not mount`).toBeVisible();
  };

  const clickPanelTile = async (panel: string, selector: string): Promise<void> => {
    const tile = page.locator(`#nav-host .panel[data-panel="${panel}"] ${selector}`).first();
    await expect(tile, `no "${selector}" in the ${panel} panel`).toHaveCount(1);
    await clickHere(tile);
  };

  /**
   * Scrolls the viewer until a point on the page is inside the window, and answers with where it
   * ended up on screen.
   *
   * A page is routinely taller than the window — the middle of an A4 page at fit-width is below
   * the fold — and a click aimed there lands outside the window entirely. The reader scrolls
   * first, so the journey does too.
   */
  const screenPointOf = async (
    point: PagePoint,
    index: number,
  ): Promise<{ x: number; y: number }> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const box = await pageBox(index);
      const at = { x: box.x + point[0], y: box.y + point[1] };
      const size = page.viewportSize() ?? { width: 0, height: 0 };
      const inside =
        at.x >= 0 &&
        at.y >= 0 &&
        (size.width === 0 || at.x < size.width) &&
        (size.height === 0 || at.y < size.height);
      const room = await pageLocator(index).evaluate((el, p) => {
        const hit = document.elementFromPoint(p.x, p.y);
        return hit !== null && (hit === el || el.contains(hit));
      }, at);
      if (inside && room) return at;
      // Put the wanted point in the middle of whatever scrolls the page.
      await pageLocator(index).evaluate(
        (el, p) => {
          const box2 = el.getBoundingClientRect();
          for (let n: HTMLElement | null = el.parentElement; n; n = n.parentElement) {
            const s = getComputedStyle(n);
            if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') continue;
            const view = n.getBoundingClientRect();
            n.scrollTop += box2.top + p.y - (view.top + view.height / 2);
            return;
          }
        },
        { x: point[0], y: point[1] },
      );
      await page.waitForTimeout(200);
    }
    const box = await pageBox(index);
    return { x: box.x + point[0], y: box.y + point[1] };
  };

  const clickPage = async (point: PagePoint, index = 0): Promise<void> => {
    const at = await screenPointOf(point, index);
    await clickHere(pageLocator(index), at);
    await page.waitForTimeout(150);
  };

  const dragOnPage = async (from: PagePoint, to: PagePoint, index = 0): Promise<void> => {
    const start = await screenPointOf(from, index);
    const box = await pageBox(index);
    const covering = await pageLocator(index).evaluate((el, p) => {
      const hit = document.elementFromPoint(p.x, p.y);
      if (!hit) return 'nothing at all (the point is outside the window)';
      return hit === el || el.contains(hit) ? null : hit.tagName.toLowerCase();
    }, start);
    expect(
      covering,
      `the page is covered at the start of the drag by ${String(covering)}`,
    ).toBeNull();
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(250);
  };

  const toPixels = async (point: PageFraction, index: number): Promise<PagePoint> => {
    const box = await pageBox(index);
    return [point[0] * box.width, point[1] * box.height];
  };

  const clickPageAt = async (point: PageFraction, index = 0): Promise<void> => {
    await clickPage(await toPixels(point, index), index);
  };

  const dragOnPageAt = async (from: PageFraction, to: PageFraction, index = 0): Promise<void> => {
    await dragOnPage(await toPixels(from, index), await toPixels(to, index), index);
  };

  const dragElement = async (
    from: Locator,
    to: Locator,
    options: { readonly after?: boolean } = {},
  ): Promise<void> => {
    await from.scrollIntoViewIfNeeded();
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    expect(a, 'the element being dragged has no box').not.toBeNull();
    expect(b, 'the drop target has no box').not.toBeNull();
    if (!a || !b) return;
    // Past the target, or onto it. "Past" is the far corner of both axes, because a grid can be
    // laid out either way and the insertion point is decided by which half the pointer is in.
    const target =
      options.after === true
        ? { x: b.x + b.width * 0.9, y: b.y + b.height * 0.75 }
        : { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    // Several moves: a drag that jumps in one step never fires the drag-over the reorder needs.
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(
        a.x + a.width / 2 + ((target.x - a.x - a.width / 2) * i) / 8,
        a.y + a.height / 2 + ((target.y - a.y - a.height / 2) * i) / 8,
      );
    }
    await page.mouse.up();
    await page.waitForTimeout(300);
  };

  const answerIdentityIfAsked = async (name: string): Promise<boolean> => {
    const dialog = page.locator('#annot-identity');
    try {
      await dialog.waitFor({ state: 'visible', timeout: 1500 });
    } catch {
      return false;
    }
    await dialog.locator('input[type="text"]').first().fill(name);
    await clickHere(dialog.locator('[data-result="ok"]'));
    await expect(dialog).toHaveCount(0);
    return true;
  };

  const clickDialogButton = async (dialog: string, label: string): Promise<void> => {
    // `.dlg-footer` is M02's dialog service; `.actions` is M00's hand-built About box.
    const button = page
      .locator(`${dialog} .dlg-footer button, ${dialog} .actions button`)
      .filter({ hasText: label })
      .first();
    await expect(button, `no "${label}" button in ${dialog}`).toHaveCount(1);
    await clickHere(button);
  };

  return {
    openDocument,
    clickRibbon,
    openPanel,
    clickPanelTile,
    clickPage,
    dragOnPage,
    clickPageAt,
    dragOnPageAt,
    dragElement,
    answerIdentityIfAsked,
    page: pageLocator,
    pageBox,
    clickDialogButton,
  };
}

/** Convenience for a spec that only needs the page, not the whole app. */
export function windowOf(app: App): Page {
  return app.page;
}

/**
 * Closes every open document, answering the "unsaved changes" dialog each one raises.
 *
 * A journey edits the document, so closing it always asks — one dialog per document — and a
 * test that walks away from one leaves the next test staring at it. Every journey spec ends its
 * tests with this.
 */
export async function closeEverything(app: App): Promise<void> {
  await app.run('annot.deselect').catch(() => undefined);
  const closing = app.run('app.tabs.closeAll').catch(() => undefined);
  for (let i = 0; i < 8; i++) {
    const discard = app.page.locator('dialog[open] button', { hasText: "Don't save" });
    if ((await discard.count()) === 0) {
      await app.page.waitForTimeout(120);
      if ((await discard.count()) === 0) break;
    }
    await discard.first().click();
    await app.page.waitForTimeout(120);
  }
  await closing;
  await app.page.waitForTimeout(150);
}
