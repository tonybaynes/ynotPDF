/**
 * Status bar (M02): three slots (left / centre / right) that modules fill through
 * `ModuleManifest.statusBar`. The shell's own defaults, registered by the M02 manifest, are the
 * editable page field ("x of y"), the editable zoom field with a slider and fit buttons, the
 * layout radio group, and — mounted here because M01 owns it — the theme switcher. Every
 * control writes `ui.view` through commands, which M11 subscribes to.
 */

import type { StatusItemSpec, StatusSlot } from '@shared/module';
import { el } from '../dom';
import { makeRoving } from '../focus';
import type { ShellServices } from '../services';

export interface StatusBarHandle {
  readonly element: HTMLElement;
  /** Shows a transient message in the left slot (`role="status"`). */
  setMessage(text: string): void;
  refresh(): void;
  dispose(): void;
}

export function mountStatusBar(host: HTMLElement, services: ShellServices): StatusBarHandle {
  const { registry } = services;
  const root = el('footer.statusbar', {
    id: 'statusbar',
    'data-region': 'status',
    role: 'toolbar',
    'aria-label': 'Status bar',
  });
  const slots: Record<StatusSlot, HTMLElement> = {
    left: el('div.status-slot.status-left', { 'data-slot': 'left' }),
    centre: el('div.status-slot.status-centre', { 'data-slot': 'centre' }),
    right: el('div.status-slot.status-right', { 'data-slot': 'right' }),
  };
  const message = el('span.status-message', {
    id: 'status-message',
    role: 'status',
    'aria-live': 'polite',
  });
  slots.left.append(message);
  root.append(slots.left, slots.centre, slots.right);
  host.append(root);
  const roving = makeRoving(root, { selector: 'button, input, select, [tabindex="0"]' });

  const mounted = new Map<string, { element: HTMLElement; dispose: () => void }>();
  const items = (): StatusItemSpec[] => {
    const out: StatusItemSpec[] = [];
    for (const m of registry.modules()) out.push(...(m.statusBar ?? []));
    return out.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
  };

  const refresh = (): void => {
    const list = items();
    const seen = new Set<string>();
    for (const spec of list) {
      seen.add(spec.id);
      let m = mounted.get(spec.id);
      if (!m) {
        const element = el('div.status-item', { 'data-status-item': spec.id });
        let dispose = (): void => undefined;
        try {
          dispose = spec.mount(element, registry.context());
        } catch (error) {
          console.error(`status item ${spec.id} failed to mount`, error);
        }
        m = { element, dispose };
        mounted.set(spec.id, m);
      }
      const slot = slots[spec.slot];
      // Keep order: append in sorted order after any fixed children (the message span).
      slot.append(m.element);
    }
    for (const [id, m] of mounted) {
      if (!seen.has(id)) {
        m.dispose();
        m.element.remove();
        mounted.delete(id);
      }
    }
    roving.refresh();
  };
  const unsub = registry.subscribe(refresh);
  refresh();

  return {
    element: root,
    setMessage: (text) => {
      message.textContent = text;
    },
    refresh,
    dispose: () => {
      unsub();
      for (const m of mounted.values()) m.dispose();
      roving.dispose();
      root.remove();
    },
  };
}
