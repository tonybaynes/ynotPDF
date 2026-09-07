/**
 * Application shell e2e (M02). Drives the real Electron app with the demo module registered
 * (`test/e2e/demo-module/`), which exercises every ribbon widget kind, a contextual tab, panels
 * on both sides, status-bar items, backstage slots, creators and context menus.
 *
 * Acceptance (M02 brief): ribbon tab/groups/every button kind render; dropdown opens/closes by
 * mouse and keyboard; contextual tab appears when its when() flips; key tips work; nav pane
 * opens each demo panel and widths persist across restart; tabs open/reorder/cycle/close with a
 * prompt when dirty; palette finds and runs a demo command; F6 cycles regions; every interactive
 * element has a visible focus ring and axe reports no focus/contrast violations in all four
 * themes; nothing in the DOM is translucent.
 */

import { expect, test, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { launchApp, type App } from './harness';
import { THEMES } from '../../src/renderer/theme/themes';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

interface DemoState {
  bold: boolean;
  shape: string;
  colour: string;
  size: string;
  font: string;
  inkMode: boolean;
  counter: number;
  lastCommand: string;
  lastArgs: Record<string, unknown>;
}

interface UiSnapshot {
  ribbon: { tab: string; minimised: boolean; peek: boolean };
  qat: string[];
  leftPane: { width: number; collapsed: boolean; panel: string | null };
  rightPane: { width: number; visible: boolean };
  backstage: { open: boolean; page: string };
  keyTips: boolean;
  region: string;
  tabs: { id: string; title: string; dirty: boolean }[];
  activeTab: string | null;
}

let app: App;
const demo = (): Promise<DemoState> => app.run('demo.state') as Promise<DemoState>;
const ui = (): Promise<UiSnapshot> => app.run('app.ui.state') as Promise<UiSnapshot>;
/** Closes every tab without prompting (a dirty tab would otherwise block on the confirm dialog). */
const closeAll = async (): Promise<void> => {
  const { tabs } = await ui();
  for (const t of tabs) if (t.dirty) await app.run('demo.markDirty', { id: t.id, dirty: false });
  if (tabs.length > 0) await app.run('app.tabs.closeAll');
};
// The demo's overflow groups repeat commands, so take the first occurrence (the demo group).
const item = (id: string): Locator => app.page.locator(`#ribbon-body [data-item="${id}"]`).first();

test.beforeAll(async () => {
  app = await launchApp();
  await app.run('view.theme.set', { theme: 'graphite' });
});

test.afterAll(async () => {
  await app.close();
});

test.beforeEach(async () => {
  await app.page.keyboard.press('Escape');
  await app.run('app.backstage.close');
  await app.run('app.ribbon.showTab', { tab: 'home' });
});

// ---- ribbon ------------------------------------------------------------------------------------

test('the demo tab, its groups and every widget kind render', async () => {
  const tabs = app.page.locator('#ribbon-tabs [role="tab"]');
  await expect(tabs).toHaveCount(11);
  await expect(app.page.locator('#ribbon-tabs [role="tab"][aria-selected="true"]')).toHaveAttribute(
    'data-tab',
    'home',
  );
  for (const group of ['demo.buttons', 'demo.menus', 'demo.pickers']) {
    await expect(app.page.locator(`#ribbon-body [data-group="${group}"]`)).toBeVisible();
  }
  // large / small buttons, a disabled one, a toggle
  await expect(item('demo.hello')).toHaveClass(/rb-large/);
  await expect(item('demo.small')).toHaveClass(/rb-small/);
  // Compact (Foxit) row by default: labels live in the tooltip, icons stay visible.
  await expect(app.page.locator('#ribbon')).toHaveClass(/ribbon-compact/);
  await expect(item('demo.hello')).toHaveAttribute('title', /Demo: Hello/);
  await expect(item('demo.hello').locator('.icon')).toBeVisible();
  await expect(item('demo.disabled')).toBeDisabled();
  await expect(item('demo.bold')).toHaveAttribute('aria-pressed', 'false');
  // split, dropdown, gallery, colour, number input, select input
  await expect(item('demo.split.main').locator('.rb-split-arrow')).toBeVisible();
  await expect(item('demo.dropdown')).toHaveAttribute('aria-haspopup', 'menu');
  await expect(item('demo.gallery')).toHaveAttribute('aria-haspopup', 'listbox');
  await expect(item('demo.color').locator('.rb-swatch')).toBeVisible();
  await expect(item('demo.sizeInput').locator('input')).toHaveValue('12');
  await expect(item('demo.fontSelect').locator('select')).toHaveValue('sans');
  // every icon resolved (no placeholder glyphs anywhere in the chrome)
  await expect(app.page.locator('#app [data-icon="missing"]')).toHaveCount(0);
});

test('buttons run commands and the toggle reflects state without a rebuild', async () => {
  await item('demo.hello').click();
  expect((await demo()).lastCommand).toBe('demo.hello');
  // Mark the element: if it survives the toggles, the group was patched, not rebuilt.
  await item('demo.bold').evaluate((e) => {
    e.setAttribute('data-probe', 'same-node');
  });
  await item('demo.bold').click();
  await expect(item('demo.bold')).toHaveAttribute('aria-pressed', 'true');
  await expect(item('demo.bold')).toContainText('(on)');
  expect((await demo()).bold).toBe(true);
  await item('demo.bold').click();
  await expect(item('demo.bold')).toHaveAttribute('aria-pressed', 'false');
  await expect(item('demo.bold')).toHaveAttribute('data-probe', 'same-node');
});

test('dropdown opens and closes by mouse and by keyboard, submenu included', async () => {
  const button = item('demo.dropdown');
  await button.click();
  const menu = app.page.locator('.menu-popup [role="menu"]');
  await expect(menu).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await app.page.mouse.click(600, 500);
  await expect(menu).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');

  await button.focus();
  await app.page.keyboard.press('ArrowDown');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[role="menuitem"]').first()).toBeFocused();
  await app.page.keyboard.press('ArrowDown'); // Bold (checkbox)
  await expect(menu.locator('[role="menuitemcheckbox"]')).toHaveAttribute('aria-checked', 'false');
  await app.page.keyboard.press('ArrowDown'); // More ▸
  await app.page.keyboard.press('ArrowRight');
  const sub = app.page.locator('.menu-popup [role="menu"]').nth(1);
  await expect(sub).toBeVisible();
  await app.page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  expect((await demo()).lastCommand).toBe('demo.menu.sub');
  await expect(button).toBeFocused();

  await button.press('ArrowDown');
  await app.page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

test('split button: main action and menu', async () => {
  await item('demo.split.main').locator('.rb-split-main').click();
  expect((await demo()).lastCommand).toBe('demo.split.main');
  await item('demo.split.main').locator('.rb-split-arrow').click();
  await app.page.locator('.menu-popup [data-command="demo.split.b"]').click();
  expect((await demo()).lastCommand).toBe('demo.split.b');
});

test('gallery, colour picker and inline inputs run their command with { value }', async () => {
  await item('demo.gallery').click();
  const gallery = app.page.locator('.gallery-popup [role="listbox"]');
  await expect(gallery.locator('[role="option"]')).toHaveCount(4);
  await gallery.locator('[data-value="circle"]').click();
  await expect(gallery).toBeHidden();
  expect((await demo()).shape).toBe('circle');
  await expect(item('demo.gallery')).toContainText('Circle');

  await item('demo.color').click();
  const picker = app.page.locator('.color-popup');
  await expect(picker.locator('input[type="color"]')).toBeVisible();
  await picker.locator('[data-value="var(--annot-ink)"]').click();
  expect((await demo()).colour).toBe('var(--annot-ink)');

  const size = item('demo.sizeInput').locator('input');
  await size.fill('20');
  await size.press('Enter');
  expect((await demo()).size).toBe('20');
  await item('demo.fontSelect').locator('select').selectOption('serif');
  expect((await demo()).font).toBe('serif');
});

test('the contextual tab appears while its when() holds and vanishes when it flips back', async () => {
  const ink = app.page.locator('#ribbon-tabs [data-tab="demo.ink"]');
  await expect(ink).toHaveCount(0);
  await app.run('demo.ink.toggle');
  await expect(ink).toBeVisible();
  await expect(ink).toHaveClass(/ribbon-tab-contextual/);
  await ink.click();
  await expect(item('demo.ink.thin')).toBeVisible();
  await app.run('demo.ink.toggle');
  await expect(ink).toHaveCount(0);
  // The active tab fell back to Home.
  expect((await ui()).ribbon.tab).toBe('home');
});

test('a tool activates its contextual tab and Escape deactivates it', async () => {
  await app.run('tool.demoInk.activate');
  await expect(app.page.locator('#ribbon-tabs [data-tab="demo.ink"]')).toBeVisible();
  await app.run('tool.none');
  await expect(app.page.locator('#ribbon-tabs [data-tab="demo.ink"]')).toHaveCount(0);
});

test('key tips: Alt shows tab tips, letters navigate, Escape backs out', async () => {
  await app.page.locator('#doc-area').focus();
  await app.page.keyboard.press('Alt');
  await expect(app.page.locator('#keytip-layer .keytip')).not.toHaveCount(0);
  expect((await ui()).keyTips).toBe(true);
  const helpTip = await app.page
    .locator('#keytip-layer .keytip[data-for="tab:help"]')
    .textContent();
  expect(helpTip).toBeTruthy();
  await app.page.keyboard.type(helpTip ?? '');
  expect((await ui()).ribbon.tab).toBe('help');
  // Level 2: tips for the Help tab's controls; pick the demo toast.
  const toastTip = await app.page
    .locator('#keytip-layer .keytip[data-for="demo.toast"]')
    .textContent();
  expect(toastTip).toBeTruthy();
  await app.page.keyboard.type(toastTip ?? '');
  await expect(app.page.locator('#demo-toast')).toBeVisible();
  expect((await ui()).keyTips).toBe(false);

  await app.page.keyboard.press('Alt');
  await expect(app.page.locator('#keytip-layer .keytip')).not.toHaveCount(0);
  await app.page.keyboard.press('Escape');
  await expect(app.page.locator('#keytip-layer .keytip')).toHaveCount(0);
  await app.page.locator('#demo-toast .toast-close').click();
});

test('the ribbon minimises, peeks and expands', async () => {
  expect(await app.run('app.ribbon.toggleMinimised')).toBe(true);
  await expect(app.page.locator('#ribbon-body')).toBeHidden();
  await app.page.locator('#ribbon-tabs [data-tab="view"]').click();
  await expect(app.page.locator('#ribbon-body')).toBeVisible();
  expect((await ui()).ribbon.peek).toBe(true);
  await app.page.mouse.click(600, 500);
  await expect(app.page.locator('#ribbon-body')).toBeHidden();
  expect(await app.run('app.ribbon.toggleMinimised')).toBe(false);
  await expect(app.page.locator('#ribbon-body')).toBeVisible();
});

test('groups collapse into a popup button when the window is narrow', async () => {
  // The demo's Organize tab holds three deliberately wide groups. CI screens differ, so the
  // assertions are about the mechanism, not fixed counts: narrow → some groups collapse into a
  // button that opens the group in a popup; as wide as the screen allows → no more than before.
  await app.run('app.ribbon.showTab', { tab: 'organize' });
  expect(await app.run('app.ribbon.toggleLabels')).toBe(true); // labelled groups are the wide ones
  const collapsed = app.page.locator('#ribbon-body .rb-collapsed');
  const size = await app.electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getSize(),
  );
  await app.electron.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(760, 600);
  });
  await expect.poll(() => collapsed.count()).toBeGreaterThan(0);
  const narrowCount = await collapsed.count();
  await expect(app.page.locator('#ribbon-body .rb-group:not(.rb-collapsed)')).not.toHaveCount(0);
  const opener = app.page.locator('#ribbon-body .rb-collapsed-btn').last();
  await opener.click();
  await expect(app.page.locator('.ribbon-group-popup .rb-btn').first()).toBeVisible();
  await app.page.keyboard.press('Escape');
  const workArea = await app.electron.evaluate(
    ({ screen }) => screen.getPrimaryDisplay().workAreaSize,
  );
  await app.electron.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      BrowserWindow.getAllWindows()[0]?.setSize(w, h);
    },
    [workArea.width, workArea.height] as [number, number],
  );
  await expect.poll(() => collapsed.count()).toBeLessThanOrEqual(narrowCount);
  if (workArea.width >= 1500) await expect(collapsed).toHaveCount(0);
  await app.electron.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      BrowserWindow.getAllWindows()[0]?.setSize(w, h);
    },
    [size?.[0] ?? 1280, size?.[1] ?? 800] as [number, number],
  );
  expect(await app.run('app.ribbon.toggleLabels')).toBe(false);
});

