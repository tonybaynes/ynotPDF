/**
 * Application shell (M02): mounts the ribbon, document tabs, left navigation pane, document
 * area (empty state / document host / toasts), right properties pane, status bar and the File
 * backstage; creates the shared services (UiState store, Documents, Dialogs, Toasts, context
 * menus, focus regions) and registers them on the Registry by name so module commands reach
 * them through `ctx.service(...)`. The shell knows no features: everything it draws comes from
 * module manifests.
 */

import type { Registry } from '@core/Registry';
import type { Selection } from '@core/Selection';
import { bind, type Store } from '@core/Store';
import type { ToolSpec } from '@shared/module';
import { hasBridge, on, type OpenedFile } from '@shared/ipc';
import { createThemeSwitcher } from '@modules/M01-theme-system/switcher';
import { THEME_SERVICE } from '@modules/M01-theme-system/manifest';
import type { ThemeManager } from '@theme/ThemeManager';
import { mountBackstage, type BackstageHandle } from './backstage/Backstage';
import { ContextMenus } from './contextMenu';
import { Dialogs } from './dialog/Dialogs';
import { Toasts } from './dialog/toast';
import { el } from './dom';
import { mountEmptyState } from './emptyState';
import { cycleRegion, installFocusTracking } from './focus';
import { notePaletteUse } from './palette';
import { mountNavPane, type NavPaneHandle } from './panes/NavPane';
import { mountPropertiesPane, type PropertiesPaneHandle } from './panes/PropertiesPane';
import { closeAllPopups } from './popup';
import { mountRibbon, type RibbonHandle } from './ribbon/Ribbon';
import { SERVICE, type ShellServices } from './services';
import { mountStatusBar, type StatusBarHandle } from './statusbar/StatusBar';
import { Documents } from './tabs/Documents';
import { mountTabStrip, type TabStripHandle } from './tabs/TabStrip';
import {
  createUiStore,
  invalidate,
  ipcUiStorage,
  persistUi,
  type UiStorage,
  type UiStore,
} from './ui/UiState';

/** Legacy M00 shell store, still fed so M00's manifest keeps working. */
export interface ShellState {
  readonly documentTitle: string | null;
  readonly statusMessage: string;
  readonly theme: string;
}

export interface ShellOptions {
  readonly registry: Registry;
  readonly selection: Selection;
  readonly isMac: boolean;
  readonly shellState: Store<ShellState>;
  /** Persistence for pane widths etc.; defaults to the settings IPC. */
  readonly uiStorage?: UiStorage;
}

export interface ToolsService {
  activate(toolId: string): void;
  deactivate(): void;
  readonly active: string | null;
}

export interface FocusService {
  cycle(direction: 1 | -1): void;
}

export interface ShellHandle {
  readonly services: ShellServices;
  readonly ui: UiStore;
  readonly ribbon: RibbonHandle;
  readonly navPane: NavPaneHandle;
  readonly propertiesPane: PropertiesPaneHandle;
  readonly tabStrip: TabStripHandle;
  readonly statusBar: StatusBarHandle;
  readonly backstage: BackstageHandle;
  readonly documents: Documents;
  readonly dialogs: Dialogs;
  readonly toasts: Toasts;
  readonly tools: ToolsService;
  dispose(): void;
}

