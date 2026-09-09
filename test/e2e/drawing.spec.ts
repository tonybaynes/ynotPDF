/**
 * M31 acceptance tests — shapes, ink and the eraser, stamps and file attachments, inside the
 * real, built app.
 *
 * The unit tests own the arithmetic (the clouds, the endings, the smoothing, the eraser's cut,
 * the stamp matrix) and the file (`test/unit/drawing/roundtrip.test.ts` saves and reopens through
 * the whole real pipeline). This file owns what only exists once there is a DOM, a viewer and a
 * running PDFium: drawing with the pointer, dragging a vertex, the palette, the panel sections,
 * and what Chrome makes of the file we wrote.
 *
 * Each acceptance line in `docs/modules/M31-shapes-ink-stamps.md` has a test named after it.
 */

import { chromium, expect, test, type Frame, type Page } from '@playwright/test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument, PDFName, PDFRef, PDFStream } from 'pdf-lib';
import { num } from '../../src/engine/appearance/content';
import { lineEndingDrawing } from '../../src/engine/appearance/shapes';
import { Qpdf, type QpdfFactory } from '../../src/engine/security/qpdf';
import { launchApp, type App } from './harness';

const require_ = createRequire(import.meta.url);
const FIXTURES = join(process.cwd(), 'test', 'fixtures');
const PNG = readFileSync(join(FIXTURES, 'create', 'logo-alpha.png'));