test('quick-access toolbar items come from ui.qat and persist', async () => {
  await expect(app.page.locator('#qat .qat-item')).toHaveCount(3);
  await app.run('app.qat.add', { command: 'demo.hello' });
  await expect(app.page.locator('#qat [data-qat="demo.hello"]')).toBeVisible();
  await app.page.locator('#qat [data-qat="demo.hello"]').click();
  expect((await demo()).lastCommand).toBe('demo.hello');
  await app.run('app.qat.remove', { command: 'demo.hello' });
  await expect(app.page.locator('#qat .qat-item')).toHaveCount(3);
});

// ---- panes -------------------------------------------------------------------------------------

test('the navigation pane opens each demo panel and remembers the last one', async () => {
  const strip = app.page.locator('#nav-strip');
  await expect(strip.locator('button')).toHaveCount(2);
  await strip.locator('[data-panel="demo.beta"]').click();
  await expect(app.page.locator('#demo-panel-beta')).toBeVisible();
  await expect(app.page.locator('#nav-title')).toHaveText('Demo Beta');
  await expect(strip.locator('[data-panel="demo.beta"]')).toHaveAttribute('aria-pressed', 'true');
  await strip.locator('[data-panel="demo.alpha"]').click();
  await expect(app.page.locator('#demo-panel-alpha')).toBeVisible();
  await expect(app.page.locator('#demo-panel-beta')).toBeHidden();
  // The auto-generated panel command works too.
  await app.run('panel.demo.beta');
  await expect(app.page.locator('#demo-panel-beta')).toBeVisible();
  // Toggle collapses; F4 command expands again with the same panel.
  await app.run('panel.demo.beta');
  expect((await ui()).leftPane.collapsed).toBe(true);
  await expect(app.page.locator('#nav-host')).toBeHidden();
  await app.run('view.pane.left.toggle');
  expect((await ui()).leftPane).toMatchObject({ collapsed: false, panel: 'demo.beta' });
});

