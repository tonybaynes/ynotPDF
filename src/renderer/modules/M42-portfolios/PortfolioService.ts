/**
 * `PortfolioService` (M42) — everything a portfolio does that is not DOM. Registered as
 * `"portfolio"`.
 *
 * It owns:
 * - **reading**, once per open document, through M12's engine calls rather than a second reader;
 * - **the edits**, every one of them an undoable `Command` over one immutable value;
 * - **bringing files in** — from a dialog, from a folder, or dropped from Explorer or Finder —
 *   one file at a time with the status bar counting, so a 200 MB file does not freeze the window;
 * - **taking files out** — one, the selection, or all of them, folder structure preserved;
 * - **the cover sheet**, and **Save back into portfolio** for an embedded PDF opened in a tab.
 *
 * The grid is DOM and nothing else; every decision is here.
 */

import type { ShellServices } from '@app/services';
import type { DocumentTab } from '@app/tabs/Documents';
import type { Document } from '@core/Document';
import type { Registry } from '@core/Registry';
import { hasBridge, invoke, type FolderEntry } from '@shared/ipc';
import {
  blobKey,
  childFolders,
  descendantFolders,
  emptyPortfolio,
  filePath,
  filesInFolder,
  folderPath,
  namesInFolder,
  nextFolderId,
  nextOrder,
  reordered,
  ROOT_FOLDER_ID,
  sortedFiles,
  treeKey,
  uniqueName,
  withFile,
  withFilesAdded,
  withoutField,
  withoutFile,
  type ColumnKind,
  type Portfolio,
  type PortfolioColumn,
  type PortfolioFile,
  type PortfolioView,
} from '@shared/portfolio';
import { DOCUMENT_SERVICE, type DocumentService } from '@modules/M20-document-model/manifest';
import {
  NAVIGATION_SERVICE,
  type NavigationService,
} from '@modules/M12-navigation-panels/NavigationService';
import { VIEWER_SERVICE, type ViewerService } from '@modules/M11-viewer/manifest';
import {
  CoverSheetCommand,
  PortfolioEditCommand,
  portfolioOfDocument,
  ReplaceFileCommand,
  setPortfolioRecord,
} from './commands';
import { generateCover, plainFirstPage } from './cover';
import { portfolioFrom } from './read';
import {
  DEFAULT_PORTFOLIO_SETTINGS,
  ipcSettingsStorage,
  readPortfolioSettings,
  writePortfolioSetting,
  type PortfolioSettings,
  type SettingsStorage,
} from './settings';

export const PORTFOLIO_SERVICE = 'portfolio';

/** What the grid is showing, per tab. The portfolio itself lives in the document. */
export interface PortfolioUiState {
  /** Folder whose contents the grid lists. */
  folderId: number;
  /** Selected file ids, in the order the reader picked them. */
  selection: string[];
  /** Files, or the cover sheet. */
  pane: 'files' | 'cover';
}

/** A file on its way in: named, with its bytes and whatever the OS knew about it. */
export interface IncomingFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** Folder path inside the portfolio, `/`-separated. Empty for the root. */
  readonly path?: string;
  readonly modified?: string;
}

export interface PortfolioServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
  readonly storage?: SettingsStorage;
}

let addedFileSeq = 0;

