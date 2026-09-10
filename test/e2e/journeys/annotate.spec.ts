/**
 * Journeys — marking a document up (M30, M31, M32, M33).
 *
 * Not one `app.run` for the action under test. Every annotation here is made by pressing the
 * ribbon button a person would press, by its visible label, and then dragging or clicking on
 * the page. Defect 5 is why: every stamp test in the suite drove `draw.stamp` **with
 * coordinates**, so the fact that a stamp the reader made would not go on the page went
 * untested until the operator tried it.
 *
 * One app for the file; each test opens its own document so a failure cannot cascade.
 */

import { expect, test } from '@playwright/test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type App } from '../harness';
import { closeEverything, journey } from '../journey';
import { expectNothingClipped, expectReadable, expectWindowSound } from '../layout';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');
const PNG = readFileSync(join(FIXTURES, 'create', 'logo-alpha.png'));

let app: App;
let workspace: string;

test.beforeAll(async () => {
  app = await launchApp({ noDemo: true });
  workspace = mkdtempSync(join(tmpdir(), 'ynot-m04-annotate-'));
});

test.afterAll(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

test.afterEach(async () => {
  await closeEverything(app);
});

function stage(name: string, as: string): string {
  const path = join(workspace, as);
  copyFileSync(join(FIXTURES, name), path);
  return path;
}

interface AnnotRow {
  readonly subtype: string;
  readonly author?: string | null;
  readonly rect?: { x0: number; y0: number; x1: number; y1: number };
}

const annotations = async (): Promise<AnnotRow[]> =>
  (await app.run('dev.annotations', { page: 0 })) as AnnotRow[];

interface DrawingRow {
  readonly subtype: string;
  readonly rect: { x0: number; y0: number; x1: number; y1: number };
}

const drawings = async (): Promise<DrawingRow[]> => (await app.run('dev.drawings')) as DrawingRow[];

// ---- M30 -------------------------------------------------------------------------------------

test('M30 — every text-markup tool is reached from the ribbon and drawn over the page', async () => {
  const j = journey(app);
  await j.openDocument(stage('text.pdf', 'markup.pdf'));

  const tools = [
    { label: 'Highlight', subtype: 'Highlight' },
    { label: 'Underline', subtype: 'Underline' },
    { label: 'Squiggly', subtype: 'Squiggly' },
    { label: 'Strikeout', subtype: 'StrikeOut' },
  ] as const;

  // The body lines of `text.pdf`, as fractions of the page. Fractions, not pixels: the first
  // markup opens the properties pane, the viewer re-fits the page from 1006 px wide to 720, and
  // every pixel offset measured before that points at the wrong line afterwards.
  const LINES = [0.13, 0.147, 0.226, 0.261];
  const LEFT = 0.129;
  const RIGHT = 0.447;
  let asked = false;
  let line = 0;
  for (const { label, subtype } of tools) {
    await j.clickRibbon('comment', label);
    const y = LINES[line] ?? 0.13;
    line += 1;
    await j.dragOnPageAt([LEFT, y], [RIGHT, y]);
    // The first markup opens the identity dialog. A journey answers it; it must not hang here.
    if (await j.answerIdentityIfAsked('E2E Reader')) asked = true;
    await app.page.waitForTimeout(300);
    const made = (await annotations()).filter((a) => a.subtype === subtype);
    const sel = (await app.run('dev.selection')) as { empty?: boolean; text?: string };
    const tool = (await app.run('dev.annotSelection')) as { activeTool?: string | null };
    expect(
      made.length,
      `${label} made no ${subtype} — after the drag the text selection was ` +
        `${JSON.stringify(sel)} and the active tool was ${String(tool.activeTool)}`,
    ).toBeGreaterThan(0);
    // Made by the name the dialog was answered with, not by nobody.
    expect(made[0]?.author ?? '').toBe('E2E Reader');
  }

  expect(asked, 'the first annotation should have asked who it is by').toBe(true);

  // The placed notes: a click, not a drag.
  await j.clickRibbon('comment', 'Note');
  await j.clickPageAt([0.6, 0.09]);
  expect((await annotations()).filter((a) => a.subtype === 'Text').length).toBe(1);

  await expectWindowSound(app.page);
});

test('M30 — a text box is typed into where the reader put it', async () => {
  const j = journey(app);
  await j.openDocument(stage('text.pdf', 'textbox.pdf'));
  await app.run('annot.identity', { name: 'E2E Reader', initials: 'ER', email: '' });

  await j.clickRibbon('comment', 'Text Box');
  await j.dragOnPageAt([0.08, 0.4], [0.35, 0.48]);
  await app.page.waitForTimeout(300);
  const editor = app.page.locator('.annot-editor');
  await expect(editor, 'a text box should open its editor where it was drawn').toBeVisible();
  await app.page.keyboard.type('Written by hand');
  // Escape throws the text away; Ctrl/Cmd+Enter is what keeps it (M30's InlineEditor).
  await app.page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await app.page.waitForTimeout(300);

  const boxes = (await annotations()).filter((a) => a.subtype === 'FreeText');
  expect(boxes.length).toBe(1);
  await expectWindowSound(app.page);
});

// ---- M31 -------------------------------------------------------------------------------------

test('M31 — a shape and an ink stroke are drawn with the pointer', async () => {
  const j = journey(app);
  await j.openDocument(stage('text.pdf', 'shapes.pdf'));
  await app.run('annot.identity', { name: 'E2E Reader', initials: 'ER', email: '' });

  await j.clickRibbon('comment', 'Rectangle');
  await j.dragOnPageAt([0.08, 0.09], [0.24, 0.16]);
  const squares = (await drawings()).filter((d) => d.subtype === 'Square');
  expect(squares.length, 'the rectangle tool drew nothing').toBe(1);
  const rect = squares[0]?.rect;
  expect((rect?.x1 ?? 0) - (rect?.x0 ?? 0)).toBeGreaterThan(20);

  await j.clickRibbon('comment', 'Pencil');
  const box = await j.pageBox();
  const startX = box.x + box.width * 0.3;
  const startY = box.y + box.height * 0.3;
  await app.page.mouse.move(startX, startY);
  await app.page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await app.page.mouse.move(startX + i * 8, startY + Math.sin(i) * 20);
  }
  await app.page.mouse.up();
  await app.page.waitForTimeout(400);
  expect(
    (await drawings()).filter((d) => d.subtype === 'Ink').length,
    'the pencil drew nothing',
  ).toBe(1);

  await expectWindowSound(app.page);
});