test('the properties pane shows the panel whose when() matches the selection', async () => {
  const pane = app.page.locator('#pane-right');
  await closeAll();
  await app.run('demo.selectNone');
  await expect(pane).toBeHidden();
  await app.run('demo.selectText');
  await expect(pane).toBeVisible();
  await expect(app.page.locator('#demo-props-text')).toBeVisible();
  await app.run('demo.selectNone');
  await expect(pane).toBeHidden();
  await app.run('demo.openDocument', { title: 'Props.pdf' });
  await expect(app.page.locator('#demo-props-doc')).toBeVisible();
  await app.run('view.pane.right.toggle');
  await expect(pane).toBeHidden();
  await app.run('view.pane.right.toggle');
  await expect(pane).toBeVisible();
  await closeAll();
});

test('the pane resizer works from the keyboard and the width survives a restart', async () => {
  await app.run('view.panel.show', { panel: 'demo.alpha' });
  const resizer = app.page.locator('.pane-resizer[data-side="left"]');
  await resizer.focus();
  await app.page.keyboard.press('Home');
  expect((await ui()).leftPane.width).toBe(160);
  await app.page.keyboard.press('Shift+ArrowRight');
  await app.page.keyboard.press('Shift+ArrowRight');
  expect((await ui()).leftPane.width).toBe(288);
  await expect(resizer).toHaveAttribute('aria-valuenow', '288');
  const box = await app.page.locator('#pane-left').boundingBox();
  expect(Math.round(box?.width ?? 0)).toBe(288);
  // Give the debounced write time to land, then restart on the same user-data dir.
  await app.page.waitForTimeout(500);
  await app.close();
  app = await launchApp({ reuseUserData: true });
  expect((await ui()).leftPane).toMatchObject({
    width: 288,
    panel: 'demo.alpha',
    collapsed: false,
  });
});