export async function mountShell(root: HTMLElement, options: ShellOptions): Promise<ShellHandle> {
  const { registry, selection, isMac, shellState } = options;
  const storage = options.uiStorage ?? ipcUiStorage();
  let persisted = {};
  try {
    persisted = await storage.read();
  } catch (error) {
    console.warn('ui: could not read the saved layout', error);
  }
  const ui = createUiStore(persisted);
  const documents = new Documents();
  const dialogs = new Dialogs();
  const toasts = new Toasts();
  const contextMenus = new ContextMenus(registry, isMac);

  const services: ShellServices = {
    registry,
    ui,
    documents,
    dialogs,
    toasts,
    contextMenus,
    selection,
    isMac,
    invalidate: () => {
      invalidate(ui);
    },
    run: async (id, args = {}) => {
      closeAllPopups('select');
      const st = ui.get().ribbon;
      if (st.minimised && st.peek) ui.set({ ribbon: { ...st, peek: false } });
      notePaletteUse(id);
      try {
        return await registry.run(id, args);
      } catch (error) {
        console.error(`command ${id} failed`, error);
        toasts.show({
          kind: 'error',
          title: id,
          text: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    },
  };

  // ---- tools service --------------------------------------------------------------------------
  let activeTool: ToolSpec | null = null;
  const tools: ToolsService = {
    activate: (toolId) => {
      const spec = registry.tools().find((t) => t.id === toolId);
      if (!spec) throw new Error(`Unknown tool: ${toolId}`);
      if (activeTool?.id === toolId) return;
      activeTool?.deactivate?.();
      activeTool = spec;
      ui.set({ activeTool: toolId });
      spec.activate?.(registry.context());
      services.invalidate();
    },
    deactivate: () => {
      activeTool?.deactivate?.();
      activeTool = null;
      ui.set({ activeTool: null });
      services.invalidate();
    },
    get active() {
      return ui.get().activeTool;
    },
  };

  const focus: FocusService = {
    cycle: (direction) => {
      closeAllPopups();
      cycleRegion(ui, direction);
    },
  };

  // Services by name, for `ctx.service(...)` in module commands.
  registry.provide(SERVICE.ui, ui);
  registry.provide(SERVICE.documents, documents);
  registry.provide(SERVICE.dialogs, dialogs);
  registry.provide(SERVICE.toasts, toasts);
  registry.provide(SERVICE.contextMenu, contextMenus);
  registry.provide(SERVICE.tools, tools);
  registry.provide(SERVICE.focus, focus);
  registry.provide('shellServices', services);

  // ---- DOM ----------------------------------------------------------------------------------
  root.replaceChildren();
  const ribbon = mountRibbon(root, services);
  const tabStrip = mountTabStrip(root, services);
  const navPane = mountNavPane(root, services);
  registry.provide(SERVICE.panels, navPane.service);
  const docArea = el('main.doc-area', {
    id: 'doc-area',
    'data-region': 'document',
    tabindex: -1,
    'aria-label': 'Document',
  });
  root.append(docArea);
  const docHost = el('div.doc-host', { id: 'doc-host' });
  docArea.append(docHost);
  const emptyState = mountEmptyState(docArea, services);
  // `documents.subscribe` does not fire on subscription, so seed the host's visibility here:
  // left visible with nothing open it still claims `flex: 1` and eats half the document area.
  docHost.hidden = documents.tabs.length === 0;
  toasts.mount(docArea);
  const propertiesPane = mountPropertiesPane(root, services);
  const statusBar = mountStatusBar(root, services);
  registry.provide(SERVICE.tabs, tabStrip);
  registry.provide(SERVICE.ribbon, ribbon);
  registry.provide(SERVICE.statusBar, statusBar);
  const backstage = mountBackstage(root, services);
  registry.provide(SERVICE.backstage, backstage);

  // M01's theme switcher lives in the status bar's right slot.
  if (registry.hasService(THEME_SERVICE)) {
    const switcher = createThemeSwitcher(registry, registry.service<ThemeManager>(THEME_SERVICE));
    statusBar.element.querySelector('.status-right')?.append(switcher.element);
    registry.service<ThemeManager>(THEME_SERVICE).onChange(() => {
      // UI scale changes every natural width; re-measure the ribbon.
      ribbon.rebuild();
    });
  }

  // ---- wiring ---------------------------------------------------------------------------------
  const disposers: (() => void)[] = [];
  disposers.push(persistUi(ui, storage));
  disposers.push(installFocusTracking(ui));
  disposers.push(contextMenus.install(root));
  disposers.push(
    selection.subscribe(() => {
      services.invalidate();
    }),
  );
  disposers.push(
    documents.subscribe((s) => {
      const active = s.tabs.find((t) => t.id === s.active) ?? null;
      shellState.set({ documentTitle: active ? active.title : null });
      docHost.hidden = s.tabs.length === 0;
      services.invalidate();
    }),
  );
  disposers.push(
    bind(
      shellState,
      (s) => s.statusMessage,
      statusBar.element.querySelector<HTMLElement>('#status-message') ?? statusBar.element,
      'textContent',
    ),
  );
  disposers.push(
    shellState.select(
      (s) => s.documentTitle,
      (t) => {
        document.title = t ? `${t} — ynotPDF` : 'ynotPDF';
      },
    ),
  );
  disposers.push(
    registry.subscribe(() => {
      services.invalidate();
    }),
  );

  // Default close hook: only used while no module (M21) has registered one.
  documents.setDefaultCloseHook(async (tab) => {
    if (!tab.dirty) return 'close';
    const ok = await dialogs.confirm({
      title: 'Close document',
      text: `"${tab.title}" has unsaved changes. Close it without saving?`,
      confirmLabel: 'Close without saving',
      cancelLabel: 'Cancel',
      danger: true,
      kind: 'warning',
      id: 'close-unsaved-dialog',
    });
    return ok ? 'close' : 'cancel';
  });

  // Drop a PDF anywhere on the window to open it. Anything else goes, as one batch, to M91's
  // converters when that module is present (`create.fromDropped`); without it non-PDFs are
  // ignored as they always were.
  root.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  root.addEventListener('drop', (e) => {
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    const pdfs = dropped.filter((f) => /\.pdf$/i.test(f.name));
    const others = dropped.filter((f) => !/\.pdf$/i.test(f.name));
    const convertible = others.length > 0 && registry.has('create.fromDropped');
    if (pdfs.length === 0 && !convertible) return;
    e.preventDefault();
    const read = async (f: File): Promise<OpenedFile> => {
      const withPath = f as File & { path?: string };
      return {
        path: withPath.path ?? f.name,
        name: f.name,
        bytes: new Uint8Array(await f.arrayBuffer()),
      };
    };
    for (const f of pdfs) {
      void read(f).then((file) => services.run('file.openBytes', { file }));
    }
    if (convertible) {
      void Promise.all(others.map(read)).then((files) =>
        services.run('create.fromDropped', {
          files: files.map((f) => ({ ...f, mime: others.find((o) => o.name === f.name)?.type })),
        }),
      );
    }
  });

  if (hasBridge()) {
    disposers.push(
      on('window:focusChanged', ({ focused }) => {
        ui.set((s) => ({ window: { ...s.window, focused } }));
      }),
    );
    disposers.push(
      on('window:stateChanged', (state) => {
        ui.set({ window: state });
      }),
    );
  }

  return {
    services,
    ui,
    ribbon,
    navPane,
    propertiesPane,
    tabStrip,
    statusBar,
    backstage,
    documents,
    dialogs,
    toasts,
    tools,
    dispose: () => {
      for (const d of disposers) d();
      backstage.dispose();
      statusBar.dispose();
      propertiesPane.dispose();
      emptyState.dispose();
      navPane.dispose();
      tabStrip.dispose();
      ribbon.dispose();
      root.replaceChildren();
    },
  };
}