test('M31 — a catalogue stamp and a stamp the reader made both go on by tile then page', async () => {
  const j = journey(app);
  await j.openDocument(stage('text.pdf', 'stamps.pdf'));
  await app.run('annot.identity', { name: 'E2E Reader', initials: 'ER', email: '' });

  // The reader's own stamp, made from a picture — the Custom group comes first in the panel.
  const stampId = (await app.run('draw.stampCustom', {
    label: 'Screen clipping',
    png: Array.from(PNG),
    width: 900,
    height: 500,
  })) as string;

  await j.openPanel('nav.stamps');
  const panel = app.page.locator('#nav-host .panel[data-panel="nav.stamps"]');
  await expect(panel.locator('.stamp-group-title').first()).toHaveText('Custom');
  await expectReadable(panel);

  // 1. The stamp the reader made: click its tile, then click the page.
  await j.clickPanelTile('nav.stamps', `.stamp-tile[data-stamp="${stampId}"]`);
  await j.clickPageAt([0.16, 0.16]);
  await app.page.waitForTimeout(400);
  let placed = (await drawings()).filter((d) => d.subtype === 'Stamp');
  expect(placed.length, 'a stamp the reader made would not go on the page').toBe(1);
  const own = placed[0]?.rect;
  expect((own?.x1 ?? 0) - (own?.x0 ?? 0)).toBeGreaterThan(10);
  expect((own?.y1 ?? 0) - (own?.y0 ?? 0)).toBeGreaterThan(10);

  // 2. A catalogue stamp: any tile that is not the reader's own.
  await j.clickPanelTile('nav.stamps', `.stamp-tile:not([data-stamp="${stampId}"])`);
  await j.clickPageAt([0.16, 0.45]);
  await app.page.waitForTimeout(400);
  placed = (await drawings()).filter((d) => d.subtype === 'Stamp');
  expect(placed.length, 'a catalogue stamp would not go on the page').toBe(2);

  await expectWindowSound(app.page);
});

// ---- M32 -------------------------------------------------------------------------------------

test('M32 — the comments panel lists what was marked up, and a click walks to it', async () => {
  const j = journey(app);
  await j.openDocument(stage('comments.pdf', 'panel.pdf'));

  await j.clickRibbon('comment', 'Comments');
  const panel = app.page.locator('#nav-host .panel[data-panel="nav.comments"]');
  await expect(panel, 'the Comments button did not open the Comments panel').toBeVisible({
    timeout: 15_000,
  });
  const rows = panel.locator('.comments-row[data-row="comment"]');
  expect(await rows.count(), 'the comments panel listed nothing').toBeGreaterThan(0);

  await j.clickPanelTile('nav.comments', '.comments-row[data-row="comment"]');
  await app.page.waitForTimeout(300);
  await expect(panel.locator('.comments-row.is-selected')).toHaveCount(1);
  const selection = (await app.run('dev.annotSelection')) as { ids?: string[] };
  expect((selection.ids ?? []).length, 'clicking a comment selected nothing on the page').toBe(1);

  await expectNothingClipped(panel);
  await expectReadable(panel);
  await expectWindowSound(app.page);
});

// ---- M33 -------------------------------------------------------------------------------------

test('M33 — a distance is measured by dragging across the page', async () => {
  const j = journey(app);
  await j.openDocument(stage('measure.pdf', 'distance.pdf'));
  await app.run('annot.identity', { name: 'E2E Reader', initials: 'ER', email: '' });

  await j.clickRibbon('comment', 'Distance');
  await j.dragOnPageAt([0.1, 0.14], [0.34, 0.14]);
  // The distance tool finishes on the second click for some styles; make sure it is committed.
  const end = await j.pageBox();
  await app.page.mouse.click(end.x + end.width * 0.34, end.y + end.height * 0.14);
  await app.page.waitForTimeout(400);

  const measured = (await app.run('dev.measurements')) as ReadonlyArray<unknown>;
  expect(measured.length, 'dragging with the distance tool measured nothing').toBeGreaterThan(0);
  await expectWindowSound(app.page);
});