// ---- tabs --------------------------------------------------------------------------------------

test('three documents open as tabs, reorder by drag, cycle with Ctrl+Tab and close with a prompt when dirty', async () => {
  const a = (await app.run('demo.openDocument', { title: 'Alpha.pdf' })) as string;
  const b = (await app.run('demo.openDocument', { title: 'Beta.pdf' })) as string;
  const c = (await app.run('demo.openDocument', { title: 'Gamma.pdf' })) as string;
  const tabs = app.page.locator('#tabstrip [role="tab"]');
  await expect(tabs).toHaveCount(3);
  await expect(app.page.locator('#empty-state')).toBeHidden();
  await expect(app.page).toHaveTitle('Gamma.pdf — ynotPDF');

  // Drag Gamma to the front.
  const gamma = app.page.locator(`#tabstrip [data-tab-id="${c}"]`);
  const alpha = app.page.locator(`#tabstrip [data-tab-id="${a}"]`);
  const from = await gamma.boundingBox();
  const to = await alpha.boundingBox();
  if (!from || !to) throw new Error('no tab boxes');
  await app.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await app.page.mouse.down();
  await app.page.mouse.move(from.x + from.width / 2 - 20, from.y + from.height / 2, { steps: 4 });
  await app.page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 8 });
  await app.page.mouse.up();
  expect((await ui()).tabs.map((t) => t.id)).toEqual([c, a, b]);

  // Dragging far above the strip marks the tab for detaching; releasing inside cancels it.
  const box = await gamma.boundingBox();
  if (!box) throw new Error('no box');
  await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await app.page.mouse.down();
  await app.page.mouse.move(box.x + box.width / 2, box.y + 160, { steps: 6 });
  await expect(gamma).toHaveClass(/tab-detaching/);
  await app.page.mouse.up();
  await expect(gamma).not.toHaveClass(/tab-detaching/);
  expect(
    await app.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
  ).toBe(1);

  // Ctrl+Tab cycles forward, Ctrl+Shift+Tab back.
  await app.page.locator('#doc-area').focus();
  await app.page.keyboard.press('Control+Tab');
  expect((await ui()).activeTab).toBe(a);
  await app.page.keyboard.press('Control+Tab');
  expect((await ui()).activeTab).toBe(b);
  await app.page.keyboard.press('Control+Shift+Tab');
  expect((await ui()).activeTab).toBe(a);

  // Middle-click closes a clean tab.
  await app.page.locator(`#tabstrip [data-tab-id="${b}"]`).click({ button: 'middle' });
  await expect(tabs).toHaveCount(2);

  // A dirty tab shows the dot plus the word, and closing asks first.
  await app.run('demo.markDirty', { id: a });
  await expect(alpha).toHaveClass(/tab-modified/);
  await expect(alpha).toContainText('(Modified)');
  await expect(alpha).toHaveAttribute('title', /Modified/);
  await app.run('app.tabs.activate', { id: a });
  void app.run('file.close');
  const prompt = app.page.locator('#close-unsaved-dialog');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('Warning');
  await app.page.keyboard.press('Escape');
  await expect(prompt).toBeHidden();
  await expect(tabs).toHaveCount(2);
  void app.run('file.close');
  await expect(prompt).toBeVisible();
  await prompt.locator('[data-result="confirm"]').click();
  await expect(tabs).toHaveCount(1);
  await closeAll();
  await expect(app.page.locator('#empty-state')).toBeVisible();
});

