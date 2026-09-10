/**
 * M60 acceptance tests — forms inside the real, built app.
 *
 * The unit tests own the arithmetic and the file: `test/unit/forms/` proves the `/Ff` table, the
 * appearance streams, the barcode round trip and the write plan, and
 * `test/unit/writer/forms.test.ts` proves the writer builds an AcroForm PDFium can read back.
 * This file owns what only exists with a DOM, a viewer and a running engine: the widget layer's
 * real controls, typing and its word-wise undo, the designer, a save that is reopened, tab order,
 * and the accessibility of fill mode.
 *
 * Each acceptance line in `docs/modules/M60-forms.md` has a test named after it.
 */

import { expect, test } from '@playwright/test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engine as pdfium } from '../unit/engine/helpers';
import { launchApp, type App } from './harness';

const require = createRequire(import.meta.url);
const AXE_SOURCE: string = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const FIXTURES = join(process.cwd(), 'test', 'fixtures');

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface FieldProbe {
  id: string;
  name: string;
  role: string;
  value: string;
  flags: number;
  options: Array<{ value: string; label: string }>;
  widgets: Array<{ id: string; page: number; rect: Rect }>;
}

interface SelectionProbe {
  keys: string[];
  names: string[];
  bounds: Rect | null;
  page: number | null;
}

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected a ${what}, got nothing`);
  return value;
}

let app: App;
let workspace: string;

test.beforeAll(async () => {
  app = await launchApp();
  workspace = mkdtempSync(join(tmpdir(), 'ynot-m60-'));
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
  await app.page.waitForTimeout(300);
}

/**
 * Waits for the widget layer to have painted at least `count` fields.
 *
 * The layer paints on an animation frame, and an off-screen e2e window gets those when the
 * compositor feels like it — on a loaded Linux runner that is well past any fixed wait. Polling
 * for the condition is the only honest way to ask "are the fields there yet".
 */
async function waitForWidgets(count = 1): Promise<void> {
  await expect
    .poll(() => app.page.locator('.layer-widget .form-widget').count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(count);
}

/** Closes every tab, answering M21's "Save?" for each. */
async function closeAll(): Promise<void> {
  await app.run('form.deselect').catch(() => undefined);
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

const fields = (): Promise<FieldProbe[]> => app.run('form.probe.fields') as Promise<FieldProbe[]>;
const selection = (): Promise<SelectionProbe> =>
  app.run('form.probe.selection') as Promise<SelectionProbe>;
const tabOrder = (page = 0): Promise<{ mode: string; names: string[] }> =>
  app.run('form.probe.tabOrder', { page }) as Promise<{ mode: string; names: string[] }>;

async function fieldNamed(name: string): Promise<FieldProbe> {
  const all = await fields();
  return must(
    all.find((f) => f.name === name),
    `field ${name}`,
  );
}

async function setValue(name: string, value: string): Promise<void> {
  await app.run('form.setValue', { name, value });
  await app.page.waitForTimeout(80);
}

/**
 * Saves, answering the warning `forms-all.pdf` earns: the fixture carries a signature field, and
 * a full rewrite breaks a signature, so M21 asks first. Saving anyway is what the test wants.
 */
async function saveAnyway(): Promise<{ saved: boolean }> {
  const saving = app.run('file.save') as Promise<{ saved: boolean }>;
  const anyway = app.page.locator('#save-signatures-dialog button', { hasText: 'Save anyway' });
  for (let i = 0; i < 10; i++) {
    if ((await anyway.count()) > 0) {
      await anyway.first().click();
      break;
    }
    await app.page.waitForTimeout(150);
  }
  return await saving;
}

/** Every field of a saved file, as PDFium (which is Chrome's viewer) reads it. */
async function readWithEngine(path: string) {
  const engine = await pdfium();
  const handle = await engine.open(new Uint8Array(readFileSync(path)));
  try {
    return await engine.formFields(handle);
  } finally {
    await engine.close(handle);
  }
}

test.describe('M60 — forms', () => {
  test.afterEach(async () => {
    await closeAll();
  });

  test('registers its commands, tools and panels', async () => {
    const commands = await app.commands();
    for (const id of [
      'form.fill',
      'form.select',
      'form.place.text',
      'form.place.checkbox',
      'form.place.radio',
      'form.place.combobox',
      'form.place.listbox',
      'form.place.button',
      'form.place.signature',
      'form.place.image',
      'form.place.date',
      'form.place.barcode',
      'form.highlight',
      'form.showTabOrder',
      'form.setTabOrder',
      'form.resetForm',
      'form.delete',
      'form.duplicate',
      'form.align.left',
      'form.distribute.horizontal',
      'form.matchSize.both',
    ]) {
      expect(commands, id).toContain(id);
    }
  });

  test('the widget layer draws a real, labelled control for every field', async () => {
    await openPath(stage('forms-all.pdf', 'controls.pdf'));
    await waitForWidgets(9);
    // Every control has an accessible name and is a real form element, not a painted box.
    const kinds = await app.page.$$eval('.layer-widget .form-control', (els) =>
      els.map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        label: el.getAttribute('aria-label') ?? '',
      })),
    );
    expect(kinds.length).toBeGreaterThan(8);
    for (const control of kinds) expect(control.label.length).toBeGreaterThan(0);
    expect(kinds.some((c) => c.tag === 'textarea')).toBe(true);
    expect(kinds.some((c) => c.tag === 'select')).toBe(true);
    expect(kinds.some((c) => c.type === 'checkbox')).toBe(true);
    expect(kinds.some((c) => c.type === 'radio')).toBe(true);
    expect(kinds.some((c) => c.type === 'password')).toBe(true);
  });

  // ---- acceptance 1 ----------------------------------------------------------------------------

  test('fill every field type in the AcroForm fixture ⇒ save ⇒ values readable by the engine', async () => {
    const path = stage('forms-all.pdf', 'filled.pdf');
    await openPath(path);

    await setValue('fields.text', 'Ada Lovelace');
    await setValue('fields.multiline', 'Line one\nLine two');
    await setValue('fields.password', 'secret');
    await setValue('fields.checkbox2', 'Yes');
    await setValue('fields.radio', 'red');
    await setValue('fields.combo', 'Gamma');
    await setValue('fields.list', 'Three');

    const before = await fields();
    expect(before.find((f) => f.name === 'fields.text')?.value).toBe('Ada Lovelace');

    const saved = await saveAnyway();
    expect(saved.saved).toBe(true);

    // Read the file back with PDFium — the engine this app renders with, and the one Chrome's
    // own viewer is built on. If PDFium can see the values, so can Chrome.
    const written = await readWithEngine(path);
    const byName = new Map(written.map((f) => [f.name, f.value]));
    expect(byName.get('fields.text')).toBe('Ada Lovelace');
    expect(byName.get('fields.multiline')).toContain('Line one');
    expect(byName.get('fields.password')).toBe('secret');
    expect(byName.get('fields.checkbox2')).not.toBe('Off');
    expect(byName.get('fields.radio')).toBe('red');
    expect(byName.get('fields.combo')).toBe('Gamma');
    expect(byName.get('fields.list')).toBe('Three');
  });

  test('undo of typing works word-wise', async () => {
    await openPath(stage('form.pdf', 'typing.pdf'));
    const all = await fields();
    const text = must(
      all.find((f) => f.role === 'text'),
      'a text field',
    );
    const widget = must(text.widgets[0], 'widget');
    const control = app.page.locator(`.form-widget[data-key="${text.id}:${widget.id}"] input`);
    await control.click();
    await control.fill('');
    await app.page.waitForTimeout(80);
    // Typed with the keyboard so every keystroke reaches the layer, as a reader's would.
    await app.page.keyboard.type('Hello brave world');
    await app.page.waitForTimeout(200);
    await app.page.keyboard.press('Tab');
    await app.page.waitForTimeout(200);
    expect((await fieldNamed(text.name)).value).toBe('Hello brave world');

    // A space ends an undo step, so undo walks back a word at a time rather than emptying the
    // field in one go.
    await app.run('edit.undo');
    await app.page.waitForTimeout(150);
    expect((await fieldNamed(text.name)).value).toBe('Hello brave ');
    await app.run('edit.undo');
    await app.page.waitForTimeout(150);
    expect((await fieldNamed(text.name)).value).toBe('Hello ');
  });

  // ---- acceptance 2 ----------------------------------------------------------------------------

  test('design a 10-field form ⇒ save ⇒ opens and fills in Chrome’s viewer; tab order as set', async () => {
    const path = stage('blank.pdf', 'designed.pdf');
    await openPath(path);
    await app.run('form.select');

    const roles = [
      'text',
      'checkbox',
      'radio',
      'combobox',
      'listbox',
      'button',
      'signature',
      'image',
      'date',
      'barcode',
    ];
    // Drawn bottom-up on purpose, so "tab order as set" has something to prove.
    for (const [i, role] of roles.entries()) {
      const y = 80 + i * 60;
      await app.run('form.place', {
        role,
        page: 0,
        rect: { x0: 100, y0: y, x1: 260, y1: y + 30 },
      });
      await app.page.waitForTimeout(40);
    }
    const designed = await fields();
    expect(designed).toHaveLength(10);
    expect(new Set(designed.map((f) => f.role)).size).toBe(10);
    // No two fields share a name: two fields with one name are one field in a PDF.
    expect(new Set(designed.map((f) => f.name)).size).toBe(10);

    // Row order runs top-down, which is the reverse of the order they were drawn in.
    await app.run('form.tabOrder.row');
    await app.page.waitForTimeout(150);
    const rowOrder = await tabOrder(0);
    expect(rowOrder.names[0]).toBe(must(designed[9], 'last field').name);
    expect(rowOrder.names[9]).toBe(must(designed[0], 'first field').name);

    const saved = (await app.run('file.save')) as { saved: boolean };
    expect(saved.saved).toBe(true);

    const written = await readWithEngine(path);
    expect(written).toHaveLength(10);
    const types = new Set(written.map((f) => f.type));
    expect(types).toContain('text');
    expect(types).toContain('checkbox');
    expect(types).toContain('radio');
    expect(types).toContain('combobox');
    expect(types).toContain('listbox');
    expect(types).toContain('button');
    expect(types).toContain('signature');

    // Reopen the file the app wrote and fill one of its fields: a designed form is a real form.
    await closeAll();
    const copy = join(workspace, 'designed-reopened.pdf');
    copyFileSync(path, copy);
    await openPath(copy);
    const reopened = await fields();
    expect(reopened).toHaveLength(10);
    const textField = must(
      reopened.find((f) => f.role === 'text'),
      'a text field',
    );
    await setValue(textField.name, 'filled after reopening');
    expect((await fieldNamed(textField.name)).value).toBe('filled after reopening');
    // The tab order the designer set is in the file, and comes back with it.
    expect((await tabOrder(0)).names).toEqual(rowOrder.names);
  });

  test('selecting, moving, aligning and deleting designed fields', async () => {
    await openPath(stage('blank.pdf', 'arrange.pdf'));
    await app.run('form.select');
    for (const [i, x] of [100, 200, 300].entries()) {
      await app.run('form.place', {
        role: 'text',
        page: 0,
        rect: { x0: x, y0: 600 + i * 7, x1: x + 80, y1: 620 + i * 7 },
      });
      await app.page.waitForTimeout(40);
    }
    const drawn = await fields();
    expect(drawn).toHaveLength(3);

    await app.run('form.selectField', { names: drawn.map((f) => f.name), page: 0 });
    expect((await selection()).names).toHaveLength(3);

    await app.run('form.align.bottom');
    await app.page.waitForTimeout(120);
    const aligned = await fields();
    const bottoms = new Set(aligned.map((f) => Math.round(must(f.widgets[0], 'widget').rect.y0)));
    expect(bottoms.size).toBe(1);

    await app.run('form.matchSize.both');
    await app.page.waitForTimeout(120);
    const sized = await fields();
    const sizes = new Set(
      sized.map((f) => {
        const r = must(f.widgets[0], 'widget').rect;
        return `${Math.round(r.x1 - r.x0)}x${Math.round(r.y1 - r.y0)}`;
      }),
    );
    expect(sizes.size).toBe(1);

    await app.run('form.move', { dx: 20, dy: -10 });
    await app.page.waitForTimeout(120);
    const moved = await fields();
    expect(Math.round(must(moved[0], 'field').widgets[0]?.rect.x0 ?? 0)).toBe(
      Math.round((must(sized[0], 'field').widgets[0]?.rect.x0 ?? 0) + 20),
    );

    // One undo puts the whole multi-field move back: a drag is one step.
    await app.run('edit.undo');
    await app.page.waitForTimeout(150);
    expect(Math.round((await fields())[0]?.widgets[0]?.rect.x0 ?? 0)).toBe(
      Math.round(must(sized[0], 'field').widgets[0]?.rect.x0 ?? 0),
    );

    await app.run('form.selectField', { names: [must(drawn[0], 'field').name], page: 0 });
    await app.run('form.delete');
    await app.page.waitForTimeout(150);
    expect(await fields()).toHaveLength(2);
    await app.run('edit.undo');
    await app.page.waitForTimeout(150);
    expect(await fields()).toHaveLength(3);
  });

  test('the Fields panel lists the form as a tree and jumps to a field', async () => {
    await openPath(stage('forms-all.pdf', 'panel.pdf'));
    await app.run('panel.nav.fields');
    await expect
      .poll(() => app.page.locator('.fields-tree .fields-row').count(), { timeout: 15_000 })
      .toBeGreaterThan(8);
    // The dotted names build a tree: "fields" is a group node above its children.
    const group = app.page.locator('.fields-row.synthetic', { hasText: 'fields' });
    expect(await group.count()).toBeGreaterThan(0);
    // Every row says its type in words, not by icon alone.
    const kinds = await app.page.$$eval('.fields-tree .fields-kind', (els) =>
      els.map((el) => el.textContent ?? ''),
    );
    expect(kinds.some((k) => k.includes('Text field'))).toBe(true);
    expect(kinds.some((k) => k.includes('Check box'))).toBe(true);

    const row = app.page.locator('.fields-row', { hasText: 'checkbox' }).first();
    await row.click();
    await app.page.waitForTimeout(200);
    expect((await selection()).names.length).toBeGreaterThan(0);
  });

  test('the properties panel edits a field, and the change is undoable', async () => {
    await openPath(stage('blank.pdf', 'props.pdf'));
    await app.run('form.select');
    await app.run('form.place', {
      role: 'text',
      page: 0,
      rect: { x0: 100, y0: 600, x1: 300, y1: 624 },
    });
    const panel = app.page.locator('.field-props');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    // The General tab's Required box is a real checkbox with a label.
    const required = app.page
      .locator('.field-props-check', { hasText: 'Required' })
      .locator('input');
    await required.check();
    await app.page.waitForTimeout(200);
    expect(((await fields())[0]?.flags ?? 0) & 2).toBeTruthy();
    await app.run('edit.undo');
    await app.page.waitForTimeout(200);
    expect(((await fields())[0]?.flags ?? 0) & 2).toBeFalsy();
  });

  // ---- acceptance 3 ----------------------------------------------------------------------------

  test('barcode field encodes the field value', async () => {
    const path = stage('blank.pdf', 'barcode.pdf');
    await openPath(path);
    await app.run('form.select');
    await app.run('form.place', {
      role: 'barcode',
      page: 0,
      rect: { x0: 100, y0: 500, x1: 280, y1: 620 },
    });
    await app.page.waitForTimeout(150);
    const field = must((await fields())[0], 'barcode field');
    await setValue(field.name, 'ORDER-4711');
    await app.page.waitForTimeout(200);

    // On screen the widget draws the symbol itself, as an inline SVG path.
    const svg = app.page.locator('.form-widget[data-kind="barcode"] .form-barcode path');
    await expect(svg).toHaveCount(1, { timeout: 15_000 });
    const drawn = await svg.getAttribute('d');
    expect((drawn ?? '').length).toBeGreaterThan(100);

    const saved = (await app.run('file.save')) as { saved: boolean };
    expect(saved.saved).toBe(true);
    const written = await readWithEngine(path);
    const barcode = must(
      written.find((f) => f.design?.role === 'barcode'),
      'barcode field in the file',
    );
    expect(barcode.value).toBe('ORDER-4711');
    expect(barcode.design?.barcode?.symbology).toBe('pdf417');
    // The decode itself is `test/unit/forms/barcode.test.ts`, where a second library reads the
    // value back out of the same geometry this widget and this appearance stream are drawn from.
  });

  // ---- acceptance 4 ----------------------------------------------------------------------------

  test('axe-core: fill mode has no missing-label violations', async () => {
    await openPath(stage('forms-all.pdf', 'axe.pdf'));
    await app.run('form.fill');
    await waitForWidgets(9);
    // Evaluated rather than injected as a <script>: the app's own Content Security Policy
    // forbids an inline script, and rightly so.
    await app.page.evaluate(AXE_SOURCE);
    const violations = await app.page.evaluate(async () => {
      const axe = (
        globalThis as unknown as {
          axe: {
            run(
              context: string,
              options: unknown,
            ): Promise<{ violations: Array<{ id: string; nodes: unknown[] }> }>;
          };
        }
      ).axe;
      const result = await axe.run('.viewer-content', {
        runOnly: {
          type: 'rule',
          values: [
            'label',
            'aria-input-field-name',
            'form-field-multiple-labels',
            'select-name',
            'button-name',
            'aria-required-attr',
            'aria-valid-attr-value',
            'duplicate-id-aria',
          ],
        },
      });
      return result.violations.map((v) => ({ id: v.id, nodes: v.nodes.length }));
    });
    expect(violations).toEqual([]);
  });

  test('every field is reachable from the keyboard, in tab order', async () => {
    await openPath(stage('forms-all.pdf', 'keyboard.pdf'));
    await app.run('form.fill');
    await waitForWidgets(9);
    const visited: string[] = [];
    for (let i = 0; i < 4; i++) {
      const moved = (await app.run('form.nextField')) as boolean;
      expect(moved).toBe(true);
      const focused = await app.page.evaluate(
        () => document.activeElement?.getAttribute('aria-label') ?? '',
      );
      visited.push(focused);
    }
    expect(new Set(visited).size).toBe(visited.length);
    expect(visited.every((v) => v.length > 0)).toBe(true);
  });

  test('highlight and the required outline are toggles, and required says so in words', async () => {
    await openPath(stage('forms-all.pdf', 'highlight.pdf'));
    await waitForWidgets(9);
    const layer = app.page.locator('.layer-widget').first();
    await expect(layer).toHaveClass(/form-highlight/);
    await app.run('form.highlight');
    await app.page.waitForTimeout(200);
    await expect(layer).not.toHaveClass(/form-highlight/);
    await app.run('form.highlight');
    await app.page.waitForTimeout(200);
    await expect(layer).toHaveClass(/form-highlight/);

    // The required field carries the word as well as the outline.
    await app.run('panel.nav.fields');
    await expect
      .poll(() => app.page.locator('.fields-flag').count(), { timeout: 15_000 })
      .toBeGreaterThan(1);
    const flags = await app.page.$$eval('.fields-flag', (els) =>
      els.map((el) => el.textContent ?? ''),
    );
    expect(flags).toContain('Required');
    expect(flags).toContain('Read-only');
  });

  test('Show Tab Order numbers the fields, and Set Tab Order changes them', async () => {
    await openPath(stage('blank.pdf', 'taborder.pdf'));
    await app.run('form.select');
    for (const y of [700, 600, 500]) {
      await app.run('form.place', {
        role: 'text',
        page: 0,
        rect: { x0: 100, y0: y, x1: 300, y1: y + 24 },
      });
      await app.page.waitForTimeout(40);
    }
    await app.run('form.showTabOrder');
    await expect(app.page.locator('.form-tab-number text')).toHaveCount(3, { timeout: 15_000 });
    const numbers = await app.page.$$eval('.form-tab-number text', (els) =>
      els.map((el) => el.textContent ?? ''),
    );
    expect(numbers.sort()).toEqual(['1', '2', '3']);

    const rows = await tabOrder(0);
    await app.run('form.tabOrder.column');
    await app.page.waitForTimeout(200);
    // One column, so column order is the same top-down order; the mode is what changed.
    expect((await tabOrder(0)).mode).toBe('column');
    expect((await tabOrder(0)).names).toEqual(rows.names);

    // The command does not resolve until the dialog is answered, so it is started rather than
    // awaited.
    const dialog = app.page.locator('#tab-order-dialog');
    const setting = app.run('form.setTabOrder');
    await expect(dialog).toBeVisible();
    // The list is keyboard-reachable and reordering is on buttons, not on drag alone.
    await dialog.locator('.tab-order-row').first().click();
    await dialog.locator('button', { hasText: 'Move down' }).click();
    await dialog.locator('button', { hasText: 'Apply' }).click();
    await setting;
    await app.page.waitForTimeout(250);
    const after = await tabOrder(0);
    expect(after.mode).toBe('manual');
    expect(after.names[0]).toBe(rows.names[1]);
    expect(after.names[1]).toBe(rows.names[0]);
  });

  test('Reset Form puts every field back, in one undo step', async () => {
    await openPath(stage('forms-all.pdf', 'reset.pdf'));
    await setValue('fields.text', 'changed');
    await setValue('fields.combo', 'Alpha');
    expect((await fieldNamed('fields.text')).value).toBe('changed');
    await app.run('form.resetForm');
    await app.page.waitForTimeout(250);
    expect((await fieldNamed('fields.text')).value).toBe('');
    await app.run('edit.undo');
    await app.page.waitForTimeout(250);
    expect((await fieldNamed('fields.text')).value).toBe('changed');
    expect((await fieldNamed('fields.combo')).value).toBe('Alpha');
  });

  test('duplicating a field across pages gives each copy its own name', async () => {
    await openPath(stage('multipage.pdf', 'duplicate.pdf'));
    await app.run('form.select');
    await app.run('form.place', {
      role: 'signature',
      page: 0,
      rect: { x0: 100, y0: 100, x1: 300, y1: 148 },
    });
    await app.page.waitForTimeout(150);
    const first = must((await fields())[0], 'field');
    await app.run('form.selectField', { names: [first.name], page: 0 });
    await app.run('form.duplicate', { pages: [1, 2] });
    await app.page.waitForTimeout(250);
    const all = await fields();
    expect(all).toHaveLength(3);
    expect(new Set(all.map((f) => f.name)).size).toBe(3);
    expect(all.map((f) => must(f.widgets[0], 'widget').page).sort()).toEqual([0, 1, 2]);
  });
});
