/**
 * Document tab strip (M02). One `role="tab"` per open document: title, a dirty marker (dot
 * *and* the word "Modified" for screen readers and the tooltip), a close button. Middle-click
 * closes; pointer drag reorders (with capture, so it is deterministic under Playwright);
 * releasing the pointer outside the window detaches the tab into a new window over IPC.
 * Ctrl+Tab / Ctrl+Shift+Tab cycle (global shortcuts registered by the M02 manifest).
 */

import { hasBridge, invoke } from '@shared/ipc';
import { button, el, srOnly } from '../dom';
import { makeRoving } from '../focus';
import { icon } from '../icons';
import type { ShellServices } from '../services';
import type { DocumentTab } from './Documents';

export interface TabStripHandle {
  readonly element: HTMLElement;
  /** Moves a tab into a new window (drag-out, context menu, command). */
  detach(id: string): Promise<boolean>;
  dispose(): void;
}

const DRAG_THRESHOLD = 6;
const DETACH_DISTANCE = 48;

export function mountTabStrip(host: HTMLElement, services: ShellServices): TabStripHandle {
  const { documents } = services;
  const strip = el('div.tabstrip', {
    id: 'tabstrip',
    role: 'tablist',
    'aria-label': 'Open documents',
  });
  host.append(strip);
  const roving = makeRoving(strip, { selector: '[role="tab"]' });
  const views = new Map<string, HTMLElement>();

  const detach = async (id: string): Promise<boolean> => {
    const tab = documents.get(id);
    if (!tab) return false;
    if (!hasBridge()) {
      services.toasts.show({
        kind: 'warning',
        text: 'Opening a new window needs the Electron shell.',
      });
      return false;
    }
    if (tab.dirty) {
      const ok = await services.dialogs.confirm({
        title: 'Move to new window',
        text: `"${tab.title}" has unsaved changes. Moving it to a new window closes it here without saving. Continue?`,
        confirmLabel: 'Move without saving',
        cancelLabel: 'Cancel',
        danger: true,
        kind: 'warning',
      });
      if (!ok) return false;
    }
    await invoke('window:new', tab.path ?? undefined);
    await documents.close(id, { force: true });
    return true;
  };

  const buildTab = (tab: DocumentTab): HTMLElement => {
    const t = el('div.tab', {
      role: 'tab',
      'data-tab-id': tab.id,
      tabindex: -1,
      'aria-selected': 'false',
    });
    const label = el('span.tab-title', null, tab.title);
    const dirty = el('span.tab-dirty', { 'aria-hidden': 'true' }, '●');
    const dirtyWord = srOnly('');
    const closeBtn = button(
      'icon-btn tab-close',
      { 'aria-label': `Close ${tab.title}`, tabindex: -1 },
      icon('x'),
    );
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void documents.close(tab.id);
    });
    t.append(label, dirty, dirtyWord, closeBtn);

    t.addEventListener('click', () => {
      documents.activate(tab.id);
    });
    // Middle-click closes. Handled on pointerup rather than `auxclick`, which synthetic input
    // (Playwright / CDP) never dispatches; a real middle click fires both, and only this one acts.
    t.addEventListener('pointerup', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        void documents.close(tab.id);
      }
    });
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || (e.key === 'w' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        void documents.close(tab.id);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        documents.activate(tab.id);
      }
    });

    // Pointer drag: reorder within the strip, detach when released far outside it.
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let pendingIndex: number | null = null;
    const clearMarker = (): void => {
      for (const s of strip.querySelectorAll('.tab-drop-before'))
        s.classList.remove('tab-drop-before');
      strip.classList.remove('tab-drop-end');
    };
    t.addEventListener('pointerdown', (e) => {
      if (e.button === 1) {
        // Stop Chromium's middle-button autoscroll: it swallows every key until it ends.
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      if ((e.target as Element).closest('.tab-close')) return;
      startX = e.clientX;
      startY = e.clientY;
      dragging = false;
      t.setPointerCapture(e.pointerId);
    });
    t.addEventListener('pointermove', (e) => {
      if (!t.hasPointerCapture(e.pointerId)) return;
      if (!dragging) {
        if (
          Math.abs(e.clientX - startX) < DRAG_THRESHOLD &&
          Math.abs(e.clientY - startY) < DRAG_THRESHOLD
        )
          return;
        dragging = true;
        t.classList.add('tab-dragging');
        documents.activate(tab.id);
      }
      const rect = strip.getBoundingClientRect();
      const outside =
        e.clientY < rect.top - DETACH_DISTANCE || e.clientY > rect.bottom + DETACH_DISTANCE;
      t.classList.toggle('tab-detaching', outside);
      clearMarker();
      if (outside) {
        pendingIndex = null;
        return;
      }
      // Find the index the pointer is over. The DOM is only reordered on release: moving the
      // dragged node mid-drag would release its pointer capture.
      const siblings = Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]')).filter(
        (s) => s !== t,
      );
      let index = siblings.length;
      for (let i = 0; i < siblings.length; i++) {
        const r = siblings[i]?.getBoundingClientRect();
        if (r && e.clientX < r.left + r.width / 2) {
          index = i;
          break;
        }
      }
      pendingIndex = index;
      const target = siblings[index];
      if (target) target.classList.add('tab-drop-before');
      else strip.classList.add('tab-drop-end');
    });
    const endDrag = (e: PointerEvent): void => {
      if (!t.hasPointerCapture(e.pointerId)) return;
      t.releasePointerCapture(e.pointerId);
      const wasDetaching = t.classList.contains('tab-detaching');
      t.classList.remove('tab-dragging', 'tab-detaching');
      clearMarker();
      if (!dragging) return;
      dragging = false;
      // The click that follows a drag release must not land on whatever is under the pointer
      // (a ribbon button, say): swallow the next click, once.
      document.addEventListener(
        'click',
        (ce) => {
          ce.preventDefault();
          ce.stopPropagation();
        },
        { capture: true, once: true },
      );
      setTimeout(() => {
        // If no click followed (release outside the window), drop the one-shot guard.
        document.dispatchEvent(new Event('click'));
      }, 0);
      const outsideWindow =
        e.clientX < 0 ||
        e.clientY < 0 ||
        e.clientX > window.innerWidth ||
        e.clientY > window.innerHeight;
      if (wasDetaching && outsideWindow && documents.tabs.length > 1) {
        void detach(tab.id);
      } else if (pendingIndex !== null) {
        const current = documents.tabs.findIndex((x) => x.id === tab.id);
        if (pendingIndex !== current) documents.move(tab.id, pendingIndex);
      }
      pendingIndex = null;
    };
    t.addEventListener('pointerup', endDrag);
    t.addEventListener('pointercancel', endDrag);
    return t;
  };

  const updateTab = (view: HTMLElement, tab: DocumentTab, active: boolean): void => {
    const title = view.querySelector('.tab-title');
    if (title && title.textContent !== tab.title) title.textContent = tab.title;
    view.classList.toggle('tab-modified', tab.dirty);
    view.classList.toggle('tab-readonly', tab.readOnly);
    const word = view.querySelector('.sr-only');
    if (word) word.textContent = tab.dirty ? ' (Modified)' : tab.readOnly ? ' (Read-only)' : '';
    view.title = `${tab.title}${tab.dirty ? ' — Modified' : ''}${tab.readOnly ? ' — Read-only' : ''}${tab.path ? `\n${tab.path}` : ''}`;
    view.setAttribute('aria-selected', active ? 'true' : 'false');
    view.classList.toggle('tab-active', active);
    view.querySelector('.tab-close')?.setAttribute('aria-label', `Close ${tab.title}`);
  };

  const render = (): void => {
    const { tabs, active } = documents.state;
    strip.hidden = tabs.length === 0;
    const seen = new Set<string>();
    tabs.forEach((tab, i) => {
      seen.add(tab.id);
      let view = views.get(tab.id);
      if (!view) {
        view = buildTab(tab);
        views.set(tab.id, view);
      }
      updateTab(view, tab, tab.id === active);
      if (strip.children[i] !== view) strip.insertBefore(view, strip.children[i] ?? null);
    });
    for (const [id, view] of views) {
      if (!seen.has(id)) {
        view.remove();
        views.delete(id);
      }
    }
    roving.refresh();
    const activeView = active ? views.get(active) : undefined;
    if (activeView) {
      for (const v of views.values()) v.tabIndex = v === activeView ? 0 : -1;
      activeView.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };

  const unsub = documents.subscribe(render);
  render();
  return {
    element: strip,
    detach,
    dispose: () => {
      unsub();
      roving.dispose();
      strip.remove();
    },
  };
}
