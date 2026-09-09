/**
 * M42 — PDF Portfolios.
 *
 * Registers the `portfolio` service, the file grid that fills the document area when a portfolio
 * is open, every command in the palette, and a **Portfolio ribbon tab that appears only while one
 * is open** — the contextual-tab mechanism M02 provides, so an ordinary document never sees it.
 *
 * The commands are the whole feature surface: the grid's buttons, the ribbon and the palette all
 * run the same ids, which is also how the e2e suite drives it.
 */

import { registerIcon } from '@app/icons';
import { Files, FolderPlus, FolderTree, PanelsTopLeft } from 'lucide';
import type { ShellServices } from '@app/services';
import type { Registry } from '@core/Registry';
import { defineModule, type CommandContext, type ServiceContext } from '@shared/module';
import {
  CUSTOM_KINDS,
  isCustom,
  ROOT_FOLDER_ID,
  type ColumnKind,
  type PortfolioView,
} from '@shared/portfolio';
import { DOCUMENT_SERVICE, type DocumentService } from '@modules/M20-document-model/manifest';
import { VIEWER_SERVICE, type ViewerService } from '@modules/M11-viewer/manifest';
import { PORTFOLIO_COMMAND } from './commandIds';
import { PortfolioService, PORTFOLIO_SERVICE } from './PortfolioService';
import { mountPortfolioView, type PortfolioViewHandle } from './PortfolioView';
import { PORTFOLIO_SETTINGS_SCHEMA } from './settings';
import { convertToSinglePdf } from './merge';
import './portfolio.css';

let live: PortfolioService | null = null;
let view: PortfolioViewHandle | null = null;

/** The service, when the module has activated. */
function service(ctx: ServiceContext): PortfolioService | null {
  return ctx.service<Registry>('registry').hasService(PORTFOLIO_SERVICE)
    ? ctx.service<PortfolioService>(PORTFOLIO_SERVICE)
    : null;
}

/** True while the open document is a portfolio — what the contextual tab and most `when`s ask. */
function isPortfolio(ctx: ServiceContext): boolean {
  return service(ctx)?.isPortfolio ?? false;
}

function hasSelection(ctx: ServiceContext): boolean {
  const s = service(ctx);
  return (s?.isPortfolio ?? false) && s !== null && s.state.selection.length > 0;
}

function hasFiles(ctx: ServiceContext): boolean {
  return (service(ctx)?.portfolio?.files.length ?? 0) > 0;
}

/** The single selected file, when exactly one is chosen. */
function onlySelected(ctx: ServiceContext): string | null {
  const selection = service(ctx)?.state.selection ?? [];
  return selection.length === 1 ? (selection[0] ?? null) : null;
}

function argString(ctx: CommandContext, key: string): string | null {
  const value = ctx.args[key];
  return typeof value === 'string' ? value : null;
}

