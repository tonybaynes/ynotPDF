/**
 * File backstage (M02): the full-window panel behind the File button, as in Foxit 14. A rail
 * of fixed slots on the left (Open, Recent, New, Save, Save As, Print, Properties, Preferences,
 * Exit) and a page on the right. Modules fill a slot through `ModuleManifest.backstage`
 * (a command, or a mounted page); a slot nobody has filled is shown disabled with the words
 * "Not available yet" so the operator can see what is still to come. Escape or the Back button
 * closes it and returns focus to the File button.
 */

import type { BackstageSlot, BackstageSpec, CreatorSpec, ServiceContext } from '@shared/module';
import { button, el, srOnly } from '../dom';
import { makeRoving } from '../focus';
import { icon } from '../icons';
import type { ShellServices } from '../services';
import { createRecentList } from './recent';

export const BACKSTAGE_SLOTS: ReadonlyArray<{ id: BackstageSlot; label: string; icon: string }> = [
  { id: 'open', label: 'Open', icon: 'folder-open' },
  { id: 'recent', label: 'Recent', icon: 'history' },
  { id: 'new', label: 'New', icon: 'file-plus' },
  { id: 'save', label: 'Save', icon: 'save' },
  { id: 'saveAs', label: 'Save As', icon: 'file-output' },
  { id: 'print', label: 'Print', icon: 'printer' },
  { id: 'properties', label: 'Properties', icon: 'file-cog' },
  { id: 'preferences', label: 'Preferences', icon: 'settings' },
  { id: 'exit', label: 'Exit', icon: 'log-out' },
];

export interface BackstageHandle {
  readonly element: HTMLElement;
  open(page?: BackstageSlot): void;
  close(): void;
  readonly isOpen: boolean;
  /** Which slots are filled (tests). */
  filled(): BackstageSlot[];
  dispose(): void;
}

/** Tiles for every registered creator (New page and the empty state). */
export function creatorTiles(services: ShellServices, className = 'creator-tile'): HTMLElement {
  const { registry } = services;
  const ctx = registry.context();
  const creators: CreatorSpec[] = [];
  for (const m of registry.modules()) creators.push(...(m.creators ?? []));
  creators.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label));
  const grid = el('div.creator-grid', { role: 'list' });
  for (const c of creators) {
    if (c.when && !c.when(ctx)) continue;
    const tile = button(className, {
      role: 'listitem',
      'data-creator': c.id,
      title: c.description,
    });
    tile.append(icon(c.icon ?? 'file-plus', { size: 'lg' }), el('span.tile-label', null, c.label));
    if (c.description) tile.append(el('span.tile-desc', null, c.description));
    tile.addEventListener('click', () => {
      void services.run(c.command);
    });
    grid.append(tile);
  }
  if (!grid.childElementCount) {
    grid.append(
      el(
        'p.creator-empty',
        { role: 'listitem' },
        icon('info'),
        ' No document creators yet — "Create PDF" arrives with module M91.',
      ),
    );
  }
  return grid;
}

