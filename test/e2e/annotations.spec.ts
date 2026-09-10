/**
 * M30 acceptance tests — text markup, notes, typewriter, text box and callout inside the real,
 * built app.
 *
 * The unit tests own the arithmetic (the quads, the appearance streams, the style strings, the
 * clipboard) and the file (`test/unit/annotations/roundtrip.test.ts` saves and reopens through the
 * whole real pipeline). This file owns what only exists once there is a DOM, a viewer and a
 * running PDFium: creating an annotation with the pointer, dragging and resizing it, the popup and
 * the inline editor, copy and paste between two documents, and what Chrome makes of the file we
 * wrote.
 *
 * Each acceptance line in `docs/modules/M30-markup-annotations.md` has a test named after it.
 */

import { chromium, expect, test, type Frame, type Page } from '@playwright/test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchApp, type App } from './harness';
import { expectReadable } from './layout';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

/** Narrows away a value the test knows is there; `!` is forbidden project-wide. */
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected a ${what}, got nothing`);
  return value;
}

interface AnnotationRow {
  id: string;
  subtype: string;
  family: string;
  rect: { x0: number; y0: number; x1: number; y1: number };
  color: number | null;
  interiorColor: number | null;
  opacity: number | null;
  contents: string | null;
  author: string | null;
  subject: string | null;
  state: string | null;
  inReplyTo: string | null;
  quadPoints: number[];
  intent: string | null;
  freeTextIntent: string | null;
  icon: string | null;
  style: { family: string; size: number; align: number; color: number } | null;
  callout: number[] | null;
  ours: boolean;
  extra: Record<string, unknown>;
}

interface SelectionState {
  ids: string[];
  drawn: string[];
  total: number;
  activeTool: string | null;
  keepToolSelected: boolean;
}

let app: App;
let workspace: string;

test.beforeAll(async () => {
  app = await launchApp();
  workspace = mkdtempSync(join(tmpdir(), 'ynot-m30-'));
  // Answer the identity question once, up front: every annotation carries an author, and the
  // dialog would otherwise block the first one in every test.
  await app.run('annot.identity', { name: 'E2E Reader', initials: 'ER', email: '' });
});

test.afterAll(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

/** Copies a fixture into the scratch folder so a save has somewhere to go. */
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

/**
 * Closes every tab, discarding the edits.
 *
 * Annotating makes a document dirty, so M21 asks "Save · Don't save · Cancel" before each tab
 * goes — one dialog per open document, and a test that walks away from one leaves the next test
 * staring at it. Every one of them is answered here.
 */
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

const annotations = (page = 0): Promise<AnnotationRow[]> =>
  app.run('dev.annotations', { page }) as Promise<AnnotationRow[]>;

const selection = (): Promise<SelectionState> =>
  app.run('dev.annotSelection') as Promise<SelectionState>;

/**
 * The first page's box, with the page scrolled into view first.
 *
 * `boundingBox()` reports where the element *is*, which is not necessarily where it can be
 * clicked: the ribbon grows when the Comment tab is chosen and the properties pane opens when
 * something is selected, and either can push part of a page behind the chrome. Scrolling it in
 * first keeps a coordinate the mouse can actually reach.
 */
async function pageBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const page = app.page.locator('.viewer-content .page').first();
  await page.scrollIntoViewIfNeeded();
  return must(await page.boundingBox(), 'page box');
}

/** Clicks a point inside the first page, in the page element's own coordinates. */
async function clickPage(x: number, y: number): Promise<void> {
  await app.page.locator('.viewer-content .page').first().click({ position: { x, y } });
  await app.page.waitForTimeout(150);
}

/** Closes the popup note, if one is open. Placing a note opens one, and it covers the page. */
async function closePopup(): Promise<void> {
  const popup = app.page.locator('#annot-popup');
  if ((await popup.count()) === 0) return;
  await popup.locator('.annot-popup-close').click();
  await app.page.waitForTimeout(120);
}

/** Selects some text on page 1 with the pointer, which is what the markup commands act on. */
async function selectSomeText(): Promise<void> {
  await app.run('tool.selectText.activate');
  const box = await pageBox();
  await app.page.mouse.move(box.x + 80, box.y + 120);
  await app.page.mouse.down();
  await app.page.mouse.move(box.x + 340, box.y + 124, { steps: 10 });
  await app.page.mouse.up();
  await app.page.waitForTimeout(150);
}

/** Waits until a probe reports what the test is waiting for, or gives up. */
async function until<T>(probe: () => Promise<T>, ready: (value: T) => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (ready(value)) return value;
    if (Date.now() > deadline) return value;
    await app.page.waitForTimeout(120);
  }
}

// ---- the commands and the tools ---------------------------------------------------------------

test.describe('the module is wired in', () => {
  test.afterEach(closeAll);

  test('every tool and every action is a registered command', async () => {
    const commands = await app.commands();
    for (const id of [
      'annot.highlight',
      'annot.underline',
      'annot.squiggly',
      'annot.strikeout',
      'annot.replace',
      'annot.insert',
      'annot.note',
      'annot.typewriter',
      'annot.textbox',
      'annot.callout',
      'annot.delete',
      'annot.copy',
      'annot.cut',
      'annot.paste',
      'annot.selectAll',
      'annot.keepToolSelected',
      'annot.identity',
      'annot.reply',
      'annot.setStatus',
      'tool.selectAnnotation.activate',
      'tool.note.activate',
      'tool.typewriter.activate',
      'tool.textbox.activate',
      'tool.callout.activate',
    ]) {
      expect(commands, id).toContain(id);
    }
  });

  test('the Comment tab carries the ribbon groups', async () => {
    await openPath(stage('text.pdf', 'ribbon.pdf'));
    await app.page.setViewportSize({ width: 1280, height: 900 });
    await app.run('view.ribbon.tab', { tab: 'comment' }).catch(() => undefined);
    await app.page.locator('[role="tab"]', { hasText: 'Comment' }).first().click();
    await expect(app.page.locator('#ribbon-body')).toContainText('Text markup');
  });
});

// ---- each tool creates its annotation ----------------------------------------------------------

test.describe('each tool creates its annotation', () => {
  test.afterEach(closeAll);

  test('the four text-markup tools mark the selected text', async () => {
    await openPath(stage('text.pdf', 'markup.pdf'));
    for (const [command, subtype] of [
      ['annot.highlight', 'Highlight'],
      ['annot.underline', 'Underline'],
      ['annot.squiggly', 'Squiggly'],
      ['annot.strikeout', 'StrikeOut'],
    ] as const) {
      await selectSomeText();
      await app.run(command);
      await app.page.waitForTimeout(120);
      const made = (await annotations()).filter((a) => a.subtype === subtype);
      expect(made.length, subtype).toBeGreaterThan(0);
      const first = must(made[0], subtype);
      // Quads, an author and a subject, and no `/CA` — the app writes solid colours only.
      expect(first.quadPoints.length, subtype).toBeGreaterThanOrEqual(8);
      expect(first.author).toBe('E2E Reader');
      expect(first.subject).toBe(subtype === 'StrikeOut' ? 'Strikeout' : subtype);
      expect(first.opacity === null || first.opacity === 1).toBe(true);
    }
  });

  test('Replace Text writes a strike-out and a caret, as one undo step', async () => {
    await openPath(stage('text.pdf', 'replace.pdf'));
    const before = (await annotations()).length;
    await selectSomeText();
    await app.run('annot.replace');
    await app.page.waitForTimeout(150);
    const after = await annotations();
    expect(after.length).toBe(before + 2);
    expect(after.some((a) => a.subtype === 'StrikeOut')).toBe(true);
    const caret = must(
      after.find((a) => a.subtype === 'Caret'),
      'caret',
    );
    expect(caret.intent).toBe('Replace');
    // One composite command, so one undo takes both away.
    await app.run('edit.undo');
    await app.page.waitForTimeout(150);
    expect((await annotations()).length).toBe(before);
  });

  test('Insert Text marks where text should go', async () => {
    await openPath(stage('text.pdf', 'insert.pdf'));
    await selectSomeText();
    await app.run('annot.insert');
    await app.page.waitForTimeout(150);
    const caret = must(
      (await annotations()).find((a) => a.subtype === 'Caret'),
      'caret',
    );
    expect(caret.intent).toBe('InsertText');
    expect(caret.rect.y1).toBeGreaterThan(caret.rect.y0);
  });

  test('the Note tool drops a note where the page is clicked', async () => {
    await openPath(stage('text.pdf', 'note.pdf'));
    await app.run('tool.note.activate');
    await clickPage(200, 200);
    const made = await until(annotations, (list) => list.some((a) => a.subtype === 'Text'));
    const note = must(
      made.find((a) => a.subtype === 'Text'),
      'note',
    );
    expect(note.icon).toBe('Comment');
    // 20 × 20, which is what every reader draws a note as.
    expect(Math.round(note.rect.x1 - note.rect.x0)).toBe(20);
    await app.run('annot.edit');
    await expect(app.page.locator('#annot-popup')).toBeVisible();
    await app.page.locator('#annot-popup .annot-popup-body').fill('typed into the popup');
    await app.page.locator('#annot-popup .btn-primary').click();
    await app.page.waitForTimeout(150);
    const saved = must(
      (await annotations()).find((a) => a.subtype === 'Text'),
      'note',
    );
    expect(saved.contents).toContain('typed into the popup');
  });

  test('a typewriter, a text box and a callout are each what their `/IT` says', async () => {
    await openPath(stage('text.pdf', 'freetext.pdf'));
    const cases = [
      ['annot.typewriter', 'FreeTextTypewriter'],
      ['annot.textbox', 'FreeText'],
      ['annot.callout', 'FreeTextCallout'],
    ] as const;
    let y = 300;
    const ids: string[] = [];
    for (const [command, intent] of cases) {
      const rect = { x0: 60, y0: y, x1: 300, y1: y + 40 };
      y += 60;
      const args =
        intent === 'FreeTextCallout'
          ? {
              page: 0,
              rect,
              callout: [
                { x: 30, y: 260 },
                { x: 45, y: 320 },
                { x: 60, y: 320 },
              ],
            }
          : { page: 0, rect };
      ids.push((await app.run(command, args)) as string);
      await app.page.waitForTimeout(120);
      const made = (await annotations()).filter((a) => a.freeTextIntent === intent);
      expect(made.length, intent).toBe(1);
      const one = must(made[0], intent);
      expect(one.style?.family).toBe('Helvetica');
      if (intent === 'FreeTextCallout') expect(one.callout?.length).toBe(6);
      if (intent === 'FreeTextTypewriter') expect(one.interiorColor).toBeNull();
    }

    /*
     * PDFium will not draw free text at all, so the overlay has to. The text box and the callout
     * have a border to draw straight away; the typewriter is words on the page and nothing else,
     * so an empty one draws nothing until it has some — which is also why the inline editor
     * removes a box the reader typed nothing into.
     */
    expect((await selection()).drawn.length).toBe(2);
    await app.run('annot.setText', { id: ids[0], text: 'now it has words' });
    await app.page.waitForTimeout(200);
    expect((await selection()).drawn.length).toBe(3);
  });

  test('the inline editor types into a text box and the words reach the model', async () => {
    await openPath(stage('text.pdf', 'typing.pdf'));
    const id = (await app.run('annot.textbox', {
      page: 0,
      rect: { x0: 60, y0: 300, x1: 320, y1: 350 },
    })) as string;
    await app.run('annot.edit', { id });
    const editor = app.page.locator('.annot-editor');
    await expect(editor).toBeVisible();
    await editor.fill('typed in place');
    await app.page.keyboard.press('Control+Enter');
    await app.page.waitForTimeout(200);
    const one = must(
      (await annotations()).find((a) => a.id === id),
      'text box',
    );
    expect(one.contents).toBe('typed in place');
  });
});

// ---- selection, geometry and the undo stack -----------------------------------------------------

test.describe('move, resize, delete, undo and redo', () => {
  test.afterEach(closeAll);

  test('every type can be moved, and one drag is one undo step', async () => {
    await openPath(stage('text.pdf', 'move.pdf'));
    await selectSomeText();
    await app.run('annot.highlight');
    await app.run('annot.note', { page: 0, x: 400, y: 700 });
    await app.run('annot.textbox', { page: 0, rect: { x0: 60, y0: 300, x1: 300, y1: 340 } });
    await app.page.waitForTimeout(200);

    const before = await annotations();
    expect(before.length).toBeGreaterThanOrEqual(3);
    await app.run('annot.selectAll');
    expect((await selection()).ids.length).toBe(before.length);

    // Nudge: one arrow press is one command, ten points with Shift.
    await app.page
      .locator('.viewer-scroll')
      .first()
      .click({ position: { x: 5, y: 5 } });
    await app.run('annot.selectAll');
    await app.page.keyboard.press('ArrowRight');
    await app.page.waitForTimeout(200);
    const nudged = await annotations();
    for (const a of nudged) {
      const was = must(
        before.find((b) => b.id === a.id),
        'before',
      );
      expect(a.rect.x0 - was.rect.x0).toBeCloseTo(1, 1);
    }
    // A highlight's quads move with its rect, or it comes away from the words it marks.
    const highlight = must(
      nudged.find((a) => a.subtype === 'Highlight'),
      'highlight',
    );
    const wasHighlight = must(
      before.find((b) => b.id === highlight.id),
      'highlight',
    );
    expect(highlight.quadPoints[0]).toBeCloseTo((wasHighlight.quadPoints[0] ?? 0) + 1, 1);

    await app.run('edit.undo');
    await app.page.waitForTimeout(200);
    const back = await annotations();
    for (const a of back) {
      const was = must(
        before.find((b) => b.id === a.id),
        'before',
      );
      expect(a.rect.x0).toBeCloseTo(was.rect.x0, 2);
    }
  });

  test('a text box can be resized by dragging a handle', async () => {
    await openPath(stage('text.pdf', 'resize.pdf'));
    const id = (await app.run('annot.textbox', {
      page: 0,
      rect: { x0: 100, y0: 400, x1: 300, y1: 460 },
    })) as string;
    await app.page.waitForTimeout(200);
    await expect(app.page.locator(`.annot-handle[data-annot="${id}"]`).first()).toBeVisible();
    const handle = app.page.locator(`.annot-handle-se[data-annot="${id}"]`);
    const box = must(await handle.boundingBox(), 'handle box');
    await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await app.page.mouse.down();
    await app.page.mouse.move(box.x + 60, box.y + 40, { steps: 8 });
    await app.page.mouse.up();
    await app.page.waitForTimeout(250);
    const resized = must(
      (await annotations()).find((a) => a.id === id),
      'text box',
    );
    expect(resized.rect.x1).toBeGreaterThan(300);
    expect(resized.rect.y0).toBeLessThan(400);
  });

  test('Delete removes the selection, and undo brings it back', async () => {
    await openPath(stage('text.pdf', 'delete.pdf'));
    await app.run('annot.note', { page: 0, x: 300, y: 700 });
    await app.run('annot.note', { page: 0, x: 360, y: 700 });
    await app.page.waitForTimeout(200);
    expect((await annotations()).length).toBe(2);
    await app.run('annot.selectAll');
    expect(await app.run('annot.delete')).toBe(2);
    await app.page.waitForTimeout(200);
    expect((await annotations()).length).toBe(0);
    await app.run('edit.undo');
    await app.page.waitForTimeout(200);
    expect((await annotations()).length).toBe(2);
    await app.run('edit.redo');
    await app.page.waitForTimeout(200);
    expect((await annotations()).length).toBe(0);
  });

  test('a locked annotation refuses to be moved or deleted', async () => {
    await openPath(stage('text.pdf', 'locked.pdf'));
    const id = (await app.run('annot.note', { page: 0, x: 300, y: 700 })) as string;
    await app.page.waitForTimeout(150);
    await app.run('annot.selectAll');
    await app.page.locator('#pane-right input[type="checkbox"]').first().check();
    await app.page.waitForTimeout(200);
    const before = must(
      (await annotations()).find((a) => a.id === id),
      'note',
    );
    await app.run('annot.selectAll');
    expect(await app.run('annot.delete')).toBe(0);
    await app.page.waitForTimeout(150);
    const after = must(
      (await annotations()).find((a) => a.id === id),
      'note',
    );
    expect(after.rect).toEqual(before.rect);
  });
});

// ---- properties ---------------------------------------------------------------------------------

test.describe('the properties panel', () => {
  test.afterEach(closeAll);

  test('changing a property updates the annotation and undoes as one step', async () => {
    await openPath(stage('text.pdf', 'props.pdf'));
    await selectSomeText();
    const ids = (await app.run('annot.highlight')) as string[];
    const id = must(ids[0], 'highlight');
    await app.page.waitForTimeout(200);
    await app.run('annot.selectAll');
    await expect(app.page.locator('#annot-props')).toBeVisible();

    const before = must(
      (await annotations()).find((a) => a.id === id),
      'highlight',
    );
    // The swatch says its colour's *name*, which is what makes the panel usable at all here.
    const swatch = app.page.locator('#annot-props .annot-swatch', { hasText: 'Sky' }).first();
    await expect(swatch).toBeVisible();
    await swatch.click();
    await app.page.waitForTimeout(250);

    const after = must(
      (await annotations()).find((a) => a.id === id),
      'highlight',
    );
    expect(after.color).not.toBe(before.color);
    // And the appearance the writer would attach has changed with it.
    const stream = (await app.run('dev.annotAppearance', { id })) as { content: string } | null;
    expect(stream?.content).toContain('rg');

    await app.run('edit.undo');
    await app.page.waitForTimeout(250);
    const undone = must(
      (await annotations()).find((a) => a.id === id),
      'highlight',
    );
    expect(undone.color).toBe(before.color);
  });

  test('“Set as default” is remembered for the next annotation of that tool', async () => {
    await openPath(stage('text.pdf', 'defaults.pdf'));
    const id = (await app.run('annot.note', { page: 0, x: 300, y: 700 })) as string;
    await app.page.waitForTimeout(200);
    await app.run('annot.selectAll');
    await app.page.locator('#annot-props select').first().selectOption('Key');
    await app.page.waitForTimeout(200);
    expect(
      must(
        (await annotations()).find((a) => a.id === id),
        'note',
      ).icon,
    ).toBe('Key');

    await app.page.locator('#annot-props .btn', { hasText: 'Set as default' }).click();
    await app.page.waitForTimeout(200);
    expect(
      (await app.run('dev.annotDefaults', { tool: 'note' })) as { icon: string },
    ).toMatchObject({ icon: 'Key' });

    const second = (await app.run('annot.note', { page: 0, x: 380, y: 700 })) as string;
    await app.page.waitForTimeout(200);
    expect(
      must(
        (await annotations()).find((a) => a.id === second),
        'note',
      ).icon,
    ).toBe('Key');
  });

  test('the font list offers the base families and whatever the machine has', async () => {
    await openPath(stage('text.pdf', 'fonts.pdf'));
    await app.run('annot.textbox', { page: 0, rect: { x0: 60, y0: 300, x1: 300, y1: 340 } });
    await app.page.waitForTimeout(200);
    await app.run('annot.selectAll');
    const options = app.page.locator('#annot-props optgroup[label="Always available"] option');
    await expect(options.first()).toHaveText('Helvetica');
    expect(await options.count()).toBeGreaterThanOrEqual(3);
    // And it says, in words, what a family that is not one of those costs.
    await expect(app.page.locator('#annot-props .annot-field-note')).toContainText('not embedded');
  });

  test('a text box can be turned, and the words turn with it', async () => {
    await openPath(stage('text.pdf', 'rotate.pdf'));
    const id = (await app.run('annot.textbox', {
      page: 0,
      rect: { x0: 60, y0: 260, x1: 320, y1: 360 },
    })) as string;
    await app.run('annot.setText', { id, text: 'down the margin' });
    await app.page.waitForTimeout(200);
    await app.run('annot.selectAll');
    const rotation = app.page.locator('#annot-props select').filter({ hasText: 'Upside down' });
    await rotation.selectOption('90');
    await app.page.waitForTimeout(250);

    const turned = must(
      (await annotations()).find((a) => a.id === id),
      'text box',
    );
    expect(turned.extra['rotate']).toBe(90);
    // The rect is where it was — `/Rotate` turns the words, not the box.
    expect(Math.round(turned.rect.x0)).toBe(60);
    // And the appearance stream the writer would attach carries the turn.
    const stream = (await app.run('dev.annotAppearance', { id })) as { content: string } | null;
    expect(stream?.content).toContain('0 1 -1 0');
  });

  test('“Keep tool selected” keeps the tool active after it has been used', async () => {
    await openPath(stage('text.pdf', 'keep.pdf'));
    await app.run('annot.keepToolSelected', { on: true });
    await app.run('tool.note.activate');
    await clickPage(150, 150);
    await until(annotations, (list) => list.length === 1);
    // Placing a note opens its popup, which sits over the page; put it away before clicking again.
    await closePopup();
    // Still in the Note tool, so a second click puts down a second note without picking it again.
    expect((await selection()).activeTool).toBe('tool.note');
    await clickPage(300, 150);
    await until(annotations, (list) => list.length === 2);
    expect((await annotations()).length).toBe(2);
    await closePopup();

    // With the setting off, the tool puts itself away after one use, as Foxit does.
    await app.run('annot.keepToolSelected', { on: false });
    await app.run('tool.note.activate');
    await clickPage(450, 150);
    await until(annotations, (list) => list.length === 3);
    await closePopup();
    expect((await selection()).activeTool).toBe('tool.hand');
  });
});

// ---- the clipboard --------------------------------------------------------------------------------

test.describe('copy and paste', () => {
  test.afterEach(closeAll);

  /**
   * Whether this machine's clipboard works at all, asked of the OS with nothing of ours in the
   * question.
   *
   * Windows' clipboard can wedge — the service keeps running, writes report success and reads come
   * back empty, for every application on the machine at once. A comment test that failed then
   * would be saying something false: it would report a broken feature where there is a broken
   * desktop. So the round trip is checked first, and the test says which of the two it found.
   */
  async function clipboardWorks(): Promise<boolean> {
    const probe = `ynot-clipboard-probe-${Date.now()}`;
    return await app.electron.evaluate(async ({ clipboard }, value) => {
      try {
        await clipboard.writeText(value);
        return (await clipboard.readText()) === value;
      } catch {
        return false;
      }
    }, probe);
  }

  test('annotations copy and paste between two documents', async () => {
    test.skip(!(await clipboardWorks()), 'this machine’s clipboard is not working at all');
    await openPath(stage('text.pdf', 'source.pdf'));
    await app.run('annot.note', { page: 0, x: 200, y: 600 });
    await app.run('annot.textbox', { page: 0, rect: { x0: 60, y0: 300, x1: 300, y1: 340 } });
    await app.page.waitForTimeout(200);
    await app.run('annot.selectAll');
    // Two, not "it tried": a copy that the OS refused reports 0 rather than claiming it worked.
    expect(await app.run('annot.copy')).toBe(2);
    await openPath(stage('multipage.pdf', 'target.pdf'));
    expect((await annotations()).length).toBe(0);
    // The payload really is on the OS clipboard, in the form the decoder expects.
    expect(await app.run('dev.annotClipboard')).toMatchObject({ isOurs: true, annotations: 2 });
    const pasted = (await app.run('annot.paste')) as string[];
    await app.page.waitForTimeout(250);
    expect(pasted.length).toBe(2);
    const list = await annotations();
    expect(list.length).toBe(2);
    expect(list.map((a) => a.subtype).sort()).toEqual(['FreeText', 'Text']);
    // The paste is signed by whoever pasted it, not by whoever copied it.
    for (const a of list) expect(a.author).toBe('E2E Reader');
  });

  test('cut removes the originals and paste puts them back, offset on the same page', async () => {
    test.skip(!(await clipboardWorks()), 'this machine’s clipboard is not working at all');
    await openPath(stage('text.pdf', 'cut.pdf'));
    const id = (await app.run('annot.note', { page: 0, x: 200, y: 600 })) as string;
    await app.page.waitForTimeout(200);
    const before = must(
      (await annotations()).find((a) => a.id === id),
      'note',
    );
    await app.run('annot.selectAll');
    expect(await app.run('annot.cut')).toBe(1);
    await app.page.waitForTimeout(200);
    expect((await annotations()).length).toBe(0);
    await app.run('annot.paste');
    await app.page.waitForTimeout(250);
    const after = must((await annotations())[0], 'pasted note');
    expect(after.rect.x0).toBeGreaterThan(before.rect.x0);
  });
});

// ---- replies and status (the data M32 builds on) --------------------------------------------------

test.describe('replies and status', () => {
  test.afterEach(closeAll);

  test('a reply is an annotation that names the one it answers', async () => {
    await openPath(stage('text.pdf', 'reply.pdf'));
    const id = (await app.run('annot.note', { page: 0, x: 200, y: 600 })) as string;
    await app.page.waitForTimeout(150);
    const replyId = (await app.run('annot.reply', { id, text: 'I agree' })) as string;
    await app.page.waitForTimeout(150);
    const reply = must(
      (await annotations()).find((a) => a.id === replyId),
      'reply',
    );
    expect(reply.inReplyTo).toBe(id);
    expect(reply.contents).toBe('I agree');

    await app.run('annot.setStatus', { id, state: 'Accepted' });
    await app.page.waitForTimeout(150);
    expect(
      must(
        (await annotations()).find((a) => a.id === id),
        'note',
      ).state,
    ).toBe('Accepted');
  });
});

// ---- opacity ---------------------------------------------------------------------------------------

test.describe('nothing the module draws is translucent', () => {
  test.afterEach(closeAll);

  test('no overlay element has an alpha below 1', async () => {
    await openPath(stage('text.pdf', 'opacity.pdf'));
    await selectSomeText();
    await app.run('annot.highlight');
    await app.run('annot.note', { page: 0, x: 300, y: 700 });
    await app.run('annot.callout', {
      page: 0,
      rect: { x0: 60, y0: 300, x1: 300, y1: 340 },
      callout: [
        { x: 30, y: 260 },
        { x: 45, y: 320 },
        { x: 60, y: 320 },
      ],
    });
    await app.run('annot.selectAll');
    // The note's popup as well, so the walk covers the one overlay with a text field in it.
    await app.run('annot.edit', { id: (await annotations()).find((a) => a.icon)?.id });
    await app.page.waitForTimeout(300);

    // M04's shared check rather than a fourth copy of the walk. The annotation layer's own SVG
    // is exempt from the contrast half: its colours are the *document's*, chosen by whoever made
    // the annotation, and are not this app's to police.
    for (const scope of ['.annot-popup', '.annot-editor', '#annot-props']) {
      const region = app.page.locator(scope);
      if ((await region.count()) === 0) continue;
      await expectReadable(region.first());
    }
    await expectReadable(app.page.locator('.layer-annot').first(), { contrast: false });
    // And no annotation the app made carries a `/CA` either.
    for (const a of await annotations()) expect(a.opacity === null || a.opacity === 1).toBe(true);
  });
});

// ---- the file the module writes ----------------------------------------------------------------------

test.describe('the saved file', () => {
  test.afterEach(closeAll);

  /** Renders page 1 of a file in a Chromium PDF viewer and returns a screenshot of the viewer. */
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

  /**
   * The fraction of pixels that differ between two PNGs, measured in a browser.
   *
   * Node here has no image decoder, and the two pictures are Chromium's own output — so they are
   * decoded and compared by a Chromium, on canvases of a common size. A channel has to move by
   * more than 8/255 to count, which ignores the re-encoding and the anti-aliasing and notices
   * anything a reader would.
   */
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

  test('annotations survive a save and a reopen, and the raster then carries them all', async () => {
    const path = stage('text.pdf', 'saved.pdf');
    await openPath(path);
    await selectSomeText();
    await app.run('annot.highlight');
    await app.run('annot.note', { page: 0, x: 400, y: 700 });
    await app.run('annot.typewriter', { page: 0, rect: { x0: 60, y0: 300, x1: 320, y1: 350 } });
    await app.run('annot.setText', { text: 'saved and reopened' });
    await app.page.waitForTimeout(250);

    const before = (await annotations()).map((a) => `${a.subtype}:${Math.round(a.rect.x0)}`).sort();
    const outcome = (await app.run('file.save')) as { saved: boolean };
    expect(outcome.saved).toBe(true);
    await closeAll();

    await openPath(path);
    const after = (await annotations()).map((a) => `${a.subtype}:${Math.round(a.rect.x0)}`).sort();
    expect(after).toEqual(before);

    /*
     * "Our overlay-free render == PDFium's": after a reopen every annotation carries an appearance
     * stream, so the tile raster — which *is* PDFium — draws all of them and the overlay draws
     * nothing. That is the claim, stated as the thing that makes it true.
     */
    const drawn = await until(selection, (s) => s.total > 0);
    expect(drawn.total).toBeGreaterThanOrEqual(3);
    expect(drawn.drawn).toEqual([]);
  });

  test('Chrome’s own viewer draws what we wrote', async () => {
    const annotated = stage('text.pdf', 'for-chrome.pdf');
    const plain = stage('text.pdf', 'for-chrome-plain.pdf');
    await openPath(annotated);
    await selectSomeText();
    await app.run('annot.highlight');
    await app.run('annot.note', { page: 0, x: 420, y: 720 });
    await app.run('annot.textbox', { page: 0, rect: { x0: 60, y0: 250, x1: 380, y1: 320 } });
    await app.run('annot.setText', { text: 'A TEXT BOX WITH WORDS IN IT' });
    await app.page.waitForTimeout(250);
    expect(((await app.run('file.save')) as { saved: boolean }).saved).toBe(true);
    await closeAll();

    // The full Chromium build, not the headless shell: the shell has no PDF viewer at all.
    const browser = await chromium.launch({ channel: 'chromium' });
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
      const withAnnotations = await chromeShot(page, annotated);
      const without = await chromeShot(page, plain);
      const same = await chromeShot(page, annotated);
      const scratch = await browser.newPage();

      /*
       * A perceptual comparison of the only kind that is fair between two renderers: the same
       * viewer, at the same size, on the file with our annotations and on the file without them.
       * The same file twice gives the same picture; ours gives a different one — which is Chrome's
       * PDFium drawing the appearance streams the writer attached.
       *
       * **Perceptual, not byte-for-byte.** The first version compared the PNG bytes and failed on
       * a macOS runner: a viewer's toolbar fades, a focus ring blinks, and a scrollbar settles a
       * frame late, so two screenshots of one file are alike without being identical. The pixels
       * are counted instead, with a tolerance far below the difference an annotation makes.
       */
      const noise = await differingFraction(scratch, withAnnotations, same);
      const signal = await differingFraction(scratch, withAnnotations, without);
      await scratch.close();
      await page.close();

      /*
       * The thresholds are small because the screenshot is mostly viewer chrome and grey margin:
       * three annotations on one page move about half a per cent of it. What carries the weight is
       * the *ratio* — the difference our annotations make against the difference two shots of one
       * file make, which is the only scale-free way to say "this is signal, not noise".
       */
      expect(noise, 'two shots of the same file should look the same').toBeLessThan(0.001);
      expect(signal, 'our annotations should be visible in Chrome').toBeGreaterThan(0.002);
      expect(signal, 'the annotations should stand out from the noise').toBeGreaterThan(
        Math.max(noise * 10, 0.002),
      );
      expect(withAnnotations.byteLength).toBeGreaterThan(1000);
    } finally {
      await browser.close();
    }
  });
});
