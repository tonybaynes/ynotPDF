/**
 * The ribbon (M02): File button, tab strip (built-in tabs in Foxit order plus contextual tabs
 * whose `when()` holds), the quick-access toolbar, the minimise toggle, and the body of groups
 * for the active tab.
 *
 * Rendering is granular: the tab strip and group *structure* rebuild only when the model's
 * structural signature changes; otherwise each group compares its state signature and patches
 * its widgets in place. Groups that no longer fit collapse — from the right — into one large
 * button that opens the group in a popup.
 *
 * Keyboard: Tab into the strip, arrows move between tabs (activating them), Enter/Space opens a
 * minimised ribbon; inside the body arrows move between controls. A bare Alt press shows key
 * tips: type a tab's letters, then a control's letters; Escape backs out.
 */

import type { RibbonGroupSpec } from '@shared/module';
import { el, button, srOnly, isVisible } from '../dom';
import { makeRoving } from '../focus';
import { icon } from '../icons';
import { closeAllPopups, openPopup } from '../popup';
import type { ShellServices } from '../services';
import { assignKeyTips, matchKeyTip, type KeyTipTarget } from './keytips';
import {
  buildRibbon,
  groupSignature,
  itemState,
  ribbonSignature,
  type RibbonGroupModel,
  type RibbonTabModel,
} from './model';
import { fileTabGroups, RecentCache } from './fileTab';
import { mountQat } from './qat';
import { renderItem, type Widget } from './widgets';

export interface RibbonHandle {
  readonly element: HTMLElement;
  /** Re-evaluates predicates and patches what changed. */
  refresh(): void;
  /** Forces a structural rebuild (after a UI-scale change, the natural widths change). */
  rebuild(): void;
  showTab(id: string): void;
  focusActiveTab(): void;
  toggleKeyTips(): void;
  readonly keyTipsVisible: boolean;
  /** Current tab models (tests). */
  tabs(): ReadonlyArray<RibbonTabModel>;
  dispose(): void;
}

interface GroupView {
  readonly model: RibbonGroupModel;
  readonly element: HTMLElement;
  readonly widgets: Widget[];
  signature: string;
  naturalWidth: number;
  collapsed: boolean;
}

/**
 * Optional service (M130, ADR 0018) that rewrites the group list before it is drawn: hidden and
 * reordered groups and buttons, stored as a diff over the manifests. With nothing registered
 * under {@link RIBBON_CUSTOMISATION} the ribbon is exactly what the manifests say.
 */
export interface RibbonCustomisation {
  apply(groups: ReadonlyArray<RibbonGroupSpec>): ReadonlyArray<RibbonGroupSpec>;
}

export const RIBBON_CUSTOMISATION = 'ribbonCustomisation';