export function mountBackstage(host: HTMLElement, services: ShellServices): BackstageHandle {
  const { registry, ui } = services;
  const root = el('div.backstage', {
    id: 'backstage',
    role: 'dialog',
    'aria-modal': 'false',
    'aria-label': 'File',
    tabindex: -1,
  });
  root.hidden = true;
  const rail = el('nav.backstage-rail', { 'aria-label': 'File menu' });
  const back = button('backstage-back', {
    id: 'backstage-back',
    'aria-label': 'Back to the document',
  });
  back.append(icon('arrow-left'), el('span', null, 'Back'));
  back.addEventListener('click', () => {
    handle.close();
  });
  rail.append(back);
  const slotList = el('ul.backstage-slots', { role: 'list' });
  rail.append(slotList);
  const page = el('section.backstage-page', { id: 'backstage-page', 'aria-live': 'polite' });
  root.append(rail, page);
  host.append(root);
  const roving = makeRoving(rail, { selector: 'button:not([disabled])', orientation: 'vertical' });

  const specs = (): Map<BackstageSlot, BackstageSpec> => {
    const map = new Map<BackstageSlot, BackstageSpec>();
    const ctx = registry.context();
    for (const m of registry.modules()) {
      for (const s of m.backstage ?? []) {
        if (s.when && !s.when(ctx)) continue;
        if (!map.has(s.slot)) map.set(s.slot, s);
      }
    }
    return map;
  };

  const mountedPages = new Map<BackstageSlot, { element: HTMLElement; dispose: () => void }>();
  let lastOpener: HTMLElement | null = null;

  const renderRail = (): void => {
    const filled = specs();
    const focusedSlot =
      document.activeElement instanceof HTMLElement && slotList.contains(document.activeElement)
        ? document.activeElement.dataset['slot']
        : undefined;
    slotList.replaceChildren();
    const current = ui.get().backstage.page;
    for (const slot of BACKSTAGE_SLOTS) {
      const spec = filled.get(slot.id);
      const enabled =
        spec !== undefined &&
        (spec.mount !== undefined ||
          (spec.command !== undefined && registry.isEnabled(spec.command)));
      const li = el('li');
      const b = button('backstage-slot', {
        'data-slot': slot.id,
        'aria-current': current === slot.id && spec?.mount ? 'page' : undefined,
        title: enabled ? (spec?.label ?? slot.label) : `${slot.label} — not available yet`,
      });
      b.disabled = !enabled;
      b.append(icon(spec?.icon ?? slot.icon), el('span', null, spec?.label ?? slot.label));
      if (!enabled) b.append(el('span.backstage-unavailable', null, 'Not available yet'));
      b.addEventListener('click', () => {
        if (!spec) return;
        if (spec.mount) {
          ui.set((s) => ({ backstage: { ...s.backstage, page: slot.id } }));
        } else if (spec.command) {
          const cmd = spec.command;
          handle.close();
          void services.run(cmd);
        }
      });
      li.append(b);
      slotList.append(li);
    }
    roving.refresh();
    if (focusedSlot) {
      slotList.querySelector<HTMLElement>(`[data-slot="${focusedSlot}"]:not([disabled])`)?.focus();
    }
  };

  const renderPage = (): void => {
    const filled = specs();
    const slot = ui.get().backstage.page;
    const spec = filled.get(slot);
    for (const [id, m] of mountedPages) m.element.hidden = id !== slot;
    if (!spec?.mount) {
      const fallback = mountedPages.get('open');
      if (fallback && slot !== 'open') {
        ui.set((s) => ({ backstage: { ...s.backstage, page: 'open' } }));
        return;
      }
    }
    if (spec?.mount && !mountedPages.has(slot)) {
      const element = el('div.backstage-page-body', { 'data-page': slot });
      page.append(element);
      let dispose = (): void => undefined;
      try {
        dispose = spec.mount(element, registry.context());
      } catch (error) {
        console.error(`backstage page ${slot} failed`, error);
        element.append(el('p', null, icon('octagon-x'), ' Error: this page failed to load.'));
      }
      mountedPages.set(slot, { element, dispose });
    }
  };

  const refresh = (): void => {
    if (root.hidden) return;
    renderRail();
    renderPage();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !root.hidden) {
      e.preventDefault();
      e.stopPropagation();
      handle.close();
    }
  };

  const handle: BackstageHandle = {
    element: root,
    open: (pageId) => {
      lastOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      root.hidden = false;
      document.body.classList.add('backstage-open');
      ui.set((s) => ({ backstage: { open: true, page: pageId ?? s.backstage.page } }));
      refresh();
      document.addEventListener('keydown', onKey, true);
      (
        slotList.querySelector<HTMLElement>(
          `[data-slot="${ui.get().backstage.page}"]:not([disabled])`,
        ) ?? back
      ).focus();
    },
    close: () => {
      if (root.hidden) return;
      root.hidden = true;
      document.body.classList.remove('backstage-open');
      document.removeEventListener('keydown', onKey, true);
      ui.set((s) => ({ backstage: { ...s.backstage, open: false } }));
      const restore = lastOpener ?? document.getElementById('ribbon-file');
      restore?.focus();
    },
    get isOpen() {
      return !root.hidden;
    },
    filled: () => Array.from(specs().keys()),
    dispose: () => {
      for (const u of unsubs) u();
      for (const m of mountedPages.values()) m.dispose();
      roving.dispose();
      root.remove();
    },
  };
  const unsubs = [
    ui.select((s) => s.backstage.page, refresh, { immediate: false }),
    ui.select((s) => s.revision, refresh, { immediate: false }),
    registry.subscribe(refresh),
  ];
  return handle;
}

/** The shell's own backstage pages (Open, Recent, New), registered by the M02 manifest. */
export function shellBackstagePages(): BackstageSpec[] {
  const svc = (ctx: ServiceContext): ShellServices => ctx.service<ShellServices>('shellServices');
  return [
    {
      slot: 'open',
      mount: (host, ctx) => {
        const services = svc(ctx);
        host.append(el('h2.backstage-title', null, 'Open'));
        const openBtn = button('btn btn-primary btn-big', { id: 'backstage-open-file' });
        openBtn.append(icon('folder-open', { size: 'lg' }), el('span', null, 'Browse for a PDF…'));
        openBtn.addEventListener('click', () => {
          void services.run('file.open');
        });
        host.append(el('div.backstage-actions', null, openBtn));
        host.append(
          el(
            'p.backstage-hint',
            null,
            'You can also drop a PDF onto the window, or open one from Recent.',
          ),
        );
        host.append(el('h3.backstage-subtitle', null, 'Recent'));
        const recent = createRecentList(services, { limit: 8, controls: false });
        host.append(recent.element);
        return () => {
          recent.dispose();
        };
      },
    },
    {
      slot: 'recent',
      mount: (host, ctx) => {
        const services = svc(ctx);
        host.append(el('h2.backstage-title', null, 'Recent files'));
        host.append(
          el(
            'p.backstage-hint',
            null,
            'Pinned files stay at the top and are never dropped from the list.',
          ),
        );
        const recent = createRecentList(services, {});
        host.append(recent.element);
        const clear = button('btn', { id: 'backstage-clear-recent' });
        clear.append(icon('trash-2'), el('span', null, 'Clear unpinned'));
        clear.addEventListener('click', () => {
          void services.run('file.recent.clear');
        });
        host.append(el('div.backstage-actions', null, clear));
        return () => {
          recent.dispose();
        };
      },
    },
    {
      slot: 'new',
      mount: (host, ctx) => {
        const services = svc(ctx);
        host.append(el('h2.backstage-title', null, 'New'));
        host.append(
          el(
            'p.backstage-hint',
            null,
            'Create a PDF from images, web pages, the clipboard or text.',
          ),
        );
        const gridHost = el('div.creator-host');
        gridHost.append(creatorTiles(services));
        host.append(gridHost);
        return services.registry.subscribe(() => {
          gridHost.replaceChildren(creatorTiles(services));
        });
      },
    },
    { slot: 'exit', command: 'app.quit', label: 'Exit' },
  ];
}

export { srOnly };
