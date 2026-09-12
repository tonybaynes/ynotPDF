/**
 * Journeys — filling a form in and designing one (M60).
 *
 * "Fill a form field" is in M04's minimum list, and the module's own `test/e2e/forms.spec.ts`
 * reaches most of it through `form.*` commands — which is exactly the shape M04 was written
 * against. So this file does it the way a person does: press the ribbon button by its visible
 * label, click the field on the page, type into it, tick the box. Nothing here drives a `form.*`
 * command; `dev.formFields` reads the answer back afterwards.
 *
 * One app for the file; each test opens its own document so a failure cannot cascade.
 */

import { expect, test } from '@playwright/test';
import { realpathSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type App } from '../harness';
import { closeEverything, journey } from '../journey';
import { expectNothingClipped, expectReadable, expectWindowSound } from '../layout';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

let app: App;
let workspace: string;

test.beforeAll(async () => {
  workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'ynot-m04-forms-')));
  app = await launchApp({ noDemo: true });
  await app.grantPath(workspace, true);
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

interface FieldRow {
  readonly name: string;
  readonly role: string;
  readonly value: string;
}

const fields = async (): Promise<FieldRow[]> => (await app.run('dev.formFields')) as FieldRow[];

const valueOf = async (name: string): Promise<string> =>
  (await fields()).find((f) => f.name === name)?.value ?? '';

/**
 * Waits for the widget layer to have painted.
 *
 * The layer paints on an animation frame and the e2e window is off-screen, so "how long" is not
 * a number anyone can pick — poll for the condition instead (M60, and M04's own rule).
 */
async function waitForWidgets(count = 1): Promise<void> {
  await expect
    .poll(() => app.page.locator('.layer-widget .form-widget').count(), {
      timeout: 20_000,
      message: 'the widget layer never painted a field',
    })
    .toBeGreaterThanOrEqual(count);
}

test('M60 — a form is filled in by clicking the field on the page and typing into it', async () => {
  const j = journey(app);
  await j.openDocument(stage('forms-all.pdf', 'fill.pdf'));

  // The reader presses "Fill In Form" on the Form tab. Nothing else turns fill mode on.
  await j.clickRibbon('form', 'Fill In Form');
  await waitForWidgets(6);

  const layer = app.page.locator('.layer-widget');

  // A single-line text field: click into it, clear it, type. `fields.text` starts as "Hello".
  const text = layer.getByRole('textbox', { name: 'fields.text' }).first();
  await expect(text, 'fill mode did not put a real control over the text field').toBeVisible();
  await text.click();
  await expect(text, 'clicking the field did not give it the caret').toBeFocused();
  await text.fill('');
  await app.page.keyboard.type('Filled by hand');
  // Tab is what a person presses next, and it is also what commits the value.
  await app.page.keyboard.press('Tab');
  await expect.poll(() => valueOf('fields.text'), { timeout: 10_000 }).toBe('Filled by hand');

  // A check box: one click, and it is ticked in the document, not just on screen.
  const box = layer.getByRole('checkbox', { name: 'fields.checkbox2' }).first();
  await expect(box).toBeVisible();
  await box.click();
  await expect.poll(() => valueOf('fields.checkbox2'), { timeout: 10_000 }).toBe('Yes');

  // A combo box: choose an option by its visible label.
  const combo = layer.getByRole('combobox', { name: 'fields.combo' }).first();
  await expect(combo).toBeVisible();
  await combo.selectOption({ label: 'Gamma' });
  await expect.poll(() => valueOf('fields.combo'), { timeout: 10_000 }).toBe('Gamma');

  // Undo is word-wise over typing, so one press must not throw the whole entry away.
  await app.page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(() => valueOf('fields.combo'), { timeout: 10_000 }).not.toBe('Gamma');

  await expectWindowSound(app.page);
});

test('M60 — a field is drawn on the page with the Text field tool and listed in the Fields panel', async () => {
  const j = journey(app);
  await j.openDocument(stage('text.pdf', 'design.pdf'));

  // "Text field" is the first button of the Fields group; pressing it arms the placement tool.
  await j.clickRibbon('form', 'Text field');
  await j.dragOnPageAt([0.1, 0.6], [0.45, 0.66]);

  await expect
    .poll(async () => (await fields()).length, {
      timeout: 15_000,
      message: 'dragging with the Text field tool made no field',
    })
    .toBe(1);
  const made = (await fields())[0];
  expect(made?.role).toBe('text');

  // The Fields panel is where the designer reads the form back, so it has to list what was drawn.
  await j.openPanel('nav.fields');
  const panel = app.page.locator('#nav-host .panel[data-panel="nav.fields"]');
  const rows = panel.locator('.fields-row');
  await expect(rows, 'the Fields panel listed nothing after a field was drawn').toHaveCount(1);
  await expect(rows.first()).toContainText(made?.name ?? '');
  // Every row says its type in words — colour is not how the operator tells a field apart.
  await expect(rows.first()).toContainText('Text field');

  await expectNothingClipped(panel);
  await expectReadable(panel);
  await expectWindowSound(app.page);
});
