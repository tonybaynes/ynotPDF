/**
 * The portfolio view (M42) — what fills the document area when the open file is a portfolio.
 *
 * A portfolio's pages are a cover sheet; its *content* is the list of files, so that is what the
 * reader sees first. Two panes, switched by a tab strip: **Files**, the grid, and **Cover
 * sheet**, which hands the area back to M11's viewer.
 *
 * The grid comes in the two shapes Foxit offers. **Details** is a table with the portfolio's own
 * schema columns, sortable by clicking a heading. **Tiles** is a card per file with the first
 * page of an embedded PDF drawn on it. Both are keyboard-first: arrows move, Enter opens, Space
 * adds to the selection, and every column heading is a button.
 *
 * DOM only. Every decision — what a click means, what an edit does — is in `PortfolioService`.
 */

import { el, button as domButton } from '@app/dom';
import { icon } from '@app/icons';
import type { ServiceContext } from '@shared/module';
import {
  childFolders,
  columnValue,
  filesInFolder,
  folderPath,
  ROOT_FOLDER_ID,
  visibleColumns,
  type Portfolio,
  type PortfolioColumn,
  type PortfolioFile,
} from '@shared/portfolio';
import { formatBytes, formatDate } from '@modules/M12-navigation-panels/panelChrome';
import { isPdfFile, type PortfolioService } from './PortfolioService';
import { PORTFOLIO_COMMAND } from './commandIds';

/** Draws the first page of an embedded PDF, once per file, for tiles view. */
class TileThumbnails {
  private readonly cache = new Map<string, string>();
  private readonly pending = new Set<string>();
  private readonly service: PortfolioService;

  constructor(service: PortfolioService) {
    this.service = service;
  }

  /** A data URL for the file's first page, or null while it is being made (or never). */
  get(file: PortfolioFile, onReady: () => void): string | null {
    const cached = this.cache.get(file.id);
    if (cached !== undefined) return cached;
    if (this.pending.has(file.id)) return null;
    if (!isPdfFile(file.name, file.mimeType)) return null;
    this.pending.add(file.id);
    void this.render(file)
      .then((url) => {
        if (url !== null) this.cache.set(file.id, url);
        this.pending.delete(file.id);
        if (url !== null) onReady();
      })
      .catch(() => {
        this.pending.delete(file.id);
      });
    return null;
  }

  private async render(file: PortfolioFile): Promise<string | null> {
    const document_ = this.service.document;
    const bytes = await this.service.bytesOf(file);
    if (!document_ || !bytes || bytes.length === 0) return null;
    const engine = document_.engine;
    const handle = await engine.open(bytes.slice());
    try {
      const size = await engine.pageSize(handle, 0);
      const scale = Math.min(160 / size.width, 200 / size.height);
      const render = await engine.render(handle, 0, scale);
      const canvas = document.createElement('canvas');
      canvas.width = render.bitmap.width;
      canvas.height = render.bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(render.bitmap, 0, 0);
      render.bitmap.close();
      return canvas.toDataURL('image/png');
    } finally {
      await engine.close(handle).catch(() => undefined);
    }
  }

  forget(): void {
    this.cache.clear();
  }
}

export interface PortfolioViewHandle {
  /** Repaints from the service's current state. */
  refresh(): void;
  dispose(): void;
  readonly element: HTMLElement;
}

/**
 * Mounts the view into the document area, above M11's page host, and takes the area over
 * whenever the active document is a portfolio showing its files.
 */