test('a tab can be moved to a new window through IPC', async () => {
  await app.run('demo.openDocument', { title: 'Detach.pdf' });
  await app.run('demo.openDocument', { title: 'Stay.pdf' });
  await app.run('app.tabs.previous');
  const windowsBefore = await app.electron.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  );
  expect(await app.run('app.tabs.detach')).toBe(true);
  await expect
    .poll(() => app.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
    .toBe(windowsBefore + 1);
  expect((await ui()).tabs.map((t) => t.title)).toEqual(['Stay.pdf']);
  // `getAllWindows()` is not in creation order: the newest window has the highest id.
  await app.electron.evaluate(({ BrowserWindow }) => {
    const newest = [...BrowserWindow.getAllWindows()].sort((x, y) => y.id - x.id)[0];
    newest?.close();
  });
  await expect
    .poll(() => app.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
    .toBe(windowsBefore);
  await closeAll();
});

// ---- status bar ----------------------------------------------------------------------------------

test('status bar: editable page and zoom fields, slider, layout buttons', async () => {
  await app.run('demo.openDocument', { title: 'Status.pdf', pages: 9 });
  const page = app.page.locator('#status-page-input');
  await expect(page).toHaveValue('1');
  await expect(app.page.locator('#status-page-count')).toHaveText('of 9');
  await page.fill('7');
  await page.press('Enter');
  await expect(page).toHaveValue('7');
  await page.fill('99');
  await page.press('Enter');
  await expect(page).toHaveValue('7');
  await app.page.locator('#statusbar [data-command="view.page.next"]').click();
  await expect(page).toHaveValue('8');

  const zoom = app.page.locator('#status-zoom-input');
  await expect(zoom).toHaveValue('100%');
  await zoom.fill('150');
  await zoom.press('Enter');
  await expect(zoom).toHaveValue('150%');
  await expect(app.page.locator('#status-zoom-slider')).toHaveValue('150');
  await zoom.fill('fit width');
  await zoom.press('Enter');
  await expect(zoom).toHaveValue('Fit width');
  await app.page.locator('#statusbar [data-command="view.zoom.fitPage"]').click();
  await expect(zoom).toHaveValue('Fit page');
  await app.page.locator('#status-zoom-slider').fill('75');
  await expect(zoom).toHaveValue('75%');

  await app.page.locator('#status-layout [data-layout="facing"]').click();
  await expect(app.page.locator('#status-layout [data-layout="facing"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect(((await app.run('view.state')) as { layout: string }).layout).toBe('facing');
  await expect(app.page.locator('#demo-status')).toContainText('Demo:');
  await app.run('view.layout.set', { layout: 'continuous' });
  await closeAll();
});

// ---- backstage / empty state ------------------------------------------------------------------------

test('the backstage (palette-only) still lists slots, shows pages and closes with Escape', async () => {
  await app.run('app.backstage.open');
  const backstage = app.page.locator('#backstage');
  await expect(backstage).toBeVisible();
  await expect(backstage.locator('[data-slot="open"]')).toBeEnabled();
  await expect(backstage.locator('[data-slot="recent"]')).toBeEnabled();
  await expect(backstage.locator('[data-slot="new"]')).toBeEnabled();
  await expect(backstage.locator('[data-slot="exit"]')).toBeEnabled();
  await expect(backstage.locator('[data-slot="save"]')).toBeDisabled();
  await expect(backstage.locator('[data-slot="save"]')).toContainText('Not available yet');
  await expect(backstage.locator('[data-slot="print"]')).toBeEnabled(); // demo fills it with a command
  await expect(app.page.locator('#backstage-open-file')).toBeVisible();
  await backstage.locator('[data-slot="new"]').click();
  await expect(backstage.locator('[data-creator="demo.blank"]')).toBeVisible();
  await backstage.locator('[data-slot="properties"]').click();
  await expect(app.page.locator('#demo-backstage-props')).toBeVisible();
  await app.page.keyboard.press('Escape');
  await expect(backstage).toBeHidden();
  // A command slot runs and closes.
  await app.run('app.backstage.open');
  await backstage.locator('[data-slot="print"]').click();
  await expect(backstage).toBeHidden();
  expect((await demo()).lastCommand).toBe('demo.hello');
});

test('the File tab is a horizontal ribbon: Open, Recent, New, the module slots and Exit', async () => {
  await app.page.locator('#ribbon-tabs [data-tab="file"]').click();
  await expect(app.page.locator('#backstage')).toBeHidden();
  await expect(app.page.locator('#ribbon-body [data-group="file.open"]')).toBeVisible();
  await expect(item('file.open')).toBeEnabled();
  // Recent is a dropdown whose menu reflects the current list.
  await item('file.recent').click();
  const menu = app.page.locator('.menu-popup [role="menu"]');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('No recent files yet');
  await app.page.keyboard.press('Escape');
  // New lists the registered creators.
  await item('file.new').click();
  await expect(menu.locator('[data-command="demo.create.blank"]')).toBeVisible();
  await app.page.keyboard.press('Escape');
  // Unfilled slots are disabled and say so; the demo fills Print (command) and Properties (page).
  await expect(item('file.slot.save')).toBeDisabled();
  await expect(item('file.slot.save')).toHaveAttribute('title', /not available yet/);
  await expect(item('file.slot.saveAs')).toBeDisabled();
  await expect(item('file.slot.preferences')).toBeDisabled();
  await expect(item('demo.hello')).toBeEnabled(); // Print (demo)
  await item('file.slot.properties').click();
  const page = app.page.locator('#file-page-properties');
  await expect(page).toBeVisible();
  await expect(page.locator('#demo-backstage-props')).toBeVisible();
  await page.locator('[data-result="close"]').click();
  await expect(page).toBeHidden();
  await expect(item('app.quit')).toBeEnabled(); // Exit
  await app.run('app.ribbon.showTab', { tab: 'home' });
});

test('the empty state offers Open, Recent and Create tiles', async () => {
  await expect(app.page.locator('#empty-open')).toBeVisible();
  await expect(app.page.locator('#empty-state .recent-list')).toBeVisible();
  await app.page.locator('#empty-state [data-creator="demo.blank"]').click();
  await expect(app.page.locator('#tabstrip [role="tab"]')).toHaveCount(1);
  await expect(app.page.locator('#tabstrip .tab-modified')).toHaveCount(1);
  await app.run('demo.markDirty', { dirty: false });
  await closeAll();
});

// ---- dialogs, toasts, context menus ----------------------------------------------------------------

test('message boxes carry an icon and the word, trap focus, answer Enter and Escape', async () => {
  await app.run('app.message', {
    kind: 'warning',
    title: 'Careful',
    text: 'Something needs attention.',
  });
  const dialog = app.page.locator('#app-message-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.dlg-kind')).toContainText('Warning');
  await expect(dialog.locator('.dlg-kind .icon')).toBeVisible();
  await expect(dialog.locator('[data-result="ok"]')).toBeFocused();
  await app.page.keyboard.press('Tab');
  await expect(dialog.locator('[data-result="ok"]')).toBeFocused(); // trapped: only one control
  await app.page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await app.run('app.message', { kind: 'error', title: 'Broken', text: 'It failed.' });
  await expect(dialog.locator('.dlg-kind')).toContainText('Error');
  await app.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('form dialog with label-above-input fields validates before closing', async () => {
  const result = app.run('demo.form');
  const dialog = app.page.locator('#demo-form');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('label[for="demo-form-name"]')).toHaveText(/Name/);
  await expect(dialog.locator('#demo-form-name')).toBeFocused();
  await expect(dialog.locator('.field-hint').first()).toHaveText('Shown in the title');
  await app.page.keyboard.press('Enter'); // empty name: stays open
  await expect(dialog).toBeVisible();
  await dialog.locator('#demo-form-name').fill('Hello');
  await app.page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  expect(await result).toEqual({ result: 'ok', name: 'Hello', size: '12' });
});

test('progress dialog can be cancelled', async () => {
  const run = app.run('demo.progress', { ms: 3000 });
  const dialog = app.page.locator('#demo-progress');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('progress')).toBeVisible();
  await dialog.locator('[data-result="cancel"]').click();
  expect(await run).toBe('cancelled');
  await expect(dialog).toBeHidden();
});

test('non-modal dialogs leave the app usable', async () => {
  await app.run('demo.nonModal');
  const dialog = app.page.locator('#demo-nonmodal');
  await expect(dialog).toBeVisible();
  await item('demo.hello').click();
  expect((await demo()).lastCommand).toBe('demo.hello');
  await dialog.locator('[data-result="close"]').click();
  await expect(dialog).toBeHidden();
});

test('toasts show the kind word, an action and a close button', async () => {
  await app.run('demo.toast');
  const toast = app.page.locator('#demo-toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Done');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toBeHidden();
  expect((await demo()).lastCommand).toBe('demo.toast.undo');
});

test('context menus collect contributions per region, by mouse and by keyboard', async () => {
  await app.page.locator('#doc-area').click({ button: 'right', position: { x: 40, y: 40 } });
  const menu = app.page.locator('.context-menu [role="menu"]');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-command="demo.hello"]')).toBeVisible();
  await expect(menu.locator('[data-command="demo.small"]')).toBeVisible();
  await expect(menu.locator('[data-command="view.zoom.in"]')).toBeVisible();
  await app.page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  await item('demo.hello').focus();
  await app.page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-command="app.ribbon.toggleMinimised"]')).toBeVisible();
  await expect(menu.locator('[data-command="demo.hello"]')).toHaveCount(0);
  await app.page.keyboard.press('Escape');
});

