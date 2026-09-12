import { expect, test } from '@playwright/test';
import { PDFDocument, degrees } from 'pdf-lib';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type App } from '../harness';
import { closeEverything, journey } from '../journey';
import { expectWindowSound } from '../layout';

let app: App;
let workspace: string;
let serial = 0;
let bytes: Uint8Array;

interface HeldBounds {
  held: number;
  replies: number;
  release(): void;
}
type BoundsWindow = Window & { m11Bounds?: HeldBounds };

test.beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'ynot-fit-visible-'));
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 4; i++) {
    const page = pdf.addPage([600, 800]);
    page.setCropBox(50, 100, 500, 600);
    if (i === 3) page.setRotation(degrees(90));
    if (i !== 2)
      page.drawRectangle({
        x: i === 1 ? 250 : 150,
        y: 200,
        width: i === 1 ? 150 : 200,
        height: 300,
        borderWidth: 0,
      });
  }
  bytes = await pdf.save();
  app = await launchApp({ noDemo: true });
});
test.afterEach(async () => {
  await closeEverything(app);
});
test.afterAll(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

async function open(): Promise<void> {
  const path = join(workspace, `fit-${++serial}.pdf`);
  writeFileSync(path, bytes);
  await journey(app).openDocument(path);
}
async function state(): Promise<{
  zoom: number;
  rotation: number;
  page: number;
  fit: string | null;
}> {
  return (await app.run('dev.viewerState')) as {
    zoom: number;
    rotation: number;
    page: number;
    fit: string | null;
  };
}
async function go(page: number): Promise<void> {
  await app.page.locator('#status-page-input').fill(String(page + 1));
  await app.page.locator('#status-page-input').press('Enter');
  await expect.poll(async () => (await state()).page).toBe(page);
}

// These positions come directly from the synthetic PDF, independently of production helpers.
const rotatedInk = [
  { x: 100, y: 200, width: 200, height: 300 },
  { x: 100, y: 100, width: 300, height: 200 },
  { x: 200, y: 100, width: 200, height: 300 },
  { x: 200, y: 200, width: 300, height: 200 },
];
async function expectInk(page: number, rotation: number, pane?: number): Promise<void> {
  const ink = rotatedInk[rotation / 90];
  if (!ink) throw new Error('Unexpected rotation');
  const scrollers = app.page.locator('.viewer-scroll:visible');
  const scroller = pane === undefined ? scrollers : scrollers.nth(pane);
  await expect
    .poll(
      async () => {
        const s = await state();
        return scroller.evaluate(
          (scroll, args) => {
            const page = scroll.querySelector<HTMLElement>(`.page[data-page="${args.page}"]`);
            if (!page) return false;
            const p = page.getBoundingClientRect();
            const v = scroll.getBoundingClientRect();
            const left = p.left - v.left + args.ink.x * args.zoom;
            const top = p.top - v.top + args.ink.y * args.zoom;
            const right = left + args.ink.width * args.zoom;
            return (
              Math.abs(left - 16) <= 1.5 &&
              Math.abs(top - 16) <= 1.5 &&
              right <= scroll.clientWidth - 15 &&
              right >= scroll.clientWidth - 20
            );
          },
          { page, ink, zoom: s.zoom },
        );
      },
      { message: 'Fit Visible must put the ink edges at the viewport padding', timeout: 15000 },
    )
    .toBe(true);
  // Geometry alone cannot detect a bucket bitmap painted at the wrong display scale.
  await expect
    .poll(async () => {
      const perf = (await app.run('dev.viewerPerf')) as { queued: number; inFlight: number };
      return perf.queued + perf.inFlight;
    })
    .toBe(0);
  const zoom = (await state()).zoom;
  const raster = await scroller.evaluate(
    (scroll, args) => {
      const pageElement = scroll.querySelector<HTMLElement>(`.page[data-page="${args.page}"]`);
      const canvas = pageElement?.querySelector<HTMLCanvasElement>('canvas');
      const context = canvas?.getContext('2d');
      if (!pageElement || !canvas || !context) throw new Error('Fitted page raster is missing');
      const c = canvas.getBoundingClientRect(),
        v = scroll.getBoundingClientRect();
      const p = pageElement.getBoundingClientRect();
      const style = getComputedStyle(pageElement);
      const borderLeft = Number.parseFloat(style.borderLeftWidth);
      const borderTop = Number.parseFloat(style.borderTopWidth);
      const sx = canvas.width / c.width,
        sy = canvas.height / c.height;
      const row = context.getImageData(
        0,
        Math.round((v.top + 32 - c.top) * sy),
        canvas.width,
        1,
      ).data;
      const col = context.getImageData(
        Math.round((v.left + 32 - c.left) * sx),
        0,
        1,
        canvas.height,
      ).data;
      const black = (pixels: Uint8ClampedArray, p: number, threshold = 16): boolean =>
        (pixels[p] ?? 255) < threshold &&
        (pixels[p + 1] ?? 255) < threshold &&
        (pixels[p + 2] ?? 255) < threshold &&
        (pixels[p + 3] ?? 0) > 240;
      let left = -1,
        right = -1,
        top = -1;
      for (let x = 0; x < canvas.width; x++)
        if (black(row, x * 4, 128)) {
          if (left < 0) left = x;
          right = x + 1;
        }
      for (let y = 0; y < canvas.height; y++)
        if (black(col, y * 4, 128)) {
          top = y;
          break;
        }
      // Every interior pixel must remain opaque black, including tile seams and clipped tiles.
      const width = Math.floor(Math.min(args.width * args.zoom - 4, scroll.clientWidth - 36) * sx);
      const height = Math.floor(
        Math.min(args.height * args.zoom - 4, scroll.clientHeight - 36) * sy,
      );
      const interior = context.getImageData(
        Math.round((v.left + 18 - c.left) * sx),
        Math.round((v.top + 18 - c.top) * sy),
        width,
        height,
      ).data;
      let holes = 0;
      for (let p = 0; p < interior.length; p += 4) if (!black(interior, p)) holes++;
      const rect = (r: DOMRect): { left: number; top: number; width: number; height: number } => ({
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
      });
      return {
        left: c.left - v.left + left / sx,
        right: c.left - v.left + right / sx,
        top: c.top - v.top + top / sy,
        expected: {
          left: p.left - v.left + borderLeft + args.x * args.zoom,
          right: p.left - v.left + borderLeft + (args.x + args.width) * args.zoom,
          top: p.top - v.top + borderTop + args.y * args.zoom,
        },
        dpr: window.devicePixelRatio,
        border: { left: borderLeft, top: borderTop },
        pageRect: rect(p),
        canvasRect: rect(c),
        viewportRect: rect(v),
        scroll: { left: scroll.scrollLeft, top: scroll.scrollTop },
        canvasSize: { width: canvas.width, height: canvas.height },
        holes,
      };
    },
    { page, zoom, x: ink.x, y: ink.y, width: ink.width, height: ink.height },
  );
  // Fit placement above permits scroll rounding. Independently compare raster to the actual
  // content origin: clientLeft/clientTop round fractional rendered borders to integer CSS px.
  // Keep the same one-CSS-pixel raster bound and include measurements in CI failure output.
  const diagnostic = JSON.stringify({ page, rotation, zoom, raster });
  expect(Math.abs(raster.left - raster.expected.left), diagnostic).toBeLessThanOrEqual(1);
  expect(Math.abs(raster.top - raster.expected.top), diagnostic).toBeLessThanOrEqual(1);
  expect(Math.abs(raster.right - raster.expected.right), diagnostic).toBeLessThanOrEqual(1);
  expect(raster.holes, 'solid ink must have no transparent or white tile seams').toBe(0);
}

test('M11 — Fit Visible finds cropped content, follows every view rotation and restores manual zoom', async () => {
  await open();
  const j = journey(app);
  await j.clickRibbon('view', 'Layout: Single Page');
  await j.clickRibbon('view', 'Fit Width');
  const widthZoom = (await state()).zoom;
  await j.clickRibbon('view', 'Fit Visible');
  await expectInk(0, 0);
  expect((await state()).zoom).toBeGreaterThan(widthZoom * 2);
  for (const rotation of [90, 180, 270]) {
    await j.clickRibbon('view', 'Rotate View Clockwise');
    await expectInk(0, rotation);
  }
  await j.clickRibbon('view', 'Actual Size (100 %)');
  await expect.poll(async () => (await state()).zoom).toBe(1);
  expect((await state()).fit).toBeNull();
  await expectWindowSound(app.page);
});

test('M11 — Fit Visible preserves facing inner margins, navigates to blank and rotated pages', async () => {
  await open();
  const j = journey(app);
  await j.clickRibbon('view', 'Layout: Facing');
  await j.clickRibbon('view', 'Fit Visible');
  await expect
    .poll(async () => {
      const width = await app.page.locator('.viewer-scroll:visible').evaluate((e) => e.clientWidth);
      // 500pt page + 200pt right inset + 150pt right ink - 100pt left inset, plus 16px gap.
      return (await state()).zoom === Math.floor(((width - 48) / 750) * 100) / 100;
    })
    .toBe(true);
  await j.clickRibbon('view', 'Layout: Single Page');
  await go(2);
  await expect
    .poll(async () => {
      const width = await app.page.locator('.viewer-scroll:visible').evaluate((e) => e.clientWidth);
      return (await state()).zoom === Math.floor(((width - 32) / 500) * 100) / 100;
    })
    .toBe(true);
  await go(3);
  await expectInk(3, 90);
  await expectWindowSound(app.page);
});

test('M11 — Fit Visible responds to pane resizing and cannot override a later actual-size shortcut', async () => {
  await open();
  const j = journey(app);
  await j.clickRibbon('view', 'Layout: Single Page');
  await j.clickRibbon('view', 'Fit Visible');
  await expectInk(0, 0);
  await j.openPanel('nav.pages');
  const larger = app.page.getByRole('button', { name: 'Larger thumbnails', exact: true });
  await larger.click();
  await expectInk(0, 0);
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  // Same input burst: the second request wins even if the bounds promise completes later.
  await app.page.keyboard.press(`${mod}+3`);
  await app.page.keyboard.press(`${mod}+0`);
  await expect.poll(async () => (await state()).zoom).toBe(1);
  await app.page.waitForTimeout(300);
  expect((await state()).zoom).toBe(1);
  expect((await state()).fit).toBeNull();
  await expectWindowSound(app.page);
});

test('M11 — deleting the fitted object and undoing refreshes the content bounds', async () => {
  await open();
  const j = journey(app);
  await j.clickRibbon('view', 'Layout: Single Page');
  await j.clickRibbon('view', 'Fit Visible');
  await expectInk(0, 0);
  await j.clickRibbon('edit', 'Edit Object');
  // The solid rectangle starts at 16,16 after fitting. Select inside its visible ink.
  await app.page.locator('.viewer-scroll:visible').click({ position: { x: 100, y: 100 } });
  await expect
    .poll(
      async () =>
        ((await app.run('dev.objectSelection')) as { objectIds: string[] }).objectIds.length,
    )
    .toBe(1);
  await app.page.keyboard.press('Delete');
  await expect
    .poll(async () => {
      const width = await app.page.locator('.viewer-scroll:visible').evaluate((e) => e.clientWidth);
      return (await state()).zoom === Math.floor(((width - 32) / 500) * 100) / 100;
    })
    .toBe(true);
  await j.clickRibbon('edit', 'Undo');
  await expectInk(0, 0);
  await expectWindowSound(app.page);
});

test('M11 — continuous and book navigation fit the current row, and split panes fit independently', async () => {
  await open();
  const j = journey(app);
  await j.clickRibbon('view', 'Tool: Hand');
  await j.clickRibbon('view', 'Layout: Continuous');
  await j.clickRibbon('view', 'Fit Visible');
  await expectInk(0, 0);
  await go(3);
  await expectInk(3, 90);
  await go(0);
  await j.clickRibbon('view', 'Layout: Book');
  await expectInk(0, 0);
  await j.clickRibbon('view', 'Layout: Single Page');
  await j.clickRibbon('view', 'Split Vertically');
  const panes = app.page.locator('.viewer-scroll:visible');
  await expect(panes).toHaveCount(2);
  await expect
    .poll(async () => {
      const widths = await panes.evaluateAll((els) => els.map((e) => e.clientWidth));
      return (await state()).zoom === Math.floor((((widths[0] ?? 0) - 32) / 200) * 100) / 100;
    })
    .toBe(true);
  await panes.nth(1).click({ position: { x: 50, y: 50 } });
  await expect(app.page.locator('.viewer-pane[data-pane="1"]')).toHaveAttribute(
    'data-active',
    'true',
  );
  await j.clickRibbon('view', 'Actual Size (100 %)');
  expect((await state()).zoom).toBe(1);
  await panes.nth(0).click({ position: { x: 50, y: 50 } });
  await expect(app.page.locator('.viewer-pane[data-pane="0"]')).toHaveAttribute(
    'data-active',
    'true',
  );
  await expect.poll(async () => (await state()).fit).toBe('visible');
  expect((await state()).zoom).toBeGreaterThan(1);
  await j.clickRibbon('view', 'Fit Visible');
  await expectInk(0, 0, 0);
  await expectWindowSound(app.page);
});

test('M11 — a delayed content read cannot override a newer zoom command', async () => {
  await open();
  const j = journey(app);
  await j.clickRibbon('view', 'Tool: Hand');
  await j.clickRibbon('view', 'Actual Size (100 %)');
  // Fault injection only: hold the real worker request, not a fabricated bounds result.
  // The action under test still comes from the reader's visible ribbon controls.
  await app.page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored verbatim; Reflect.apply below supplies the original worker receiver.
    const original = Worker.prototype.postMessage;
    const pending: Array<() => void> = [];
    const state: HeldBounds = {
      held: 0,
      replies: 0,
      release: () => {
        Worker.prototype.postMessage = original;
        for (const send of pending.splice(0)) send();
      },
    };
    (window as BoundsWindow).m11Bounds = state;
    Worker.prototype.postMessage = function (
      message: unknown,
      options: Transferable[] | StructuredSerializeOptions = [],
    ): void {
      const send = (): void => {
        Reflect.apply(original, this, [message, options]);
      };
      const request = message as { kind?: string; method?: string; id?: number } | null;
      if (request?.kind !== 'request' || request.method !== 'pageObjects') {
        send();
        return;
      }
      state.held++;
      const reply = (event: MessageEvent): void => {
        const response = event.data as { id?: number };
        if (response.id !== request.id) return;
        state.replies++;
        this.removeEventListener('message', reply);
      };
      this.addEventListener('message', reply);
      pending.push(send);
    };
  });
  try {
    await j.clickRibbon('view', 'Fit Visible');
    await expect
      .poll(() => app.page.evaluate(() => (window as BoundsWindow).m11Bounds?.held ?? 0))
      .toBeGreaterThan(0);
    await j.clickRibbon('view', 'Actual Size (100 %)');
    await app.page.evaluate(() => {
      (window as BoundsWindow).m11Bounds?.release();
    });
    await expect
      .poll(() => app.page.evaluate(() => (window as BoundsWindow).m11Bounds?.replies ?? 0))
      .toBeGreaterThan(0);
    // Drain the completion's layout frame before checking the user-visible state.
    await app.page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              resolve();
            }),
          ),
        ),
    );
    expect((await state()).zoom).toBe(1);
    expect((await state()).fit).toBeNull();
    await expectWindowSound(app.page);
  } finally {
    await app.page.evaluate(() => {
      (window as BoundsWindow).m11Bounds?.release();
      delete (window as BoundsWindow).m11Bounds;
    });
  }
});