export function mountPortfolioView(
  area: HTMLElement,
  pageHost: HTMLElement,
  ctx: ServiceContext,
  service: PortfolioService,
): PortfolioViewHandle {
  const disposers: Array<() => void> = [];
  const thumbnails = new TileThumbnails(service);

  const tabs = el('div.pf-tabs', { role: 'tablist', 'aria-label': 'Portfolio' });
  const filesTab = tabButton('Files', 'files', 'files');
  const coverTab = tabButton('Cover sheet', 'cover', 'file-text');
  tabs.append(filesTab, coverTab);

  const breadcrumb = el('nav.pf-breadcrumb', { 'aria-label': 'Folder' });
  const folders = el('div.pf-folders', { 'aria-label': 'Folders' });
  const grid = el('div.pf-grid', { 'data-testid': 'portfolio-grid' });
  const empty = el(
    'p.pf-empty',
    { role: 'status' },
    'This portfolio has no files yet. Use Add files on the Portfolio tab.',
  );
  const body = el('div.pf-body', null, folders, el('div.pf-main', null, breadcrumb, grid, empty));
  const host = el(
    'section.pf-host',
    { id: 'portfolio-view', 'aria-label': 'Portfolio' },
    tabs,
    body,
  );
  host.hidden = true;
  area.insertBefore(host, pageHost);

  function tabButton(label: string, pane: 'files' | 'cover', iconName: string): HTMLElement {
    const b = domButton('pf-tab', { role: 'tab', 'data-pane': pane }, icon(iconName), label);
    b.addEventListener('click', () => {
      service.setState({ pane });
    });
    return b;
  }

  // ---- rendering -------------------------------------------------------------------------------

  const render = (): void => {
    const portfolio = service.portfolio;
    const showing = portfolio !== null;
    const pane = service.state.pane;
    host.hidden = !showing;
    // The viewer keeps the area for the cover sheet; the grid takes it for the files.
    pageHost.hidden = showing && pane === 'files';
    body.hidden = pane !== 'files';
    for (const tab of [filesTab, coverTab]) {
      const on = tab.dataset['pane'] === pane;
      tab.setAttribute('aria-selected', String(on));
      tab.classList.toggle('is-current', on);
      tab.tabIndex = on ? 0 : -1;
    }
    if (!portfolio || pane !== 'files') return;

    renderFolders(portfolio);
    renderBreadcrumb(portfolio);
    const files = service.visibleFiles;
    empty.hidden = files.length > 0;
    grid.hidden = files.length === 0;
    grid.replaceChildren();
    if (portfolio.view === 'tile') renderTiles(portfolio, files);
    else renderDetails(portfolio, files);
  };

  const renderFolders = (portfolio: Portfolio): void => {
    folders.replaceChildren();
    const list = el('ul.pf-folder-list', { role: 'tree', 'aria-label': 'Folders' });
    const addNode = (id: number, depth: number, parent: HTMLElement): void => {
      const folder = portfolio.folders.find((f) => f.id === id);
      if (!folder) return;
      const count = filesInFolder(portfolio, id).length;
      const label = id === ROOT_FOLDER_ID ? 'All files' : folder.name;
      const item = el('li.pf-folder', { role: 'none' });
      const b = domButton(
        'pf-folder-button',
        {
          role: 'treeitem',
          'aria-selected': String(service.state.folderId === id),
          'data-folder': String(id),
          style: `--pf-depth:${String(depth)}`,
        },
        icon(id === ROOT_FOLDER_ID ? 'folder-open' : 'folder'),
        el('span.pf-folder-name', null, label),
        el('span.pf-folder-count', null, count === 1 ? '1 file' : `${String(count)} files`),
      );
      b.classList.toggle('is-current', service.state.folderId === id);
      b.addEventListener('click', () => {
        service.setState({ folderId: id, selection: [] });
      });
      // A file dragged onto a folder moves into it, which is what a file manager does.
      b.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types.includes('application/x-ynot-portfolio-file') === true) {
          e.preventDefault();
          b.classList.add('is-drop-target');
        }
      });
      b.addEventListener('dragleave', () => {
        b.classList.remove('is-drop-target');
      });
      b.addEventListener('drop', (e) => {
        b.classList.remove('is-drop-target');
        const ids = readDraggedIds(e);
        if (ids.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        void service.moveToFolder(ids, id);
      });
      item.append(b);
      parent.append(item);
      const children = childFolders(portfolio, id);
      if (children.length > 0) {
        const sub = el('ul.pf-folder-list', { role: 'group' });
        for (const child of children) addNode(child.id, depth + 1, sub);
        item.append(sub);
      }
    };
    addNode(ROOT_FOLDER_ID, 0, list);
    folders.append(list);
    // One folder and nothing in it is not a tree worth showing.
    folders.hidden = portfolio.folders.length <= 1;
  };

  const renderBreadcrumb = (portfolio: Portfolio): void => {
    const path = folderPath(portfolio, service.state.folderId);
    breadcrumb.replaceChildren(
      icon('folder'),
      el('span', null, path === '' ? 'All files' : path),
      el(
        'span.pf-count',
        null,
        `${String(service.visibleFiles.length)} of ${String(portfolio.files.length)} shown`,
      ),
    );
  };

  const renderDetails = (portfolio: Portfolio, files: ReadonlyArray<PortfolioFile>): void => {
    const columns = visibleColumns(portfolio).filter((c) => c.key !== portfolio.orderKey);
    const table = el('div.pf-table', { role: 'table', 'aria-label': 'Files in this portfolio' });
    table.style.setProperty('--pf-columns', String(columns.length));
    const header = el('div.pf-tr.pf-th', { role: 'row' });
    for (const column of columns) {
      const sorted = portfolio.sort?.key === column.key;
      const direction = portfolio.sort?.ascending === false ? 'descending' : 'ascending';
      const cell = el('span.pf-td', {
        role: 'columnheader',
        'aria-sort': sorted ? direction : 'none',
      });
      const b = domButton(
        'pf-sort',
        { title: `Sort by ${column.label}` },
        el('span', null, column.label),
        // The arrow is decoration; the word next to it is what says which way, because an arrow
        // alone is a shape a reader with low vision has to hunt for.
        sorted ? icon(direction === 'ascending' ? 'arrow-up' : 'arrow-down') : null,
        sorted ? el('span.pf-sort-word', null, direction === 'ascending' ? 'A–Z' : 'Z–A') : null,
      );
      b.addEventListener('click', () => {
        void service.setSort(column.key, sorted ? !portfolio.sort?.ascending : true);
      });
      cell.append(b);
      header.append(cell);
    }
    table.append(header);

    for (const file of files) {
      const row = el('div.pf-tr', {
        role: 'row',
        'data-row': '',
        'data-id': file.id,
        tabindex: '-1',
        draggable: 'true',
        'aria-selected': String(service.state.selection.includes(file.id)),
      });
      row.classList.toggle('is-selected', service.state.selection.includes(file.id));
      for (const [index, column] of columns.entries()) {
        const cell = el('span.pf-td', { role: 'cell' }, cellText(portfolio, file, column));
        if (index === 0) {
          cell.prepend(icon(isPdfFile(file.name, file.mimeType) ? 'file-text' : 'file'));
          if (portfolio.initialFile === file.name) {
            cell.append(
              el(
                'span.pf-badge',
                { title: 'Shown first when this portfolio opens' },
                'Opens first',
              ),
            );
          }
          if (file.source.kind === 'added') {
            cell.append(
              el('span.pf-badge', { title: 'Added in this session; not saved yet' }, 'New'),
            );
          }
        }
        row.append(cell);
      }
      wireRow(row, file);
      table.append(row);
    }
    grid.append(table);
    installKeys(table);
  };

  const renderTiles = (portfolio: Portfolio, files: ReadonlyArray<PortfolioFile>): void => {
    const list = el('div.pf-tiles', { role: 'listbox', 'aria-label': 'Files in this portfolio' });
    for (const file of files) {
      const selected = service.state.selection.includes(file.id);
      const tile = el('div.pf-tile', {
        role: 'option',
        'data-row': '',
        'data-id': file.id,
        tabindex: '-1',
        draggable: 'true',
        'aria-selected': String(selected),
      });
      tile.classList.toggle('is-selected', selected);
      const picture = el('div.pf-tile-picture');
      const url = service.settings.tileThumbnails ? thumbnails.get(file, render) : null;
      if (url === null)
        picture.append(icon(isPdfFile(file.name, file.mimeType) ? 'file-text' : 'file'));
      else picture.append(el('img', { src: url, alt: '' }));
      tile.append(picture, el('span.pf-tile-name', { title: file.name }, file.name));
      tile.append(el('span.pf-tile-meta', null, formatBytes(file.size)));
      if (file.description !== null && file.description !== '') {
        tile.append(el('span.pf-tile-desc', { title: file.description }, file.description));
      }
      wireRow(tile, file);
      list.append(tile);
    }
    grid.append(list);
    installKeys(list);
  };

  // ---- interaction -----------------------------------------------------------------------------

  const wireRow = (row: HTMLElement, file: PortfolioFile): void => {
    row.addEventListener('click', (e) => {
      select(file.id, { add: e.ctrlKey || e.metaKey, range: e.shiftKey });
    });
    row.addEventListener('dblclick', () => {
      select(file.id, {});
      void ctx.run(PORTFOLIO_COMMAND.openFile);
    });
    row.addEventListener('dragstart', (e) => {
      if (!service.state.selection.includes(file.id)) select(file.id, {});
      e.dataTransfer?.setData(
        'application/x-ynot-portfolio-file',
        JSON.stringify(service.state.selection),
      );
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('application/x-ynot-portfolio-file') !== true) return;
      e.preventDefault();
      row.classList.add('is-drop-target');
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('is-drop-target');
    });
    row.addEventListener('drop', (e) => {
      row.classList.remove('is-drop-target');
      const ids = readDraggedIds(e);
      if (ids.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      void dropBefore(ids, file.id);
    });
  };

  /** Moves the dragged files so they sit immediately before `targetId` in the reader's order. */
  const dropBefore = async (ids: ReadonlyArray<string>, targetId: string): Promise<void> => {
    const portfolio = service.portfolio;
    if (!portfolio || ids.includes(targetId)) return;
    const moving = new Set(ids);
    const order = [...portfolio.files].sort((a, b) => a.order - b.order).map((f) => f.id);
    const rest = order.filter((id) => !moving.has(id));
    const at = rest.indexOf(targetId);
    const next = at < 0 ? [...rest, ...ids] : [...rest.slice(0, at), ...ids, ...rest.slice(at)];
    await service.reorder(next);
  };

  const select = (id: string, options: { add?: boolean; range?: boolean }): void => {
    const current = service.state.selection;
    if (options.add === true) {
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      service.setState({ selection: next });
      return;
    }
    if (options.range === true && current.length > 0) {
      const ids = service.visibleFiles.map((f) => f.id);
      const from = ids.indexOf(current[current.length - 1] ?? '');
      const to = ids.indexOf(id);
      if (from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        service.setState({ selection: ids.slice(a, b + 1) });
        return;
      }
    }
    service.setState({ selection: [id] });
  };

  const installKeys = (container: HTMLElement): void => {
    const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-row]')];
    const active = rows().find((r) => r.dataset['id'] === service.state.selection.at(-1));
    for (const row of rows()) row.tabIndex = row === (active ?? rows()[0]) ? 0 : -1;
    container.addEventListener('keydown', (e) => {
      const list = rows();
      const index = list.findIndex((r) => r === document.activeElement);
      const step = (delta: number): void => {
        const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
        if (!next) return;
        e.preventDefault();
        next.focus();
        select(next.dataset['id'] ?? '', { add: e.shiftKey });
      };
      switch (e.key) {
        case 'ArrowDown':
          step(1);
          break;
        case 'ArrowUp':
          step(-1);
          break;
        case 'Home':
          step(-list.length);
          break;
        case 'End':
          step(list.length);
          break;
        case 'Enter':
          e.preventDefault();
          void ctx.run(PORTFOLIO_COMMAND.openFile);
          break;
        case 'Delete':
          e.preventDefault();
          void ctx.run(PORTFOLIO_COMMAND.removeFiles);
          break;
        case 'a':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            service.setState({ selection: service.visibleFiles.map((f) => f.id) });
          }
          break;
        default:
          break;
      }
    });
  };

  // ---- files dropped from Explorer or Finder ------------------------------------------------------

  const onDragOver = (e: DragEvent): void => {
    if (e.dataTransfer?.types.includes('Files') !== true) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    host.classList.add('is-drop-target');
  };
  const onDragLeave = (): void => {
    host.classList.remove('is-drop-target');
  };
  const onDrop = (e: DragEvent): void => {
    host.classList.remove('is-drop-target');
    if (e.dataTransfer?.types.includes('Files') !== true) return;
    // Stops the shell's window-wide handler opening the PDFs in tabs instead.
    e.preventDefault();
    e.stopPropagation();
    void addDropped(e.dataTransfer);
  };
  host.addEventListener('dragover', onDragOver);
  host.addEventListener('dragleave', onDragLeave);
  host.addEventListener('drop', onDrop);
  disposers.push(() => {
    host.removeEventListener('dragover', onDragOver);
    host.removeEventListener('dragleave', onDragLeave);
    host.removeEventListener('drop', onDrop);
  });

  /**
   * Reads a drop from the OS. A folder arrives as a directory entry, which is walked so its
   * structure is kept — dropping a folder of statements gives a folder of statements.
   */
  const addDropped = async (data: DataTransfer): Promise<void> => {
    const items = Array.from(data.items).filter((i) => i.kind === 'file');
    const roots = items.map((i) => i.webkitGetAsEntry()).filter((e) => e !== null);
    const incoming: Array<{ name: string; bytes: Uint8Array; path: string; modified?: string }> =
      [];
    const readFile = (entry: FileSystemFileEntry, path: string): Promise<void> =>
      new Promise((resolve) => {
        entry.file(
          (file) => {
            void file.arrayBuffer().then((buffer) => {
              incoming.push({
                name: file.name,
                bytes: new Uint8Array(buffer),
                path,
                modified: new Date(file.lastModified).toISOString(),
              });
              resolve();
            });
          },
          () => {
            resolve();
          },
        );
      });
    const readDirectory = async (entry: FileSystemDirectoryEntry, path: string): Promise<void> => {
      const reader = entry.createReader();
      // `readEntries` answers in batches and signals the end with an empty one.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve) => {
          reader.readEntries(resolve, () => {
            resolve([]);
          });
        });
        if (batch.length === 0) break;
        for (const child of batch)
          await walk(child, path === '' ? entry.name : `${path}/${entry.name}`);
      }
    };
    const walk = async (entry: FileSystemEntry, path: string): Promise<void> => {
      if (entry.isFile) await readFile(entry as FileSystemFileEntry, path);
      else if (entry.isDirectory) await readDirectory(entry as FileSystemDirectoryEntry, path);
    };
    for (const entry of roots) await walk(entry, '');
    if (incoming.length === 0) {
      // No directory API (an older drop source): fall back to the plain file list.
      for (const file of Array.from(data.files)) {
        incoming.push({
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
          path: '',
          modified: new Date(file.lastModified).toISOString(),
        });
      }
    }
    if (incoming.length > 0) await service.addFiles(incoming);
  };

  disposers.push(
    service.watch(() => {
      render();
    }),
  );
  render();

  return {
    element: host,
    refresh: () => {
      thumbnails.forget();
      render();
    },
    dispose: () => {
      for (const d of disposers.splice(0)) d();
      host.remove();
      pageHost.hidden = false;
    },
  };
}

/** The ids carried by an internal drag, or an empty list when the drag is not ours. */
function readDraggedIds(e: DragEvent): string[] {
  const raw = e.dataTransfer?.getData('application/x-ynot-portfolio-file') ?? '';
  if (raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** One cell, formatted the way its column kind asks. */
function cellText(portfolio: Portfolio, file: PortfolioFile, column: PortfolioColumn): string {
  const value = columnValue(file, column);
  if (value === null) return '';
  switch (column.kind) {
    case 'size':
    case 'compressedSize':
      return formatBytes(file.size);
    case 'created':
    case 'modified':
      return formatDate(column.kind === 'created' ? file.created : file.modified);
    case 'date':
      return formatDate(file.fields[column.key] ?? null);
    default:
      return String(value);
  }
}