// ---- palette, focus, accessibility -------------------------------------------------------------

test('the palette fuzzy-finds and runs a demo command', async () => {
  await app.run('app.commandPalette');
  const palette = app.page.locator('#command-palette');
  await palette.locator('input').fill('dm hel');
  await expect(palette.locator('li[aria-selected="true"]')).toHaveAttribute(
    'data-command',
    'demo.hello',
  );
  await expect(palette.locator('li[aria-selected="true"] mark').first()).toBeVisible();
  await app.page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  expect((await demo()).lastCommand).toBe('demo.hello');
});

test('F6 cycles the regions and Shift+F6 goes back', async () => {
  await app.run('view.panel.show', { panel: 'demo.alpha' });
  await app.run('demo.openDocument', { title: 'Focus.pdf' });
  await app.run('demo.selectText');
  await app.page.locator('#doc-area').focus();
  const regionOfFocus = (): Promise<string | null> =>
    app.page.evaluate(
      () => document.activeElement?.closest('[data-region]')?.getAttribute('data-region') ?? null,
    );
  const seen: (string | null)[] = [];
  for (let i = 0; i < 5; i++) {
    await app.page.keyboard.press('F6');
    seen.push(await regionOfFocus());
  }
  expect(seen).toEqual(['left-pane', 'right-pane', 'status', 'ribbon', 'document']);
  await app.page.keyboard.press('Shift+F6');
  expect(await regionOfFocus()).toBe('ribbon');
  await app.run('demo.selectNone');
  await closeAll();
});