export class PortfolioService {
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly storage: SettingsStorage;
  private settingsValue: PortfolioSettings = DEFAULT_PORTFOLIO_SETTINGS;
  private readonly ui = new Map<string, PortfolioUiState>();
  private readonly listeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];
  private readonly read = new Set<string>();
  /** Tabs opened from an embedded file: tab id → where it came from. */
  private readonly openedFrom = new Map<string, { documentId: string; fileId: string }>();

  constructor(options: PortfolioServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.storage = options.storage ?? ipcSettingsStorage();
    this.disposers.push(
      this.shell.documents.onAttached((tab) => {
        void this.documentOpened(tab);
      }),
      this.shell.documents.onClosed((tab) => {
        this.ui.delete(tab.id);
        this.read.delete(tab.id);
        this.openedFrom.delete(tab.id);
      }),
    );
  }

  // ---- settings --------------------------------------------------------------------------------

  get settings(): PortfolioSettings {
    return this.settingsValue;
  }

  async load(): Promise<void> {
    this.settingsValue = await readPortfolioSettings(this.storage);
    this.changed();
  }

  async setSetting<K extends keyof PortfolioSettings>(
    name: K,
    value: PortfolioSettings[K],
  ): Promise<PortfolioSettings[K]> {
    this.settingsValue = { ...this.settingsValue, [name]: value };
    await writePortfolioSetting(this.storage, name, value);
    this.changed();
    return value;
  }

  // ---- what the view subscribes to ---------------------------------------------------------------

  /** Fires when the portfolio, the selection, the folder or the active tab changes. */
  watch(listener: () => void): () => void {
    this.listeners.add(listener);
    let stopDocument: (() => void) | null = null;
    let watched: Document | null = null;
    const rebind = (): void => {
      const document = this.document;
      if (document === watched) return;
      stopDocument?.();
      watched = document;
      stopDocument =
        document?.store.subscribe(() => {
          listener();
        }) ?? null;
    };
    const stopTabs = this.shell.documents.subscribe(() => {
      rebind();
      listener();
    });
    rebind();
    return () => {
      this.listeners.delete(listener);
      stopDocument?.();
      stopTabs();
    };
  }

  private changed(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }

  // ---- the document ----------------------------------------------------------------------------

  get document(): Document | null {
    if (!this.registry.hasService(DOCUMENT_SERVICE)) return null;
    return this.registry.service<DocumentService>(DOCUMENT_SERVICE).active;
  }

  get tab(): DocumentTab | null {
    return this.shell.documents.active;
  }

  /** The active document's portfolio, or null when it is an ordinary file. */
  get portfolio(): Portfolio | null {
    const document = this.document;
    return document ? portfolioOfDocument(document) : null;
  }

  get isPortfolio(): boolean {
    return this.portfolio !== null;
  }

  /** The grid's own state for the active tab. */
  get state(): PortfolioUiState {
    const tab = this.tab;
    const id = tab?.id ?? 'none';
    let state = this.ui.get(id);
    if (!state) {
      state = {
        folderId: ROOT_FOLDER_ID,
        selection: [],
        pane: 'files',
      };
      this.ui.set(id, state);
    }
    return state;
  }

  setState(patch: Partial<PortfolioUiState>): void {
    Object.assign(this.state, patch);
    this.changed();
  }

  /** The files the grid is listing, in the order it shows them. */
  get visibleFiles(): ReadonlyArray<PortfolioFile> {
    const portfolio = this.portfolio;
    if (!portfolio) return [];
    return sortedFiles(portfolio, filesInFolder(portfolio, this.state.folderId));
  }

  get selectedFiles(): ReadonlyArray<PortfolioFile> {
    const portfolio = this.portfolio;
    if (!portfolio) return [];
    const ids = new Set(this.state.selection);
    return portfolio.files.filter((f) => ids.has(f.id));
  }

  /** Reads the portfolio out of a freshly opened document, once. */
  private async documentOpened(tab: DocumentTab): Promise<void> {
    if (this.read.has(tab.id)) return;
    this.read.add(tab.id);
    if (!this.registry.hasService(DOCUMENT_SERVICE)) return;
    const document = this.registry.service<DocumentService>(DOCUMENT_SERVICE).get(tab.id);
    if (!document) return;
    try {
      const collection = await document.engine.collection(document.handle);
      if (collection === null) return;
      const attachments = await document.engine.attachments(document.handle);
      const read = portfolioFrom(collection, attachments);
      if (read === null) return;
      // A file written for a navigator we do not have falls back to the reader's own preference
      // (M130's hook), rather than to whatever the format happened to say.
      const portfolio =
        collection.view === 'custom' ? { ...read, view: this.settingsValue.defaultView } : read;
      // Reading is not an edit: it must not make the document dirty and must not be undoable.
      setPortfolioRecord(document, portfolio);
      const state = this.ui.get(tab.id) ?? null;
      // `/View /H` is a portfolio asking to be shown as its cover sheet only. That is the file's
      // choice about its own contents, so it is honoured — the Files tab is still one click away.
      if (state) state.pane = portfolio.view === 'hidden' ? 'cover' : 'files';
      this.changed();
    } catch {
      // A file whose collection cannot be read is treated as an ordinary document; the
      // Attachments panel still lists whatever the engine found.
    }
  }

  // ---- running an edit ---------------------------------------------------------------------------

  /** Applies one structural change as an undoable command. */
  async edit(
    label: string,
    change: (portfolio: Portfolio) => Portfolio,
    options: {
      readonly mergeKey?: string;
      readonly blobs?: ReadonlyArray<{ readonly key: string; readonly bytes: Uint8Array }>;
    } = {},
  ): Promise<boolean> {
    const document = this.document;
    const portfolio = this.portfolio;
    if (!document || !portfolio) return false;
    const next = change(portfolio);
    await document.apply(new PortfolioEditCommand(document, label, next, options));
    this.changed();
    return true;
  }

  // ---- creating ----------------------------------------------------------------------------------

  /**
   * A new, empty portfolio in its own tab: a cover sheet and a `/Collection`, saved nowhere yet.
   * Everything else — files, folders, columns — is an edit on top of this.
   */
  async createEmpty(title = 'Portfolio'): Promise<Document | null> {
    if (!this.registry.hasService(DOCUMENT_SERVICE)) return null;
    const portfolio: Portfolio = { ...emptyPortfolio(), view: this.settingsValue.defaultView };
    // A PDF must have a page, so "no cover sheet" is a plain one rather than none at all: a
    // reader whose application cannot show portfolios still gets something to look at.
    const cover = this.settingsValue.coverSheetOnNew
      ? await generateCover(portfolio, { title })
      : await plainFirstPage(title);
    const service = this.registry.service<DocumentService>(DOCUMENT_SERVICE);
    const opened = await service.open(cover, { path: null, name: `${title}.pdf`, title });
    if (this.registry.hasService(VIEWER_SERVICE)) {
      await this.registry
        .service<ViewerService>(VIEWER_SERVICE)
        .attach(opened.tab, opened.document);
    }
    this.read.add(opened.tab.id);
    // The document *becomes* a portfolio here, which is a change to it: an undoable one, so the
    // reader can back out of "New portfolio" the way they can back out of anything else.
    await opened.document.apply(
      new PortfolioEditCommand(opened.document, 'New portfolio', {
        ...portfolio,
        generatedCover: this.settingsValue.coverSheetOnNew,
      }),
    );
    this.changed();
    return opened.document;
  }

  // ---- bringing files in -------------------------------------------------------------------------

  /** Asks for files and adds them to the current folder. Returns how many arrived. */
  async addFilesFromDialog(): Promise<number> {
    if (!hasBridge()) return 0;
    const files = await invoke('file:openFilesDialog', {
      title: 'Choose files to add to the portfolio',
      buttonLabel: 'Add',
      multi: true,
    });
    if (files.length === 0) return 0;
    return await this.addFiles(files.map((f) => ({ name: f.name, bytes: f.bytes })));
  }

  /**
   * Asks for a folder and adds everything in it, keeping the folder structure.
   *
   * The tree is listed first, metadata only, and the files are then read one at a time — a
   * folder of a thousand scans must not become one enormous message, and the status bar has to
   * be able to count.
   */
  async addFolderFromDialog(): Promise<number> {
    if (!hasBridge()) return 0;
    const dir = await invoke('dialog:pickFolder', 'Choose a folder to add to the portfolio');
    if (dir === null) return 0;
    const entries = await invoke('file:readFolder', dir, { recursive: true });
    if (entries.length === 0) {
      this.shell.toasts.show({ kind: 'info', text: 'That folder has no files in it.' });
      return 0;
    }
    return await this.addFromDisk(entries);
  }

  /** Reads the listed files one at a time and adds them, with progress in the status bar. */
  async addFromDisk(entries: ReadonlyArray<FolderEntry>): Promise<number> {
    const incoming: IncomingFile[] = [];
    const total = entries.length;
    let done = 0;
    for (const entry of entries) {
      this.status(`Reading ${entry.name} (${String(done + 1)} of ${String(total)})…`);
      try {
        const file = await invoke('file:read', entry.path);
        const slash = entry.relativePath.lastIndexOf('/');
        incoming.push({
          name: entry.name,
          bytes: file.bytes,
          path: slash < 0 ? '' : entry.relativePath.slice(0, slash),
          modified: entry.modified,
        });
      } catch {
        this.shell.toasts.show({ kind: 'error', text: `Could not read ${entry.name}` });
      }
      done++;
      // Let the window paint between files: a 200 MB file arriving must not freeze the grid.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.status(null);
    return await this.addFiles(incoming);
  }

  /**
   * Adds files to the portfolio in one undoable step, creating any folder their path names.
   *
   * A name already used in its folder gets " (2)" — the name tree cannot hold a duplicate key,
   * so this is correctness rather than tidiness.
   */
  async addFiles(files: ReadonlyArray<IncomingFile>): Promise<number> {
    if (files.length === 0) return 0;
    const blobs: Array<{ key: string; bytes: Uint8Array }> = [];
    let added = 0;
    const ok = await this.edit(
      files.length === 1 ? `Add ${files[0]?.name ?? 'file'}` : `Add ${String(files.length)} files`,
      (portfolio) => {
        let next = portfolio;
        for (const file of files) {
          const folderId = this.ensureFolderPath(next, file.path ?? '');
          next = folderId.portfolio;
          const name = uniqueName(namesInFolder(next, folderId.id), file.name);
          const id = `added:${String(++addedFileSeq)}`;
          const record: PortfolioFile = {
            id,
            name,
            folderId: folderId.id,
            description: null,
            mimeType: mimeTypeFor(name),
            size: file.bytes.length,
            created: new Date().toISOString(),
            modified: file.modified ?? new Date().toISOString(),
            fields: {},
            order: nextOrder(next),
            source: { kind: 'added' },
          };
          blobs.push({ key: blobKey(id), bytes: file.bytes });
          next = withFilesAdded(next, [record]);
          added++;
        }
        return next;
      },
      { blobs },
    );
    if (!ok) return 0;
    this.shell.toasts.show({
      kind: 'success',
      text: added === 1 ? '1 file added to the portfolio' : `${String(added)} files added`,
    });
    return added;
  }

  /** Makes sure every folder on a `/`-separated path exists, and answers with the deepest id. */
  private ensureFolderPath(
    portfolio: Portfolio,
    path: string,
  ): { readonly portfolio: Portfolio; readonly id: number } {
    let current = portfolio;
    let parent = this.state.folderId;
    if (!current.folders.some((f) => f.id === parent)) parent = ROOT_FOLDER_ID;
    for (const part of path.split('/').filter((p) => p !== '')) {
      const existing = childFolders(current, parent).find((f) => f.name === part);
      if (existing) {
        parent = existing.id;
        continue;
      }
      const id = nextFolderId(current);
      const now = new Date().toISOString();
      current = {
        ...current,
        folders: [
          ...current.folders,
          { id, name: part, parentId: parent, description: null, created: now, modified: now },
        ],
      };
      parent = id;
    }
    return { portfolio: current, id: parent };
  }

  // ---- folders ------------------------------------------------------------------------------------

  async addFolder(name: string): Promise<boolean> {
    const parent = this.state.folderId;
    return await this.edit(`New folder ${name}`, (portfolio) => {
      const id = nextFolderId(portfolio);
      const now = new Date().toISOString();
      const taken = childFolders(portfolio, parent).map((f) => f.name);
      return {
        ...portfolio,
        folders: [
          ...portfolio.folders,
          {
            id,
            name: uniqueName(taken, name),
            parentId: parent,
            description: null,
            created: now,
            modified: now,
          },
        ],
      };
    });
  }

  async renameFolder(folderId: number, name: string): Promise<boolean> {
    if (folderId === ROOT_FOLDER_ID) return false;
    return await this.edit(`Rename folder to ${name}`, (portfolio) => ({
      ...portfolio,
      folders: portfolio.folders.map((f) => (f.id === folderId ? { ...f, name } : f)),
    }));
  }

  /** Removes a folder, everything under it, and every file in any of them. */
  async removeFolder(folderId: number): Promise<boolean> {
    if (folderId === ROOT_FOLDER_ID) return false;
    const portfolio = this.portfolio;
    const folder = portfolio?.folders.find((f) => f.id === folderId);
    if (!portfolio || !folder) return false;
    const gone = new Set([folderId, ...descendantFolders(portfolio, folderId).map((f) => f.id)]);
    const count = portfolio.files.filter((f) => gone.has(f.folderId)).length;
    const confirmed = await this.shell.dialogs.confirm({
      title: 'Remove folder',
      kind: 'warning',
      text:
        count === 0
          ? `Remove the folder "${folder.name}" from the portfolio?`
          : `Remove the folder "${folder.name}" and the ${count === 1 ? 'file' : `${String(count)} files`} in it?`,
      confirmLabel: 'Remove',
      cancelLabel: 'Keep it',
      danger: true,
    });
    if (!confirmed) return false;
    if (this.state.folderId === folderId) this.setState({ folderId: ROOT_FOLDER_ID });
    return await this.edit(`Remove folder ${folder.name}`, (current) => ({
      ...current,
      folders: current.folders.filter((f) => !gone.has(f.id)),
      files: current.files.filter((f) => !gone.has(f.folderId)),
    }));
  }

  // ---- file edits ---------------------------------------------------------------------------------

  async renameFile(fileId: string, name: string): Promise<boolean> {
    const portfolio = this.portfolio;
    const file = portfolio?.files.find((f) => f.id === fileId);
    if (!portfolio || !file || name.trim() === '') return false;
    const unique = uniqueName(namesInFolder(portfolio, file.folderId, fileId), name.trim());
    return await this.edit(`Rename to ${unique}`, (current) =>
      withFile(current, { ...file, name: unique }),
    );
  }

  async describeFile(fileId: string, description: string): Promise<boolean> {
    const file = this.portfolio?.files.find((f) => f.id === fileId);
    if (!file) return false;
    return await this.edit(
      `Describe ${file.name}`,
      (current) => {
        const target = current.files.find((f) => f.id === fileId);
        return target
          ? withFile(current, { ...target, description: description || null })
          : current;
      },
      { mergeKey: `describe:${fileId}` },
    );
  }

  async setFieldValue(fileId: string, key: string, value: string): Promise<boolean> {
    const file = this.portfolio?.files.find((f) => f.id === fileId);
    if (!file) return false;
    return await this.edit(
      `Set ${key} for ${file.name}`,
      (current) => {
        const target = current.files.find((f) => f.id === fileId);
        if (!target) return current;
        const fields =
          value === '' ? withoutField(target.fields, key) : { ...target.fields, [key]: value };
        return withFile(current, { ...target, fields });
      },
      { mergeKey: `field:${fileId}:${key}` },
    );
  }

  async removeFiles(ids: ReadonlyArray<string>): Promise<boolean> {
    const portfolio = this.portfolio;
    if (!portfolio || ids.length === 0) return false;
    const names = portfolio.files.filter((f) => ids.includes(f.id)).map((f) => f.name);
    if (names.length === 0) return false;
    const confirmed = await this.shell.dialogs.confirm({
      title: names.length === 1 ? 'Remove file' : 'Remove files',
      kind: 'warning',
      text:
        names.length === 1
          ? `Remove "${names[0] ?? ''}" from the portfolio? Its contents go with it.`
          : `Remove ${String(names.length)} files from the portfolio? Their contents go with them.`,
      confirmLabel: 'Remove',
      cancelLabel: 'Keep them',
      danger: true,
    });
    if (!confirmed) return false;
    this.setState({ selection: [] });
    return await this.edit(
      names.length === 1 ? `Remove ${names[0] ?? 'file'}` : `Remove ${String(names.length)} files`,
      (current) => {
        let next = current;
        for (const id of ids) next = withoutFile(next, id);
        return next;
      },
    );
  }

  async moveToFolder(ids: ReadonlyArray<string>, folderId: number): Promise<boolean> {
    const portfolio = this.portfolio;
    if (!portfolio || ids.length === 0) return false;
    const target = portfolio.folders.find((f) => f.id === folderId);
    if (!target) return false;
    const where = folderId === ROOT_FOLDER_ID ? 'the top level' : target.name;
    return await this.edit(`Move to ${where}`, (current) => {
      let next = current;
      for (const id of ids) {
        const file = next.files.find((f) => f.id === id);
        if (!file || file.folderId === folderId) continue;
        const name = uniqueName(namesInFolder(next, folderId), file.name);
        next = withFile(next, { ...file, folderId, name });
      }
      return next;
    });
  }

  /** Moves the selection one place up or down in the reader's own order. */
  async nudge(direction: -1 | 1): Promise<boolean> {
    const portfolio = this.portfolio;
    if (!portfolio) return false;
    const order = sortedFiles(portfolio).map((f) => f.id);
    const chosen = new Set(this.state.selection);
    if (chosen.size === 0) return false;
    const next = [...order];
    const indexes = next
      .map((id, i) => (chosen.has(id) ? i : -1))
      .filter((i) => i >= 0)
      .sort((a, b) => (direction < 0 ? a - b : b - a));
    for (const index of indexes) {
      const to = index + direction;
      if (to < 0 || to >= next.length) continue;
      const moving = next[index];
      const other = next[to];
      if (moving === undefined || other === undefined) continue;
      if (chosen.has(other)) continue;
      next[index] = other;
      next[to] = moving;
    }
    return await this.reorder(next);
  }

  /** Puts the files in exactly this order. What a drag produces. */
  async reorder(ids: ReadonlyArray<string>): Promise<boolean> {
    return await this.edit('Reorder files', (portfolio) => reordered(portfolio, ids));
  }

  // ---- the collection itself ------------------------------------------------------------------------

  async setView(view: PortfolioView): Promise<boolean> {
    return await this.edit(`Show as ${view === 'tile' ? 'tiles' : view}`, (portfolio) => ({
      ...portfolio,
      view,
    }));
  }

  async setSort(key: string, ascending: boolean): Promise<boolean> {
    return await this.edit('Sort files', (portfolio) => ({
      ...portfolio,
      sort: { key, ascending },
    }));
  }

  async setInitialFile(name: string | null): Promise<boolean> {
    return await this.edit(
      name === null ? 'Clear the file shown first' : `Show ${name} first`,
      (portfolio) => ({ ...portfolio, initialFile: name }),
    );
  }

  async addColumn(label: string, kind: ColumnKind): Promise<boolean> {
    const portfolio = this.portfolio;
    if (!portfolio) return false;
    const key = uniqueColumnKey(portfolio, label);
    const order = portfolio.schema.reduce((max, c) => Math.max(max, c.order), 0) + 1;
    const column: PortfolioColumn = { key, label, kind, order, visible: true };
    return await this.edit(`Add column ${label}`, (current) => ({
      ...current,
      schema: [...current.schema, column],
    }));
  }

  async removeColumn(key: string): Promise<boolean> {
    const portfolio = this.portfolio;
    const column = portfolio?.schema.find((c) => c.key === key);
    if (!portfolio || !column) return false;
    if (key === portfolio.orderKey) {
      this.shell.toasts.show({
        kind: 'error',
        text: 'That column holds the file order and cannot be removed.',
      });
      return false;
    }
    return await this.edit(`Remove column ${column.label}`, (current) => ({
      ...current,
      schema: current.schema.filter((c) => c.key !== key),
      files: current.files.map((f) =>
        key in f.fields ? { ...f, fields: withoutField(f.fields, key) } : f,
      ),
      sort: current.sort?.key === key ? { key: current.orderKey, ascending: true } : current.sort,
    }));
  }

  // ---- the cover sheet -------------------------------------------------------------------------------

  /**
   * Draws a cover sheet and makes it the document's page. Never happens on its own: the reader
   * asks for it, from the ribbon or the command palette.
   */
  async regenerateCover(subtitle?: string): Promise<boolean> {
    const document = this.document;
    const portfolio = this.portfolio;
    if (!document || !portfolio) return false;
    const title = document.state.title ?? this.tab?.title ?? 'Portfolio';
    const bytes = await generateCover(portfolio, {
      title,
      ...(subtitle === undefined ? {} : { subtitle }),
    });
    await document.apply(
      new CoverSheetCommand(document, 'Generate cover sheet', bytes, {
        ...portfolio,
        generatedCover: true,
      }),
    );
    this.changed();
    this.shell.toasts.show({ kind: 'success', text: 'Cover sheet generated' });
    return true;
  }

  /** Uses a PDF the reader chooses as the cover instead of a generated one. */
  async useCoverFromFile(): Promise<boolean> {
    const document = this.document;
    const portfolio = this.portfolio;
    if (!document || !portfolio || !hasBridge()) return false;
    const files = await invoke('file:openFilesDialog', {
      title: 'Choose a PDF to use as the cover sheet',
      buttonLabel: 'Use as cover',
      multi: false,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    const chosen = files[0];
    if (!chosen) return false;
    await document.apply(
      new CoverSheetCommand(document, `Use ${chosen.name} as the cover`, chosen.bytes, {
        ...portfolio,
        generatedCover: false,
      }),
    );
    this.changed();
    return true;
  }

  // ---- taking files out --------------------------------------------------------------------------------

  /** The bytes of one file: from the engine when it is embedded, from memory when it is new. */
  async bytesOf(file: PortfolioFile): Promise<Uint8Array | null> {
    const document = this.document;
    if (!document) return null;
    const source = file.source;
    if (source.kind === 'added') return document.blobs.get(blobKey(file.id)) ?? null;
    const attachments = await document.engine.attachments(document.handle);
    const match =
      attachments.find((a) => a.treeKey === source.treeKey) ??
      attachments.find((a) => a.name === file.name);
    if (!match) return null;
    return await document.engine.attachmentData(document.handle, match.id);
  }

  /** Saves one file wherever the reader says. */
  async extractOne(fileId: string): Promise<string | null> {
    const file = this.portfolio?.files.find((f) => f.id === fileId);
    if (!file || !hasBridge()) return null;
    const bytes = await this.bytesOf(file);
    if (!bytes) {
      this.shell.toasts.show({ kind: 'error', text: `Could not read ${file.name}` });
      return null;
    }
    const path = await invoke('file:saveAsDialog', {
      defaultPath: file.name,
      title: `Save ${file.name}`,
      buttonLabel: 'Save',
    });
    if (path === null) return null;
    await invoke('file:write', path, bytes);
    this.shell.toasts.show({ kind: 'success', text: `Saved ${file.name}` });
    return path;
  }

  /**
   * Writes files into a folder the reader chooses, keeping the portfolio's own folder structure.
   * One file at a time, with the status bar counting, so a big portfolio never holds every file
   * in memory at once.
   */
  async extractMany(files: ReadonlyArray<PortfolioFile>): Promise<number> {
    const portfolio = this.portfolio;
    if (!portfolio || files.length === 0 || !hasBridge()) return 0;
    const dir = await invoke('dialog:pickFolder', 'Choose where to put the extracted files');
    if (dir === null) return 0;
    let written = 0;
    for (const [index, file] of files.entries()) {
      this.status(`Extracting ${file.name} (${String(index + 1)} of ${String(files.length)})…`);
      const bytes = await this.bytesOf(file);
      if (!bytes) {
        this.shell.toasts.show({ kind: 'error', text: `Could not read ${file.name}` });
        continue;
      }
      try {
        await invoke('file:writeInto', dir, filePath(portfolio, file), bytes);
        written++;
      } catch (error) {
        this.shell.toasts.show({
          kind: 'error',
          text: `Could not write ${file.name}: ${messageOf(error)}`,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.status(null);
    this.shell.toasts.show({
      kind: 'success',
      text: written === 1 ? '1 file extracted' : `${String(written)} files extracted`,
    });
    return written;
  }

  // ---- opening an embedded file, and putting it back ---------------------------------------------------

  /** Opens a file: an embedded PDF in a new tab, anything else in the OS default application. */
  async open(fileId: string): Promise<'tab' | 'os' | 'failed'> {
    const document = this.document;
    const file = this.portfolio?.files.find((f) => f.id === fileId);
    if (!document || !file) return 'failed';
    const bytes = await this.bytesOf(file);
    if (!bytes || bytes.length === 0) {
      this.shell.toasts.show({ kind: 'error', text: `${file.name} is empty` });
      return 'failed';
    }
    if (isPdfFile(file.name, file.mimeType, bytes)) {
      const nav = this.navigation;
      const opened = nav ? await nav.openBytesInTab(file.name, bytes) : false;
      if (opened) {
        const tab = this.shell.documents.active;
        if (tab) this.openedFrom.set(tab.id, { documentId: document.id, fileId });
        return 'tab';
      }
      return 'failed';
    }
    if (!hasBridge()) return 'failed';
    try {
      await invoke('shell:openTempFile', file.name, bytes);
      return 'os';
    } catch (error) {
      this.shell.toasts.show({
        kind: 'error',
        text: `Could not open ${file.name}: ${messageOf(error)}`,
      });
      return 'failed';
    }
  }

  /** Whether the active tab is an embedded file opened out of a portfolio that is still open. */
  get canSaveBack(): boolean {
    return this.sourceOfActiveTab() !== null;
  }

  private sourceOfActiveTab(): { document: Document; fileId: string } | null {
    const tab = this.shell.documents.active;
    const origin = tab ? this.openedFrom.get(tab.id) : undefined;
    if (!origin || !this.registry.hasService(DOCUMENT_SERVICE)) return null;
    const service = this.registry.service<DocumentService>(DOCUMENT_SERVICE);
    const document = service.all().find((d) => d.id === origin.documentId);
    if (!document) return null;
    return portfolioOfDocument(document) ? { document, fileId: origin.fileId } : null;
  }

  /**
   * Puts an edited embedded file back where it came from.
   *
   * The portfolio keeps everything it knew about the file — its name, its description, its
   * column values, its place in the order — and only the bytes change, which is what "replace"
   * means here and what an operator expects after correcting a supporting document.
   */
  async saveBack(): Promise<boolean> {
    const source = this.sourceOfActiveTab();
    const active = this.document;
    if (!source || !active) return false;
    const portfolio = portfolioOfDocument(source.document);
    const file = portfolio?.files.find((f) => f.id === source.fileId);
    if (!portfolio || !file) return false;
    const bytes = await active.engine.save(active.handle);
    const next: Portfolio = {
      ...portfolio,
      files: portfolio.files.map((f) =>
        f.id === file.id
          ? {
              ...f,
              size: bytes.length,
              modified: new Date().toISOString(),
              source: { kind: 'added' as const },
            }
          : f,
      ),
    };
    await source.document.apply(new ReplaceFileCommand(source.document, file.id, next, bytes));
    // The portfolio is now the one with unsaved changes, and it says so. This tab keeps its own
    // dirty flag: M20 drives that from the document's own journal, and the file still has no
    // path of its own — closing it should still ask, because the copy on this tab is not saved
    // anywhere until the portfolio is.
    this.shell.toasts.show({
      kind: 'success',
      text: `${file.name} saved back into the portfolio. Save the portfolio to keep it.`,
    });
    this.changed();
    return true;
  }

  /** Replaces one file's content from a file on disk, keeping its metadata. */
  async replaceContent(fileId: string): Promise<boolean> {
    const document = this.document;
    const portfolio = this.portfolio;
    const file = portfolio?.files.find((f) => f.id === fileId);
    if (!document || !portfolio || !file || !hasBridge()) return false;
    const files = await invoke('file:openFilesDialog', {
      title: `Choose the file to put in place of ${file.name}`,
      buttonLabel: 'Replace',
      multi: false,
    });
    const chosen = files[0];
    if (!chosen) return false;
    const next: Portfolio = {
      ...portfolio,
      files: portfolio.files.map((f) =>
        f.id === fileId
          ? {
              ...f,
              size: chosen.bytes.length,
              modified: new Date().toISOString(),
              source: { kind: 'added' as const },
            }
          : f,
      ),
    };
    await document.apply(new ReplaceFileCommand(document, fileId, next, chosen.bytes));
    this.shell.toasts.show({ kind: 'success', text: `${file.name} replaced` });
    this.changed();
    return true;
  }

  // ---- helpers ---------------------------------------------------------------------------------------

  /** The folder path shown in the grid's breadcrumb. */
  path(folderId: number): string {
    const portfolio = this.portfolio;
    return portfolio ? folderPath(portfolio, folderId) : '';
  }

  /** The name-tree key a file would be saved under; shown in the properties list. */
  keyOf(file: PortfolioFile): string {
    return treeKey(file.name, file.folderId);
  }

  private get navigation(): NavigationService | null {
    return this.registry.hasService(NAVIGATION_SERVICE)
      ? this.registry.service<NavigationService>(NAVIGATION_SERVICE)
      : null;
  }

  /** Says what is happening, in the status bar. `null` puts it back to Ready. */
  note(message: string | null): void {
    this.status(message);
  }

  private status(message: string | null): void {
    const shell = this.registry.hasService('shell')
      ? this.registry.service<{ set(v: { statusMessage: string }): void }>('shell')
      : null;
    shell?.set({ statusMessage: message ?? 'Ready' });
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
    this.listeners.clear();
    this.ui.clear();
  }
}

/** A schema key nothing else uses, derived from the label the reader typed. */
export function uniqueColumnKey(portfolio: Portfolio, label: string): string {
  const base = label.replace(/[^A-Za-z0-9]+/g, '') || 'Column';
  let key = base;
  let n = 2;
  while (portfolio.schema.some((c) => c.key === key)) key = `${base}${String(n++)}`;
  return key;
}

/**
 * The MIME type a name implies. Small and deliberately conservative: what matters is that a PDF
 * is called a PDF, because the type decides whether a double-click opens a tab or the OS.
 */
export function mimeTypeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  zip: 'application/zip',
};

/**
 * Whether a file is a PDF. The extension and the bytes are believed before the declared type,
 * because real files lie about it — the operator's own Foxit-made portfolio declares
 * `text/plain` on three embedded PDFs (M12).
 */
export function isPdfFile(name: string, mimeType: string | null, bytes?: Uint8Array): boolean {
  if (name.toLowerCase().endsWith('.pdf')) return true;
  if (bytes && bytes.length >= 5) {
    if (String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') return true;
  }
  return mimeType?.toLowerCase().includes('pdf') ?? false;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
