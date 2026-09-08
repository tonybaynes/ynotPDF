/**
 * M11 manifest — the viewer's commands, View ribbon groups, tools and shortcuts.
 *
 * The page, zoom and layout commands were registered by M02 (they write `ui.view`); this module
 * makes them mean something by subscribing to that slice, and adds the ones M02 could not:
 * rotation, fit visible, marquee and loupe, rulers/grid/guides, rendering options, split view,
 * full screen, reading mode, auto-scroll and navigation history.
 *
 * Everything a reader can do is a registered command, so it appears in the command palette and
 * the e2e suite can drive it — including the developer probes at the bottom, which is how the
 * acceptance tests read the perf HUD and the layout table out of the running app.
 */

import { RotateCw } from 'lucide';
import { registerIcon } from '@app/icons';
import type { ShellServices } from '@app/services';
import { SERVICE } from '@app/services';
import type { Registry } from '@core/Registry';
import type { EngineClient } from '@engine/EngineClient';
import { hasBridge, type OpenedFile } from '@shared/ipc';
import { defineModule, type CommandSpec, type ServiceContext } from '@shared/module';
import { LAYOUT_MODES, type LayoutMode } from '@view/layout';
import { UNITS, type Unit } from '@view/units';
import { zoomToRect } from '@view/zoom';
import { ViewerService, VIEWER_SERVICE } from './ViewerService';
import type { Viewer } from './Viewer';
import { VIEWER_SETTINGS_SCHEMA, type ViewerSettings } from './settings';
import { viewerTools } from './tools';

export { ViewerService, VIEWER_SERVICE } from './ViewerService';
export type { Viewer } from './Viewer';

const service = (ctx: ServiceContext): ViewerService => ctx.service<ViewerService>(VIEWER_SERVICE);

/**
 * The tools are declared on the manifest, which the Registry reads *before* `activate` builds
 * the service — so they reach the active viewer through this reference rather than a captured
 * one. (Handing `viewerTools` a `() => null` here is exactly the bug that made every tool a
 * silent no-op: the shell hands the *manifest's* specs to the page layers.)
 */
let live: ViewerService | null = null;
const activeViewer = (): Viewer | null => live?.active ?? null;

const hasViewer = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(VIEWER_SERVICE);

/** The viewer of the active tab, or a clear error — these commands are gated on `when`. */
function viewer(ctx: ServiceContext): Viewer {
  const v = hasViewer(ctx) ? service(ctx).active : null;
  if (!v) throw new Error('No document is open');
  return v;
}

const open = (ctx: ServiceContext): boolean => hasViewer(ctx) && service(ctx).active !== null;

