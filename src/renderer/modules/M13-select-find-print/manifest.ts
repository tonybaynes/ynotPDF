/**
 * M13 manifest — selection, copy, snapshot, find, advanced search and printing.
 *
 * Everything a reader can do here is a registered command, so it is in the palette and the e2e
 * suite drives it by id rather than by pixel. The developer probes at the bottom are how the
 * acceptance tests read the text model, the selection, the find state and the print plan out of
 * the running app.
 */

import { Camera } from 'lucide';
import { registerIcon } from '@app/icons';
import type { ShellServices } from '@app/services';
import type { Registry } from '@core/Registry';
import type { PdfEngine } from '@engine/PdfEngine';
import { defineModule, type CommandSpec, type ServiceContext } from '@shared/module';
import { buildPageText, paragraphSpanAt, wordAt } from '@view/TextLayer';
import { mountSearchPanel } from './find/SearchPanel';
import { writeClipboard } from './selection/clipboard';
import type { FindOptions } from './find/search';
import { SelectFindService, SEARCH_PANEL_ID, SELECT_FIND_SERVICE } from './SelectFindService';
import { DEFAULT_PRINT_SETTINGS, mergePrintSettings, type SelectFindSettings } from './settings';
import { SELECT_FIND_SETTINGS_SCHEMA } from './settings';
import { selectFindTools } from './tools';

export { SelectFindService, SELECT_FIND_SERVICE, SEARCH_PANEL_ID } from './SelectFindService';

/*
 * Registered at module scope, not in `activate`: the ribbon is built when the shell mounts, which
 * is *before* manifests are activated, so an icon registered later paints as a placeholder on the
 * first frame — which `test/e2e/shell.spec.ts` rightly fails on.
 */
registerIcon('camera', Camera);

/**
 * The tools are handed to the Registry before `activate` builds the service, so they reach it
 * through this reference rather than a captured one — the same trap M11 documented.
 */
let live: SelectFindService | null = null;
const lookup = (): SelectFindService | null => live;

const service = (ctx: ServiceContext): SelectFindService =>
  ctx.service<SelectFindService>(SELECT_FIND_SERVICE);

const hasService = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(SELECT_FIND_SERVICE);

/** A document is open. */
const open = (ctx: ServiceContext): boolean =>
  hasService(ctx) && service(ctx).activeSource() !== null;

/** Something is selected. */
const selected = (ctx: ServiceContext): boolean => hasService(ctx) && service(ctx).hasSelection();

/** The focused element is a text field, so the browser's own copy is the right one. */
function inTextField(): HTMLInputElement | HTMLTextAreaElement | null {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(el.type)) {
    return el;
  }
  if (el instanceof HTMLTextAreaElement) return el;
  return null;
}

/** Copies the focused field's selection, so Ctrl+C keeps working inside the find bar. */
async function copyFromField(field: HTMLInputElement | HTMLTextAreaElement): Promise<boolean> {
  const start = field.selectionStart ?? 0;
  const end = field.selectionEnd ?? 0;
  const text = end > start ? field.value.slice(start, end) : field.value;
  if (text.length === 0) return false;
  await writeClipboard({ text });
  return true;
}

/** One palette entry per find option, so every switch is reachable without the mouse. */
function findOptionToggle(spec: {
  id: string;
  label: string;
  option: keyof FindOptions;
  description: string;
}): CommandSpec {
  return {
    id: spec.id,
    label: spec.label,
    category: 'Edit',
    description: spec.description,
    when: hasService,
    run: async (ctx) => {
      const s = service(ctx);
      const current = Boolean(s.findOptions()[spec.option]);
      const next = typeof ctx.args['on'] === 'boolean' ? ctx.args['on'] : !current;
      await s.setFindOption(spec.option, next);
      return next;
    },
  };
}

const FIND_TOGGLES: ReadonlyArray<CommandSpec> = [
  findOptionToggle({
    id: 'edit.find.matchCase',
    label: 'Find: Match Case',
    option: 'matchCase',
    description: 'Distinguish upper case from lower case while searching',
  }),
  findOptionToggle({
    id: 'edit.find.wholeWord',
    label: 'Find: Whole Words Only',
    option: 'wholeWord',
    description: 'Only match a query that stands as a whole word',
  }),
  findOptionToggle({
    id: 'edit.find.regex',
    label: 'Find: Regular Expression',
    option: 'regex',
    description: 'Treat the query as a regular expression',
  }),
  findOptionToggle({
    id: 'edit.find.ignoreDiacritics',
    label: 'Find: Ignore Accents',
    option: 'ignoreDiacritics',
    description: 'Let “e” match “é” and “ê”',
  }),
  findOptionToggle({
    id: 'edit.find.includeBookmarks',
    label: 'Find: Include Bookmarks',
    option: 'includeBookmarks',
    description: 'Search bookmark titles as well as the pages',
  }),
  findOptionToggle({
    id: 'edit.find.includeComments',
    label: 'Find: Include Comments',
    option: 'includeComments',
    description: 'Search annotation text as well as the pages',
  }),
  findOptionToggle({
    id: 'edit.find.includeFormFields',
    label: 'Find: Include Form Values',
    option: 'includeFormFields',
    description: 'Search what has been typed into form fields',
  }),
];

