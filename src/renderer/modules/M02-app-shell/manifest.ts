/**
 * M02 manifest — the shell's own commands, status-bar defaults, backstage pages and context
 * menus. Every user action in the chrome is a registered command with a palette entry and,
 * where sensible, a shortcut. None of these change a *document*, so no `Command` (undo)
 * objects are involved: they change view state in the `UiState` store.
 *
 * The page / zoom / layout commands only write `ui.view`; M11 subscribes to that slice and
 * applies it to the viewport, so status bar, ribbon and tests read one source.
 */

import type { Registry } from '@core/Registry';
import { hasBridge, invoke } from '@shared/ipc';
import {
  defineModule,
  type BackstageSlot,
  type CommandSpec,
  type ServiceContext,
} from '@shared/module';
import type { BackstageHandle } from '@app/backstage/Backstage';
import { shellBackstagePages } from '@app/backstage/Backstage';
import type { Dialogs, MessageKind } from '@app/dialog/Dialogs';
import type { Toasts, ToastOptions } from '@app/dialog/toast';
import { button, el, srOnly } from '@app/dom';
import { icon } from '@app/icons';
import type { FocusService, ToolsService } from '@app/shell';
import type { PanelsService } from '@app/panes/NavPane';
import type { RibbonHandle } from '@app/ribbon/Ribbon';
import { SERVICE } from '@app/services';
import type { Documents } from '@app/tabs/Documents';
import type { TabStripHandle } from '@app/tabs/TabStrip';
import {
  clampZoom,
  formatZoom,
  LAYOUT_MODES,
  parsePageInput,
  parseZoomInput,
  stepZoom,
  ZOOM_MAX,
  ZOOM_MIN,
  type LayoutMode,
  type UiStore,
  type ViewState,
} from '@app/ui/UiState';
import { BUILT_IN_TABS } from '@app/ribbon/model';

const ui = (ctx: ServiceContext): UiStore => ctx.service<UiStore>(SERVICE.ui);
const docs = (ctx: ServiceContext): Documents => ctx.service<Documents>(SERVICE.documents);
const hasDocument = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(SERVICE.documents) && docs(ctx).tabs.length > 0;
const isLayout = (v: unknown): v is LayoutMode => LAYOUT_MODES.some((m) => m.id === v);
const setView = (ctx: ServiceContext, patch: Partial<ViewState>): ViewState => {
  const store = ui(ctx);
  store.set((s) => ({ view: { ...s.view, ...patch } }));
  return store.get().view;
};

const tabCommands: CommandSpec[] = BUILT_IN_TABS.map((t) => ({
  id: `app.ribbon.tab.${t.id}`,
  label: `Ribbon: ${t.label} tab`,
  category: 'View',
  hidden: true,
  run: (ctx) => {
    ctx.service<RibbonHandle>(SERVICE.ribbon).showTab(t.id);
  },
}));

const layoutCommands: CommandSpec[] = LAYOUT_MODES.map((m) => ({
  id: `view.layout.${m.id}`,
  label: `Layout: ${m.label}`,
  category: 'View',
  icon: m.icon,
  description: `Show pages in ${m.label.toLowerCase()} layout`,
  run: (ctx) => setView(ctx, { layout: m.id }).layout,
}));