function booleanArg(args: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** A toggle command for one boolean setting, so every rendering option is in the palette. */
function settingToggle(spec: {
  id: string;
  label: string;
  setting: keyof ViewerSettings;
  icon?: string;
  description: string;
  shortcut?: string;
}): CommandSpec {
  return {
    id: spec.id,
    label: spec.label,
    category: 'View',
    ...(spec.icon !== undefined ? { icon: spec.icon } : {}),
    ...(spec.shortcut !== undefined ? { shortcut: spec.shortcut } : {}),
    description: spec.description,
    when: hasViewer,
    run: async (ctx) => {
      const s = service(ctx);
      const current = s.settings[spec.setting] as boolean;
      const next = booleanArg(ctx.args, 'on') ?? !current;
      await s.setSetting(spec.setting, next);
      return next;
    },
  };
}

const RENDER_TOGGLES: ReadonlyArray<CommandSpec> = [
  settingToggle({
    id: 'view.lineWeights.toggle',
    label: 'Line Weights',
    setting: 'lineWeights',
    icon: 'pen-tool',
    description: 'Draw strokes at their true widths; off makes every line a hairline',
  }),
  settingToggle({
    id: 'view.render.smoothText',
    label: 'Smooth Text',
    setting: 'smoothText',
    icon: 'type',
    description: 'Anti-alias text on the page',
  }),
  settingToggle({
    id: 'view.render.smoothImages',
    label: 'Smooth Images',
    setting: 'smoothImages',
    icon: 'image',
    description: 'Anti-alias images on the page',
  }),
  settingToggle({
    id: 'view.render.smoothPaths',
    label: 'Smooth Line Art',
    setting: 'smoothPaths',
    icon: 'pencil',
    description: 'Anti-alias vector line art on the page',
  }),
  settingToggle({
    id: 'view.render.greyscale',
    label: 'Greyscale Pages',
    setting: 'grayscale',
    icon: 'contrast',
    description: 'Render pages in greyscale',
  }),
  settingToggle({
    id: 'view.night.keepImages',
    label: 'Night Mode Keeps Photographs',
    setting: 'nightKeepImages',
    icon: 'image',
    description: 'Leave image objects as they are when Night Mode darkens the page',
  }),
  settingToggle({
    id: 'view.grid.snap',
    label: 'Snap to Grid',
    setting: 'snapToGrid',
    icon: 'grid-2x2',
    description: 'Tools snap their points to the grid',
  }),
  settingToggle({
    id: 'view.restorePosition',
    label: 'Reopen Documents Where I Left Them',
    setting: 'restorePosition',
    icon: 'history',
    description: 'Remember each document’s page, zoom and guides between sessions',
  }),
];

export default defineModule({
  id: 'M11',
  name: 'Viewer',

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(VIEWER_SERVICE)) return undefined;
    registerIcon('rotate-cw', RotateCw);
    const shell = registry.service<ShellServices>('shellServices');
    const host = document.getElementById('doc-host');
    if (!host) return undefined;
    const client = registry.service<EngineClient>('engineClient');
    const viewerService = new ViewerService({ registry, shell, host, client });
    live = viewerService;
    registry.provide(VIEWER_SERVICE, viewerService);
    const stopStore = viewerService.install();
    void viewerService.load();

    // The Hand tool is the default, as in Foxit: pointing at a page never changes it.
    queueMicrotask(() => {
      if (!shell.ui.get().activeTool) {
        try {
          registry.service<{ activate(id: string): void }>(SERVICE.tools).activate('tool.hand');
        } catch {
          // The tools service only exists once the shell has mounted; harmless in unit tests.
        }
      }
    });

    return () => {
      live = null;
      stopStore();
      viewerService.dispose();
    };
  },

  tools: viewerTools(activeViewer),

  settings: VIEWER_SETTINGS_SCHEMA,

  commands: [
    // ---- opening -------------------------------------------------------------------------------
    {
      id: 'view.openFile',
      label: 'Open in the viewer',
      category: 'View',
      hidden: true,
      description:
        'Internal: M00’s file.openBytes hands the bytes here so they become a real document',
      when: hasViewer,
      run: async (ctx) => {
        const file = ctx.args['file'] as OpenedFile | undefined;
        if (!file) throw new Error('view.openFile needs { file }');
        // The e2e bridge structured-clones a plain array; IPC and drag-drop send real bytes.
        const bytes = toBytes(file.bytes);
        if (!bytes) throw new Error('view.openFile needs { file: { bytes } }');
        const tab = await service(ctx).open({ ...file, bytes });
        return tab ? { id: tab.id, title: tab.title } : null;
      },
    },

    // ---- rotation ------------------------------------------------------------------------------
    {
      id: 'view.rotate.clockwise',
      label: 'Rotate View Clockwise',
      category: 'View',
      icon: 'rotate-cw',
      shortcut: 'Mod+Shift+Plus',
      description: 'Turn the page view 90° clockwise. The document is not changed.',
      when: open,
      run: (ctx) => viewer(ctx).rotateBy(1),
    },
    {
      id: 'view.rotate.anticlockwise',
      label: 'Rotate View Anticlockwise',
      category: 'View',
      icon: 'rotate-ccw',
      shortcut: 'Mod+Shift+Minus',
      description: 'Turn the page view 90° anticlockwise. The document is not changed.',
      when: open,
      run: (ctx) => viewer(ctx).rotateBy(-1),
    },
    {
      id: 'view.rotate.set',
      label: 'Set View Rotation…',
      category: 'View',
      icon: 'rotate-cw',
      hidden: true,
      description: 'Internal: set the view rotation (pass { rotation: 0 | 90 | 180 | 270 })',
      when: open,
      run: (ctx) => {
        const rotation = ctx.args['rotation'];
        if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
          throw new Error('view.rotate.set needs { rotation: 0 | 90 | 180 | 270 }');
        }
        viewer(ctx).setRotation(rotation);
        return rotation;
      },
    },
    {
      id: 'view.rotate.reset',
      label: 'Reset View Rotation',
      category: 'View',
      icon: 'refresh-cw',
      when: (ctx) => open(ctx) && service(ctx).active?.state.rotation !== 0,
      run: (ctx) => {
        viewer(ctx).setRotation(0);
        return 0;
      },
    },

    // ---- zoom that M02 did not cover -------------------------------------------------------------
    {
      id: 'view.zoom.fitVisible',
      label: 'Fit Visible',
      category: 'View',
      icon: 'expand',
      shortcut: 'Mod+3',
      description: 'Zoom so the page’s content fills the width of the window',
      when: open,
      run: (ctx) => {
        viewer(ctx).setFit('visible');
        return 'visible';
      },
    },
    {
      id: 'view.zoom.toSelection',
      label: 'Zoom to Rectangle…',
      category: 'View',
      icon: 'square-dashed',
      hidden: true,
      description: 'Internal: zoom to a content rectangle (pass { x, y, width, height })',
      when: open,
      run: (ctx) => {
        const numbers = ['x', 'y', 'width', 'height'].map((k) => ctx.args[k]);
        if (!numbers.every((n): n is number => typeof n === 'number')) {
          throw new Error('view.zoom.toSelection needs { x, y, width, height }');
        }
        const [x, y, width, height] = numbers as [number, number, number, number];
        const v = viewer(ctx);
        const scroller = v.pane.scroller;
        const result = zoomToRect({ x, y, width, height }, v.pane.zoom, {
          width: scroller.clientWidth,
          height: scroller.clientHeight,
        });
        v.pane.setZoom(result.zoom);
        v.pane.setScroll(result.scroll);
        v.syncOverlays();
        return result.zoom;
      },
    },

    // ---- navigation history -----------------------------------------------------------------------
    {
      id: 'view.history.back',
      label: 'Previous View',
      category: 'View',
      icon: 'arrow-left',
      shortcut: 'Alt+ArrowLeft',
      description: 'Back to where you were before the last jump',
      when: (ctx) => open(ctx) && (service(ctx).active?.history.canGoBack ?? false),
      run: (ctx) => viewer(ctx).back(),
    },
    {
      id: 'view.history.forward',
      label: 'Next View',
      category: 'View',
      icon: 'arrow-right',
      shortcut: 'Alt+ArrowRight',
      description: 'Forward again after a Previous View',
      when: (ctx) => open(ctx) && (service(ctx).active?.history.canGoForward ?? false),
      run: (ctx) => viewer(ctx).forward(),
    },

    // ---- rulers, grid, guides ----------------------------------------------------------------------
    {
      id: 'view.rulers.toggle',
      label: 'Rulers',
      category: 'View',
      icon: 'ruler',
      shortcut: 'Mod+R',
      description: 'Show rulers along the top and left edges; drag from one to make a guide',
      when: hasViewer,
      run: async (ctx) => {
        const s = service(ctx);
        const next = booleanArg(ctx.args, 'on') ?? !s.settings.rulers;
        await s.setSetting('rulers', next);
        return next;
      },
    },
    {
      id: 'view.rulers.units',
      label: 'Ruler Units…',
      category: 'View',
      icon: 'ruler',
      description: 'Ruler and coordinate units (pass { unit: pt | mm | cm | in })',
      when: hasViewer,
      run: async (ctx) => {
        const unit = ctx.args['unit'];
        const s = service(ctx);
        if (!UNITS.some((u) => u.id === unit)) {
          throw new Error('view.rulers.units needs { unit: pt | mm | cm | in }');
        }
        await s.setSetting('rulerUnits', unit as Unit);
        return unit;
      },
    },
    {
      id: 'view.grid.toggle',
      label: 'Grid',
      category: 'View',
      icon: 'grid-2x2',
      shortcut: 'Mod+U',
      description: 'Show the layout grid over each page',
      when: hasViewer,
      run: async (ctx) => {
        const s = service(ctx);
        const next = booleanArg(ctx.args, 'on') ?? !s.settings.grid;
        await s.setSetting('grid', next);
        return next;
      },
    },
    {
      id: 'view.grid.spacing',
      label: 'Grid Spacing…',
      category: 'View',
      icon: 'grid-2x2',
      description: 'Grid spacing in points (pass { points })',
      when: hasViewer,
      run: async (ctx) => {
        const points = ctx.args['points'];
        if (typeof points !== 'number' || !(points > 0)) {
          throw new Error('view.grid.spacing needs { points } greater than zero');
        }
        await service(ctx).setSetting('gridSpacing', points);
        return points;
      },
    },
    {
      id: 'view.guides.toggle',
      label: 'Guides',
      category: 'View',
      icon: 'move',
      description: 'Show the guides dragged out of the rulers',
      when: hasViewer,
      run: async (ctx) => {
        const s = service(ctx);
        const next = booleanArg(ctx.args, 'on') ?? !s.settings.guides;
        await s.setSetting('guides', next);
        return next;
      },
    },
    {
      id: 'view.guides.add',
      label: 'Add Guide…',
      category: 'View',
      icon: 'move',
      description:
        'Add a guide to a page (pass { page, axis: vertical | horizontal, at } in points)',
      when: open,
      run: (ctx) => {
        const { page, axis, at } = ctx.args as {
          page?: number;
          axis?: 'vertical' | 'horizontal';
          at?: number;
        };
        if (typeof page !== 'number' || typeof at !== 'number') {
          throw new Error('view.guides.add needs { page, axis, at }');
        }
        if (axis !== 'vertical' && axis !== 'horizontal') {
          throw new Error('view.guides.add needs { axis: vertical | horizontal }');
        }
        const v = viewer(ctx);
        const guide = v.guides.add(page, axis, at);
        v.setOverlays({ guides: true });
        v.syncOverlays();
        return guide.id;
      },
    },
    {
      id: 'view.guides.clear',
      label: 'Clear Guides',
      category: 'View',
      icon: 'trash-2',
      description: 'Remove every guide from this document (pass { page } for one page only)',
      when: (ctx) => open(ctx) && (service(ctx).active?.guides.all.length ?? 0) > 0,
      run: (ctx) => {
        const v = viewer(ctx);
        const page = ctx.args['page'];
        const removed = v.guides.clear(typeof page === 'number' ? page : undefined);
        v.syncOverlays();
        return removed;
      },
    },

    // ---- split view ------------------------------------------------------------------------------
    {
      id: 'view.split.vertical',
      label: 'Split Vertically',
      category: 'View',
      icon: 'columns-2',
      description: 'Two views of this document side by side',
      when: open,
      run: (ctx) => {
        const s = service(ctx);
        const next = s.active?.split === 'vertical' ? 'off' : 'vertical';
        s.setSplit(next);
        return next;
      },
    },
    {
      id: 'view.split.horizontal',
      label: 'Split Horizontally',
      category: 'View',
      icon: 'rows-2',
      description: 'Two views of this document, one above the other',
      when: open,
      run: (ctx) => {
        const s = service(ctx);
        const next = s.active?.split === 'horizontal' ? 'off' : 'horizontal';
        s.setSplit(next);
        return next;
      },
    },
    {
      id: 'view.split.off',
      label: 'Remove Split',
      category: 'View',
      icon: 'square',
      when: (ctx) => open(ctx) && service(ctx).active?.split !== 'off',
      run: (ctx) => {
        service(ctx).setSplit('off');
        return 'off';
      },
    },
    {
      id: 'view.split.sync',
      label: 'Synchronise Split Scrolling',
      category: 'View',
      icon: 'link',
      description: 'Scroll both halves of a split view together',
      when: (ctx) => open(ctx) && service(ctx).active?.split !== 'off',
      run: (ctx) => {
        const v = viewer(ctx);
        const next = booleanArg(ctx.args, 'on') ?? !v.synced;
        v.setSyncScroll(next);
        return next;
      },
    },

    // ---- window modes ------------------------------------------------------------------------------
    {
      id: 'view.fullScreen.toggle',
      label: 'Full Screen',
      category: 'View',
      icon: 'fullscreen',
      shortcut: 'F11',
      description: 'Fill the screen. Esc leaves.',
      run: async (ctx) => {
        const on = booleanArg(ctx.args, 'on');
        return await service(ctx).setFullScreen(on);
      },
    },
    {
      id: 'view.readingMode.toggle',
      label: 'Reading Mode',
      category: 'View',
      icon: 'book',
      shortcut: 'Mod+H',
      description: 'Hide the toolbars and read; a small bar keeps the page controls',
      when: hasViewer,
      run: (ctx) => {
        const s = service(ctx);
        const next = booleanArg(ctx.args, 'on') ?? !s.isReadingMode;
        return s.setReadingMode(next);
      },
    },

    // ---- auto-scroll ---------------------------------------------------------------------------------
    {
      id: 'view.autoScroll.toggle',
      label: 'Auto-Scroll',
      category: 'View',
      icon: 'chevron-down',
      shortcut: 'Mod+Shift+H',
      description: 'Scroll steadily down the document; number keys change the speed',
      when: open,
      run: (ctx) => viewer(ctx).toggleAutoScroll(),
    },
    {
      id: 'view.autoScroll.speed',
      label: 'Auto-Scroll Speed…',
      category: 'View',
      icon: 'sliders-horizontal',
      description: 'Auto-scroll speed 1–10 (pass { speed })',
      when: hasViewer,
      run: async (ctx) => {
        const speed = ctx.args['speed'];
        if (typeof speed !== 'number') throw new Error('view.autoScroll.speed needs { speed }');
        const clamped = Math.min(10, Math.max(1, Math.round(speed)));
        await service(ctx).setSetting('autoScrollSpeed', clamped);
        service(ctx).active?.setAutoScrollSpeed(clamped);
        return clamped;
      },
    },
    {
      id: 'view.autoScroll.reverse',
      label: 'Reverse Auto-Scroll',
      category: 'View',
      icon: 'chevron-up',
      when: (ctx) => open(ctx) && (service(ctx).active?.autoScrolling ?? false),
      run: (ctx) => {
        viewer(ctx).reverseAutoScroll();
        return true;
      },
    },

    // ---- loupe ---------------------------------------------------------------------------------------
    {
      id: 'view.loupe.toggle',
      label: 'Loupe',
      category: 'View',
      icon: 'search',
      description: 'A magnifier window that follows the pointer',
      when: open,
      run: (ctx) => viewer(ctx).toggleLoupe(),
    },
    {
      id: 'view.loupe.factor',
      label: 'Loupe Magnification',
      category: 'View',
      icon: 'zoom-in',
      description: 'Cycle the loupe between 2×, 4× and 8×',
      when: (ctx) => open(ctx) && (service(ctx).active?.loupeOpen ?? false),
      run: (ctx) => viewer(ctx).cycleLoupeFactor(),
    },

    // ---- rendering options ----------------------------------------------------------------------------
    ...RENDER_TOGGLES,
    {
      id: 'view.cache.size',
      label: 'Page Cache Size…',
      category: 'View',
      icon: 'cpu',
      description: 'Megabytes of rendered pages to keep in memory (pass { megabytes })',
      when: hasViewer,
      run: async (ctx) => {
        const mb = ctx.args['megabytes'];
        if (typeof mb !== 'number' || mb <= 0) {
          throw new Error('view.cache.size needs { megabytes } greater than zero');
        }
        await service(ctx).setSetting('cacheMegabytes', Math.round(mb));
        return Math.round(mb);
      },
    },

    // ---- developer probes (how the acceptance tests read the viewer) --------------------------------------
    {
      id: 'dev.viewerState',
      label: 'Viewer state',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the active viewport’s state, layout table and settings',
      when: hasViewer,
      run: (ctx) => {
        const s = service(ctx);
        const v = s.active;
        if (!v) return null;
        const table = v.pane.layoutTable;
        return {
          ...v.state,
          split: v.split,
          synced: v.synced,
          readingMode: s.isReadingMode,
          overlays: v.overlays,
          flags: v.renderFlags,
          guides: v.guides.toJSON(),
          history: { back: v.history.canGoBack, forward: v.history.canGoForward },
          mountedPages: table.rects
            .map((r) => r.page)
            .filter((p) => v.pane.pageView(p) !== undefined),
          content: { width: table.width, height: table.height, rows: table.rows.length },
          rects: table.rects.map((r) => ({
            page: r.page,
            x: round(r.x),
            y: round(r.y),
            width: round(r.width),
            height: round(r.height),
          })),
        };
      },
    },
    {
      id: 'dev.viewerPerf',
      label: 'Viewer performance',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the perf HUD’s numbers (pass { reset: true } to start a new window)',
      when: open,
      run: (ctx) => {
        const v = viewer(ctx);
        if (ctx.args['reset'] === true) {
          v.resetPerf();
          return null;
        }
        return v.perfSample();
      },
    },
    {
      id: 'dev.viewerHud',
      label: 'Toggle viewer HUD',
      category: 'Developer',
      hidden: true,
      shortcut: 'Mod+Alt+P',
      when: open,
      run: (ctx) => viewer(ctx).toggleHud(),
    },
    {
      id: 'dev.viewerScroll',
      label: 'Scroll the viewer',
      category: 'Developer',
      hidden: true,
      description: 'Internal: set or nudge the scroll (pass { top, left } or { dy })',
      when: open,
      run: (ctx) => {
        const v = viewer(ctx);
        const dy = ctx.args['dy'];
        if (typeof dy === 'number') v.pane.scrollBy(0, dy);
        else {
          v.pane.setScroll({
            left: typeof ctx.args['left'] === 'number' ? ctx.args['left'] : v.state.scrollLeft,
            top: typeof ctx.args['top'] === 'number' ? ctx.args['top'] : v.state.scrollTop,
          });
        }
        v.syncOverlays();
        return v.state;
      },
    },
    {
      id: 'dev.viewerZoomAt',
      label: 'Zoom about a point',
      category: 'Developer',
      hidden: true,
      description: 'Internal: zoom to { percent } about the viewport point { x, y }',
      when: open,
      run: (ctx) => {
        const { x, y } = ctx.args as { x?: number; y?: number };
        const target = ctx.args['percent'];
        if (typeof x !== 'number' || typeof y !== 'number' || typeof target !== 'number') {
          throw new Error('dev.viewerZoomAt needs { percent, x, y }');
        }
        const v = viewer(ctx);
        const before = v.pane.hitTest(
          v.pane.scroller.getBoundingClientRect().left + x,
          v.pane.scroller.getBoundingClientRect().top + y,
        );
        v.pane.zoomAt(target / 100, x, y);
        v.syncOverlays();
        const after = v.pane.hitTest(
          v.pane.scroller.getBoundingClientRect().left + x,
          v.pane.scroller.getBoundingClientRect().top + y,
        );
        // A point can only be held still if there is scroll left to hold it with: when the whole
        // document fits the window there is nothing to compensate with, and it cannot.
        return {
          before,
          after,
          zoom: v.pane.zoom,
          scrollable: v.pane.scrollRange > 0,
        };
      },
    },
  ],

  shortcuts: [
    { key: 'Mod+Shift+Plus', command: 'view.rotate.clockwise' },
    { key: 'Mod+Shift+Minus', command: 'view.rotate.anticlockwise' },
    { key: 'Mod+Alt+Right', command: 'view.page.next' },
    { key: 'Mod+Alt+Left', command: 'view.page.previous' },
    { key: 'Mod+Home', command: 'view.page.first' },
    { key: 'Mod+End', command: 'view.page.last' },
    { key: 'G', command: 'tool.hand.activate' },
    { key: 'V', command: 'tool.selectText.activate' },
    { key: 'Z', command: 'tool.marqueeZoom.activate' },
  ],

  ribbon: [
    {
      id: 'view.tools',
      tab: 'view',
      label: 'Tools',
      order: 5,
      items: [
        { kind: 'toggle', command: 'tool.hand.activate', pressed: toolIs('tool.hand') },
        { kind: 'toggle', command: 'tool.selectText.activate', pressed: toolIs('tool.selectText') },
        {
          kind: 'toggle',
          command: 'tool.marqueeZoom.activate',
          pressed: toolIs('tool.marqueeZoom'),
        },
        { kind: 'toggle', command: 'view.loupe.toggle', pressed: loupeOpen },
      ],
      large: ['tool.hand.activate'],
    },
    {
      id: 'view.rotate',
      tab: 'view',
      label: 'Rotate view',
      order: 25,
      items: ['view.rotate.anticlockwise', 'view.rotate.clockwise', 'view.rotate.reset'],
    },
    {
      id: 'view.pageDisplay',
      tab: 'view',
      label: 'Page display',
      order: 32,
      items: [
        'view.zoom.fitVisible',
        '-',
        {
          kind: 'dropdown',
          id: 'view.render.options',
          label: 'Rendering',
          icon: 'sliders-horizontal',
          menu: [
            { command: 'view.lineWeights.toggle', checked: setting('lineWeights') },
            { command: 'view.render.smoothText', checked: setting('smoothText') },
            { command: 'view.render.smoothImages', checked: setting('smoothImages') },
            { command: 'view.render.smoothPaths', checked: setting('smoothPaths') },
            '-',
            { command: 'view.render.greyscale', checked: setting('grayscale') },
            { command: 'view.night.keepImages', checked: setting('nightKeepImages') },
          ],
        },
        { kind: 'toggle', command: 'view.autoScroll.toggle', pressed: autoScrolling },
      ],
    },
    {
      id: 'view.assist',
      tab: 'view',
      label: 'Rulers & grids',
      order: 40,
      items: [
        { kind: 'toggle', command: 'view.rulers.toggle', pressed: setting('rulers') },
        { kind: 'toggle', command: 'view.grid.toggle', pressed: setting('grid') },
        { kind: 'toggle', command: 'view.guides.toggle', pressed: setting('guides') },
        { kind: 'toggle', command: 'view.grid.snap', pressed: setting('snapToGrid') },
        {
          kind: 'gallery',
          id: 'view.rulers.unitGallery',
          label: 'Units',
          icon: 'ruler',
          command: 'view.rulers.units',
          options: UNITS.map((u) => ({ value: u.id, label: u.label })),
          selected: (ctx) => (hasViewer(ctx) ? service(ctx).settings.rulerUnits : 'mm'),
        },
      ],
    },
    {
      id: 'view.window',
      tab: 'view',
      label: 'Window',
      order: 50,
      items: [
        { kind: 'toggle', command: 'view.split.vertical', pressed: splitIs('vertical') },
        { kind: 'toggle', command: 'view.split.horizontal', pressed: splitIs('horizontal') },
        { kind: 'toggle', command: 'view.split.sync', pressed: splitSynced },
        '-',
        'view.fullScreen.toggle',
        { kind: 'toggle', command: 'view.readingMode.toggle', pressed: readingMode },
      ],
      large: ['view.fullScreen.toggle', 'view.readingMode.toggle'],
    },
  ],

  contextMenus: [
    {
      id: 'view.pageMenu',
      region: '.viewer-scroll',
      order: 10,
      items: [
        'view.page.previous',
        'view.page.next',
        '-',
        'view.zoom.in',
        'view.zoom.out',
        'view.zoom.fitPage',
        'view.zoom.fitWidth',
        '-',
        'view.rotate.clockwise',
        'view.rotate.anticlockwise',
        '-',
        { label: 'Layout', submenu: LAYOUT_MODES.map((m) => `view.layout.${m}`) },
        '-',
        'view.history.back',
        'view.history.forward',
      ],
    },
  ],
});