test('every interactive element in the chrome shows the two-ring focus and axe finds no contrast violations, in all four themes', async () => {
  await app.run('view.panel.show', { panel: 'demo.alpha' });
  await app.run('demo.openDocument', { title: 'Axe.pdf' });
  await app.page.keyboard.press('Tab'); // keyboard modality, so programmatic focus shows :focus-visible
  for (const theme of THEMES) {
    await app.run('view.theme.set', { theme: theme.name });
    const missing = await app.page.evaluate(() => {
      const selector =
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), [role="tab"]';
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(`#app ${selector}`))) {
        if (el.closest('[hidden]') || el.getClientRects().length === 0) continue;
        el.focus();
        if (document.activeElement !== el) continue;
        const s = getComputedStyle(el);
        const ok =
          s.outlineStyle === 'solid' &&
          Number.parseFloat(s.outlineWidth) >= 2 &&
          s.boxShadow !== 'none';
        if (!ok) out.push(`${el.tagName.toLowerCase()}#${el.id}.${el.className}`);
      }
      return out;
    });
    expect(missing, `${theme.name}: elements without the focus ring`).toEqual([]);

    await app.page.evaluate(AXE_SOURCE);
    const violations = await app.page.evaluate(async () => {
      const axe = (
        window as unknown as {
          axe: {
            run(
              ctx: unknown,
              opts: unknown,
            ): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
          };
        }
      ).axe;
      const result = await axe.run('#app', {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'best-practice'] },
      });
      return result.violations
        .filter((v) => /contrast|focus/.test(v.id))
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
    });
    expect(violations, `${theme.name}: axe`).toEqual([]);
  }
  await app.run('view.theme.set', { theme: 'graphite' });
  await closeAll();
});

test('nothing in the DOM is translucent: no opacity < 1, no rgba alpha between 0 and 1, no backdrop-filter', async () => {
  await app.run('app.commandPalette');
  await app.page.keyboard.press('Escape');
  await app.run('demo.toast');
  await item('demo.dropdown').click();
  const offenders = await app.page.evaluate(() => {
    const out: string[] = [];
    const alpha = (c: string): number | null => {
      const m = /rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*([\d.]+))?\s*\)/.exec(c);
      if (!m) return null;
      return m[1] === undefined ? 1 : Number(m[1]);
    };
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const s = getComputedStyle(el);
      const name = `${el.tagName.toLowerCase()}#${el.id}.${(el.getAttribute('class') ?? '').slice(0, 40)}`;
      if (Number.parseFloat(s.opacity) < 1) out.push(`${name} opacity ${s.opacity}`);
      const a = alpha(s.backgroundColor);
      if (a !== null && a > 0 && a < 1) out.push(`${name} background ${s.backgroundColor}`);
      const bf = s.backdropFilter;
      if (bf && bf !== 'none') out.push(`${name} backdrop-filter ${bf}`);
    }
    return out;
  });
  expect(offenders).toEqual([]);
  await app.page.keyboard.press('Escape');
});
