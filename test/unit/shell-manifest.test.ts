/**
 * The M02 manifest against fake services: every command is well-formed and reachable, and the
 * view-state commands drive the UiState store the way the status bar and M11 rely on.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Registry } from '@core/Registry';
import { Selection } from '@core/Selection';
import shellManifest from '@modules/M02-app-shell/manifest';
import { createUiStore, type UiStore } from '@app/ui/UiState';
import { Documents } from '@app/tabs/Documents';
import { BACKSTAGE_SLOTS } from '@app/backstage/Backstage';

let registry: Registry;
let ui: UiStore;
let documents: Documents;
const shownTabs: string[] = [];

beforeEach(() => {
  registry = new Registry();
  ui = createUiStore();
  documents = new Documents();
  registry.provide('registry', registry);
  registry.provide('ui', ui);
  registry.provide('documents', documents);
  registry.provide('selection', new Selection());
  registry.provide('platform', { isMac: false });
  registry.provide('ribbon', {
    showTab: (id: string) => {
      shownTabs.push(id);
    },
    toggleKeyTips: () => undefined,
    keyTipsVisible: false,
  });
  registry.provide('panels', {
    collapsed: false,
    active: null,
    expand: () => undefined,
    collapse: () => undefined,
    show: () => undefined,
  });
  registry.register(shellManifest);
});

describe('M02 manifest', () => {
  it('registers well-formed commands with unique ids and palette entries for visible ones', () => {
    const cmds = shellManifest.commands ?? [];
    expect(cmds.length).toBeGreaterThan(40);
    const ids = new Set(cmds.map((c) => c.id));
    expect(ids.size).toBe(cmds.length);
    for (const c of cmds) {
      expect(c.label, c.id).toBeTruthy();
      expect(c.category, c.id).toBeTruthy();
      expect(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/.test(c.id), c.id).toBe(true);
    }
    const palette = registry.paletteEntries().map((e) => e.id);
    expect(palette).toContain('app.backstage.open');
    expect(palette).toContain('app.ribbon.toggleMinimised');
    expect(palette).toContain('app.focus.nextRegion');
    expect(palette).not.toContain('app.ui.state');
    expect(registry.shortcutFor('app.focus.nextRegion')).toBe('F6');
    expect(registry.shortcutFor('view.pane.left.toggle')).toBe('F4');
  });

  it('fills the shell backstage slots and leaves the module slots empty', () => {
    const slots = (shellManifest.backstage ?? []).map((b) => b.slot);
    expect(slots).toEqual(expect.arrayContaining(['open', 'recent', 'new', 'exit']));
    for (const s of ['save', 'saveAs', 'print', 'properties', 'preferences'])
      expect(slots).not.toContain(s);
    expect(BACKSTAGE_SLOTS.map((s) => s.id)).toEqual([
      'open',
      'recent',
      'new',
      'save',
      'saveAs',
      'print',
      'properties',
      'preferences',
      'exit',
    ]);
  });

  it('drives page navigation through the store with range checks', async () => {
    expect(registry.isEnabled('view.page.next')).toBe(false);
    await registry.run('view.setPageCount', { count: 5 });
    expect(ui.get().view).toMatchObject({ page: 1, pageCount: 5 });
    expect(await registry.run('view.page.next')).toBe(2);
    expect(await registry.run('view.page.last')).toBe(5);
    expect(registry.isEnabled('view.page.next')).toBe(false);
    expect(await registry.run('view.page.previous')).toBe(4);
    expect(await registry.run('view.page.first')).toBe(1);
    expect(registry.isEnabled('view.page.previous')).toBe(false);
    expect(await registry.run('view.page.goTo', { page: 3 })).toBe(3);
    await expect(registry.run('view.page.goTo', { page: 9 })).rejects.toThrow(/1–5/);
  });

  it('drives zoom, fit modes and layout', async () => {
    expect(await registry.run('view.zoom.in')).toBe(125);
    expect(await registry.run('view.zoom.out')).toBe(100);
    expect(await registry.run('view.zoom.set', { percent: 99_999 })).toMatchObject({
      zoom: 6400,
      fit: null,
    });
    expect(await registry.run('view.zoom.fitPage')).toBe('page');
    expect(ui.get().view.fit).toBe('page');
    expect(await registry.run('view.zoom.actual')).toBe(100);
    expect(ui.get().view.fit).toBeNull();
    expect(await registry.run('view.zoom.set', { value: 'fit width' })).toMatchObject({
      fit: 'width',
    });
    await expect(registry.run('view.zoom.set', { value: 'nonsense' })).rejects.toThrow(/zoom/);
    await expect(registry.run('view.zoom.set', {})).rejects.toThrow(/percent/);
    expect(await registry.run('view.layout.set', { layout: 'book' })).toBe('book');
    expect(await registry.run('view.layout.single')).toBe('single');
    await expect(registry.run('view.layout.set', { layout: 'spiral' })).rejects.toThrow(/layout/);
  });

  it('manages the quick-access toolbar', async () => {
    expect(await registry.run('app.qat.add', { command: 'view.zoom.in' })).toContain(
      'view.zoom.in',
    );
    expect(await registry.run('app.qat.add', { command: 'view.zoom.in' })).toHaveLength(4);
    await expect(registry.run('app.qat.add', { command: 'nope' })).rejects.toThrow(/Unknown/);
    expect(await registry.run('app.qat.remove', { command: 'view.zoom.in' })).not.toContain(
      'view.zoom.in',
    );
    ui.set({ qat: [] });
    expect(await registry.run('app.qat.reset')).toEqual(['file.open', 'edit.undo', 'edit.redo']);
  });

  it('toggles the ribbon and panes and switches tabs', async () => {
    expect(await registry.run('app.ribbon.toggleMinimised')).toBe(true);
    expect(await registry.run('app.ribbon.toggleMinimised')).toBe(false);
    expect(await registry.run('view.pane.right.toggle')).toBe(false);
    expect(ui.get().rightPane.visible).toBe(false);
    await registry.run('app.ribbon.tab.view');
    await registry.run('app.ribbon.showTab', { tab: 'help' });
    expect(shownTabs.slice(-2)).toEqual(['view', 'help']);
    await expect(registry.run('app.ribbon.showTab', {})).rejects.toThrow(/tab/);
  });

  it('tab commands follow the documents service', async () => {
    expect(registry.isEnabled('app.tabs.next')).toBe(false);
    const a = documents.open({ title: 'A' });
    const b = documents.open({ title: 'B' });
    expect(registry.isEnabled('app.tabs.next')).toBe(true);
    expect(await registry.run('app.tabs.next')).toBe(a.id);
    expect(await registry.run('app.tabs.previous')).toBe(b.id);
    expect(await registry.run('app.tabs.activate', { id: a.id })).toBe(a.id);
    expect(await registry.run('app.tabs.closeOthers')).toBe(true);
    expect(documents.tabs.map((t) => t.id)).toEqual([a.id]);
    expect(await registry.run('app.tabs.closeAll')).toBe(true);
    expect(documents.tabs).toHaveLength(0);
    const state = (await registry.run('app.ui.state')) as {
      tabs: unknown[];
      activeTab: string | null;
    };
    expect(state.tabs).toEqual([]);
    expect(state.activeTab).toBeNull();
  });
});
