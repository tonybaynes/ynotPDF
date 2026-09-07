/**
 * Quick-access toolbar (M02): a row of small command buttons above the ribbon tabs. Items are
 * command ids in `ui.qat`, persisted through the UI settings. Right-click a ribbon button →
 * "Add to Quick Access Toolbar"; right-click a QAT button → "Remove". The row is a roving
 * tabindex group.
 */

import { el } from '../dom';
import { makeRoving } from '../focus';
import type { ShellServices } from '../services';
import { renderItem, type Widget } from './widgets';
import { itemState, normalizeItem } from './model';

export interface QatHandle {
  readonly element: HTMLElement;
  refresh(): void;
  dispose(): void;
}

export function mountQat(host: HTMLElement, services: ShellServices): QatHandle {
  const { registry, ui } = services;
  const bar = el('div.qat', { role: 'toolbar', 'aria-label': 'Quick access toolbar', id: 'qat' });
  host.append(bar);
  const roving = makeRoving(bar, { selector: '.rb-btn' });
  let widgets: { id: string; widget: Widget }[] = [];
  let rendered = '';

  const rebuild = (): void => {
    const ids = ui.get().qat;
    const key = ids.join(',');
    if (key !== rendered) {
      rendered = key;
      bar.replaceChildren();
      widgets = [];
      for (const id of ids) {
        const item = normalizeItem(
          id,
          { id: 'qat', tab: 'home', label: 'QAT', items: [] },
          registry,
        );
        const w = renderItem({ ...item, size: 'small' }, services);
        w.element.classList.add('qat-item');
        w.element.dataset['qat'] = id;
        widgets.push({ id, widget: w });
        bar.append(w.element);
      }
      roving.refresh();
    }
    for (const { id, widget } of widgets) {
      const item = normalizeItem(id, { id: 'qat', tab: 'home', label: 'QAT', items: [] }, registry);
      widget.update(itemState(item, registry));
    }
  };

  const unsubs = [
    ui.select((s) => s.qat, rebuild),
    ui.select((s) => s.revision, rebuild, { immediate: false }),
    registry.subscribe(rebuild),
  ];
  rebuild();
  return {
    element: bar,
    refresh: rebuild,
    dispose: () => {
      for (const u of unsubs) u();
      roving.dispose();
      bar.remove();
    },
  };
}