export function mountRibbon(host: HTMLElement, services: ShellServices): RibbonHandle {
  const { registry, ui } = services;
  // The File tab's groups are built by the shell from the backstage slots modules fill.
  const recent = new RecentCache();
  recent.start();
  const customise = (groups: ReadonlyArray<RibbonGroupSpec>): ReadonlyArray<RibbonGroupSpec> => {
    if (!registry.hasService(RIBBON_CUSTOMISATION)) return groups;
    try {
      return registry.service<RibbonCustomisation>(RIBBON_CUSTOMISATION).apply(groups);
    } catch (error) {
      // A broken customisation must cost the reader their customisation, never their ribbon.
      console.warn(
        'ribbon: customisation failed; showing the ribbon as the modules declare it',
        error,
      );
      return groups;
    }
  };
  const source = {
    ribbonGroups: () =>
      customise([
        ...registry.ribbonGroups(),
        ...fileTabGroups({ registry, recent, dialogs: services.dialogs }),
      ]),
    ribbonTabs: () => registry.ribbonTabs(),
    get: (id: string) => registry.get(id),
    context: () => registry.context(),
  };

  const root = el('div.ribbon', { id: 'ribbon', 'data-region': 'ribbon' });
  const top = el('div.ribbon-top');
  const qat = mountQat(top, services);
  const tablist = el('div.ribbon-tabs', {
    role: 'tablist',
    'aria-label': 'Ribbon tabs',
    id: 'ribbon-tabs',
  });
  const minimiseBtn = button('icon-btn ribbon-minimise', {
    id: 'ribbon-minimise',
    'aria-pressed': 'false',
  });
  minimiseBtn.addEventListener('click', () => {
    void services.run('app.ribbon.toggleMinimised');
  });
  top.append(tablist, minimiseBtn);
  const body = el('div.ribbon-body', { role: 'tabpanel', id: 'ribbon-body', tabindex: -1 });
  root.append(top, body);
  host.append(root);

  const tabRoving = makeRoving(tablist, { selector: '[role="tab"]' });
  const bodyRoving = makeRoving(body, { selector: '[data-rb-focus]:not([disabled])' });

  let tabs: RibbonTabModel[] = [];
  let structure = '';
  let activeTabId = ui.get().ribbon.tab;
  let groups: GroupView[] = [];
  let disposed = false;
  let compactApplied = ui.get().ribbon.compact;

  // ---- tab strip -----------------------------------------------------------------------------

  const renderTabs = (): void => {
    tablist.replaceChildren();
    for (const t of tabs) {
      const tab = button(`ribbon-tab${t.contextual ? ' ribbon-tab-contextual' : ''}`, {
        role: 'tab',
        id: `ribbon-tab-${t.id}`,
        'data-tab': t.id,
        'aria-selected': t.id === activeTabId ? 'true' : 'false',
        'aria-controls': 'ribbon-body',
      });
      if (t.contextual) tab.append(icon('sparkles'), srOnly('Contextual tab: '));
      tab.append(t.label);
      tab.addEventListener('click', () => {
        selectTab(t.id, 'click');
      });
      tab.addEventListener('dblclick', () => {
        void services.run('app.ribbon.toggleMinimised');
      });
      tab.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectTab(t.id, 'key');
          if (ui.get().ribbon.minimised) ui.set((s) => ({ ribbon: { ...s.ribbon, peek: true } }));
          bodyRoving.focusFirst();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          bodyRoving.focusFirst();
        }
      });
      tablist.append(tab);
    }
    tabRoving.refresh();
  };

  // Arrow keys activate tabs as they move (automatic activation).
  const onTabFocus = (e: FocusEvent): void => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || t.getAttribute('role') !== 'tab') return;
    const id = t.dataset['tab'];
    if (id && id !== activeTabId) selectTab(id, 'key');
  };
  tablist.addEventListener('focusin', onTabFocus);

  const selectTab = (id: string, via: 'click' | 'key' | 'program'): void => {
    const st = ui.get().ribbon;
    if (st.minimised) {
      // Clicking the active tab while peeking closes the peek; any other click opens it.
      const peek = via === 'click' && id === st.tab && st.peek ? false : true;
      ui.set({ ribbon: { ...st, tab: id, peek } });
    } else if (id !== st.tab) {
      ui.set({ ribbon: { ...st, tab: id } });
    }
  };

  // ---- body ------------------------------------------------------------------------------------

  const buildGroup = (model: RibbonGroupModel): GroupView => {
    const element = el('div.rb-group', {
      'data-group': model.id,
      role: 'group',
      'aria-label': model.label,
    });
    const items = el('div.rb-items');
    const widgets: Widget[] = [];
    for (const item of model.items) {
      const w = renderItem(item, services);
      if (item.kind !== 'separator') {
        w.focusTarget.dataset['rbFocus'] = item.id;
        w.focusTarget.dataset['keytipTarget'] = item.id;
      }
      widgets.push(w);
      items.append(w.element);
    }
    element.append(items, el('div.rb-group-label', null, model.label));
    return { model, element, widgets, signature: '', naturalWidth: 0, collapsed: false };
  };

  const updateGroup = (g: GroupView, force = false): void => {
    const sig = groupSignature(g.model, registry);
    if (!force && sig === g.signature) return;
    g.signature = sig;
    g.model.items.forEach((item, i) => {
      g.widgets[i]?.update(itemState(item, registry));
    });
    if (g.collapsed) return;
  };

  const renderBody = (): void => {
    body.replaceChildren();
    groups = [];
    const tab = tabs.find((t) => t.id === activeTabId);
    body.setAttribute('aria-labelledby', `ribbon-tab-${activeTabId}`);
    if (!tab || tab.groups.length === 0) {
      body.append(
        el(
          'p.ribbon-empty',
          null,
          icon('info'),
          ' Nothing on this tab yet — it fills in as feature modules are built.',
        ),
      );
      bodyRoving.refresh();
      return;
    }
    for (const gm of tab.groups) {
      const g = buildGroup(gm);
      groups.push(g);
      body.append(g.element);
      updateGroup(g, true);
    }
    // Measure natural widths while everything is expanded, then collapse to fit.
    for (const g of groups) g.naturalWidth = g.element.getBoundingClientRect().width;
    fitGroups();
    bodyRoving.refresh();
  };

  const collapseGroup = (g: GroupView): void => {
    if (g.collapsed) return;
    g.collapsed = true;
    g.element.classList.add('rb-collapsed');
    const items = g.element.querySelector('.rb-items');
    if (items instanceof HTMLElement) items.hidden = true;
    const opener = button('rb-btn rb-large rb-collapsed-btn', {
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      'data-rb-focus': `group:${g.model.id}`,
      'data-keytip-target': `group:${g.model.id}`,
      title: `${g.model.label} (collapsed — opens the group)`,
    });
    opener.append(
      icon('ellipsis', { size: 'lg' }),
      el('span.rb-label.rb-label-large', null, g.model.label),
    );
    opener.addEventListener('click', () => {
      const clone = buildGroup(g.model);
      updateGroup(clone, true);
      clone.element.classList.add('rb-group-popup');
      const roving = makeRoving(clone.element, { selector: '[data-rb-focus]:not([disabled])' });
      openPopup({
        anchor: opener,
        content: clone.element,
        role: 'dialog',
        label: g.model.label,
        className: 'ribbon-group-popup',
        onClose: () => {
          roving.dispose();
        },
      });
    });
    g.element.prepend(opener);
  };

  const expandGroup = (g: GroupView): void => {
    if (!g.collapsed) return;
    g.collapsed = false;
    g.element.classList.remove('rb-collapsed');
    g.element.querySelector('.rb-collapsed-btn')?.remove();
    const items = g.element.querySelector('.rb-items');
    if (items instanceof HTMLElement) items.hidden = false;
  };

  /**
   * Collapses groups from the right until the row fits — **measuring** after each one rather
   * than predicting the width a collapsed group will take.
   *
   * It used to subtract a flat 72 px per collapsed group, which is its width at 100 % UI scale
   * and nothing like its width at 150 % or 200 %, where everything in it is sized in rem. The
   * arithmetic then stopped collapsing while the groups still needed another two hundred pixels
   * and the ribbon clipped its last buttons off the right edge — the same mistake as the pane
   * widths in `d1edee4`, and scaling the constant only moved the error rather than removing it
   * (M04, 2026-09-10). The DOM knows the answer, so ask it.
   *
   * The measurement is a forced reflow per collapsed group, bounded by the number of groups on
   * a tab and only on a rebuild or a resize; the common case — everything fits — costs one.
   */
  const fitGroups = (): void => {
    if (groups.length === 0 || !isVisible(body)) return;
    if (body.clientWidth <= 0) return;
    for (const g of groups) expandGroup(g);
    for (let i = groups.length - 1; i >= 0; i--) {
      if (body.scrollWidth <= body.clientWidth) break;
      const g = groups[i];
      if (g) collapseGroup(g);
    }
    bodyRoving.refresh();
  };
  const resizeObserver = new ResizeObserver(() => {
    fitGroups();
  });
  resizeObserver.observe(body);

  // ---- refresh / rebuild -------------------------------------------------------------------------

  const refresh = (): void => {
    if (disposed) return;
    const next = buildRibbon(source);
    const sig = ribbonSignature(next);
    const st = ui.get().ribbon;
    const tabChanged = st.tab !== activeTabId;
    activeTabId = st.tab;
    // If the active tab vanished (contextual tab whose when() dropped), fall back to Home.
    if (!next.some((t) => t.id === activeTabId)) {
      activeTabId = 'home';
      ui.set({ ribbon: { ...st, tab: 'home' } });
    }
    if (sig !== structure || tabChanged) {
      tabs = next;
      structure = sig;
      renderTabs();
      renderBody();
    } else {
      for (const t of tablist.querySelectorAll<HTMLElement>('[role="tab"]')) {
        t.setAttribute('aria-selected', t.dataset['tab'] === activeTabId ? 'true' : 'false');
      }
      for (const g of groups) updateGroup(g);
    }
    applyMinimised();
  };

  const rebuild = (): void => {
    structure = '';
    refresh();
  };

  const applyMinimised = (): void => {
    const { minimised, peek, compact } = ui.get().ribbon;
    if (compactApplied !== compact) {
      // Natural widths change with the layout: apply the class first, then measure again.
      compactApplied = compact;
      root.classList.toggle('ribbon-compact', compact);
      structure = '';
      refresh();
      return;
    }
    root.classList.toggle('ribbon-compact', ui.get().ribbon.compact);
    root.classList.toggle('ribbon-minimised', minimised);
    root.classList.toggle('ribbon-peek', minimised && peek);
    body.hidden = minimised && !peek;
    minimiseBtn.setAttribute('aria-pressed', minimised ? 'true' : 'false');
    minimiseBtn.replaceChildren(
      icon(minimised ? 'chevron-down' : 'chevron-up'),
      srOnly(minimised ? 'Expand ribbon' : 'Minimise ribbon'),
    );
    minimiseBtn.title = minimised ? 'Expand the ribbon' : 'Minimise the ribbon';
  };

  // A peeked ribbon closes when focus or a click leaves it, or when a command runs.
  const onDocPointer = (e: PointerEvent): void => {
    const st = ui.get().ribbon;
    if (!st.minimised || !st.peek) return;
    const t = e.target as Node | null;
    if (t && (root.contains(t) || (t instanceof Element && t.closest('.popup')))) return;
    ui.set({ ribbon: { ...st, peek: false } });
  };
  document.addEventListener('pointerdown', onDocPointer, true);
  root.addEventListener('focusout', (e) => {
    const st = ui.get().ribbon;
    if (!st.minimised || !st.peek) return;
    const next = e.relatedTarget as Node | null;
    if (next && (root.contains(next) || (next instanceof Element && next.closest('.popup'))))
      return;
    if (!next) return;
    ui.set({ ribbon: { ...st, peek: false } });
  });

  // ---- key tips --------------------------------------------------------------------------------

  const tipLayer = el('div.keytip-layer', { id: 'keytip-layer', 'aria-hidden': 'true' });
  document.body.append(tipLayer);
  let tipLevel: 0 | 1 | 2 = 0;
  let tipMap = new Map<string, string>();
  let typed = '';
  let tipTargets = new Map<string, HTMLElement>();

  const showTips = (targets: Map<string, HTMLElement>, specs: KeyTipTarget[]): void => {
    tipLayer.replaceChildren();
    tipTargets = targets;
    tipMap = assignKeyTips(specs);
    typed = '';
    for (const [id, tip] of tipMap) {
      const target = targets.get(id);
      if (!target || !isVisible(target)) continue;
      const r = target.getBoundingClientRect();
      const badge = el('span.keytip', { 'data-for': id }, tip);
      badge.style.left = `${r.left + Math.min(12, r.width / 2)}px`;
      badge.style.top = `${r.bottom - 8}px`;
      tipLayer.append(badge);
    }
    tipLayer.hidden = false;
    ui.set({ keyTips: true });
  };

  const level1 = (): void => {
    tipLevel = 1;
    const targets = new Map<string, HTMLElement>();
    const specs: KeyTipTarget[] = [];
    for (const t of tabs) {
      const e = tablist.querySelector<HTMLElement>(`[data-tab="${t.id}"]`);
      if (!e) continue;
      targets.set(`tab:${t.id}`, e);
      specs.push({ id: `tab:${t.id}`, label: t.label });
    }
    qat.element.querySelectorAll<HTMLElement>('.qat-item').forEach((e, i) => {
      const id = `qat:${e.dataset['qat'] ?? String(i)}`;
      targets.set(id, e);
      specs.push({ id, label: String(i + 1), keyTip: String(i + 1) });
    });
    showTips(targets, specs);
  };

  const level2 = (): void => {
    tipLevel = 2;
    const targets = new Map<string, HTMLElement>();
    const specs: KeyTipTarget[] = [];
    const tab = tabs.find((t) => t.id === activeTabId);
    for (const e of body.querySelectorAll<HTMLElement>('[data-keytip-target]')) {
      const id = e.dataset['keytipTarget'] ?? '';
      if (!id || !isVisible(e)) continue;
      const item = tab?.groups.flatMap((g) => g.items).find((i) => i.id === id);
      const group = id.startsWith('group:')
        ? tab?.groups.find((g) => `group:${g.id}` === id)
        : undefined;
      targets.set(id, e);
      specs.push({
        id,
        label: item?.label ?? group?.label ?? id,
        ...(item?.keyTip ? { keyTip: item.keyTip } : {}),
      });
    }
    showTips(targets, specs);
  };

  const hideTips = (): void => {
    tipLevel = 0;
    typed = '';
    tipLayer.hidden = true;
    tipLayer.replaceChildren();
    if (ui.get().keyTips) ui.set({ keyTips: false });
  };

  const onTipKey = (e: KeyboardEvent): void => {
    if (tipLevel === 0) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (tipLevel === 2) level1();
      else hideTips();
      return;
    }
    if (e.key === 'Alt') return;
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey) {
      hideTips();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    typed += e.key.toUpperCase();
    const m = matchKeyTip(typed, tipMap);
    if (m.kind === 'partial') {
      for (const b of tipLayer.querySelectorAll<HTMLElement>('.keytip')) {
        b.hidden = !(b.textContent ?? '').startsWith(typed);
      }
      return;
    }
    if (m.kind === 'none') {
      typed = '';
      for (const b of tipLayer.querySelectorAll<HTMLElement>('.keytip')) b.hidden = false;
      return;
    }
    const target = tipTargets.get(m.id);
    if (tipLevel === 1 && m.id.startsWith('tab:')) {
      selectTab(m.id.slice(4), 'key');
      if (ui.get().ribbon.minimised) ui.set((s) => ({ ribbon: { ...s.ribbon, peek: true } }));
      refresh();
      target?.focus();
      level2();
      return;
    }
    hideTips();
    if (!target) return;
    target.focus();
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return;
    target.click();
  };
  document.addEventListener('keydown', onTipKey, true);
  const onTipBlur = (): void => {
    if (tipLevel) hideTips();
  };
  window.addEventListener('blur', onTipBlur);

  // ---- subscriptions -----------------------------------------------------------------------------

  const unsubs = [
    ui.select((s) => s.revision, refresh, { immediate: false }),
    ui.select((s) => s.ribbon, refresh, { immediate: false }),
    registry.subscribe(refresh),
  ];
  refresh();

  return {
    element: root,
    refresh,
    rebuild,
    showTab: (id) => {
      selectTab(id, 'program');
    },
    focusActiveTab: () => {
      tablist.querySelector<HTMLElement>(`[data-tab="${activeTabId}"]`)?.focus();
    },
    toggleKeyTips: () => {
      if (tipLevel) hideTips();
      else {
        closeAllPopups();
        level1();
      }
    },
    get keyTipsVisible() {
      return tipLevel > 0;
    },
    tabs: () => tabs,
    dispose: () => {
      disposed = true;
      for (const u of unsubs) u();
      resizeObserver.disconnect();
      document.removeEventListener('pointerdown', onDocPointer, true);
      document.removeEventListener('keydown', onTipKey, true);
      window.removeEventListener('blur', onTipBlur);
      recent.dispose();
      qat.dispose();
      tabRoving.dispose();
      bodyRoving.dispose();
      tipLayer.remove();
      root.remove();
    },
  };
}