export default defineModule({
  id: 'M42',
  name: 'PDF Portfolios',
  settings: PORTFOLIO_SETTINGS_SCHEMA,

  commands: [
    // ---- creating ---------------------------------------------------------------------------
    {
      id: PORTFOLIO_COMMAND.newPortfolio,
      label: 'New portfolio',
      category: 'File',
      icon: 'files',
      description: 'An empty PDF Portfolio with a cover sheet',
      run: async (ctx) => {
        const s = service(ctx);
        if (!s) return false;
        const title = argString(ctx, 'title') ?? 'Portfolio';
        return (await s.createEmpty(title)) !== null;
      },
    },
    {
      id: PORTFOLIO_COMMAND.newFromFiles,
      label: 'New portfolio from files…',
      category: 'File',
      icon: 'folder-plus',
      description: 'Choose files, or a folder, and put them in a new portfolio',
      run: async (ctx) => {
        const s = service(ctx);
        if (!s) return 0;
        const created = await s.createEmpty(argString(ctx, 'title') ?? 'Portfolio');
        if (!created) return 0;
        return argString(ctx, 'from') === 'folder'
          ? await s.addFolderFromDialog()
          : await s.addFilesFromDialog();
      },
    },

    // ---- bringing files in -------------------------------------------------------------------
    {
      id: PORTFOLIO_COMMAND.addFiles,
      label: 'Add files',
      category: 'File',
      icon: 'plus',
      when: isPortfolio,
      run: async (ctx) => (await service(ctx)?.addFilesFromDialog()) ?? 0,
    },
    {
      id: PORTFOLIO_COMMAND.addFolderFromDisk,
      label: 'Add a folder',
      category: 'File',
      icon: 'folder-tree',
      description: 'Add every file in a folder, keeping the folder structure',
      when: isPortfolio,
      run: async (ctx) => (await service(ctx)?.addFolderFromDialog()) ?? 0,
    },
    {
      id: PORTFOLIO_COMMAND.newFolder,
      label: 'New folder',
      category: 'File',
      icon: 'folder-plus',
      when: isPortfolio,
      run: async (ctx) => {
        const s = service(ctx);
        if (!s) return false;
        const name =
          argString(ctx, 'name') ??
          (await ctx.service<ShellServices>('shellServices').dialogs.prompt({
            title: 'New folder',
            label: 'Folder name',
            value: 'New folder',
            id: 'portfolio-new-folder',
            validate: (v) => (v.trim() === '' ? 'A folder needs a name.' : null),
          }));
        return name === null ? false : await s.addFolder(name.trim());
      },
    },
    {
      id: PORTFOLIO_COMMAND.renameFolder,
      label: 'Rename this folder',
      category: 'File',
      icon: 'square-pen',
      when: (ctx) => isPortfolio(ctx) && (service(ctx)?.state.folderId ?? 0) !== ROOT_FOLDER_ID,
      run: async (ctx) => {
        const s = service(ctx);
        if (!s) return false;
        const id = s.state.folderId;
        const current = s.portfolio?.folders.find((f) => f.id === id)?.name ?? '';
        const name =
          argString(ctx, 'name') ??
          (await ctx.service<ShellServices>('shellServices').dialogs.prompt({
            title: 'Rename folder',
            label: 'Folder name',
            value: current,
            id: 'portfolio-rename-folder',
            validate: (v) => (v.trim() === '' ? 'A folder needs a name.' : null),
          }));
        return name === null ? false : await s.renameFolder(id, name.trim());
      },
    },
    {
      id: PORTFOLIO_COMMAND.removeFolder,
      label: 'Remove this folder',
      category: 'File',
      icon: 'trash-2',
      when: (ctx) => isPortfolio(ctx) && (service(ctx)?.state.folderId ?? 0) !== ROOT_FOLDER_ID,
      run: async (ctx) =>
        (await service(ctx)?.removeFolder(service(ctx)?.state.folderId ?? 0)) ?? false,
    },

    // ---- the files themselves -----------------------------------------------------------------
    {
      id: PORTFOLIO_COMMAND.openFile,
      label: 'Open the selected file',
      category: 'File',
      icon: 'external-link',
      when: hasSelection,
      run: async (ctx) => {
        const s = service(ctx);
        const id = argString(ctx, 'fileId') ?? onlySelected(ctx) ?? s?.state.selection[0] ?? null;
        return id === null ? 'failed' : ((await s?.open(id)) ?? 'failed');
      },
    },
    {
      id: PORTFOLIO_COMMAND.removeFiles,
      label: 'Remove the selected files',
      category: 'File',
      icon: 'trash-2',
      when: hasSelection,
      run: async (ctx) => {
        const s = service(ctx);
        return (await s?.removeFiles(s.state.selection)) ?? false;
      },
    },
    {
      id: PORTFOLIO_COMMAND.renameFile,
      label: 'Rename the selected file',
      category: 'File',
      icon: 'square-pen',
      when: (ctx) => onlySelected(ctx) !== null,
      run: async (ctx) => {
        const s = service(ctx);
        const id = argString(ctx, 'fileId') ?? onlySelected(ctx);
        if (!s || id === null) return false;
        const current = s.portfolio?.files.find((f) => f.id === id)?.name ?? '';
        const name =
          argString(ctx, 'name') ??
          (await ctx.service<ShellServices>('shellServices').dialogs.prompt({
            title: 'Rename file',
            label: 'File name',
            hint: 'The name a reader sees, and the name it extracts under.',
            value: current,
            id: 'portfolio-rename-file',
            validate: (v) => (v.trim() === '' ? 'A file needs a name.' : null),
          }));
        return name === null ? false : await s.renameFile(id, name);
      },
    },
    {
      id: PORTFOLIO_COMMAND.describeFile,
      label: 'Edit the description',
      category: 'File',
      icon: 'text-cursor-input',
      when: (ctx) => onlySelected(ctx) !== null,
      run: async (ctx) => {
        const s = service(ctx);
        const id = argString(ctx, 'fileId') ?? onlySelected(ctx);
        if (!s || id === null) return false;
        const current = s.portfolio?.files.find((f) => f.id === id)?.description ?? '';
        const description =
          argString(ctx, 'description') ??
          (await ctx.service<ShellServices>('shellServices').dialogs.prompt({
            title: 'Description',
            label: 'Description',
            hint: 'What this file is, in the reader’s words. Shown in the Description column.',
            value: current,
            id: 'portfolio-describe',
          }));
        return description === null ? false : await s.describeFile(id, description);
      },
    },
    {
      id: PORTFOLIO_COMMAND.moveToFolder,
      label: 'Move to folder…',
      category: 'File',
      icon: 'folder-input',
      when: hasSelection,
      run: async (ctx) => {
        const s = service(ctx);
        if (!s?.portfolio) return false;
        const argFolder = ctx.args['folderId'];
        if (typeof argFolder === 'number')
          return await s.moveToFolder(s.state.selection, argFolder);
        const choices = s.portfolio.folders.map((f) => ({
          id: String(f.id),
          label: f.parentId === null ? 'All files (the top level)' : s.path(f.id),
        }));
        const chosen = await ctx.service<ShellServices>('shellServices').dialogs.message({
          kind: 'question',
          title: 'Move to folder',
          text: 'Which folder should these files go in?',
          id: 'portfolio-move-to-folder',
          buttons: [
            ...choices.map((c, i) => ({ id: c.id, label: c.label, primary: i === 0 })),
            { id: 'cancel', label: 'Cancel' },
          ],
        });
        if (chosen === 'cancel') return false;
        return await s.moveToFolder(s.state.selection, Number(chosen));
      },
    },
    {
      id: PORTFOLIO_COMMAND.moveUp,
      label: 'Move up',
      category: 'File',
      icon: 'arrow-up',
      when: hasSelection,
      run: async (ctx) => (await service(ctx)?.nudge(-1)) ?? false,
    },
    {
      id: PORTFOLIO_COMMAND.moveDown,
      label: 'Move down',
      category: 'File',
      icon: 'arrow-down',
      when: hasSelection,
      run: async (ctx) => (await service(ctx)?.nudge(1)) ?? false,
    },
    {
      id: PORTFOLIO_COMMAND.replaceFile,
      label: 'Replace the file’s contents',
      category: 'File',
      icon: 'refresh-cw',
      description: 'Put a new version in, keeping the name, description and column values',
      when: (ctx) => onlySelected(ctx) !== null,
      run: async (ctx) => {
        const id = argString(ctx, 'fileId') ?? onlySelected(ctx);
        return id === null ? false : ((await service(ctx)?.replaceContent(id)) ?? false);
      },
    },

    // ---- taking files out ----------------------------------------------------------------------
    {
      id: PORTFOLIO_COMMAND.extractFile,
      label: 'Extract the selected file',
      category: 'File',
      icon: 'save',
      when: (ctx) => onlySelected(ctx) !== null,
      run: async (ctx) => {
        const id = argString(ctx, 'fileId') ?? onlySelected(ctx);
        return id === null ? null : ((await service(ctx)?.extractOne(id)) ?? null);
      },
    },
    {
      id: PORTFOLIO_COMMAND.extractSelected,
      label: 'Extract the selected files to a folder',
      category: 'File',
      icon: 'folder-down',
      when: hasSelection,
      run: async (ctx) => {
        const s = service(ctx);
        return (await s?.extractMany(s.selectedFiles)) ?? 0;
      },
    },
    {
      id: PORTFOLIO_COMMAND.extractAll,
      label: 'Extract all files to a folder',
      category: 'File',
      icon: 'folder-down',
      description: 'Every file, with the portfolio’s folder structure kept on disk',
      when: hasFiles,
      run: async (ctx) => {
        const s = service(ctx);
        return (await s?.extractMany(s.portfolio?.files ?? [])) ?? 0;
      },
    },

    // ---- columns -------------------------------------------------------------------------------
    {
      id: PORTFOLIO_COMMAND.addColumn,
      label: 'Add a column',
      category: 'File',
      icon: 'columns-3',
      description: 'A column of your own: text, a date or a number',
      when: isPortfolio,
      run: async (ctx) => {
        const s = service(ctx);
        if (!s) return false;
        const label = argString(ctx, 'label');
        const kindArg = argString(ctx, 'kind');
        if (label !== null && kindArg !== null && isColumnKind(kindArg)) {
          return await s.addColumn(label, kindArg);
        }
        const dialogs = ctx.service<ShellServices>('shellServices').dialogs;
        const name = await dialogs.prompt({
          title: 'Add a column',
          label: 'Column heading',
          hint: 'Shown at the top of the column and stored in the portfolio’s schema.',
          id: 'portfolio-add-column',
          validate: (v) => (v.trim() === '' ? 'A column needs a heading.' : null),
        });
        if (name === null) return false;
        const kind = await dialogs.message({
          kind: 'question',
          title: 'What goes in this column?',
          text: `“${name.trim()}” holds:`,
          id: 'portfolio-column-kind',
          buttons: [
            { id: 'text', label: 'Text', primary: true },
            { id: 'date', label: 'A date' },
            { id: 'number', label: 'A number' },
            { id: 'cancel', label: 'Cancel' },
          ],
        });
        if (!isColumnKind(kind)) return false;
        return await s.addColumn(name.trim(), kind);
      },
    },
    {
      id: PORTFOLIO_COMMAND.removeColumn,
      label: 'Remove a column',
      category: 'File',
      icon: 'columns-3',
      when: (ctx) => (service(ctx)?.portfolio?.schema.filter(isCustom).length ?? 0) > 0,
      run: async (ctx) => {
        const s = service(ctx);
        if (!s?.portfolio) return false;
        const key = argString(ctx, 'key');
        if (key !== null) return await s.removeColumn(key);
        const custom = s.portfolio.schema
          .filter(isCustom)
          .filter((c) => c.key !== s.portfolio?.orderKey);
        if (custom.length === 0) return false;
        const chosen = await ctx.service<ShellServices>('shellServices').dialogs.message({
          kind: 'question',
          title: 'Remove a column',
          text: 'Which column should go? The values in it go with it.',
          id: 'portfolio-remove-column',
          buttons: [
            ...custom.map((c, i) => ({ id: c.key, label: c.label, primary: i === 0 })),
            { id: 'cancel', label: 'Cancel' },
          ],
        });
        return chosen === 'cancel' ? false : await s.removeColumn(chosen);
      },
    },
    {
      id: PORTFOLIO_COMMAND.setColumnValue,
      label: 'Fill in a column for this file',
      category: 'File',
      icon: 'text-cursor-input',
      when: (ctx) =>
        onlySelected(ctx) !== null &&
        (service(ctx)?.portfolio?.schema.filter(isCustom).length ?? 0) > 0,
      run: async (ctx) => {
        const s = service(ctx);
        const id = argString(ctx, 'fileId') ?? onlySelected(ctx);
        if (!s?.portfolio || id === null) return false;
        const custom = s.portfolio.schema
          .filter(isCustom)
          .filter((c) => c.key !== s.portfolio?.orderKey);
        if (custom.length === 0) return false;
        const dialogs = ctx.service<ShellServices>('shellServices').dialogs;
        let key = argString(ctx, 'key');
        if (key === null) {
          const chosen = await dialogs.message({
            kind: 'question',
            title: 'Which column?',
            text: 'Choose the column to fill in for this file.',
            id: 'portfolio-pick-column',
            buttons: [
              ...custom.map((c, i) => ({ id: c.key, label: c.label, primary: i === 0 })),
              { id: 'cancel', label: 'Cancel' },
            ],
          });
          if (chosen === 'cancel') return false;
          key = chosen;
        }
        const column = custom.find((c) => c.key === key);
        if (!column) return false;
        const value =
          argString(ctx, 'value') ??
          (await dialogs.prompt({
            title: column.label,
            label: column.label,
            hint:
              column.kind === 'date'
                ? 'A date, written as YYYY-MM-DD.'
                : column.kind === 'number'
                  ? 'A number.'
                  : 'Anything you like.',
            value: s.portfolio.files.find((f) => f.id === id)?.fields[column.key] ?? '',
            id: 'portfolio-column-value',
          }));
        return value === null ? false : await s.setFieldValue(id, column.key, value);
      },
    },

    // ---- how it is shown ------------------------------------------------------------------------
    {
      id: PORTFOLIO_COMMAND.setView,
      label: 'Show as details or tiles',
      category: 'View',
      icon: 'panels-top-left',
      when: isPortfolio,
      run: async (ctx) => {
        const s = service(ctx);
        if (!s) return false;
        const asked = argString(ctx, 'value');
        const next: PortfolioView =
          asked === 'details' || asked === 'tile'
            ? asked
            : s.portfolio?.view === 'tile'
              ? 'details'
              : 'tile';
        return await s.setView(next);
      },
    },
    {
      id: PORTFOLIO_COMMAND.setInitialFile,
      label: 'Show this file first',
      category: 'File',
      icon: 'star',
      description: 'The file a reader is shown when the portfolio opens',
      when: (ctx) => onlySelected(ctx) !== null,
      run: async (ctx) => {
        const s = service(ctx);
        const id = onlySelected(ctx);
        const name = s?.portfolio?.files.find((f) => f.id === id)?.name ?? null;
        if (!s || name === null) return false;
        return await s.setInitialFile(s.portfolio?.initialFile === name ? null : name);
      },
    },
    {
      id: PORTFOLIO_COMMAND.showFiles,
      label: 'Show the portfolio’s files',
      category: 'View',
      icon: 'files',
      when: isPortfolio,
      run: (ctx) => {
        service(ctx)?.setState({ pane: 'files' });
        return true;
      },
    },
    {
      id: PORTFOLIO_COMMAND.showCover,
      label: 'Show the cover sheet',
      category: 'View',
      icon: 'file-text',
      when: isPortfolio,
      run: (ctx) => {
        service(ctx)?.setState({ pane: 'cover' });
        return true;
      },
    },

    // ---- the cover sheet --------------------------------------------------------------------------
    {
      id: PORTFOLIO_COMMAND.generateCover,
      label: 'Generate the cover sheet',
      category: 'File',
      icon: 'file-text',
      description: 'Draw a new cover listing every file. Replaces the pages this document has.',
      when: isPortfolio,
      run: async (ctx) => {
        const s = service(ctx);
        if (!s) return false;
        const subtitle = argString(ctx, 'subtitle');
        if (subtitle !== null) return await s.regenerateCover(subtitle);
        const typed = await ctx.service<ShellServices>('shellServices').dialogs.prompt({
          title: 'Generate the cover sheet',
          label: 'Subtitle (optional)',
          hint: 'A line under the title. Leave it empty for none.',
          id: 'portfolio-cover-subtitle',
        });
        if (typed === null) return false;
        return await s.regenerateCover(typed);
      },
    },
    {
      id: PORTFOLIO_COMMAND.coverFromFile,
      label: 'Use a PDF as the cover sheet',
      category: 'File',
      icon: 'file-input',
      when: isPortfolio,
      run: async (ctx) => (await service(ctx)?.useCoverFromFile()) ?? false,
    },

    // ---- back into the portfolio, and out of it -------------------------------------------------------
    {
      id: PORTFOLIO_COMMAND.saveBack,
      label: 'Save back into the portfolio',
      category: 'File',
      icon: 'save',
      description: 'Put this file back where it was opened from, keeping everything else about it',
      when: (ctx) => service(ctx)?.canSaveBack ?? false,
      run: async (ctx) => (await service(ctx)?.saveBack()) ?? false,
    },
    {
      id: PORTFOLIO_COMMAND.convertToSinglePdf,
      label: 'Convert to a single PDF',
      category: 'Convert',
      icon: 'combine',
      description: 'The embedded PDFs, in this order, as one ordinary document',
      when: hasFiles,
      run: async (ctx) => {
        const s = service(ctx);
        const portfolio = s?.portfolio;
        if (!s || !portfolio) return false;
        const shell = ctx.service<ShellServices>('shellServices');
        const result = await convertToSinglePdf(portfolio, (file) => s.bytesOf(file), {
          title: s.tab?.title ?? 'Portfolio',
        });
        const registry = ctx.service<Registry>('registry');
        if (!registry.hasService(DOCUMENT_SERVICE)) return false;
        const name = `${(s.tab?.title ?? 'Portfolio').replace(/\.pdf$/i, '')} (merged).pdf`;
        const opened = await registry
          .service<DocumentService>(DOCUMENT_SERVICE)
          .open(result.bytes, { path: null, name, title: name });
        if (registry.hasService(VIEWER_SERVICE)) {
          await registry.service<ViewerService>(VIEWER_SERVICE).attach(opened.tab, opened.document);
        }
        if (result.skipped.length > 0) {
          shell.toasts.show({
            kind: 'warning',
            text: `${String(result.skipped.length)} ${result.skipped.length === 1 ? 'file is' : 'files are'} not a PDF and could not be merged: ${result.skipped.join(', ')}`,
          });
        }
        return result.merged.length;
      },
    },

    // ---- developer ------------------------------------------------------------------------------
    {
      id: 'dev.portfolioState',
      label: 'Portfolio state',
      category: 'Developer',
      hidden: true,
      description: 'Internal: what the portfolio view is showing',
      run: (ctx) => {
        const s = service(ctx);
        const portfolio = s?.portfolio ?? null;
        const rows = [...document.querySelectorAll<HTMLElement>('.pf-host [data-row]')];
        return {
          isPortfolio: portfolio !== null,
          pane: s?.state.pane ?? null,
          view: portfolio?.view ?? null,
          folderId: s?.state.folderId ?? null,
          selection: s?.state.selection ?? [],
          gridVisible: document.querySelector<HTMLElement>('.pf-host')?.hidden === false,
          pageHostHidden: document.getElementById('doc-host')?.hidden ?? null,
          columns: [...document.querySelectorAll<HTMLElement>('.pf-th .pf-sort')].map(
            (b) => b.textContent ?? '',
          ),
          rows: rows.map((r) => ({
            id: r.dataset['id'] ?? '',
            text: r.textContent ?? '',
            selected: r.getAttribute('aria-selected') === 'true',
          })),
          tiles: [...document.querySelectorAll<HTMLElement>('.pf-tile-picture img')].length,
          folders: [...document.querySelectorAll<HTMLElement>('.pf-folder-button')].map(
            (b) => b.querySelector('.pf-folder-name')?.textContent ?? '',
          ),
          files: (portfolio?.files ?? []).map((f) => ({
            id: f.id,
            name: f.name,
            folderId: f.folderId,
            description: f.description,
            order: f.order,
            fields: f.fields,
          })),
          schema: (portfolio?.schema ?? []).map((c) => ({
            key: c.key,
            label: c.label,
            kind: c.kind,
          })),
          sort: portfolio?.sort ?? null,
          initialFile: portfolio?.initialFile ?? null,
          canSaveBack: s?.canSaveBack ?? false,
          pages: s?.document?.state.pages.length ?? 0,
        };
      },
    },
    {
      id: 'dev.portfolioSelect',
      label: 'Select files in the portfolio',
      category: 'Developer',
      hidden: true,
      description: 'Internal: selects files by name, so a test can act on them',
      run: (ctx) => {
        const s = service(ctx);
        const wanted = ctx.args['names'];
        const list = Array.isArray(wanted)
          ? wanted.filter((v): v is string => typeof v === 'string')
          : [];
        const ids = (s?.portfolio?.files ?? [])
          .filter((f) => list.includes(f.name))
          .map((f) => f.id);
        s?.setState({ selection: ids });
        return ids;
      },
    },
    {
      id: 'dev.portfolioAddBytes',
      label: 'Add a file to the portfolio from bytes',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the drop path without a file dialog',
      run: async (ctx) => {
        const s = service(ctx);
        const name = argString(ctx, 'name') ?? 'added.txt';
        const path = argString(ctx, 'path') ?? '';
        const raw = ctx.args['bytes'];
        const bytes = Array.isArray(raw) ? new Uint8Array(raw as number[]) : new Uint8Array();
        return (await s?.addFiles([{ name, bytes, path }])) ?? 0;
      },
    },
  ],

  // ---- the ribbon ------------------------------------------------------------------------------
  ribbonTabs: [
    {
      id: 'portfolio',
      label: 'Portfolio',
      when: isPortfolio,
      order: 10,
    },
  ],

  ribbon: [
    {
      id: 'portfolio.files',
      tab: 'portfolio',
      label: 'Files',
      order: 10,
      items: [
        PORTFOLIO_COMMAND.addFiles,
        PORTFOLIO_COMMAND.addFolderFromDisk,
        PORTFOLIO_COMMAND.newFolder,
        '-',
        PORTFOLIO_COMMAND.removeFiles,
        PORTFOLIO_COMMAND.renameFile,
        PORTFOLIO_COMMAND.describeFile,
        PORTFOLIO_COMMAND.replaceFile,
      ],
      large: [PORTFOLIO_COMMAND.addFiles],
    },
    {
      id: 'portfolio.order',
      tab: 'portfolio',
      label: 'Order',
      order: 20,
      items: [
        PORTFOLIO_COMMAND.moveUp,
        PORTFOLIO_COMMAND.moveDown,
        PORTFOLIO_COMMAND.moveToFolder,
        PORTFOLIO_COMMAND.setInitialFile,
      ],
    },
    {
      id: 'portfolio.columns',
      tab: 'portfolio',
      label: 'Columns',
      order: 30,
      items: [
        PORTFOLIO_COMMAND.addColumn,
        PORTFOLIO_COMMAND.setColumnValue,
        PORTFOLIO_COMMAND.removeColumn,
      ],
    },
    {
      id: 'portfolio.view',
      tab: 'portfolio',
      label: 'View',
      order: 40,
      items: [
        {
          kind: 'toggle',
          command: PORTFOLIO_COMMAND.setView,
          pressed: (ctx) => service(ctx)?.portfolio?.view === 'tile',
          size: 'large',
          dynamicLabel: (ctx) =>
            service(ctx)?.portfolio?.view === 'tile' ? 'Showing tiles' : 'Showing details',
        },
        PORTFOLIO_COMMAND.showFiles,
        PORTFOLIO_COMMAND.showCover,
      ],
    },
    {
      id: 'portfolio.cover',
      tab: 'portfolio',
      label: 'Cover sheet',
      order: 50,
      items: [PORTFOLIO_COMMAND.generateCover, PORTFOLIO_COMMAND.coverFromFile],
      large: [PORTFOLIO_COMMAND.generateCover],
    },
    {
      id: 'portfolio.out',
      tab: 'portfolio',
      label: 'Take out',
      order: 60,
      items: [
        PORTFOLIO_COMMAND.openFile,
        PORTFOLIO_COMMAND.extractFile,
        PORTFOLIO_COMMAND.extractSelected,
        PORTFOLIO_COMMAND.extractAll,
        PORTFOLIO_COMMAND.convertToSinglePdf,
      ],
      large: [PORTFOLIO_COMMAND.extractAll],
    },
    {
      // The one group that belongs to an *embedded* file rather than to the portfolio: it shows
      // on the Home tab of the document that was opened out of one.
      id: 'portfolio.saveBack',
      tab: 'home',
      label: 'Portfolio',
      order: 90,
      when: (ctx) => service(ctx)?.canSaveBack ?? false,
      items: [PORTFOLIO_COMMAND.saveBack],
      large: [PORTFOLIO_COMMAND.saveBack],
    },
  ],

  creators: [
    {
      id: 'portfolio.new',
      label: 'Portfolio',
      description: 'A pack of files in one PDF',
      icon: 'files',
      command: PORTFOLIO_COMMAND.newPortfolio,
      order: 20,
    },
    {
      id: 'portfolio.newFromFiles',
      label: 'Portfolio from files',
      description: 'Choose the files it holds',
      icon: 'folder-plus',
      command: PORTFOLIO_COMMAND.newFromFiles,
      order: 21,
    },
  ],

  contextMenus: [
    {
      id: 'portfolio.grid',
      region: '.pf-host',
      order: 10,
      when: isPortfolio,
      items: [
        PORTFOLIO_COMMAND.openFile,
        PORTFOLIO_COMMAND.extractFile,
        '-',
        PORTFOLIO_COMMAND.renameFile,
        PORTFOLIO_COMMAND.describeFile,
        PORTFOLIO_COMMAND.setColumnValue,
        PORTFOLIO_COMMAND.replaceFile,
        '-',
        PORTFOLIO_COMMAND.moveUp,
        PORTFOLIO_COMMAND.moveDown,
        PORTFOLIO_COMMAND.moveToFolder,
        PORTFOLIO_COMMAND.setInitialFile,
        '-',
        PORTFOLIO_COMMAND.removeFiles,
      ],
    },
  ],

  shortcuts: [{ key: 'Mod+Shift+O', command: PORTFOLIO_COMMAND.openFile }],

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(PORTFOLIO_SERVICE)) return undefined;
    registerIcon('files', Files);
    registerIcon('folder-plus', FolderPlus);
    registerIcon('folder-tree', FolderTree);
    registerIcon('panels-top-left', PanelsTopLeft);
    const shell = registry.service<ShellServices>('shellServices');
    const instance = new PortfolioService({ registry, shell });
    live = instance;
    registry.provide(PORTFOLIO_SERVICE, instance);
    void instance.load();

    const area = document.getElementById('doc-area');
    const pageHost = document.getElementById('doc-host');
    if (area && pageHost) view = mountPortfolioView(area, pageHost, ctx, instance);

    // A portfolio's own ribbon tab appears and disappears with the document; the shell re-reads
    // every `when` when it is told to.
    const stop = instance.watch(() => {
      shell.invalidate();
    });

    return () => {
      stop();
      view?.dispose();
      view = null;
      live = null;
      instance.dispose();
    };
  },
});

/** The live service, for tests and for the e2e harness. */
export function portfolioService(): PortfolioService | null {
  return live;
}

function isColumnKind(value: string): value is ColumnKind {
  return (CUSTOM_KINDS as ReadonlyArray<string>).includes(value);
}

export { PORTFOLIO_SERVICE } from './PortfolioService';
export type { PortfolioService } from './PortfolioService';