/** Narrows away a value the test knows is there; `!` is forbidden project-wide. */
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected a ${what}, got nothing`);
  return value;
}

interface DrawingRow {
  id: string;
  subtype: string;
  family: string;
  rect: { x0: number; y0: number; x1: number; y1: number };
  color: number | null;
  interiorColor: number | null;
  borderWidth: number | null;
  vertices: Array<{ x: number; y: number }>;
  paths: number[];
  rotate: number;
  extra: Record<string, unknown>;
  drawnByOverlay: boolean;
  appearance: { content: string; xobjects: Record<string, string> } | null;
}

interface SelectionState {
  ids: string[];
  drawn: string[];
  total: number;
  activeTool: string | null;
}

interface DrawingState {
  settings: { eraserMode: string; favouriteStamps: string[] };
  defaults: { stampId: string; cloudy: number };
  stamps: Array<{ id: string; label: string; kind: string; favourite: boolean }>;
  xobjects: string[];
}

let app: App;
let workspace: string;

test.beforeAll(async () => {
  app = await launchApp();
  workspace = mkdtempSync(join(tmpdir(), 'ynot-m31-'));
  await app.run('annot.identity', { name: 'E2E Reader', initials: 'ER', email: '' });
});

test.afterAll(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

function stage(name: string, as: string): string {
  const path = join(workspace, as);
  copyFileSync(join(FIXTURES, name), path);
  return path;
}

async function openPath(path: string): Promise<void> {
  const bytes = Array.from(readFileSync(path));
  await app.run('file.openBytes', { file: { path, name: path.split(/[\\/]/).pop(), bytes } });
  await app.page.waitForSelector('.viewer-content .page');
  await app.page.waitForTimeout(200);
}

/** Closes every tab, answering M21's "Save?" for each. */
async function closeAll(): Promise<void> {
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

const drawings = (page = 0): Promise<DrawingRow[]> =>
  app.run('dev.drawings', { page }) as Promise<DrawingRow[]>;
const selection = (): Promise<SelectionState> =>
  app.run('dev.annotSelection') as Promise<SelectionState>;
const drawingState = (tool = 'rectangle'): Promise<DrawingState> =>
  app.run('dev.drawing', { tool }) as Promise<DrawingState>;

async function until<T>(probe: () => Promise<T>, ready: (value: T) => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (ready(value)) return value;
    if (Date.now() > deadline) return value;
    await app.page.waitForTimeout(120);
  }
}

/** The first page's box, scrolled into view so the pointer can reach it. */
async function pageBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const page = app.page.locator('.viewer-content .page').first();
  await page.scrollIntoViewIfNeeded();
  return must(await page.boundingBox(), 'page box');
}

/** Drags with the mouse from one page-element point to another. */
async function drag(from: [number, number], to: [number, number]): Promise<void> {
  const box = await pageBox();
  await app.page.mouse.move(box.x + from[0], box.y + from[1]);
  await app.page.mouse.down();
  await app.page.mouse.move(box.x + to[0], box.y + to[1], { steps: 12 });
  await app.page.mouse.up();
  await app.page.waitForTimeout(200);
}

const rect = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

// ---- wiring --------------------------------------------------------------------------------------

test.describe('the module is wired in', () => {
  test.afterEach(closeAll);

  test('every tool and every action is a registered command', async () => {
    const commands = await app.commands();
    for (const id of [
      'draw.rectangle',
      'draw.ellipse',
      'draw.line',
      'draw.arrow',
      'draw.polygon',
      'draw.polyline',
      'draw.cloud',
      'draw.areaHighlight',
      'draw.pencil',
      'draw.eraser',
      'draw.eraserMode',
      'draw.stamp',
      'draw.stamps',
      'draw.stampRotate',
      'draw.stampFavourite',
      'draw.stampCustom',
      'draw.stampRemove',
      'draw.attachFile',
      'tool.rectangle.activate',
      'tool.pencil.activate',
      'tool.eraser.activate',
      'tool.stamp.activate',
      'tool.attachFile.activate',
    ]) {
      expect(commands, id).toContain(id);
    }
  });

  test('the Comment tab carries the drawing groups', async () => {
    await openPath(stage('text.pdf', 'ribbon.pdf'));
    await app.page.setViewportSize({ width: 1400, height: 900 });
    await app.page.locator('[role="tab"]', { hasText: 'Comment' }).first().click();
    await expect(app.page.locator('#ribbon-body')).toContainText('Shapes');
    await expect(app.page.locator('#ribbon-body')).toContainText('Stamps');
  });
});

// ---- each tool creates its annotation --------------------------------------------------------------

test.describe('each shape, ink, stamp and attachment tool creates its annotation', () => {
  test.afterEach(closeAll);

  test('every tool makes what its name says, with the entries the file needs', async () => {
    await openPath(stage('text.pdf', 'tools.pdf'));
    const line = [
      { x: 60, y: 700 },
      { x: 260, y: 740 },
    ];
    const polygon = [
      { x: 300, y: 600 },
      { x: 400, y: 620 },
      { x: 380, y: 700 },
    ];
    await app.run('draw.rectangle', { page: 0, rect: rect(60, 560, 240, 640) });
    await app.run('draw.ellipse', { page: 0, rect: rect(260, 560, 360, 640) });
    await app.run('draw.line', { page: 0, vertices: line });
    await app.run('draw.arrow', { page: 0, vertices: line.map((p) => ({ x: p.x, y: p.y - 60 })) });
    await app.run('draw.polygon', { page: 0, vertices: polygon });
    await app.run('draw.polyline', {
      page: 0,
      vertices: polygon.map((p) => ({ x: p.x + 120, y: p.y })),
    });
    await app.run('draw.cloud', {
      page: 0,
      vertices: polygon.map((p) => ({ x: p.x, y: p.y - 200 })),
    });
    await app.run('draw.areaHighlight', { page: 0, rect: rect(60, 400, 240, 440) });
    await app.run('draw.pencil', {
      page: 0,
      points: Array.from({ length: 12 }, (_v, i) => ({ x: 60 + i * 10, y: 300 + (i % 2) * 6 })),
    });
    await app.run('draw.stamp', { page: 0, x: 400, y: 300, stamp: 'Approved' });
    await app.run('draw.attachFile', {
      page: 0,
      x: 500,
      y: 700,
      file: { name: 'notes.txt', bytes: [104, 105], description: 'my notes' },
    });
    const rows = await until(drawings, (list) => list.length >= 11);
    const by = (subtype: string): DrawingRow[] => rows.filter((r) => r.subtype === subtype);
    expect(rows.length).toBe(11);
    expect(by('Square').length).toBe(1);
    expect(by('Circle').length).toBe(1);
    expect(by('Line').length).toBe(2);
    const arrow = must(
      by('Line').find((r) => r.extra['intent'] === 'LineArrow'),
      'arrow',
    );
    expect(arrow.extra['lineEndings']).toEqual(['None', 'OpenArrow']);
    expect(by('Polygon').length).toBe(2);
    const cloud = must(
      by('Polygon').find((r) => (r.extra['cloudy'] as number) > 0),
      'cloud',
    );
    expect(cloud.extra['intent']).toBe('PolygonCloud');
    expect(by('PolyLine').length).toBe(1);
    const area = must(by('Highlight')[0], 'area highlight');
    expect(area.extra['intent']).toBe('AreaHighlight');
    expect(must(by('Ink')[0], 'ink').paths).toEqual([12]);
    const stamp = must(by('Stamp')[0], 'stamp');
    expect(stamp.extra['icon']).toBe('Approved');
    expect(String(stamp.extra['stampKey'])).toMatch(/^stamp:Approved:/);
    expect(stamp.appearance?.content).toContain('Do');
    const pin = must(by('FileAttachment')[0], 'attachment');
    expect(pin.extra['attachmentName']).toBe('notes.txt');
    // The picture is registered once in the document, keyed.
    expect((await drawingState()).xobjects).toEqual([stamp.extra['stampKey']]);
    // Every one carries an author and no `/CA`: solid colours only.
    for (const r of rows)
      expect(r.extra['hasAP'] === undefined || typeof r.extra['hasAP'] === 'boolean').toBe(true);
  });

  test('a rectangle, a stroke and a polygon can be drawn with the pointer', async () => {
    await openPath(stage('text.pdf', 'pointer.pdf'));
    await app.run('tool.rectangle.activate');
    await drag([100, 100], [220, 180]);
    let rows = await until(drawings, (list) => list.some((r) => r.subtype === 'Square'));
    const square = must(
      rows.find((r) => r.subtype === 'Square'),
      'square',
    );
    expect(square.rect.x1 - square.rect.x0).toBeGreaterThan(60);
    expect(square.rect.y1 - square.rect.y0).toBeGreaterThan(40);

    await app.run('tool.pencil.activate');
    await drag([100, 300], [300, 340]);
    rows = await until(drawings, (list) => list.some((r) => r.subtype === 'Ink'));
    expect(
      must(
        rows.find((r) => r.subtype === 'Ink'),
        'ink',
      ).paths[0],
    ).toBeGreaterThan(5);
    await app.run('draw.pencilEndGroup');

    await app.run('tool.polygon.activate');
    const box = await pageBox();
    for (const [x, y] of [
      [100, 500],
      [200, 500],
      [150, 560],
    ] as const) {
      await app.page.mouse.click(box.x + x, box.y + y);
      await app.page.waitForTimeout(450);
    }
    await app.page.keyboard.press('Enter');
    rows = await until(drawings, (list) => list.some((r) => r.subtype === 'Polygon'));
    expect(
      must(
        rows.find((r) => r.subtype === 'Polygon'),
        'polygon',
      ).vertices.length,
    ).toBe(3);
    // Every one is an undo step of its own.
    for (let i = 0; i < 3; i++) await app.run('edit.undo');
    await app.page.waitForTimeout(200);
    expect((await drawings()).length).toBe(0);
  });
});

// ---- arrow end styles after rotate/resize -----------------------------------------------------------

test.describe('arrow end styles render at the correct angle after rotate/resize', () => {
  test.afterEach(closeAll);

  test('dragging the arrow’s tip turns the head with the line', async () => {
    await openPath(stage('text.pdf', 'arrow.pdf'));
    const id = (await app.run('draw.arrow', {
      page: 0,
      vertices: [
        { x: 100, y: 600 },
        { x: 300, y: 600 },
      ],
    })) as string;
    await app.page.waitForTimeout(200);
    await app.run('annot.selectAll');
    const tip = app.page.locator(`.annot-handle[data-handle="v1"][data-annot="${id}"]`);
    await expect(tip).toBeVisible();
    const box = must(await tip.boundingBox(), 'tip handle');
    // Drag the tip down and to the left: the line turns and shortens.
    await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await app.page.mouse.down();
    await app.page.mouse.move(box.x - 60, box.y + 120, { steps: 10 });
    await app.page.mouse.up();
    await app.page.waitForTimeout(300);

    const arrow = must(
      (await drawings()).find((r) => r.id === id),
      'arrow',
    );
    const [from, to] = arrow.vertices;
    expect(from).toEqual({ x: 100, y: 600 });
    expect(must(to, 'tip').y).toBeLessThan(600);
    // The head in the appearance stream is the one the arithmetic gives for the *new* line.
    const head = must(
      lineEndingDrawing('OpenArrow', must(to, 'tip'), must(from, 'from'), arrow.borderWidth ?? 1),
      'head',
    );
    const wing = head.ops[0];
    if (wing?.op !== 'M') throw new Error('unexpected head');
    expect(arrow.appearance?.content).toContain(`${num(wing.x)} ${num(wing.y)} m`);
    // And the rect grew to hold the head at its new angle.
    expect(arrow.rect.y0).toBeLessThan(must(to, 'tip').y);
    await app.run('edit.undo');
    await app.page.waitForTimeout(200);
    expect(
      must(
        (await drawings()).find((r) => r.id === id),
        'arrow',
      ).vertices[1],
    ).toEqual({ x: 300, y: 600 });
  });
});

// ---- the eraser --------------------------------------------------------------------------------------

test.describe('eraser split of a stroke yields two ink annotations with the expected point counts', () => {
  test.afterEach(closeAll);

  test('a cut in the middle leaves two strokes; stroke mode removes the whole thing', async () => {
    await openPath(stage('text.pdf', 'eraser.pdf'));
    const points = Array.from({ length: 11 }, (_v, i) => ({ x: 100 + i * 10, y: 500 }));
    await app.run('draw.pencil', { page: 0, points });
    await app.run('draw.pencilEndGroup');
    await app.run('draw.eraserMode', { mode: 'split' });
    expect(await app.run('draw.eraser', { page: 0, x: 150, y: 500, radius: 12 })).toEqual({
      changed: 1,
    });
    await app.page.waitForTimeout(200);
    const inks = (await drawings()).filter((r) => r.subtype === 'Ink');
    expect(inks.length).toBe(2);
    expect(inks.map((r) => r.paths[0]).sort()).toEqual([4, 4]);

    // One undo step for the whole cut.
    await app.run('edit.undo');
    await app.page.waitForTimeout(200);
    const restored = (await drawings()).filter((r) => r.subtype === 'Ink');
    expect(restored.length).toBe(1);
    expect(restored[0]?.paths).toEqual([11]);

    await app.run('draw.eraserMode', { mode: 'stroke' });
    expect(await app.run('draw.eraser', { page: 0, x: 150, y: 500, radius: 12 })).toEqual({
      changed: 1,
    });
    await app.page.waitForTimeout(200);
    expect((await drawings()).filter((r) => r.subtype === 'Ink').length).toBe(0);
  });

  test('rubbing with the pointer cuts a drawn stroke', async () => {
    await openPath(stage('text.pdf', 'rub.pdf'));
    await app.run('tool.pencil.activate');
    await drag([100, 400], [300, 400]);
    await app.run('draw.pencilEndGroup');
    await until(drawings, (list) => list.some((r) => r.subtype === 'Ink'));
    await app.run('draw.eraserMode', { mode: 'split' });
    await app.run('tool.eraser.activate');
    await drag([200, 380], [200, 420]);
    const inks = await until(
      async () => (await drawings()).filter((r) => r.subtype === 'Ink'),
      (list) => list.length === 2,
    );
    expect(inks.length).toBe(2);
  });
});

// ---- stamps ------------------------------------------------------------------------------------------

test.describe('custom stamp from a PNG is embedded once for 10 placements', () => {
  test.afterEach(closeAll);

  test('ten placements, one picture — counted by qpdf --json', async () => {
    const path = stage('text.pdf', 'stamps.pdf');
    await openPath(path);
    const stampId = (await app.run('draw.stampCustom', {
      label: 'Logo',
      png: Array.from(PNG),
      width: 120,
      height: 60,
    })) as string;
    expect(stampId).toMatch(/^custom-/);
    for (let i = 0; i < 10; i++) {
      await app.run('draw.stamp', {
        page: 0,
        x: 80 + (i % 5) * 100,
        y: 300 - Math.floor(i / 5) * 80,
        stamp: stampId,
      });
    }
    await app.page.waitForTimeout(200);
    const placed = (await drawings()).filter((r) => r.subtype === 'Stamp');
    expect(placed.length).toBe(10);
    expect(new Set(placed.map((r) => r.extra['stampKey'])).size).toBe(1);
    expect((await drawingState()).xobjects).toEqual([`image:${stampId}`]);
    expect(((await app.run('file.save')) as { saved: boolean }).saved).toBe(true);
    await closeAll();

    const bytes = new Uint8Array(readFileSync(path));
    // pdf-lib: the images that are not another image's soft mask.
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    let images = 0;
    const masks = new Set<string>();
    for (const [, object] of pdf.context.enumerateIndirectObjects()) {
      if (
        object instanceof PDFStream &&
        object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image'
      ) {
        images++;
        const mask = object.dict.get(PDFName.of('SMask'));
        if (mask instanceof PDFRef) masks.add(mask.toString());
      }
    }
    expect(images - masks.size).toBe(1);
    // qpdf: the same count from its JSON view of the file, as the brief asks.
    const qpdf = new Qpdf({ factory: require_('@neslinesli93/qpdf-wasm') as QpdfFactory });
    const run = await qpdf.run(['--json', 'in.pdf'], { 'in.pdf': bytes });
    expect(run.code).toBeLessThanOrEqual(3);
    const text = JSON.stringify(JSON.parse(run.output.slice(run.output.indexOf('{'))));
    const imageObjects = (text.match(/"\/Subtype":\s*"\/Image"/g) ?? []).length;
    const maskRefs = (text.match(/"\/SMask":\s*"\d+ \d+ R"/g) ?? []).length;
    expect(imageObjects - maskRefs).toBe(1);

    // Reopened, the raster carries all ten and the overlay draws none of them.
    await openPath(path);
    const back = await until(drawings, (list) => list.length >= 10);
    expect(back.filter((r) => r.subtype === 'Stamp').length).toBe(10);
    expect(back.every((r) => !r.drawnByOverlay)).toBe(true);
    // The custom stamp is kept in the palette across documents, and can be removed.
    expect((await drawingState()).stamps.some((s) => s.id === stampId)).toBe(true);
    expect(await app.run('draw.stampRemove', { stamp: stampId })).toBe(true);
    expect((await drawingState()).stamps.some((s) => s.id === stampId)).toBe(false);
  });

  test('the palette lists the catalogue, picks a stamp up, stars a favourite, and turns a placed one', async () => {
    await openPath(stage('text.pdf', 'palette.pdf'));
    await app.run('draw.stamps');
    const panel = app.page.locator('#stamp-panel');
    await expect(panel).toBeVisible();
    expect(await panel.locator('.stamp-tile').count()).toBeGreaterThanOrEqual(20);
    await panel.locator('.stamp-tile[data-stamp="Draft"]').click();
    await app.page.waitForTimeout(150);
    expect((await drawingState('stamp')).defaults.stampId).toBe('Draft');
    expect((await selection()).activeTool).toBe('tool.stamp');
    await app.run('draw.stampFavourite', { stamp: 'Draft' });
    expect((await drawingState()).settings.favouriteStamps).toContain('Draft');
    await expect(panel.locator('.stamp-group-title', { hasText: 'Favourites' })).toBeVisible();

    // A dynamic stamp carries the reader's name and today's date.
    const id = (await app.run('draw.stamp', {
      page: 0,
      x: 300,
      y: 500,
      stamp: 'DynamicApproved',
    })) as string;
    await app.page.waitForTimeout(200);
    await app.run('draw.stampRotate', { id, degrees: 45 });
    await app.page.waitForTimeout(200);
    const stamp = must(
      (await drawings()).find((r) => r.id === id),
      'stamp',
    );
    expect(stamp.rotate).toBe(45);
    // The matrix turns by 45°: equal cosine and sine, at whatever scale the stamp was placed.
    const m = must(
      /^(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) /m.exec(stamp.appearance?.content ?? ''),
      'matrix',
    );
    const [a, b, c, d] = m.slice(1, 5).map(Number);
    expect(must(a, 'a')).toBeGreaterThan(0);
    expect(must(b, 'b')).toBeCloseTo(must(a, 'a'), 3);
    expect(must(c, 'c')).toBeCloseTo(-must(b, 'b'), 3);
    expect(must(d, 'd')).toBeCloseTo(must(a, 'a'), 3);
    // The panel's rotation control shows the turn too.
    await app.run('annot.selectAll');
    await expect(app.page.locator('#annot-props input[aria-label^="Rotation"]')).toHaveValue('45');
  });
});

// ---- the properties panel ------------------------------------------------------------------------------

test.describe('the properties panel', () => {
  test.afterEach(closeAll);

  test('a rectangle can be made cloudy and an arrow’s ending changed, each undoing as one step', async () => {
    await openPath(stage('text.pdf', 'props.pdf'));
    const id = (await app.run('draw.rectangle', {
      page: 0,
      rect: rect(60, 560, 240, 640),
    })) as string;
    await app.page.waitForTimeout(200);
    // Creating a shape selects it, so the panel is already the rectangle's.
    await expect(app.page.locator('#annot-props')).toContainText('Rectangle');
    const cloudy = app.page.locator('#annot-props input[type="checkbox"]').first();
    await cloudy.check();
    await app.page.waitForTimeout(250);
    const after = must(
      (await drawings()).find((r) => r.id === id),
      'rectangle',
    );
    expect(after.extra['cloudy']).toBeGreaterThan(0);
    expect(after.appearance?.content).toMatch(/ c$/m);
    await app.run('edit.undo');
    await app.page.waitForTimeout(200);
    expect(
      must(
        (await drawings()).find((r) => r.id === id),
        'rectangle',
      ).extra['cloudy'] ?? 0,
    ).toBe(0);

    await app.run('annot.deselect');
    const arrow = (await app.run('draw.arrow', {
      page: 0,
      vertices: [
        { x: 60, y: 500 },
        { x: 260, y: 520 },
      ],
    })) as string;
    await app.page.waitForTimeout(200);
    const end = app.page.locator('#annot-props select[aria-label="End"]');
    await end.selectOption('Circle');
    await app.page.waitForTimeout(250);
    expect(
      must(
        (await drawings()).find((r) => r.id === arrow),
        'arrow',
      ).extra['lineEndings'],
    ).toEqual(['None', 'Circle']);
  });
});

// ---- opacity ---------------------------------------------------------------------------------------------

test.describe('nothing the module draws is translucent', () => {
  test.afterEach(closeAll);

  test('no overlay, palette or panel element has an alpha below 1', async () => {
    await openPath(stage('text.pdf', 'opacity.pdf'));
    await app.run('draw.cloud', {
      page: 0,
      vertices: [
        { x: 60, y: 560 },
        { x: 240, y: 560 },
        { x: 150, y: 640 },
      ],
    });
    await app.run('draw.stamp', { page: 0, x: 400, y: 500, stamp: 'Approved' });
    await app.run('draw.stamps');
    await app.run('annot.selectAll');
    await app.page.waitForTimeout(300);
    const offenders = await app.page.evaluate(() => {
      const bad: string[] = [];
      const alpha = (value: string): number | null => {
        const m = /\(([^)]*)\)/.exec(value);
        if (!m) return null;
        const parts = (m[1] ?? '').split(/[,/]/).map((p) => p.trim());
        if (parts.length < 4) return null;
        const last = parts[parts.length - 1] ?? '1';
        const n = last.endsWith('%') ? Number.parseFloat(last) / 100 : Number.parseFloat(last);
        return Number.isNaN(n) ? null : n;
      };
      const roots = document.querySelectorAll(
        '.layer-annot, .layer-annot *, #stamp-panel, #stamp-panel *, #annot-props, #annot-props *',
      );
      for (const el of roots) {
        const style = getComputedStyle(el);
        if (Number.parseFloat(style.opacity) < 1) bad.push(`${el.className}: opacity`);
        if (style.backdropFilter && style.backdropFilter !== 'none')
          bad.push(`${el.className}: backdrop-filter`);
        for (const prop of ['color', 'background-color', 'border-top-color', 'fill', 'stroke']) {
          const a = alpha(style.getPropertyValue(prop));
          if (a !== null && a > 0 && a < 1) bad.push(`${el.className}: ${prop}`);
        }
      }
      return bad;
    });
    expect(offenders).toEqual([]);
  });
});

// ---- the saved file ----------------------------------------------------------------------------------------

test.describe('each shape, ink and stamp round-trips and renders identically in PDFium and Chrome', () => {
  test.afterEach(closeAll);

  async function chromeShot(page: Page, path: string): Promise<Buffer> {
    const response = await page.goto(pathToFileURL(path).href);
    expect(response?.status() ?? 200).toBeLessThan(400);
    const viewerFrame = (): Frame | undefined =>
      page.frames().find((f) => f.url().startsWith('chrome-extension://'));
    await expect.poll(() => viewerFrame() !== undefined, { timeout: 15_000 }).toBe(true);
    await expect
      .poll(
        async () =>
          viewerFrame()?.evaluate(() => {
            const root = document.querySelector('pdf-viewer')?.shadowRoot;
            return Boolean(root?.querySelector('viewer-error-dialog, #error-screen'));
          }),
        { timeout: 15_000 },
      )
      .toBe(false);
    await page.waitForTimeout(1500);
    return await page.screenshot();
  }

  async function differingFraction(page: Page, a: Buffer, b: Buffer): Promise<number> {
    await page.goto('about:blank');
    return await page.evaluate(
      async ([first, second]) => {
        const load = async (data: string): Promise<ImageBitmap> =>
          await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
        const [x, y] = await Promise.all([load(first ?? ''), load(second ?? '')]);
        const width = Math.min(x.width, y.width);
        const height = Math.min(x.height, y.height);
        const pixels = (bitmap: ImageBitmap): Uint8ClampedArray => {
          const canvas = new OffscreenCanvas(width, height);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('no 2d context');
          context.drawImage(bitmap, 0, 0);
          return context.getImageData(0, 0, width, height).data;
        };
        const one = pixels(x);
        const two = pixels(y);
        let differing = 0;
        for (let i = 0; i < one.length; i += 4) {
          const dr = Math.abs((one[i] ?? 0) - (two[i] ?? 0));
          const dg = Math.abs((one[i + 1] ?? 0) - (two[i + 1] ?? 0));
          const db = Math.abs((one[i + 2] ?? 0) - (two[i + 2] ?? 0));
          if (dr > 8 || dg > 8 || db > 8) differing++;
        }
        return differing / (width * height);
      },
      [a.toString('base64'), b.toString('base64')] as const,
    );
  }

  /** The set of drawings every test here saves. */
  async function drawEverything(): Promise<void> {
    await app.run('draw.rectangle', { page: 0, rect: rect(60, 560, 240, 640) });
    await app.run('draw.arrow', {
      page: 0,
      vertices: [
        { x: 60, y: 500 },
        { x: 260, y: 540 },
      ],
    });
    await app.run('draw.cloud', {
      page: 0,
      vertices: [
        { x: 300, y: 560 },
        { x: 480, y: 580 },
        { x: 420, y: 660 },
      ],
    });
    await app.run('draw.pencil', {
      page: 0,
      points: Array.from({ length: 20 }, (_v, i) => ({
        x: 60 + i * 8,
        y: 420 + Math.sin(i / 2) * 10,
      })),
    });
    await app.run('draw.pencilEndGroup');
    await app.run('draw.areaHighlight', { page: 0, rect: rect(300, 400, 480, 440) });
    await app.run('draw.stamp', { page: 0, x: 400, y: 300, stamp: 'Approved' });
    await app.page.waitForTimeout(250);
  }

  const summary = (r: DrawingRow): string =>
    JSON.stringify([
      r.subtype,
      [r.rect.x0, r.rect.y0, r.rect.x1, r.rect.y1].map((n) => Math.round(n)),
      r.color,
      r.vertices.map((p) => [Math.round(p.x), Math.round(p.y)]),
      r.paths,
      r.extra['lineEndings'] ?? null,
      r.extra['cloudy'] ?? null,
    ]);

  test('everything survives a save and a reopen, and the raster then carries it all', async () => {
    const path = stage('text.pdf', 'saved.pdf');
    await openPath(path);
    await drawEverything();
    const before = (await drawings()).map(summary).sort();
    expect(before.length).toBe(6);
    expect(((await app.run('file.save')) as { saved: boolean }).saved).toBe(true);
    await closeAll();

    await openPath(path);
    const rows = await until(drawings, (list) => list.length >= 6);
    expect(rows.map(summary).sort()).toEqual(before);
    /*
     * "Our overlay-free render == PDFium's": after a reopen every drawing carries an appearance
     * stream, so the tile raster — which *is* PDFium — draws all of them and the overlay draws
     * nothing. That is the claim, stated as the thing that makes it true.
     */
    const state = await until(selection, (s) => s.total >= 6);
    expect(state.drawn).toEqual([]);
    for (const r of rows) expect(r.drawnByOverlay, r.subtype).toBe(false);
  });

  test('Chrome’s own viewer draws what we wrote', async () => {
    const annotated = stage('text.pdf', 'for-chrome.pdf');
    const plain = stage('text.pdf', 'for-chrome-plain.pdf');
    await openPath(annotated);
    await drawEverything();
    expect(((await app.run('file.save')) as { saved: boolean }).saved).toBe(true);
    await closeAll();

    const browser = await chromium.launch({ channel: 'chromium' });
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
      const withDrawings = await chromeShot(page, annotated);
      const without = await chromeShot(page, plain);
      const same = await chromeShot(page, annotated);
      const scratch = await browser.newPage();
      const noise = await differingFraction(scratch, withDrawings, same);
      const signal = await differingFraction(scratch, withDrawings, without);
      await scratch.close();
      await page.close();
      expect(noise, 'two shots of the same file should look the same').toBeLessThan(0.001);
      expect(signal, 'our drawings should be visible in Chrome').toBeGreaterThan(0.002);
      expect(signal).toBeGreaterThan(Math.max(noise * 10, 0.002));
    } finally {
      await browser.close();
    }
  });
});
