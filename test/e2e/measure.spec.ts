/**
 * M33 acceptance tests — distance, perimeter, area, calibration and snapping, inside the real,
 * built app.
 *
 * The unit tests own the arithmetic (the scale, the conversions, the shoelace, the leaders and
 * the caption) and the file (`test/unit/measure/roundtrip.test.ts` saves and reopens through the
 * whole real pipeline). This file owns what only exists once there is a DOM, a viewer and a
 * running PDFium: measuring with the pointer, snapping to what is drawn, the calibration flow,
 * the panel, and the file after a save-and-reopen in the app itself.
 *
 * Each acceptance line in `docs/modules/M33-measuring-tools.md` has a test named after it.
 */

import { expect, test } from '@playwright/test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type App } from './harness';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

/** PDF points per millimetre. */
const MM = 72 / 25.4;
const mm = (value: number): number => value * MM;

/** Narrows away a value the test knows is there; `!` is forbidden project-wide. */
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected a ${what}, got nothing`);
  return value;
}

interface MeasurementRow {
  id: string;
  subtype: string;
  rect: { x0: number; y0: number; x1: number; y1: number };
  color: number | null;
  borderWidth: number | null;
  contents: string | null;
  subject: string | null;
  vertices: Array<{ x: number; y: number }>;
  intent: unknown;
  measure: unknown;
  value: number | null;
  text: string | null;
  extra: Record<string, unknown>;
  drawnByOverlay: boolean;
  appearance: { content: string; bbox: Record<string, number> } | null;
}

interface MeasureState {
  settings: {
    snap: boolean;
    snapEndpoints: boolean;
    snapMidpoints: boolean;
    snapIntersections: boolean;
    snapPaths: boolean;
    snapTolerance: number;
    writeContents: boolean;
  };
  defaults: { leaderLength: number; caption: boolean };
  scale: { fromValue: number; fromUnit: string; toValue: number; toUnit: string };
  ratio: string;
  pageCalibrated: boolean;
  live: { text: string; detail: string } | null;
  snap: { kind: string; label: string; point: { x: number; y: number } } | null;
  rows: Array<{ id: string; page: number; kindLabel: string; text: string; value: number }>;
  totals: Array<{ kind: string; unit: string; count: number; text: string }>;
}

interface SnapProbe {
  ready: boolean;
  paths: number;
  point: { x: number; y: number };
  snapped: { kind: string; label: string } | null;
}

let app: App;
let workspace: string;

test.beforeAll(async () => {
  app = await launchApp();
  workspace = mkdtempSync(join(tmpdir(), 'ynot-m33-'));
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

const measurements = (page = 0): Promise<MeasurementRow[]> =>
  app.run('dev.measurements', { page }) as Promise<MeasurementRow[]>;
const state = (page = 0): Promise<MeasureState> =>
  app.run('dev.measure', { page }) as Promise<MeasureState>;
const probeSnap = (args: Record<string, unknown>): Promise<SnapProbe> =>
  app.run('dev.snapPoints', args) as Promise<SnapProbe>;

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
  await app.page.waitForTimeout(250);
}

/** The fixture's own geometry, in page points. */
const LINE_100MM = [
  { x: mm(20), y: mm(250) },
  { x: mm(120), y: mm(250) },
];
const RECT_50X20 = [
  { x: mm(20), y: mm(200) },
  { x: mm(70), y: mm(200) },
  { x: mm(70), y: mm(220) },
  { x: mm(20), y: mm(220) },
];
const TRIANGLE = [
  { x: mm(30), y: mm(120) },
  { x: mm(90), y: mm(120) },
  { x: mm(30), y: mm(165) },
  { x: mm(30), y: mm(120) },
];

// ---- wiring ------------------------------------------------------------------------------------

test.describe('the module is wired in', () => {
  test.afterEach(closeAll);

  test('every tool and every action is a registered command', async () => {
    const commands = await app.commands();
    for (const id of [
      'measure.distance',
      'measure.perimeter',
      'measure.area',
      'measure.calibrate',
      'measure.scale',
      'measure.clearPageScale',
      'measure.snap',
      'measure.snapKind',
      'measure.results',
      'measure.copy',
      'measure.export',
      'tool.measureDistance.activate',
      'tool.measurePerimeter.activate',
      'tool.measureArea.activate',
      'tool.calibrate.activate',
    ]) {
      expect(commands, id).toContain(id);
    }
  });

  test('the Comment tab carries the Measure group', async () => {
    await openPath(stage('measure.pdf', 'ribbon.pdf'));
    await app.page.setViewportSize({ width: 1400, height: 900 });
    await app.page.locator('[role="tab"]', { hasText: 'Comment' }).first().click();
    await expect(app.page.locator('#ribbon-body')).toContainText('Measure');
  });
});

// ---- the acceptance numbers ---------------------------------------------------------------------

test.describe('a 100 mm line measures 100.0 mm ±0.1 after calibration; a 50×20 mm rect is 1000 mm²', () => {
  test.afterEach(closeAll);

  test('calibrating on the fixture’s own line makes every measurement true size', async () => {
    await openPath(stage('measure.pdf', 'calibrate.pdf'));
    // Deliberately start from a scale that is wrong, so a calibration that did nothing would show.
    await app.run('measure.scale', {
      scale: { fromValue: 1, fromUnit: 'mm', toValue: 5, toUnit: 'mm', precision: 1 },
      scope: 'document',
    });
    expect((await state()).ratio).toBe('1 mm = 5 mm');

    const ratio = await app.run('measure.calibrate', {
      page: 0,
      from: LINE_100MM[0],
      to: LINE_100MM[1],
      length: 100,
      unit: 'mm',
      scope: 'page',
    });
    expect(ratio).toBe('1 mm = 1 mm');
    const after = await state();
    expect(after.pageCalibrated).toBe(true);

    await app.run('measure.distance', { page: 0, vertices: LINE_100MM });
    await app.run('measure.area', { page: 0, vertices: RECT_50X20 });
    await app.run('measure.perimeter', { page: 0, vertices: TRIANGLE });
    const rows = await until(measurements, (list) => list.length >= 3);
    expect(rows).toHaveLength(3);

    const distance = must(
      rows.find((r) => r.intent === 'LineDimension'),
      'distance',
    );
    const area = must(
      rows.find((r) => r.intent === 'PolygonDimension'),
      'area',
    );
    const perimeter = must(
      rows.find((r) => r.intent === 'PolyLineDimension'),
      'perimeter',
    );
    expect(Math.abs(must(distance.value, 'value') - 100)).toBeLessThanOrEqual(0.1);
    expect(distance.text).toBe('100.0 mm');
    expect(Math.abs(must(area.value, 'value') - 1000)).toBeLessThanOrEqual(0.1);
    expect(area.text).toBe('1,000.0 mm²');
    expect(Math.abs(must(perimeter.value, 'value') - 180)).toBeLessThanOrEqual(0.1);

    // The value is on the page as well as in the model, and in `/Contents` for a plain viewer.
    expect(distance.appearance?.content).toContain('(100.0 mm)');
    expect(distance.contents).toBe('100.0 mm');
    // Each measurement carries its own scale, which is what makes it reopen right. The ratio is
    // whatever the arithmetic gave, floating-point tail and all — the *display* is what rounds.
    for (const row of rows) {
      const scale = row.measure as { toUnit: string; toValue: number };
      expect(scale.toUnit).toBe('mm');
      expect(scale.toValue).toBeCloseTo(1, 9);
    }
    expect((await state()).ratio).toBe('1 mm = 1 mm');
  });

  test('a page keeps its own calibration when the document’s changes, until it is cleared', async () => {
    await openPath(stage('measure.pdf', 'per-page.pdf'));
    await app.run('measure.calibrate', {
      page: 0,
      from: LINE_100MM[0],
      to: LINE_100MM[1],
      length: 200,
      unit: 'mm',
      scope: 'page',
    });
    expect((await state()).ratio).toBe('1 mm = 2 mm');
    // The document's scale moves; the calibrated page does not.
    await app.run('measure.scale', {
      scale: { fromValue: 1, fromUnit: 'mm', toValue: 9, toUnit: 'mm', precision: 1 },
      scope: 'document',
    });
    expect((await state()).ratio).toBe('1 mm = 2 mm');
    expect(await app.run('measure.clearPageScale', { page: 0 })).toBe(true);
    expect((await state()).ratio).toBe('1 mm = 9 mm');
    expect((await state()).pageCalibrated).toBe(false);
  });

  test('recalibrating re-measures what is already on the page', async () => {
    await openPath(stage('measure.pdf', 'remeasure.pdf'));
    await app.run('measure.calibrate', {
      page: 0,
      from: LINE_100MM[0],
      to: LINE_100MM[1],
      length: 100,
      unit: 'mm',
      scope: 'page',
    });
    const id = await app.run('measure.distance', { page: 0, vertices: LINE_100MM });
    let rows = await until(measurements, (list) => list.length === 1);
    expect(rows[0]?.text).toBe('100.0 mm');

    // The same line is now said to be 200 mm: the measurement already drawn has to agree.
    await app.run('measure.calibrate', {
      page: 0,
      from: LINE_100MM[0],
      to: LINE_100MM[1],
      length: 200,
      unit: 'mm',
      scope: 'page',
    });
    rows = await until(measurements, (list) => list[0]?.text === '200.0 mm');
    expect(rows[0]?.id).toBe(id);
    expect(rows[0]?.text).toBe('200.0 mm');
    expect(rows[0]?.contents).toBe('200.0 mm');
  });
});

// ---- snapping ----------------------------------------------------------------------------------

test.describe('snap picks the nearest vertex within tolerance', () => {
  test.afterEach(closeAll);

  test('the pointer lands on a corner, a midpoint and a crossing of what is drawn', async () => {
    await openPath(stage('measure.pdf', 'snap.pdf'));
    // The page's geometry is read in the background the first time it is asked for.
    await until(
      () => probeSnap({ page: 0, x: 0, y: 0 }),
      (probe) => probe.ready && probe.paths > 0,
    );

    // A vertex: the rectangle's bottom-left corner, from 3 points away.
    const corner = await probeSnap({
      page: 0,
      x: mm(20) + 3,
      y: mm(200) - 2,
      scale: 1,
    });
    expect(corner.snapped?.kind).toBe('endpoints');
    expect(corner.point.x).toBeCloseTo(mm(20), 2);
    expect(corner.point.y).toBeCloseTo(mm(200), 2);
    expect(corner.snapped?.label).toBe('Endpoints');

    // A midpoint: half way along the 100 mm line.
    await app.run('measure.snapKind', { kind: 'endpoints', on: false });
    const middle = await probeSnap({ page: 0, x: mm(70) + 2, y: mm(250) + 2, scale: 1 });
    expect(middle.snapped?.kind).toBe('midpoints');
    expect(middle.point.x).toBeCloseTo(mm(70), 2);

    // A crossing: the two lines that meet at exactly (150, 100) mm.
    await app.run('measure.snapKind', { kind: 'midpoints', on: false });
    const crossing = await probeSnap({ page: 0, x: mm(150) + 2, y: mm(100) - 2, scale: 1 });
    expect(crossing.snapped?.kind).toBe('intersections');
    expect(crossing.point.x).toBeCloseTo(mm(150), 2);
    expect(crossing.point.y).toBeCloseTo(mm(100), 2);

    await app.run('measure.snapKind', { kind: 'endpoints', on: true });
    await app.run('measure.snapKind', { kind: 'midpoints', on: true });
  });

  test('a measurement already drawn is something the next one can snap to', async () => {
    await openPath(stage('measure.pdf', 'snap-annots.pdf'));
    await app.run('measure.snap', { on: false });
    // Somewhere with nothing of the page's own near it.
    const away = [
      { x: 400, y: 700 },
      { x: 520, y: 700 },
    ];
    await app.run('measure.distance', { page: 0, vertices: away });
    await app.run('measure.snap', { on: true });
    await app.page.waitForTimeout(400);
    const found = await until(
      () => probeSnap({ page: 0, x: 522, y: 702, scale: 1 }),
      (probe) => probe.snapped !== null,
    );
    expect(found.snapped?.kind).toBe('endpoints');
    expect(found.point.x).toBeCloseTo(520, 3);
    expect(found.point.y).toBeCloseTo(700, 3);
  });

  test('nothing snaps when the pointer is too far away, or when snapping is off', async () => {
    await openPath(stage('measure.pdf', 'snap-off.pdf'));
    await until(
      () => probeSnap({ page: 0, x: 0, y: 0 }),
      (probe) => probe.ready && probe.paths > 0,
    );
    const far = await probeSnap({ page: 0, x: mm(150), y: mm(280), scale: 1 });
    expect(far.snapped).toBeNull();
    expect(far.point.x).toBeCloseTo(mm(150), 6);

    expect(await app.run('measure.snap', { on: false })).toBe(false);
    const off = await probeSnap({ page: 0, x: mm(20) + 1, y: mm(200), scale: 1 });
    expect(off.snapped).toBeNull();
    expect(off.point.x).toBeCloseTo(mm(20) + 1, 6);
    expect(await app.run('measure.snap', { on: true })).toBe(true);
  });
});

// ---- the pointer -------------------------------------------------------------------------------

test.describe('measuring with the pointer', () => {
  test.afterEach(closeAll);

  test('a distance is a drag, and an area is a click per corner', async () => {
    await openPath(stage('measure.pdf', 'pointer.pdf'));
    // Snapping off: this test is about the gestures, not about where they land.
    await app.run('measure.snap', { on: false });
    await app.run('tool.measureDistance.activate');
    await drag([100, 500], [300, 500]);
    let rows = await until(measurements, (list) => list.length >= 1);
    const distance = must(rows[0], 'distance');
    expect(distance.subtype).toBe('Line');
    expect(distance.intent).toBe('LineDimension');
    expect(distance.vertices).toHaveLength(2);
    expect(must(distance.value, 'value')).toBeGreaterThan(0);

    await app.run('tool.measureArea.activate');
    const box = await pageBox();
    for (const [x, y] of [
      [100, 300],
      [220, 300],
      [220, 380],
    ] as const) {
      await app.page.mouse.click(box.x + x, box.y + y);
      await app.page.waitForTimeout(450);
    }
    await app.page.keyboard.press('Enter');
    rows = await until(measurements, (list) => list.length >= 2);
    const area = must(
      rows.find((r) => r.intent === 'PolygonDimension'),
      'area',
    );
    expect(area.vertices).toHaveLength(3);
    expect(must(area.value, 'value')).toBeGreaterThan(0);

    // Each is one undo step of its own.
    await app.run('edit.undo');
    await app.run('edit.undo');
    await app.page.waitForTimeout(250);
    expect(await measurements()).toHaveLength(0);
    await app.run('measure.snap', { on: true });
  });

  test('the live value follows the drag, and is cleared when the gesture ends', async () => {
    await openPath(stage('measure.pdf', 'live.pdf'));
    await app.run('measure.snap', { on: false });
    await app.run('tool.measureDistance.activate');
    const box = await pageBox();
    await app.page.mouse.move(box.x + 100, box.y + 500);
    await app.page.mouse.down();
    await app.page.mouse.move(box.x + 260, box.y + 500, { steps: 8 });
    await app.page.waitForTimeout(200);
    const live = (await state()).live;
    expect(live).not.toBeNull();
    expect(live?.text).toMatch(/mm$/);
    await app.page.mouse.up();
    await app.page.waitForTimeout(300);
    expect((await state()).live).toBeNull();
    await app.run('measure.snap', { on: true });
  });

  test('dragging a measured point re-measures the line', async () => {
    await openPath(stage('measure.pdf', 'handles.pdf'));
    const id = (await app.run('measure.distance', {
      page: 0,
      vertices: [
        { x: 100, y: 600 },
        { x: 300, y: 600 },
      ],
    })) as string;
    await app.page.waitForTimeout(250);
    await app.run('annot.selectAll');
    const handle = app.page.locator(`.annot-handle[data-handle="v1"][data-annot="${id}"]`);
    await expect(handle).toBeVisible();
    const box = must(await handle.boundingBox(), 'handle');
    const before = must(
      (await measurements()).find((r) => r.id === id),
      'before',
    );
    await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await app.page.mouse.down();
    await app.page.mouse.move(box.x - 80, box.y, { steps: 10 });
    await app.page.mouse.up();
    await app.page.waitForTimeout(400);
    const after = must(
      (await measurements()).find((r) => r.id === id),
      'after',
    );
    expect(must(after.value, 'value')).toBeLessThan(must(before.value, 'value'));
    // The caption and `/Contents` were both rewritten to match.
    expect(after.contents).toBe(after.text);
    expect(after.appearance?.content).toContain(`(${String(after.text)})`);
  });
});

// ---- the properties panel and the provider ------------------------------------------------------

test.describe('a measurement is M33’s, not M31’s', () => {
  test.afterEach(closeAll);

  test('the properties pane calls it a measurement and offers its own controls', async () => {
    await openPath(stage('measure.pdf', 'panel.pdf'));
    await app.page.setViewportSize({ width: 1400, height: 900 });
    await app.run('measure.calibrate', {
      page: 0,
      from: LINE_100MM[0],
      to: LINE_100MM[1],
      length: 100,
      unit: 'mm',
      scope: 'page',
    });
    // Creating a measurement selects it, so the panel is already its own.
    await app.run('measure.distance', { page: 0, vertices: LINE_100MM });
    await app.page.waitForTimeout(300);
    const pane = app.page.locator('#annot-props');
    // M31's provider would have said "Line"; M33's outranks it (ADR 0018).
    await expect(pane).toContainText('Distance measurement');
    await expect(pane).toContainText('100.0 mm');
    await expect(pane).toContainText('Show the value on the page');
    await expect(pane).toContainText('Leader lines');
    await expect(pane).toContainText('Line ends');
    await expect(pane).toContainText('Show in');
  });

  test('the caption has a handle of its own, and moving it changes no measurement', async () => {
    await openPath(stage('measure.pdf', 'caption-drag.pdf'));
    await app.page.setViewportSize({ width: 1400, height: 900 });
    await app.run('measure.calibrate', {
      page: 0,
      from: LINE_100MM[0],
      to: LINE_100MM[1],
      length: 100,
      unit: 'mm',
      scope: 'page',
    });
    const id = (await app.run('measure.distance', { page: 0, vertices: LINE_100MM })) as string;
    await app.page.waitForTimeout(300);
    await app.run('annot.selectAll');

    const handle = app.page.locator(`.annot-handle[data-handle="caption"][data-annot="${id}"]`);
    await expect(handle).toBeVisible();
    const box = must(await handle.boundingBox(), 'caption handle');
    await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await app.page.mouse.down();
    await app.page.mouse.move(box.x + 70, box.y - 50, { steps: 10 });
    await app.page.mouse.up();
    await app.page.waitForTimeout(400);

    const moved = must(
      (await measurements()).find((r) => r.id === id),
      'moved',
    );
    const offset = moved.extra['captionOffset'];
    expect(Array.isArray(offset)).toBe(true);
    expect((offset as number[]).some((n) => Math.abs(n) > 5)).toBe(true);
    // The label moved; the measurement did not.
    expect(moved.text).toBe('100.0 mm');
    expect(moved.vertices).toEqual(LINE_100MM);
    // And the caption is drawn where it was dropped, in the stream the file will carry.
    expect(moved.appearance?.content).toContain('(100.0 mm)');

    // "Put the value back" is one step, and so was the drag.
    await app.page.locator('#annot-props button', { hasText: 'Put the value back' }).click();
    await app.page.waitForTimeout(300);
    expect(
      must(
        (await measurements()).find((r) => r.id === id),
        'centred',
      ).extra['captionOffset'],
    ).toEqual([0, 0]);
    await app.run('edit.undo');
    await app.page.waitForTimeout(250);
    expect(
      (
        must(
          (await measurements()).find((r) => r.id === id),
          'again',
        ).extra['captionOffset'] as number[]
      ).some((n) => Math.abs(n) > 5),
    ).toBe(true);
  });

  test('the panel changes the unit and the line ends, each undoing as one step', async () => {
    await openPath(stage('measure.pdf', 'panel-edits.pdf'));
    await app.page.setViewportSize({ width: 1400, height: 900 });
    await app.run('measure.calibrate', {
      page: 0,
      from: LINE_100MM[0],
      to: LINE_100MM[1],
      length: 100,
      unit: 'mm',
      scope: 'page',
    });
    const id = (await app.run('measure.distance', { page: 0, vertices: LINE_100MM })) as string;
    await app.page.waitForTimeout(300);

    // Shown in centimetres: the same length, said differently.
    await app.page
      .locator('#annot-props select[aria-label="Unit this measurement is shown in"]')
      .selectOption('cm');
    let row = await until(
      async () =>
        must(
          (await measurements()).find((r) => r.id === id),
          'row',
        ),
      (r) => r.text === '10.0 cm',
    );
    expect(row.text).toBe('10.0 cm');
    expect(row.measure).toMatchObject({ toUnit: 'cm' });
    await app.run('edit.undo');
    await app.page.waitForTimeout(250);
    expect(
      must(
        (await measurements()).find((r) => r.id === id),
        'row',
      ).text,
    ).toBe('100.0 mm');

    // An arrow on the far end of the dimension line.
    await app.page.locator('#annot-props select[aria-label="End"]').selectOption('OpenArrow');
    row = await until(
      async () =>
        must(
          (await measurements()).find((r) => r.id === id),
          'row',
        ),
      (r) => Array.isArray(r.extra['lineEndings']),
    );
    expect(row.extra['lineEndings']).toEqual(['None', 'OpenArrow']);
    // The head is in the appearance stream the file will carry.
    expect(row.appearance?.content).toContain('m');
    await app.run('edit.undo');
    await app.page.waitForTimeout(250);
    expect(
      must(
        (await measurements()).find((r) => r.id === id),
        'row',
      ).extra['lineEndings'],
    ).toEqual(['None', 'None']);
  });
});

// ---- the results panel --------------------------------------------------------------------------

test.describe('the results panel lists what has been measured', () => {
  test.afterEach(closeAll);

  test('it shows every measurement, the scale and running totals', async () => {
    await openPath(stage('measure.pdf', 'results.pdf'));
    await app.page.setViewportSize({ width: 1400, height: 900 });
    await app.run('measure.calibrate', {
      page: 0,
      from: LINE_100MM[0],
      to: LINE_100MM[1],
      length: 100,
      unit: 'mm',
      scope: 'page',
    });
    await app.run('measure.distance', { page: 0, vertices: LINE_100MM });
    await app.run('measure.area', { page: 0, vertices: RECT_50X20 });
    await app.run('measure.results');
    await app.page.waitForTimeout(400);

    const panel = app.page.locator('.measure-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('100.0 mm');
    await expect(panel).toContainText('1,000.0 mm²');
    await expect(panel).toContainText('Scale: 1 mm = 1 mm');
    await expect(panel).toContainText('Totals');
    // Lengths and areas are totalled apart: adding them would mean nothing.
    await expect(panel).toContainText('Length (mm), 1 measured: 100.0 mm');
    await expect(panel).toContainText('Area (mm²), 1 measured: 1,000.0 mm²');

    const totals = (await state()).totals;
    expect(totals.map((t) => t.kind)).toEqual(['length', 'area']);
    // Every row is a button, so the whole list is reachable from the keyboard.
    expect(await panel.locator('button.measure-row').count()).toBe(2);
  });

  test('copy puts the whole list on the clipboard', async () => {
    await openPath(stage('measure.pdf', 'copy.pdf'));
    await app.run('measure.distance', { page: 0, vertices: LINE_100MM });
    await app.page.waitForTimeout(250);
    expect(await app.run('measure.copy')).toBe(1);
  });
});

// ---- the file --------------------------------------------------------------------------------

test.describe('a saved measurement carries /Measure and reopens with the same value', () => {
  test.afterEach(closeAll);

  test('everything survives a save and a reopen, and the raster then carries it all', async () => {
    const path = stage('measure.pdf', 'saved.pdf');
    await openPath(path);
    await app.run('measure.calibrate', {
      page: 0,
      from: LINE_100MM[0],
      to: LINE_100MM[1],
      length: 100,
      unit: 'mm',
      scope: 'page',
    });
    await app.run('measure.distance', { page: 0, vertices: LINE_100MM });
    await app.run('measure.area', { page: 0, vertices: RECT_50X20 });
    await app.run('measure.perimeter', { page: 0, vertices: TRIANGLE });
    const before = await until(measurements, (list) => list.length >= 3);
    const summary = (r: MeasurementRow): string =>
      JSON.stringify([r.intent, r.text, r.vertices.map((p) => [Math.round(p.x), Math.round(p.y)])]);
    const wanted = before.map(summary).sort();
    expect(((await app.run('file.save')) as { saved: boolean }).saved).toBe(true);
    await closeAll();

    await openPath(path);
    const rows = await until(measurements, (list) => list.length >= 3);
    expect(rows.map(summary).sort()).toEqual(wanted);
    for (const row of rows) {
      // The scale came back out of `/Measure`, not out of the app's own setting.
      expect(row.measure, String(row.intent)).toMatchObject({ toUnit: 'mm' });
      // Every one carries an appearance stream now, so the raster draws them and we do not.
      expect(row.drawnByOverlay, String(row.intent)).toBe(false);
      expect(row.extra['hasAP']).toBe(true);
    }
  });

  test('a reopened measurement still measures right when the document’s scale has moved on', async () => {
    const path = stage('measure.pdf', 'stale-scale.pdf');
    await openPath(path);
    await app.run('measure.calibrate', {
      page: 0,
      from: LINE_100MM[0],
      to: LINE_100MM[1],
      length: 100,
      unit: 'mm',
      scope: 'document',
    });
    await app.run('measure.distance', { page: 0, vertices: LINE_100MM });
    await until(measurements, (list) => list.length >= 1);
    expect(((await app.run('file.save')) as { saved: boolean }).saved).toBe(true);
    await closeAll();

    await openPath(path);
    await until(measurements, (list) => list.length >= 1);
    // The reader moves the *document's* ruler without recalibrating the page…
    await app.run('measure.scale', {
      scale: { fromValue: 1, fromUnit: 'mm', toValue: 7, toUnit: 'mm', precision: 1 },
      scope: 'page',
    });
    await app.page.waitForTimeout(300);
    const rows = await measurements();
    // …and the measurement on the page follows it, because that is what recalibrating means.
    expect(rows[0]?.text).toBe('700.0 mm');
  });
});