export default defineModule({
  id: 'M02',
  name: 'Application shell',
  commands: [
    // ---- backstage / ribbon --------------------------------------------------------------------
    {
      id: 'app.backstage.open',
      label: 'File menu',
      category: 'File',
      icon: 'menu',
      description: 'Open the File backstage (pass { page } to open a page directly)',
      run: (ctx) => {
        const page = ctx.args['page'];
        ctx
          .service<BackstageHandle>(SERVICE.backstage)
          .open(typeof page === 'string' ? (page as BackstageSlot) : undefined);
        return true;
      },
    },
    {
      id: 'app.backstage.close',
      label: 'Close File menu',
      category: 'File',
      hidden: true,
      run: (ctx) => {
        ctx.service<BackstageHandle>(SERVICE.backstage).close();
      },
    },
    {
      id: 'app.ribbon.toggleMinimised',
      label: 'Minimise Ribbon',
      category: 'View',
      icon: 'chevron-up',
      shortcut: 'Mod+F1',
      description: 'Show only the ribbon tabs; click a tab to peek at its groups',
      run: (ctx) => {
        const store = ui(ctx);
        store.set((s) => ({
          ribbon: { ...s.ribbon, minimised: !s.ribbon.minimised, peek: false },
        }));
        return store.get().ribbon.minimised;
      },
    },
    {
      id: 'app.ribbon.showTab',
      label: 'Show ribbon tab…',
      category: 'View',
      hidden: true,
      description: 'Activate a ribbon tab by id (pass { tab })',
      run: (ctx) => {
        const tab = ctx.args['tab'];
        if (typeof tab !== 'string') throw new Error('app.ribbon.showTab needs { tab }');
        ctx.service<RibbonHandle>(SERVICE.ribbon).showTab(tab);
        return tab;
      },
    },
    ...tabCommands,
    {
      id: 'app.keyTips',
      label: 'Show key tips',
      category: 'Application',
      icon: 'keyboard',
      description: 'Show the Alt key tips on the ribbon (press Alt on its own)',
      run: (ctx) => {
        const ribbon = ctx.service<RibbonHandle>(SERVICE.ribbon);
        ribbon.toggleKeyTips();
        return ribbon.keyTipsVisible;
      },
    },
    {
      id: 'app.qat.add',
      label: 'Add to Quick Access Toolbar…',
      category: 'Application',
      icon: 'plus',
      description: 'Pin a command to the quick-access toolbar (pass { command })',
      run: (ctx) => {
        const id = ctx.args['command'];
        if (typeof id !== 'string') throw new Error('app.qat.add needs { command }');
        if (!ctx.service<Registry>('registry').has(id)) throw new Error(`Unknown command: ${id}`);
        ui(ctx).set((s) => ({ qat: s.qat.includes(id) ? s.qat : [...s.qat, id] }));
        return ui(ctx).get().qat;
      },
    },
    {
      id: 'app.qat.remove',
      label: 'Remove from Quick Access Toolbar…',
      category: 'Application',
      icon: 'minus',
      description: 'Remove a command from the quick-access toolbar (pass { command })',
      run: (ctx) => {
        const id = ctx.args['command'];
        if (typeof id !== 'string') throw new Error('app.qat.remove needs { command }');
        ui(ctx).set((s) => ({ qat: s.qat.filter((c) => c !== id) }));
        return ui(ctx).get().qat;
      },
    },
    {
      id: 'app.qat.reset',
      label: 'Reset Quick Access Toolbar',
      category: 'Application',
      icon: 'rotate-ccw',
      run: (ctx) => {
        ui(ctx).set({ qat: ['file.open', 'edit.undo', 'edit.redo'] });
        return ui(ctx).get().qat;
      },
    },
    // ---- panes -----------------------------------------------------------------------------------
    {
      id: 'view.pane.left.toggle',
      label: 'Navigation Pane',
      category: 'View',
      icon: 'panel-left',
      shortcut: 'F4',
      description: 'Show or hide the left navigation pane',
      run: (ctx) => {
        const panels = ctx.service<PanelsService>(SERVICE.panels);
        if (panels.collapsed) panels.expand();
        else panels.collapse();
        return !panels.collapsed;
      },
    },
    {
      id: 'view.pane.right.toggle',
      label: 'Properties Pane',
      category: 'View',
      icon: 'panel-right',
      shortcut: 'Mod+F4',
      description: 'Show or hide the right properties pane',
      run: (ctx) => {
        const store = ui(ctx);
        store.set((s) => ({ rightPane: { ...s.rightPane, visible: !s.rightPane.visible } }));
        return store.get().rightPane.visible;
      },
    },
    {
      id: 'view.panel.show',
      label: 'Show panel…',
      category: 'View',
      hidden: true,
      description: 'Open a navigation panel by id (pass { panel })',
      run: (ctx) => {
        const id = ctx.args['panel'];
        if (typeof id !== 'string') throw new Error('view.panel.show needs { panel }');
        ctx.service<PanelsService>(SERVICE.panels).show(id);
        return ctx.service<PanelsService>(SERVICE.panels).active;
      },
    },
    // ---- tabs ------------------------------------------------------------------------------------
    {
      id: 'app.tabs.next',
      label: 'Next Document Tab',
      category: 'View',
      icon: 'chevron-right',
      shortcut: 'Mod+Tab',
      when: hasDocument,
      run: (ctx) => docs(ctx).next()?.id ?? null,
    },
    {
      id: 'app.tabs.previous',
      label: 'Previous Document Tab',
      category: 'View',
      icon: 'chevron-left',
      shortcut: 'Mod+Shift+Tab',
      when: hasDocument,
      run: (ctx) => docs(ctx).previous()?.id ?? null,
    },
    {
      id: 'app.tabs.activate',
      label: 'Activate tab…',
      category: 'View',
      hidden: true,
      run: (ctx) => {
        const id = ctx.args['id'];
        if (typeof id !== 'string') throw new Error('app.tabs.activate needs { id }');
        docs(ctx).activate(id);
        return docs(ctx).active?.id ?? null;
      },
    },
    {
      id: 'app.tabs.closeOthers',
      label: 'Close Other Tabs',
      category: 'File',
      icon: 'x',
      when: (ctx) => hasDocument(ctx) && docs(ctx).tabs.length > 1,
      run: async (ctx) => {
        const id = typeof ctx.args['id'] === 'string' ? ctx.args['id'] : docs(ctx).active?.id;
        if (!id) return false;
        return docs(ctx).closeOthers(id);
      },
    },
    {
      id: 'app.tabs.closeAll',
      label: 'Close All Tabs',
      category: 'File',
      icon: 'x',
      shortcut: 'Mod+Shift+W',
      when: hasDocument,
      run: (ctx) => docs(ctx).closeAll(),
    },
    {
      id: 'app.tabs.detach',
      label: 'Move Tab to New Window',
      category: 'View',
      icon: 'app-window',
      when: (ctx) => hasDocument(ctx) && hasBridge(),
      description: 'Open the current document in its own window (or drag the tab out)',
      run: (ctx) => {
        const id = typeof ctx.args['id'] === 'string' ? ctx.args['id'] : docs(ctx).active?.id;
        if (!id) return false;
        return ctx.service<TabStripHandle>(SERVICE.tabs).detach(id);
      },
    },
    {
      id: 'app.window.new',
      label: 'New Window',
      category: 'Application',
      icon: 'app-window',
      shortcut: 'Mod+Shift+N',
      when: () => hasBridge(),
      run: async () => {
        await invoke('window:new');
        return invoke('window:count');
      },
    },
    {
      id: 'file.showInFolder',
      label: 'Show in Folder',
      category: 'File',
      icon: 'folder',
      when: (ctx) => hasBridge() && docs(ctx).active?.path !== null && hasDocument(ctx),
      run: async (ctx) => {
        const path = docs(ctx).active?.path;
        if (path) await invoke('shell:showItemInFolder', path);
      },
    },
    // ---- recent ----------------------------------------------------------------------------------
    {
      id: 'file.recent.pin',
      label: 'Pin recent file…',
      category: 'File',
      icon: 'pin',
      hidden: true,
      run: async (ctx) => {
        const path = ctx.args['path'];
        const pinned = ctx.args['pinned'];
        if (typeof path !== 'string' || typeof pinned !== 'boolean')
          throw new Error('file.recent.pin needs { path, pinned }');
        return hasBridge() ? invoke('recent:pin', path, pinned) : [];
      },
    },
    {
      id: 'file.recent.remove',
      label: 'Remove from recent files…',
      category: 'File',
      icon: 'x',
      hidden: true,
      run: async (ctx) => {
        const path = ctx.args['path'];
        if (typeof path !== 'string') throw new Error('file.recent.remove needs { path }');
        return hasBridge() ? invoke('recent:remove', path) : [];
      },
    },
    {
      id: 'file.recent.clear',
      label: 'Clear Recent Files',
      category: 'File',
      icon: 'trash-2',
      description: 'Remove every unpinned file from the Recent list',
      run: async (ctx) => {
        const ok = await ctx.service<Dialogs>(SERVICE.dialogs).confirm({
          title: 'Clear recent files',
          text: 'Remove every unpinned file from the Recent list? Pinned files stay.',
          confirmLabel: 'Clear',
          kind: 'question',
        });
        if (!ok) return null;
        return hasBridge() ? invoke('recent:clear') : [];
      },
    },
    // ---- focus / keyboard -------------------------------------------------------------------------
    {
      id: 'app.focus.nextRegion',
      label: 'Next Region',
      category: 'Application',
      icon: 'arrow-right',
      shortcut: 'F6',
      description:
        'Move keyboard focus: ribbon → document → navigation pane → properties → status bar',
      run: (ctx) => {
        ctx.service<FocusService>(SERVICE.focus).cycle(1);
        return ui(ctx).get().region;
      },
    },
    {
      id: 'app.focus.previousRegion',
      label: 'Previous Region',
      category: 'Application',
      icon: 'arrow-left',
      shortcut: 'Shift+F6',
      run: (ctx) => {
        ctx.service<FocusService>(SERVICE.focus).cycle(-1);
        return ui(ctx).get().region;
      },
    },
    {
      id: 'app.contextMenu',
      label: 'Open Context Menu',
      category: 'Application',
      icon: 'menu',
      description:
        'Open the right-click menu for the focused element (Shift+F10 or the Menu key also work)',
      run: (ctx) => {
        const opened = ctx
          .service<{ open(o: { target: Element | null }): unknown }>(SERVICE.contextMenu)
          .open({
            target: document.activeElement,
          });
        return opened !== null;
      },
    },
    // ---- tools -------------------------------------------------------------------------------------
    {
      id: 'tool.none',
      label: 'Deactivate Tool',
      category: 'Edit',
      icon: 'mouse-pointer',
      shortcut: 'Escape',
      when: (ctx) => ui(ctx).get().activeTool !== null,
      run: (ctx) => {
        ctx.service<ToolsService>(SERVICE.tools).deactivate();
      },
    },
    // ---- view state (status bar) -------------------------------------------------------------------
    {
      id: 'view.page.goTo',
      label: 'Go to Page…',
      category: 'View',
      icon: 'file-search',
      shortcut: 'Mod+G',
      description: 'Jump to a page number (pass { page }, 1-based; without it a prompt opens)',
      when: (ctx) => ui(ctx).get().view.pageCount > 0,
      run: async (ctx) => {
        const { pageCount, page: current } = ui(ctx).get().view;
        let page = ctx.args['page'];
        if (typeof page !== 'number') {
          const text = await ctx.service<Dialogs>(SERVICE.dialogs).prompt({
            title: 'Go to page',
            label: `Page number (1–${pageCount})`,
            value: String(current),
            okLabel: 'Go',
            validate: (v) =>
              parsePageInput(v, pageCount) === null
                ? `Enter a number between 1 and ${pageCount}.`
                : null,
            id: 'goto-page-dialog',
          });
          if (text === null) return null;
          page = parsePageInput(text, pageCount);
        }
        if (typeof page !== 'number' || page < 1 || page > pageCount)
          throw new Error(`Page must be 1–${pageCount}`);
        return setView(ctx, { page }).page;
      },
    },
    {
      id: 'view.page.next',
      label: 'Next Page',
      category: 'View',
      icon: 'chevron-right',
      when: (ctx) => ui(ctx).get().view.page < ui(ctx).get().view.pageCount,
      run: (ctx) => setView(ctx, { page: ui(ctx).get().view.page + 1 }).page,
    },
    {
      id: 'view.page.previous',
      label: 'Previous Page',
      category: 'View',
      icon: 'chevron-left',
      when: (ctx) => ui(ctx).get().view.page > 1,
      run: (ctx) => setView(ctx, { page: ui(ctx).get().view.page - 1 }).page,
    },
    {
      id: 'view.page.first',
      label: 'First Page',
      category: 'View',
      icon: 'chevron-first',
      when: (ctx) => ui(ctx).get().view.page > 1,
      run: (ctx) => setView(ctx, { page: 1 }).page,
    },
    {
      id: 'view.page.last',
      label: 'Last Page',
      category: 'View',
      icon: 'chevron-last',
      when: (ctx) => ui(ctx).get().view.page < ui(ctx).get().view.pageCount,
      run: (ctx) => setView(ctx, { page: ui(ctx).get().view.pageCount }).page,
    },
    {
      id: 'view.zoom.set',
      label: 'Set Zoom…',
      category: 'View',
      icon: 'search',
      description:
        'Zoom in percent (pass { percent }) or a fit mode (pass { fit: "page" | "width" })',
      run: (ctx) => {
        const percent = ctx.args['percent'];
        const fit = ctx.args['fit'];
        if (fit === 'page' || fit === 'width')
          return setView(ctx, { fit, zoom: ui(ctx).get().view.zoom });
        if (typeof percent === 'number')
          return setView(ctx, { zoom: clampZoom(percent), fit: null });
        if (typeof ctx.args['value'] === 'string') {
          const parsed = parseZoomInput(ctx.args['value']);
          if (!parsed) throw new Error(`Cannot read zoom "${ctx.args['value']}"`);
          return setView(ctx, parsed);
        }
        throw new Error('view.zoom.set needs { percent } or { fit }');
      },
    },
    {
      id: 'view.zoom.in',
      label: 'Zoom In',
      category: 'View',
      icon: 'zoom-in',
      shortcut: 'Mod+=',
      when: (ctx) => ui(ctx).get().view.zoom < ZOOM_MAX,
      run: (ctx) => setView(ctx, { zoom: stepZoom(ui(ctx).get().view.zoom, 1), fit: null }).zoom,
    },
    {
      id: 'view.zoom.out',
      label: 'Zoom Out',
      category: 'View',
      icon: 'zoom-out',
      shortcut: 'Mod+-',
      when: (ctx) => ui(ctx).get().view.zoom > ZOOM_MIN,
      run: (ctx) => setView(ctx, { zoom: stepZoom(ui(ctx).get().view.zoom, -1), fit: null }).zoom,
    },
    {
      id: 'view.zoom.actual',
      label: 'Actual Size (100 %)',
      category: 'View',
      icon: 'maximize',
      shortcut: 'Mod+0',
      run: (ctx) => setView(ctx, { zoom: 100, fit: null }).zoom,
    },
    {
      id: 'view.zoom.fitPage',
      label: 'Fit Page',
      category: 'View',
      icon: 'rectangle-vertical',
      shortcut: 'Mod+1',
      run: (ctx) => setView(ctx, { fit: 'page' }).fit,
    },
    {
      id: 'view.zoom.fitWidth',
      label: 'Fit Width',
      category: 'View',
      icon: 'rectangle-horizontal',
      shortcut: 'Mod+2',
      run: (ctx) => setView(ctx, { fit: 'width' }).fit,
    },
    {
      id: 'view.layout.set',
      label: 'Set Layout…',
      category: 'View',
      icon: 'layout-grid',
      description: 'Page layout (pass { layout: single | continuous | facing | book })',
      run: (ctx) => {
        const layout = ctx.args['layout'];
        if (!isLayout(layout))
          throw new Error('view.layout.set needs { layout: single | continuous | facing | book }');
        return setView(ctx, { layout }).layout;
      },
    },
    ...layoutCommands,
    {
      id: 'view.state',
      label: 'View state',
      category: 'View',
      hidden: true,
      description: 'Internal: reports page, zoom and layout',
      run: (ctx) => ui(ctx).get().view,
    },
    {
      id: 'view.setPageCount',
      label: 'Set page count',
      category: 'View',
      hidden: true,
      description:
        'Internal: M11 / tests set the page count of the active document (pass { count, page? })',
      run: (ctx) => {
        const count = ctx.args['count'];
        if (typeof count !== 'number') throw new Error('view.setPageCount needs { count }');
        const page = typeof ctx.args['page'] === 'number' ? ctx.args['page'] : count > 0 ? 1 : 0;
        return setView(ctx, {
          pageCount: count,
          page: Math.min(Math.max(page, count > 0 ? 1 : 0), count),
        });
      },
    },
    // ---- notifications / dialogs (for modules and tests) ---------------------------------------------
    {
      id: 'app.notify',
      label: 'Show notification…',
      category: 'Application',
      hidden: true,
      description: 'Internal: show a toast (pass { kind, text, title? })',
      run: (ctx) => {
        const text = ctx.args['text'];
        if (typeof text !== 'string') throw new Error('app.notify needs { text }');
        const kind = ctx.args['kind'];
        const opts: ToastOptions = {
          text,
          ...(typeof kind === 'string' ? { kind: kind as MessageKind } : {}),
          ...(typeof ctx.args['title'] === 'string' ? { title: ctx.args['title'] } : {}),
          ...(typeof ctx.args['timeout'] === 'number' ? { timeout: ctx.args['timeout'] } : {}),
          ...(typeof ctx.args['id'] === 'string' ? { id: ctx.args['id'] } : {}),
        };
        ctx.service<Toasts>(SERVICE.toasts).show(opts);
        return true;
      },
    },
    {
      id: 'app.message',
      label: 'Show message…',
      category: 'Application',
      hidden: true,
      description: 'Internal: open a message box (pass { kind, title, text })',
      run: (ctx) => {
        const { kind, title, text } = ctx.args;
        if (typeof title !== 'string' || typeof text !== 'string')
          throw new Error('app.message needs { title, text }');
        const k = typeof kind === 'string' ? (kind as 'info' | 'warning' | 'error') : 'info';
        void ctx
          .service<Dialogs>(SERVICE.dialogs)
          .message({ kind: k, title, text, id: 'app-message-dialog' });
        return true;
      },
    },
    {
      id: 'app.ui.state',
      label: 'UI state',
      category: 'Application',
      hidden: true,
      description: 'Internal: the shell state (tests)',
      run: (ctx) => {
        const s = ui(ctx).get();
        return {
          ribbon: s.ribbon,
          qat: s.qat,
          leftPane: s.leftPane,
          rightPane: s.rightPane,
          backstage: s.backstage,
          activeTool: s.activeTool,
          keyTips: s.keyTips,
          region: s.region,
          tabs: docs(ctx).tabs,
          activeTab: docs(ctx).active?.id ?? null,
        };
      },
    },
  ],
  shortcuts: [
    { key: 'Mod+Plus', command: 'view.zoom.in' },
    { key: 'Mod+Minus', command: 'view.zoom.out' },
  ],
  ribbon: [
    {
      id: 'view.panes',
      tab: 'view',
      label: 'Panes',
      order: 20,
      items: [
        {
          kind: 'toggle',
          command: 'view.pane.left.toggle',
          pressed: (ctx) => !ctx.service<PanelsService>(SERVICE.panels).collapsed,
          size: 'large',
        },
        {
          kind: 'toggle',
          command: 'view.pane.right.toggle',
          pressed: (ctx) => ui(ctx).get().rightPane.visible,
          size: 'large',
        },
        '-',
        {
          kind: 'toggle',
          command: 'app.ribbon.toggleMinimised',
          pressed: (ctx) => ui(ctx).get().ribbon.minimised,
        },
      ],
    },
    {
      id: 'view.layout',
      tab: 'view',
      label: 'Page layout',
      order: 30,
      items: LAYOUT_MODES.map((m) => ({
        kind: 'toggle' as const,
        command: `view.layout.${m.id}`,
        pressed: (ctx: ServiceContext) => ui(ctx).get().view.layout === m.id,
      })),
    },
    {
      id: 'view.zoom',
      tab: 'view',
      label: 'Zoom',
      order: 40,
      items: [
        'view.zoom.in',
        'view.zoom.out',
        '-',
        'view.zoom.actual',
        'view.zoom.fitPage',
        'view.zoom.fitWidth',
        {
          kind: 'input',
          id: 'view.zoom.field',
          label: 'Zoom',
          command: 'view.zoom.set',
          type: 'select',
          value: (ctx) =>
            ui(ctx).get().view.fit
              ? `fit-${ui(ctx).get().view.fit ?? ''}`
              : String(ui(ctx).get().view.zoom),
          options: [
            ...[25, 50, 75, 100, 125, 150, 200, 300, 400].map((z) => ({
              value: String(z),
              label: `${z}%`,
            })),
            { value: 'fit-page', label: 'Fit page' },
            { value: 'fit-width', label: 'Fit width' },
          ],
        },
      ],
      large: ['view.zoom.in', 'view.zoom.out'],
    },
    {
      id: 'help.about',
      tab: 'help',
      label: 'About',
      order: 100,
      items: ['app.about', 'app.commandPalette', 'app.keyTips'],
      large: ['app.about'],
    },
  ],
  statusBar: [
    {
      id: 'shell.page',
      slot: 'left',
      order: 10,
      mount: (host, ctx) => {
        const store = ui(ctx);
        const wrap = el('div.status-field.status-page');
        const prev = button(
          'icon-btn',
          {
            'aria-label': 'Previous page',
            title: 'Previous page',
            'data-command': 'view.page.previous',
          },
          icon('chevron-left'),
        );
        prev.addEventListener('click', () => void ctx.run('view.page.previous'));
        const input = el('input', {
          type: 'text',
          id: 'status-page-input',
          'aria-label': 'Current page',
          inputmode: 'numeric',
        });
        const of = el('span', { id: 'status-page-count' });
        const next = button(
          'icon-btn',
          { 'aria-label': 'Next page', title: 'Next page', 'data-command': 'view.page.next' },
          icon('chevron-right'),
        );
        next.addEventListener('click', () => void ctx.run('view.page.next'));
        wrap.append(prev, el('label', { for: 'status-page-input' }, 'Page'), input, of, next);
        host.append(wrap);
        const commit = (): void => {
          const page = parsePageInput(input.value, store.get().view.pageCount);
          if (page === null) {
            input.value = String(store.get().view.page);
            return;
          }
          void ctx.run('view.page.goTo', { page });
        };
        input.addEventListener('change', commit);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            input.blur();
          }
        });
        return store.select(
          (s) => s.view,
          (v) => {
            const none = v.pageCount === 0;
            wrap.hidden = none;
            if (document.activeElement !== input) input.value = none ? '' : String(v.page);
            of.textContent = none ? '' : `of ${v.pageCount}`;
            prev.disabled = v.page <= 1;
            next.disabled = v.page >= v.pageCount;
          },
        );
      },
    },
    {
      id: 'shell.zoom',
      slot: 'centre',
      order: 10,
      mount: (host, ctx) => {
        const store = ui(ctx);
        const wrap = el('div.status-field.status-zoom');
        const out = button(
          'icon-btn',
          { 'aria-label': 'Zoom out', title: 'Zoom out', 'data-command': 'view.zoom.out' },
          icon('zoom-out'),
        );
        out.addEventListener('click', () => void ctx.run('view.zoom.out'));
        const slider = el('input', {
          type: 'range',
          id: 'status-zoom-slider',
          min: ZOOM_MIN,
          max: 400,
          step: 1,
          'aria-label': 'Zoom slider',
        });
        const inp = button(
          'icon-btn',
          { 'aria-label': 'Zoom in', title: 'Zoom in', 'data-command': 'view.zoom.in' },
          icon('zoom-in'),
        );
        inp.addEventListener('click', () => void ctx.run('view.zoom.in'));
        const field = el('input', {
          type: 'text',
          id: 'status-zoom-input',
          'aria-label': 'Zoom level',
          class: 'status-zoom-input',
        });
        const fitPage = button(
          'icon-btn',
          { 'aria-label': 'Fit page', title: 'Fit page', 'data-command': 'view.zoom.fitPage' },
          icon('rectangle-vertical'),
        );
        fitPage.addEventListener('click', () => void ctx.run('view.zoom.fitPage'));
        const fitWidth = button(
          'icon-btn',
          { 'aria-label': 'Fit width', title: 'Fit width', 'data-command': 'view.zoom.fitWidth' },
          icon('rectangle-horizontal'),
        );
        fitWidth.addEventListener('click', () => void ctx.run('view.zoom.fitWidth'));
        wrap.append(
          out,
          slider,
          inp,
          el('label', { for: 'status-zoom-input' }, 'Zoom'),
          field,
          fitPage,
          fitWidth,
        );
        host.append(wrap);
        slider.addEventListener('input', () => {
          void ctx.run('view.zoom.set', { percent: Number(slider.value) });
        });
        const commit = (): void => {
          const parsed = parseZoomInput(field.value);
          if (!parsed) {
            field.value = formatZoom(store.get().view);
            return;
          }
          void ctx.run(
            'view.zoom.set',
            parsed.fit ? { fit: parsed.fit } : { percent: parsed.zoom },
          );
        };
        field.addEventListener('change', commit);
        field.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            field.blur();
          }
        });
        return store.select(
          (s) => s.view,
          (v) => {
            if (document.activeElement !== field) field.value = formatZoom(v);
            if (document.activeElement !== slider) slider.value = String(Math.min(400, v.zoom));
            fitPage.setAttribute('aria-pressed', v.fit === 'page' ? 'true' : 'false');
            fitWidth.setAttribute('aria-pressed', v.fit === 'width' ? 'true' : 'false');
          },
        );
      },
    },
    {
      id: 'shell.layout',
      slot: 'right',
      order: 10,
      mount: (host, ctx) => {
        const store = ui(ctx);
        const group = el('div.status-group', {
          role: 'radiogroup',
          'aria-label': 'Page layout',
          id: 'status-layout',
        });
        const buttons = LAYOUT_MODES.map((m) => {
          const b = button('icon-btn', {
            role: 'radio',
            'aria-checked': 'false',
            'aria-label': m.label,
            title: m.label,
            'data-layout': m.id,
          });
          b.append(icon(m.icon), srOnly(m.label));
          b.addEventListener('click', () => void ctx.run('view.layout.set', { layout: m.id }));
          group.append(b);
          return b;
        });
        host.append(group);
        return store.select(
          (s) => s.view.layout,
          (layout) => {
            for (const b of buttons)
              b.setAttribute('aria-checked', b.dataset['layout'] === layout ? 'true' : 'false');
          },
        );
      },
    },
  ],
  backstage: shellBackstagePages(),
  contextMenus: [
    {
      id: 'shell.tab',
      region: 'tab',
      order: 10,
      items: [
        { label: 'Close', command: 'file.close' },
        { label: 'Close others', command: 'app.tabs.closeOthers' },
        { label: 'Close all', command: 'app.tabs.closeAll' },
        '-',
        { label: 'Move to new window', command: 'app.tabs.detach' },
        { label: 'Show in folder', command: 'file.showInFolder' },
      ],
    },
    {
      id: 'shell.ribbon',
      region: 'ribbon',
      order: 10,
      items: [
        {
          label: 'Minimise the ribbon',
          command: 'app.ribbon.toggleMinimised',
          checked: (ctx) => ui(ctx).get().ribbon.minimised,
        },
        { label: 'Show key tips', command: 'app.keyTips' },
      ],
    },
    {
      id: 'shell.document',
      region: 'document',
      order: 10,
      items: [
        { label: 'Open…', command: 'file.open' },
        '-',
        { label: 'Zoom in', command: 'view.zoom.in' },
        { label: 'Zoom out', command: 'view.zoom.out' },
        { label: 'Fit page', command: 'view.zoom.fitPage' },
        { label: 'Fit width', command: 'view.zoom.fitWidth' },
        '-',
        {
          label: 'Navigation pane',
          command: 'view.pane.left.toggle',
          checked: (ctx) => !ctx.service<PanelsService>(SERVICE.panels).collapsed,
        },
        {
          label: 'Properties pane',
          command: 'view.pane.right.toggle',
          checked: (ctx) => ui(ctx).get().rightPane.visible,
        },
      ],
    },
  ],
  settings: {
    namespace: 'ui',
    properties: {
      'ribbon.minimised': { type: 'boolean', title: 'Minimise the ribbon', default: false },
      'view.layout': {
        type: 'enum',
        title: 'Default page layout',
        default: 'continuous',
        options: LAYOUT_MODES.map((m) => ({ value: m.id, label: m.label })),
      },
    },
  },
});
