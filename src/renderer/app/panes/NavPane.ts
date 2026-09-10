/**
 * Left navigation pane (M02): an icon strip of every `dock: 'left'` panel plus a host that
 * mounts the open panel lazily (once) and keeps it mounted but hidden afterwards, so panels keep
 * their scroll position and state. Resizable, collapsible; width and last-open panel persist.
 * Exposes the `panels` service the Registry's auto-generated `panel.<id>` commands call.
 */

import type { PanelSpec } from '@shared/module';
import { button, el, srOnly, uiScaleFactor } from '../dom';
import { makeRoving } from '../focus';
import { icon } from '../icons';
import type { ShellServices } from '../services';
import { clampPaneWidth } from '../ui/UiState';
import { createResizer } from './resizer';

export interface PanelsService {
  /** Shows the panel (expanding the pane) or, if it is already showing, collapses the pane. */
  toggle(panelId: string): void;
  show(panelId: string): void;
  /** Collapses the pane (the panel stays remembered). */
  collapse(): void;
  expand(): void;
  readonly active: string | null;
  readonly collapsed: boolean;
  /** Left panels in display order. */
  list(): ReadonlyArray<PanelSpec>;
}

export interface NavPaneHandle {
  readonly element: HTMLElement;
  readonly service: PanelsService;
  refresh(): void;
  dispose(): void;
}

export function mountNavPane(host: HTMLElement, services: ShellServices): NavPaneHandle {
  const { registry, ui } = services;
  const root = el('aside.pane.pane-left', {
    id: 'pane-left',
    'data-region': 'left-pane',
    'aria-label': 'Navigation pane',
  });
  const strip = el('div.pane-strip', {
    role: 'toolbar',
    'aria-label': 'Navigation panels',
    'aria-orientation': 'vertical',
    id: 'nav-strip',
  });
  const panelHost = el('div.pane-host', { id: 'nav-host' });
  const header = el('div.pane-header');
  const title = el('h2.pane-title', { id: 'nav-title' });
  const collapseBtn = button(
    'icon-btn pane-collapse',
    { 'aria-label': 'Collapse navigation pane', title: 'Collapse navigation pane' },
    icon('panel-left-close'),
  );
  collapseBtn.addEventListener('click', () => {
    service.collapse();
  });
  header.append(title, collapseBtn);
  const content = el('div.pane-content', null, header, panelHost);
  root.append(strip, content);
  const resizer = createResizer({
    side: 'left',
    label: 'Resize navigation pane',
    getWidth: () => ui.get().leftPane.width,
    setWidth: (w) => {
      ui.set((s) => ({ leftPane: { ...s.leftPane, width: clampPaneWidth(w), collapsed: false } }));
    },
    onToggle: () => {
      service.toggle(ui.get().leftPane.panel ?? panels()[0]?.id ?? '');
    },
  });
  host.append(root, resizer);
  const roving = makeRoving(strip, { selector: 'button', orientation: 'vertical' });

  const mounted = new Map<string, { element: HTMLElement; dispose: () => void }>();
  const panels = (): PanelSpec[] => registry.panels().filter((p) => p.dock === 'left');

  const service: PanelsService = {
    toggle: (id) => {
      const st = ui.get().leftPane;
      if (!st.collapsed && st.panel === id) service.collapse();
      else service.show(id);
    },
    show: (id) => {
      if (!panels().some((p) => p.id === id)) return;
      ui.set((s) => ({ leftPane: { ...s.leftPane, panel: id, collapsed: false } }));
    },
    collapse: () => {
      ui.set((s) => ({ leftPane: { ...s.leftPane, collapsed: true } }));
    },
    expand: () => {
      ui.set((s) => ({
        leftPane: {
          ...s.leftPane,
          collapsed: false,
          panel: s.leftPane.panel ?? panels()[0]?.id ?? null,
        },
      }));
    },
    get active() {
      const st = ui.get().leftPane;
      return st.collapsed ? null : st.panel;
    },
    get collapsed() {
      return ui.get().leftPane.collapsed;
    },
    list: panels,
  };

  let stripKey = '';
  const renderStrip = (): void => {
    const list = panels();
    const key = list.map((p) => p.id).join(',');
    if (key !== stripKey) {
      stripKey = key;
      strip.replaceChildren();
      for (const p of list) {
        const b = button('pane-strip-btn', {
          'data-panel': p.id,
          'aria-pressed': 'false',
          title: p.title,
          'aria-label': p.title,
        });
        b.append(icon(p.icon, { fallbackText: p.title }));
        b.addEventListener('click', () => {
          service.toggle(p.id);
        });
        strip.append(b);
      }
      roving.refresh();
    }
    const st = ui.get().leftPane;
    for (const b of strip.querySelectorAll<HTMLElement>('button')) {
      const on = !st.collapsed && b.dataset['panel'] === st.panel;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    root.classList.toggle('pane-empty', list.length === 0);
  };

  const renderPanel = (): void => {
    const st = ui.get().leftPane;
    const list = panels();
    const spec = list.find((p) => p.id === st.panel) ?? null;
    const collapsed = st.collapsed || !spec;
    root.classList.toggle('pane-collapsed', collapsed);
    root.style.width = collapsed ? '' : `${st.width * uiScaleFactor()}px`;
    content.hidden = collapsed;
    resizer.hidden = collapsed || list.length === 0;
    root.hidden = list.length === 0;
    if (!spec) return;
    title.textContent = spec.title;
    // Panels are mounted once and cached, so mounting before `registry.activateAll()` would
    // cache a panel built against services that do not exist yet — M12's Pages panel came up
    // as "the navigation panels are not available" and stayed that way (2026-09-10).
    if (!registry.isActivated) return;
    for (const [id, m] of mounted) m.element.hidden = id !== spec.id;
    if (!mounted.has(spec.id)) {
      const element = el('div.panel', {
        'data-panel': spec.id,
        role: 'region',
        'aria-labelledby': 'nav-title',
      });
      panelHost.append(element);
      let dispose = (): void => undefined;
      try {
        dispose = spec.mount(element, registry.context());
      } catch (error) {
        console.error(`panel ${spec.id} failed to mount`, error);
        element.append(
          el('p.panel-error', null, icon('octagon-x'), ' Error: this panel failed to load.'),
        );
      }
      mounted.set(spec.id, { element, dispose });
    }
  };

  const refresh = (): void => {
    renderStrip();
    renderPanel();
  };
  const unsubs = [
    ui.select((s) => s.leftPane, refresh, { immediate: false }),
    registry.subscribe(refresh),
  ];
  refresh();
  // A collapsed pane with no chosen panel: pick the first so "expand" has something to show.
  if (!ui.get().leftPane.panel && panels()[0]) {
    ui.set((s) => ({ leftPane: { ...s.leftPane, panel: panels()[0]?.id ?? null } }));
  }

  return {
    element: root,
    service,
    refresh,
    dispose: () => {
      for (const u of unsubs) u();
      for (const m of mounted.values()) m.dispose();
      roving.dispose();
      root.remove();
      resizer.remove();
    },
  };
}

/** Visually hidden helper re-exported for panels that need it. */
export { srOnly };
