/**
 * Right properties pane (M02): hosts `dock: 'right'` panels and shows the first one (by
 * `order`) whose `when()` matches the current selection; hidden when none does or when the
 * user hid it (`view.pane.right.toggle`). Panels mount lazily and stay mounted.
 */

import type { PanelSpec } from '@shared/module';
import { button, el, uiScaleFactor } from '../dom';
import { icon } from '../icons';
import type { ShellServices } from '../services';
import { clampPaneWidth } from '../ui/UiState';
import { createResizer } from './resizer';

export interface PropertiesPaneHandle {
  readonly element: HTMLElement;
  /** The panel currently shown, if any. */
  readonly active: string | null;
  refresh(): void;
  dispose(): void;
}

export function mountPropertiesPane(
  host: HTMLElement,
  services: ShellServices,
): PropertiesPaneHandle {
  const { registry, ui } = services;
  const root = el('aside.pane.pane-right', {
    id: 'pane-right',
    'data-region': 'right-pane',
    'aria-label': 'Properties pane',
  });
  const header = el('div.pane-header');
  const title = el('h2.pane-title', { id: 'props-title' }, 'Properties');
  const hideBtn = button(
    'icon-btn pane-collapse',
    { 'aria-label': 'Hide properties pane', title: 'Hide properties pane' },
    icon('panel-right-close'),
  );
  hideBtn.addEventListener('click', () => {
    ui.set((s) => ({ rightPane: { ...s.rightPane, visible: false } }));
  });
  header.append(title, hideBtn);
  const panelHost = el('div.pane-host', { id: 'props-host' });
  root.append(header, panelHost);
  const resizer = createResizer({
    side: 'right',
    label: 'Resize properties pane',
    getWidth: () => ui.get().rightPane.width,
    setWidth: (w) => {
      ui.set((s) => ({ rightPane: { ...s.rightPane, width: clampPaneWidth(w) } }));
    },
  });
  host.append(resizer, root);

  const mounted = new Map<string, { element: HTMLElement; dispose: () => void }>();
  let active: string | null = null;

  const pick = (): PanelSpec | null => {
    const ctx = registry.context();
    for (const p of registry.panels()) {
      if (p.dock !== 'right') continue;
      try {
        if (!p.when || p.when(ctx)) return p;
      } catch (error) {
        console.warn(`panel ${p.id} when() threw`, error);
      }
    }
    return null;
  };

  const refresh = (): void => {
    const spec = pick();
    const visible = ui.get().rightPane.visible && spec !== null;
    root.hidden = !visible;
    resizer.hidden = !visible;
    root.style.width = `${ui.get().rightPane.width * uiScaleFactor()}px`;
    active = visible && spec ? spec.id : null;
    if (!spec || !visible) return;
    title.textContent = spec.title;
    for (const [id, m] of mounted) m.element.hidden = id !== spec.id;
    if (!mounted.has(spec.id)) {
      const element = el('div.panel', {
        'data-panel': spec.id,
        role: 'region',
        'aria-labelledby': 'props-title',
      });
      panelHost.append(element);
      // Claim the slot before mounting: `mount` may change UI state, which re-enters `refresh`
      // synchronously and would otherwise mount a second copy. Same hole as NavPane's (M04).
      const entry = { element, dispose: (): void => undefined };
      mounted.set(spec.id, entry);
      try {
        entry.dispose = spec.mount(element, registry.context());
      } catch (error) {
        console.error(`panel ${spec.id} failed to mount`, error);
        element.append(
          el('p.panel-error', null, icon('octagon-x'), ' Error: this panel failed to load.'),
        );
      }
    }
  };

  const unsubs = [
    ui.select((s) => s.revision, refresh, { immediate: false }),
    ui.select((s) => s.rightPane, refresh, { immediate: false }),
    registry.subscribe(refresh),
  ];
  refresh();
  return {
    element: root,
    get active() {
      return active;
    },
    refresh,
    dispose: () => {
      for (const u of unsubs) u();
      for (const m of mounted.values()) m.dispose();
      root.remove();
      resizer.remove();
    },
  };
}