export default defineModule({
  id: 'M13',
  name: 'Select, Find & Print',

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(SELECT_FIND_SERVICE)) return undefined;
    const shell = registry.service<ShellServices>('shellServices');
    const host = document.getElementById('doc-host');
    if (!host) return undefined;
    const engine = registry.service<PdfEngine>('engine');
    const selectFind = new SelectFindService({ registry, shell, engine, host });
    live = selectFind;
    registry.provide(SELECT_FIND_SERVICE, selectFind);
    void selectFind.load();
    return () => {
      live = null;
      selectFind.dispose();
    };
  },

  tools: selectFindTools(lookup),

  settings: SELECT_FIND_SETTINGS_SCHEMA,

  panels: [
    {
      id: SEARCH_PANEL_ID,
      title: 'Search',
      dock: 'left',
      icon: 'file-search',
      order: 60,
      mount: (element, context) => mountSearchPanel(element, service(context).panelHost()),
    },
  ],

  commands: [
    // ---- selection and copy ---------------------------------------------------------------------
    {
      id: 'edit.selectAll',
      label: 'Select All',
      category: 'Edit',
      icon: 'text-cursor-input',
      shortcut: 'Mod+A',
      description: 'Select the text of this page; press again for the whole document',
      when: hasService,
      run: async (ctx) => {
        const field = inTextField();
        if (field) {
          field.select();
          return true;
        }
        await service(ctx).selectAll();
        return service(ctx).hasSelection();
      },
    },
    {
      id: 'edit.deselect',
      label: 'Deselect',
      category: 'Edit',
      description: 'Clear the text selection',
      when: selected,
      run: (ctx) => {
        service(ctx).deselect();
      },
    },
    {
      id: 'edit.copy',
      label: 'Copy',
      category: 'Edit',
      icon: 'copy',
      shortcut: 'Mod+C',
      description: 'Copy the selected text',
      when: (ctx) => hasService(ctx) && (inTextField() !== null || service(ctx).canCopy()),
      run: async (ctx) => {
        const field = inTextField();
        if (field) return await copyFromField(field);
        return await service(ctx).copySelection();
      },
    },
    {
      id: 'edit.copyFormatted',
      permission: 'copy',
      label: 'Copy with Formatting',
      category: 'Edit',
      icon: 'clipboard',
      shortcut: 'Mod+Shift+C',
      description: 'Copy the selection as rich text, keeping fonts, sizes and colours',
      when: selected,
      run: (ctx) => service(ctx).copySelection({ rtf: true }),
    },
    {
      id: 'edit.copyImage',
      permission: 'copy',
      label: 'Copy Image',
      category: 'Edit',
      icon: 'image',
      description: 'Copy the image under the pointer to the clipboard',
      when: open,
      run: (ctx) => {
        // `{ page, x, y }` in page space aims at a picture without a pointer; the menu passes
        // nothing and the last place the pointer went down is used.
        const { page, x, y } = ctx.args as { page?: number; x?: number; y?: number };
        const at =
          typeof page === 'number' && typeof x === 'number' && typeof y === 'number'
            ? { page, x, y }
            : undefined;
        return service(ctx).copyImageUnderPointer(at);
      },
    },
    {
      id: 'edit.copyAsText',
      permission: 'copy',
      label: 'Copy Selection as Plain Text',
      category: 'Edit',
      description: 'Copy the selection with no formatting at all',
      when: selected,
      run: (ctx) => service(ctx).copySelection({ rtf: false }),
    },

    // ---- snapshot ------------------------------------------------------------------------------
    {
      id: 'edit.snapshot.dpi',
      label: 'Snapshot Resolution…',
      category: 'Edit',
      icon: 'camera',
      description: 'Dots per inch for the Snapshot tool',
      when: hasService,
      run: async (ctx) => {
        const s = service(ctx);
        const given = ctx.args['dpi'];
        if (typeof given === 'number') return await s.setSetting('snapshotDpi', clampDpi(given));
        const answer = await ctx.service<ShellServices>('shellServices').dialogs.prompt({
          title: 'Snapshot resolution',
          label: 'Dots per inch',
          value: String(s.settings.snapshotDpi),
          validate: (value) =>
            Number.isFinite(Number(value)) && Number(value) >= 72 && Number(value) <= 1200
              ? null
              : 'Enter a number between 72 and 1200',
        });
        if (answer === null) return s.settings.snapshotDpi;
        return await s.setSetting('snapshotDpi', clampDpi(Number(answer)));
      },
    },
    {
      id: 'edit.snapshot.target',
      label: 'Snapshot Goes To…',
      category: 'Edit',
      description: 'Whether a snapshot goes to the clipboard, a file, or both',
      when: hasService,
      run: async (ctx) => {
        const value = ctx.args['target'];
        const target =
          value === 'clipboard' || value === 'file' || value === 'both' ? value : 'clipboard';
        return await service(ctx).setSetting('snapshotTarget', target);
      },
    },

    // ---- find ----------------------------------------------------------------------------------
    {
      id: 'edit.find',
      label: 'Find',
      category: 'Edit',
      icon: 'search',
      shortcut: 'Mod+F',
      description: 'Find text on the pages of this document',
      when: open,
      run: async (ctx) => {
        const query = ctx.args['query'];
        await service(ctx).openFind(typeof query === 'string' ? query : undefined);
        return service(ctx).findProgress();
      },
    },
    {
      id: 'edit.findNext',
      label: 'Find Next',
      category: 'Edit',
      icon: 'chevron-down',
      shortcut: 'F3',
      when: open,
      run: (ctx) => service(ctx).findNext(),
    },
    {
      id: 'edit.findPrevious',
      label: 'Find Previous',
      category: 'Edit',
      icon: 'chevron-up',
      shortcut: 'Shift+F3',
      when: open,
      run: (ctx) => service(ctx).findPrevious(),
    },
    {
      id: 'edit.findClose',
      label: 'Close the Find Bar',
      category: 'Edit',
      hidden: true,
      when: hasService,
      run: (ctx) => {
        service(ctx).closeFind();
      },
    },
    ...FIND_TOGGLES,

    // ---- advanced search -------------------------------------------------------------------------
    {
      id: 'edit.search',
      label: 'Advanced Search',
      category: 'Edit',
      icon: 'file-search',
      shortcut: 'Mod+Shift+F',
      description: 'Search this document, every open document, or a folder',
      when: hasService,
      run: async (ctx) => {
        const query = ctx.args['query'];
        await service(ctx).openSearchPanel(typeof query === 'string' ? query : undefined);
        if (ctx.args['run'] === true) await service(ctx).runPanelSearch();
        return service(ctx).panel;
      },
    },
    {
      id: 'edit.search.scope',
      label: 'Search: Where to Look',
      category: 'Edit',
      description: 'This document, every open document, or a folder',
      when: hasService,
      run: async (ctx) => {
        const value = ctx.args['scope'];
        const scope = value === 'open' || value === 'folder' ? value : 'document';
        await service(ctx).setScope(scope);
        return scope;
      },
    },
    {
      id: 'edit.search.folder',
      label: 'Search: Choose a Folder…',
      category: 'Edit',
      icon: 'folder-open',
      when: hasService,
      run: (ctx) => service(ctx).pickFolder(),
    },
    {
      id: 'edit.search.run',
      label: 'Search: Run',
      category: 'Edit',
      hidden: true,
      when: hasService,
      run: async (ctx) => {
        await service(ctx).runPanelSearch();
        return service(ctx).panel.hits.length;
      },
    },
    {
      id: 'edit.search.cancel',
      label: 'Search: Stop',
      category: 'Edit',
      when: hasService,
      run: (ctx) => {
        service(ctx).cancelPanelSearch();
      },
    },
    {
      id: 'edit.search.export',
      label: 'Search: Export Results as CSV…',
      category: 'Edit',
      icon: 'download',
      when: hasService,
      run: (ctx) => service(ctx).exportResults(),
    },

    // ---- printing -------------------------------------------------------------------------------
    {
      id: 'file.print',
      permission: 'print',
      label: 'Print…',
      category: 'File',
      icon: 'printer',
      shortcut: 'Mod+P',
      description: 'Print, with page ranges, booklets, n-up, tiling and a preview',
      when: open,
      run: (ctx) => service(ctx).openPrint(),
    },
    {
      id: 'file.pageSetup',
      permission: 'print',
      label: 'Page Setup…',
      category: 'File',
      icon: 'file-cog',
      description: 'Paper size, orientation and margins — part of the print dialog',
      when: open,
      run: (ctx) => service(ctx).openPrint(),
    },
    {
      id: 'file.printToPdf',
      permission: 'print',
      label: 'Print to PDF…',
      category: 'File',
      icon: 'file-output',
      description: 'Write the printed sheets, imposed exactly as they would print, to a PDF',
      when: open,
      run: (ctx) => {
        const s = service(ctx);
        return s.runPrintToPdf(s.lastPrintSettings);
      },
    },

    // ---- developer probes (how the acceptance tests read this module) -------------------------------
    {
      id: 'dev.textLayer',
      label: 'Page text model',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the text, lines and paragraphs of a page',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        const source = s.activeSource();
        if (!source) return null;
        const page = typeof ctx.args['page'] === 'number' ? ctx.args['page'] : 0;
        const model = await s.text.page(source, page);
        return {
          page,
          text: model.text,
          length: model.text.length,
          lines: model.lines.length,
          paragraphs: model.paragraphs.map((p) => ({ start: p.start, end: p.end })),
        };
      },
    },
    {
      id: 'dev.selectRange',
      label: 'Select a character range',
      category: 'Developer',
      hidden: true,
      description: 'Internal: select { page, start, end, endPage }, or { page, at, granularity }',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        const source = s.activeSource();
        if (!source) return null;
        const page = typeof ctx.args['page'] === 'number' ? ctx.args['page'] : 0;
        const model = await s.text.page(source, page);
        const granularity = ctx.args['granularity'];
        if (typeof ctx.args['at'] === 'number') {
          const at = ctx.args['at'];
          const span = granularity === 'paragraph' ? paragraphSpanAt(model, at) : wordAt(model, at);
          s.applySelection(page, span.start, span.end);
        } else {
          const start = typeof ctx.args['start'] === 'number' ? ctx.args['start'] : 0;
          const end = typeof ctx.args['end'] === 'number' ? ctx.args['end'] : model.text.length;
          const endPage = typeof ctx.args['endPage'] === 'number' ? ctx.args['endPage'] : page;
          s.applySelection(page, start, end, endPage);
        }
        return await s.selectionSummary();
      },
    },
    {
      id: 'dev.selection',
      label: 'Text selection',
      category: 'Developer',
      hidden: true,
      description: 'Internal: what is selected, as text and as ranges',
      when: hasService,
      run: (ctx) => service(ctx).selectionSummary(),
    },
    {
      id: 'dev.selectColumn',
      label: 'Select a column',
      category: 'Developer',
      hidden: true,
      description: 'Internal: Alt-drag equivalent — select { page, x0, y0, x1, y1 }',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        const page = Number(ctx.args['page'] ?? 0);
        s.applyColumnSelection(page, {
          x0: Number(ctx.args['x0'] ?? 0),
          y0: Number(ctx.args['y0'] ?? 0),
          x1: Number(ctx.args['x1'] ?? 0),
          y1: Number(ctx.args['y1'] ?? 0),
        });
        return await s.selectionSummary();
      },
    },
    {
      id: 'dev.setSearchFolder',
      label: 'Set the search folder',
      category: 'Developer',
      hidden: true,
      description: 'Internal: choose a folder for the search panel without the native picker',
      when: hasService,
      run: (ctx) => {
        const path = ctx.args['path'];
        if (typeof path !== 'string') throw new Error('dev.setSearchFolder needs { path }');
        service(ctx).setFolder(path);
        return service(ctx).panel.folder;
      },
    },
    {
      id: 'dev.findState',
      label: 'Find state',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the find bar’s hits and which one is current',
      when: hasService,
      run: (ctx) => {
        const progress = service(ctx).findProgress();
        if (!progress) return null;
        return {
          query: progress.query,
          total: progress.hits.length,
          current: progress.current,
          scanning: progress.scanning,
          error: progress.error,
          barOpen: service(ctx).findBarOpen,
          hits: progress.hits.slice(0, 200),
        };
      },
    },
    {
      id: 'dev.searchState',
      label: 'Search panel state',
      category: 'Developer',
      hidden: true,
      when: hasService,
      run: (ctx) => {
        const panel = service(ctx).panel;
        return { ...panel, hits: panel.hits.slice(0, 200) };
      },
    },
    {
      id: 'dev.snapshot',
      label: 'Take a snapshot',
      category: 'Developer',
      hidden: true,
      description: 'Internal: snapshot { page, x0, y0, x1, y1 } and report its pixel size',
      when: open,
      run: (ctx) =>
        service(ctx).takeSnapshot(Number(ctx.args['page'] ?? 0), {
          x0: Number(ctx.args['x0'] ?? 0),
          y0: Number(ctx.args['y0'] ?? 0),
          x1: Number(ctx.args['x1'] ?? 100),
          y1: Number(ctx.args['y1'] ?? 100),
        }),
    },
    {
      id: 'dev.printPlan',
      label: 'Print plan',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the imposition for a set of print settings',
      when: open,
      run: (ctx) => {
        const settings = mergePrintSettings({
          ...DEFAULT_PRINT_SETTINGS,
          ...(ctx.args['settings'] as object | undefined),
        });
        const plan = service(ctx).planFor(settings);
        return {
          error: plan.error,
          pages: plan.pages,
          paper: plan.paper,
          sheets: plan.sheets.map((sheet) => ({
            index: sheet.index,
            width: round(sheet.width),
            height: round(sheet.height),
            placements: sheet.placements.map((p) => ({
              page: p.page,
              x: round(p.x),
              y: round(p.y),
              width: round(p.width),
              height: round(p.height),
              rotation: p.rotation,
              scale: round(p.scale),
            })),
          })),
        };
      },
    },
    {
      id: 'dev.printDryRun',
      label: 'Print (dry run)',
      category: 'Developer',
      hidden: true,
      description: 'Internal: build the whole print job in main without sending it to a printer',
      when: open,
      run: async (ctx) => {
        const settings = mergePrintSettings({
          ...DEFAULT_PRINT_SETTINGS,
          ...(ctx.args['settings'] as object | undefined),
        });
        return await service(ctx).printDryRun(settings);
      },
    },
    {
      id: 'dev.printToPdf',
      label: 'Print to PDF (to a path)',
      category: 'Developer',
      hidden: true,
      description: 'Internal: print to PDF straight to { path }, no dialog',
      when: open,
      run: async (ctx) => {
        const settings = mergePrintSettings({
          ...DEFAULT_PRINT_SETTINGS,
          ...(ctx.args['settings'] as object | undefined),
        });
        const path = ctx.args['path'];
        if (typeof path !== 'string') throw new Error('dev.printToPdf needs { path }');
        return await service(ctx).runPrintToPdf(settings, path);
      },
    },
    {
      id: 'dev.buildPageText',
      label: 'Build a page-text model from runs',
      category: 'Developer',
      hidden: true,
      description: 'Internal: exercises the pure builder with the engine’s runs for a page',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        const source = s.activeSource();
        if (!source) return null;
        const page = Number(ctx.args['page'] ?? 0);
        const engine = ctx.service<PdfEngine>('engine');
        const runs = await engine.textRuns(source.handle, page);
        const model = buildPageText(page, runs);
        return { runs: runs.length, chars: model.chars.length, text: model.text };
      },
    },
  ],

  shortcuts: [
    { key: 'Mod+G', command: 'edit.findNext', scope: 'editor' },
    { key: 'Mod+Shift+G', command: 'edit.findPrevious', scope: 'editor' },
  ],

  /*
   * One group, not two, and one large button in it. The Home tab is where every later module
   * puts its own controls, and a ribbon group that does not fit collapses into a single button —
   * so a module that spreads itself across the tab does not just cost itself, it pushes its
   * neighbours into a popup. Two large buttons here collapsed the demo module's pickers group at
   * 1024 px, which is what CI runs at.
   */
  ribbon: [
    {
      id: 'home.select',
      tab: 'home',
      label: 'Select & find',
      order: 10,
      items: [
        { kind: 'toggle', command: 'tool.selectText.activate', pressed: toolIs('tool.selectText') },
        { kind: 'toggle', command: 'tool.snapshot.activate', pressed: toolIs('tool.snapshot') },
        'edit.copy',
        'edit.copyFormatted',
        'edit.find',
        'edit.search',
        'file.print',
      ],
      large: ['edit.find'],
    },
  ],

  backstage: [{ slot: 'print', command: 'file.print', icon: 'printer' }],

  contextMenus: [
    {
      id: 'm13.pageMenu',
      region: '.viewer-scroll',
      order: 5,
      items: [
        'edit.copy',
        'edit.copyFormatted',
        'edit.copyImage',
        'edit.selectAll',
        '-',
        'edit.find',
        'edit.search',
        '-',
        'file.print',
      ],
    },
  ],
});

// ---- helpers ------------------------------------------------------------------------------------

function toolIs(id: string): (ctx: ServiceContext) => boolean {
  return (ctx) =>
    ctx.service<{ get(): { activeTool: string | null } }>('ui').get().activeTool === id;
}

function clampDpi(value: number): number {
  return Math.min(1200, Math.max(72, Math.round(value)));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The settings shape, re-exported for the tests. */
export type { SelectFindSettings };