// ---- `when` / `pressed` helpers ------------------------------------------------------------------

function toolIs(id: string): (ctx: ServiceContext) => boolean {
  return (ctx) =>
    ctx.service<{ get(): { activeTool: string | null } }>(SERVICE.ui).get().activeTool === id;
}

function setting(name: keyof ViewerSettings): (ctx: ServiceContext) => boolean {
  return (ctx) => (hasViewer(ctx) ? Boolean(service(ctx).settings[name]) : false);
}

function splitIs(orientation: 'vertical' | 'horizontal'): (ctx: ServiceContext) => boolean {
  return (ctx) => (hasViewer(ctx) ? service(ctx).active?.split === orientation : false);
}

function splitSynced(ctx: ServiceContext): boolean {
  return hasViewer(ctx) ? (service(ctx).active?.synced ?? false) : false;
}

function readingMode(ctx: ServiceContext): boolean {
  return hasViewer(ctx) ? service(ctx).isReadingMode : false;
}

function loupeOpen(ctx: ServiceContext): boolean {
  return hasViewer(ctx) ? (service(ctx).active?.loupeOpen ?? false) : false;
}

function autoScrolling(ctx: ServiceContext): boolean {
  return hasViewer(ctx) ? (service(ctx).active?.autoScrolling ?? false) : false;
}

/** Accepts a `Uint8Array`, an `ArrayBuffer` or the plain array the e2e bridge produces. */
function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return null;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Whether the app is running inside Electron (the CLI/file-association path needs it). */
export const inShell = hasBridge;

/** The layout modes this module implements, for tests. */
export const VIEWER_LAYOUTS: ReadonlyArray<LayoutMode> = LAYOUT_MODES;
