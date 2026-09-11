/**
 * `LinkService` (M53, ADR 0020) — drawing, following, creating and editing links. Registered as
 * the service `"links"`.
 *
 * A link is an ordinary `Link` annotation, so every change is one of M20's own commands and undo
 * needs nothing new. What this service adds is everything around them: reading a page's links
 * from the engine, keeping the overlay in step, following one safely, and finding the addresses
 * written in the text so a reader can turn them into links in one go.
 *
 * **Following a link is treated as the document asking to run something.** Only `http(s)` ever
 * reaches the operating system, and even then the reader is shown the whole address first unless
 * they have turned that off. `file:`, `javascript:` and everything else is refused in words —
 * the same answer M12 gives for a bookmark.
 */

import type { ShellServices } from '@app/services';
import type { Registry } from '@core/Registry';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import type { ModelAnnotation } from '@core/model';
import {
  AddAnnotationCommand,
  DeleteAnnotationCommand,
  UpdateAnnotationCommand,
  DEFAULT_ANNOTATION_FLAGS,
  draftAnnotation,
} from '@core/commands';
import type { Link, PdfEngine } from '@engine/PdfEngine';
import { detectLinks, type LinkCandidate } from '@engine/decorations/links';
import { hasBridge, invoke } from '@shared/ipc';
import type { PdfRect } from '@shared/pdf';
import { LinkLayer, type LayerLink } from '@view/LinkLayer';
import { VIEWER_SERVICE, type ViewerService } from '@modules/M11-viewer/ViewerService';
import { DOCUMENT_SERVICE, type DocumentService } from '@modules/M20-document-model/manifest';
import {
  actionExtra,
  describeAction,
  isFollowableUri,
  isMailto,
  readAction,
  readBorder,
  DEFAULT_BORDER,
  type LinkAction,
  type LinkBorder,
  type LinkInfo,
} from './links';

export const LINK_SERVICE = 'links';
export const LINK_TOOL_ID = 'tool.link';

interface TabState {
  readonly tabId: string;
  readonly layer: LinkLayer;
  readonly disposers: Array<() => void>;
  readonly pages: Map<number, ReadonlyArray<LinkInfo>>;
  selection: ReadonlyArray<string>;
  page: number | null;
}

export interface LinkServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
}

export class LinkService {
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly tabs = new Map<string, TabState>();
  private readonly listeners = new Set<() => void>();
  /** Addresses the reader has already agreed to open this session, so one yes is enough. */
  private readonly trusted = new Set<string>();
  private editing = false;
  private outlines = true;
  private confirmExternal = true;
  private detectBare = true;
  private disposed = false;

  constructor(options: LinkServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
  }

  // ---- wiring ----------------------------------------------------------------------------------

  private viewer(): ViewerService | null {
    return this.registry.hasService(VIEWER_SERVICE)
      ? this.registry.service<ViewerService>(VIEWER_SERVICE)
      : null;
  }

  private documents(): DocumentService | null {
    return this.registry.hasService(DOCUMENT_SERVICE)
      ? this.registry.service<DocumentService>(DOCUMENT_SERVICE)
      : null;
  }

  activeDocument(): Document | null {
    return this.documents()?.active ?? null;
  }

  activeTabId(): string | null {
    return this.shell.documents.state.active;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
    this.shell.invalidate();
  }

  /**
   * Follows the reader's preferences. The decoration service owns the reading of them — M130
   * calls its `load()` after a change — and hands them here.
   */
  setSettings(settings: {
    readonly confirmExternalLinks: boolean;
    readonly showLinkOutlines: boolean;
    readonly detectBareLinks: boolean;
  }): void {
    this.confirmExternal = settings.confirmExternalLinks;
    this.outlines = settings.showLinkOutlines;
    this.detectBare = settings.detectBareLinks;
    for (const tab of this.tabs.values()) tab.layer.setOutlines(this.outlines);
  }

  /** Turns the editing outlines on and off — the link tool becoming active, and going away. */
  setEditing(editing: boolean): void {
    this.ensureBound();
    if (this.editing === editing) return;
    this.editing = editing;
    for (const tab of this.tabs.values()) tab.layer.setMode(editing ? 'edit' : 'read');
    if (!editing) this.clearSelection();
    void this.refresh();
    this.notify();
  }

  get isEditing(): boolean {
    return this.editing;
  }

  /**
   * Binds any tab that has a viewer and no layer yet.
   *
   * A tab appears in the shell before M11 has built its viewer, so binding on the tab list alone
   * misses the first document of the session — the one the reader opened. Every entry point calls
   * this first, which costs a map lookup and means the layer is there whenever anything asks.
   */
  ensureBound(): void {
    for (const tab of this.shell.documents.state.tabs) this.bind(tab.id);
  }

  /** Attaches a layer to a tab's panes. Called when a document is shown. */
  bind(tabId: string): void {
    if (this.tabs.has(tabId) || this.disposed) return;
    const viewer = this.viewer()?.get(tabId);
    if (!viewer) return;
    const layer = new LinkLayer();
    layer.setMode(this.editing ? 'edit' : 'read');
    layer.setOutlines(this.outlines);
    const state: TabState = {
      tabId,
      layer,
      disposers: [],
      pages: new Map(),
      selection: [],
      page: null,
    };
    for (const pane of viewer.allPanes) state.disposers.push(layer.attach(pane));
    layer.setHandlers({
      onFollow: (id) => {
        void this.follow(id);
      },
      onSelect: (id, additive) => {
        this.select(id, additive);
      },
      onOpen: (id) => {
        const modelId = this.link(id)?.modelId ?? null;
        if (modelId !== null) void this.editLink(modelId);
      },
    });
    this.tabs.set(tabId, state);
    void this.refresh(tabId);
  }

  unbind(tabId: string): void {
    const state = this.tabs.get(tabId);
    if (!state) return;
    for (const dispose of state.disposers.splice(0)) dispose();
    state.layer.dispose();
    this.tabs.delete(tabId);
  }

  dispose(): void {
    this.disposed = true;
    for (const tabId of [...this.tabs.keys()]) this.unbind(tabId);
    this.listeners.clear();
  }

  // ---- reading ---------------------------------------------------------------------------------

  /** Re-reads the links on every page a pane is showing, and repaints. */
  async refresh(tabId?: string): Promise<void> {
    this.ensureBound();
    const documents = this.documents();
    const viewer = this.viewer();
    if (!documents || !viewer) return;
    const ids = tabId === undefined ? [...this.tabs.keys()] : [tabId];
    for (const id of ids) {
      const state = this.tabs.get(id);
      const doc = documents.get(id);
      const view = viewer.get(id);
      if (!state || !doc || !view) continue;
      const pages = new Set<number>();
      for (const pane of view.allPanes) for (const r of pane.layoutTable.rects) pages.add(r.page);
      for (const page of pages) await this.loadPage(state, doc, page);
    }
    this.notify();
  }

  /**
   * Reads every page of the active document, not only the ones a pane is showing.
   *
   * What the panel and the tests want is the whole document's links; what a repaint wants is the
   * pages on screen. Keeping them apart is what stops opening a thousand-page file reading a
   * thousand pages before it can draw one.
   */
  async readEveryPage(): Promise<void> {
    this.ensureBound();
    const tabId = this.activeTabId();
    const state = tabId === null ? undefined : this.tabs.get(tabId);
    const doc = this.activeDocument();
    if (!state || !doc) return;
    for (let page = 0; page < doc.state.pages.length; page++) {
      await this.loadPage(state, doc, page);
    }
    this.notify();
  }

  /** Forgets what was read for a tab (a reload, a page reorder). */
  forget(tabId: string): void {
    this.tabs.get(tabId)?.pages.clear();
    this.tabs.get(tabId)?.layer.clear();
  }

  private async loadPage(state: TabState, doc: Document, page: number): Promise<void> {
    const modelPage = doc.state.pages[page];
    if (!modelPage) return;
    const links = await this.readPage(doc, modelPage.id, page);
    state.pages.set(page, links);
    state.layer.setLinks(
      page,
      links.map((link) => this.toLayerLink(doc, link)),
    );
    state.layer.setSelection(page, new Set(state.selection));
  }

  /**
   * A page's links.
   *
   * **Reading a page never changes the document.** The file's own links come from
   * `PdfEngine.links`, which is a read; the model's `Link` annotations are added for a page whose
   * annotations something else has already loaded, and for the links this session made. Loading
   * them ourselves would be worse than useless: `Document.loadAnnotations` replaces the model's
   * list with PDFium's, and PDFium cannot create a Line dimension or a Caret — so it would
   * quietly delete the measurement the reader had just drawn. The link tool loads them when it is
   * chosen, which is when the reader has asked to work on links.
   */
  private async readPage(
    doc: Document,
    pageId: ModelId,
    page: number,
  ): Promise<ReadonlyArray<LinkInfo>> {
    const index = doc.enginePage(pageId);
    let fromEngine: ReadonlyArray<Link> = [];
    if (index !== undefined) {
      try {
        fromEngine = await doc.engine.links(doc.handle, index);
      } catch {
        fromEngine = [];
      }
    }
    const loaded = this.editing && index !== undefined ? await annotationsOf(doc, pageId) : null;
    const annotations = (loaded ?? doc.annotations(pageId)).filter((a) => a.subtype === 'Link');
    const out: LinkInfo[] = annotations.map((a) => this.toInfo(doc, a, pageId, page, fromEngine));
    // A link the file carries that no model annotation stands for: visible and followable, and
    // editable as soon as the page's annotations are read.
    const claimed = new Set(out.map((info) => rectKey(info.rect)));
    fromEngine.forEach((link, at) => {
      if (claimed.has(rectKey(link.rect))) return;
      out.push({
        id: `e${String(page)}.${String(at)}`,
        modelId: null,
        pageId,
        page,
        rect: link.rect,
        action: engineAction(doc, link),
        border: DEFAULT_BORDER,
      });
    });
    return out;
  }

  private toInfo(
    doc: Document,
    annotation: ModelAnnotation,
    pageId: ModelId,
    page: number,
    fromEngine: ReadonlyArray<Link>,
  ): LinkInfo {
    let action = readAction(annotation.extra);
    if (action.kind === 'none') {
      const engineId = doc.idTable.engineKey('annotation', annotation.id);
      const match =
        fromEngine.find((l) => engineId !== undefined && l.annotationId === engineId) ??
        fromEngine.find((l) => sameRect(l.rect, annotation.rect));
      if (match) action = engineAction(doc, match);
    }
    return {
      id: String(annotation.id),
      modelId: annotation.id,
      pageId,
      page,
      rect: annotation.rect,
      action,
      border: readBorder(annotation),
    };
  }

  private toLayerLink(doc: Document, link: LinkInfo): LayerLink {
    return {
      id: link.id,
      rect: link.rect,
      label: describeAction(link.action, (id) => {
        const index = doc.state.pages.findIndex((p) => p.id === id);
        return index < 0 ? null : index + 1;
      }),
      visible: link.border.width > 0,
    };
  }

  /** The rectangle a drag is making, so the tool can show it before it is a link. */
  setDraft(draft: { readonly page: number; readonly rect: PdfRect } | null): void {
    this.ensureBound();
    const tabId = this.activeTabId();
    const state = tabId === null ? undefined : this.tabs.get(tabId);
    state?.layer.setDraft(draft);
  }

  /** Every link the service currently holds for a document, in page order. */
  all(tabId?: string): ReadonlyArray<LinkInfo> {
    const id = tabId ?? this.activeTabId();
    const state = id === null ? undefined : this.tabs.get(id);
    if (!state) return [];
    return [...state.pages.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, links]) => links);
  }

  link(id: string): LinkInfo | null {
    for (const link of this.all()) if (link.id === id) return link;
    return null;
  }

  // ---- selection -------------------------------------------------------------------------------

  get selection(): ReadonlyArray<string> {
    const id = this.activeTabId();
    return (id === null ? undefined : this.tabs.get(id)?.selection) ?? [];
  }

  select(id: string, additive = false): void {
    const tabId = this.activeTabId();
    const state = tabId === null ? undefined : this.tabs.get(tabId);
    if (!state) return;
    state.selection = additive
      ? state.selection.includes(id)
        ? state.selection.filter((s) => s !== id)
        : [...state.selection, id]
      : [id];
    for (const page of state.pages.keys()) {
      state.layer.setSelection(page, new Set(state.selection));
    }
    this.notify();
  }

  clearSelection(): void {
    for (const state of this.tabs.values()) {
      state.selection = [];
      for (const page of state.pages.keys()) state.layer.setSelection(page, new Set());
    }
    this.notify();
  }

  // ---- following -------------------------------------------------------------------------------

  /**
   * Follows a link.
   *
   * An address that leaves the document is shown to the reader in full, in an opaque dialog, and
   * opened only on a yes. Anything that is not `http(s)` is refused in words rather than handed
   * to the operating system.
   */
  async follow(id: string): Promise<boolean> {
    const link = this.link(id);
    const doc = this.activeDocument();
    if (!link || !doc) return false;
    switch (link.action.kind) {
      case 'page':
        return this.goToPage(link.action);
      case 'uri':
        return await this.openUri(link.action.uri);
      case 'file':
      case 'open':
        this.shell.toasts.show({
          kind: 'warning',
          text: `This link opens ${link.action.path}. ynotPDF does not open files a document asks for; open it yourself if you trust it.`,
        });
        return false;
      default:
        this.shell.toasts.show({ kind: 'info', text: 'This link has nothing behind it yet.' });
        return false;
    }
  }

  private goToPage(action: LinkAction): boolean {
    if (action.kind !== 'page') return false;
    const doc = this.activeDocument();
    const viewer = this.viewer();
    const tabId = this.activeTabId();
    if (!doc || !viewer || tabId === null) return false;
    const index = doc.state.pages.findIndex((p) => p.id === action.page);
    if (index < 0) {
      this.shell.toasts.show({
        kind: 'warning',
        text: 'That link points at a page that is no longer in this document.',
      });
      return false;
    }
    viewer.get(tabId)?.goToPage(index);
    return true;
  }

  /** Opens a web address, after asking. */
  async openUri(uri: string): Promise<boolean> {
    if (isMailto(uri)) {
      this.shell.toasts.show({
        kind: 'info',
        text: `This link writes to ${uri.slice(7)}. Copy the address if you want to use it.`,
      });
      return false;
    }
    if (!isFollowableUri(uri)) {
      this.shell.toasts.show({
        kind: 'warning',
        text: `This link points at ${uri}, which ynotPDF will not open.`,
      });
      return false;
    }
    if (this.confirmExternal && !this.trusted.has(uri)) {
      const answer = await this.confirmOpen(uri);
      if (answer === 'no') return false;
      if (answer === 'always') this.trusted.add(uri);
    }
    if (!hasBridge()) return false;
    try {
      await invoke('shell:openExternal', uri);
      return true;
    } catch (error) {
      this.shell.toasts.show({
        kind: 'error',
        text: `Could not open ${uri}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }

  /** The "are you sure" for a link that leaves the document. Opaque, keyboard-reachable. */
  private async confirmOpen(uri: string): Promise<'yes' | 'no' | 'always'> {
    const handle = this.shell.dialogs.open({
      id: 'link-confirm-dialog',
      title: 'Open this address?',
      kind: 'question',
      width: 560,
      content: (body) => {
        const p = document.createElement('p');
        p.textContent = 'This document is asking to open a web address:';
        const address = document.createElement('p');
        address.className = 'link-confirm-address';
        address.textContent = uri;
        address.dataset['testid'] = 'link-confirm-address';
        const note = document.createElement('p');
        note.className = 'field-hint';
        note.textContent = 'It will open in your web browser, outside ynotPDF.';
        body.append(p, address, note);
      },
      buttons: [
        { id: 'yes', label: 'Open', primary: true },
        { id: 'always', label: "Open, and don't ask again for this address" },
        { id: 'no', label: 'Cancel' },
      ],
    });
    const result = await handle.result;
    return result === 'yes' || result === 'always' ? result : 'no';
  }

  // ---- creating and editing ----------------------------------------------------------------------

  /** Adds a link over `rect`. Returns its model id. */
  async create(
    doc: Document,
    pageIndex: number,
    rect: PdfRect,
    action: LinkAction,
    border: LinkBorder = DEFAULT_BORDER,
  ): Promise<ModelId | null> {
    const page = doc.state.pages[pageIndex];
    if (!page) return null;
    const draft = draftAnnotation(doc, page.id, {
      subtype: 'Link',
      rect: normalise(rect),
      flags: DEFAULT_ANNOTATION_FLAGS,
      extra: { ...actionExtra(action), ...borderExtra(border) },
      ...(border.width > 0 ? { borderWidth: border.width, color: border.colour } : {}),
    });
    const command = new AddAnnotationCommand(doc, draft);
    await doc.apply(command);
    await this.refresh();
    return command.annotationId;
  }

  /** Changes a link's action and border. */
  async update(doc: Document, id: ModelId, action: LinkAction, border: LinkBorder): Promise<void> {
    const current = doc.annotation(id);
    if (!current) return;
    await doc.apply(
      new UpdateAnnotationCommand(doc, id, {
        extra: { ...current.extra, ...actionExtra(action), ...borderExtra(border) },
        borderWidth: border.width,
        color: border.colour,
      }),
    );
    await this.refresh();
  }

  /** Moves or resizes a link. */
  async move(doc: Document, id: ModelId, rect: PdfRect): Promise<void> {
    await doc.apply(new UpdateAnnotationCommand(doc, id, { rect: normalise(rect) }));
    await this.refresh();
  }

  /** Deletes links. One command, so a multiple delete is one undo. */
  async remove(doc: Document, ids: ReadonlyArray<string>): Promise<number> {
    const alive = ids
      .map((id) => this.link(id)?.modelId ?? null)
      .filter((id): id is ModelId => id !== null && doc.annotation(id) !== null);
    if (alive.length === 0) return 0;
    await doc.batch(
      alive.length === 1 ? 'Delete link' : `Delete ${String(alive.length)} links`,
      async () => {
        for (const id of alive) await doc.apply(new DeleteAnnotationCommand(doc, id));
      },
    );
    this.clearSelection();
    await this.refresh();
    return alive.length;
  }

  /** Opens the properties dialog for a link. Set by the manifest, which owns the dialogs. */
  editLink: (id: ModelId) => Promise<void> = () => Promise.resolve();

  // ---- detecting -------------------------------------------------------------------------------

  /**
   * Every web address and e-mail address written in the text of `pages` that is not already a
   * link.
   *
   * Nothing is created here: the caller reviews the list first. A candidate whose box overlaps a
   * link the page already has is left out, so running it twice adds nothing the second time.
   */
  async detect(
    doc: Document,
    pages: ReadonlyArray<number>,
    engine: PdfEngine = doc.engine,
  ): Promise<LinkCandidate[]> {
    const out: LinkCandidate[] = [];
    for (const page of pages) {
      const modelPage = doc.state.pages[page];
      const index = modelPage ? doc.enginePage(modelPage.id) : undefined;
      if (!modelPage || index === undefined) continue;
      let existing: PdfRect[];
      try {
        const annotations = await annotationsOf(doc, modelPage.id);
        existing = annotations.filter((a) => a.subtype === 'Link').map((a) => a.rect);
      } catch {
        existing = [];
      }
      try {
        const runs = await engine.textRuns(doc.handle, index);
        out.push(...detectLinks(page, runs, { bare: this.detectBare, existing }));
      } catch {
        // A page whose text cannot be read simply contributes nothing.
      }
    }
    return out;
  }

  /** Creates links for the candidates the reader kept. One command, so one undo. */
  async createAll(doc: Document, candidates: ReadonlyArray<LinkCandidate>): Promise<number> {
    if (candidates.length === 0) return 0;
    await doc.batch(
      candidates.length === 1 ? 'Create link' : `Create ${String(candidates.length)} links`,
      async () => {
        for (const candidate of candidates) {
          const page = doc.state.pages[candidate.page];
          if (!page) continue;
          const draft = draftAnnotation(doc, page.id, {
            subtype: 'Link',
            rect: normalise(candidate.rect),
            flags: DEFAULT_ANNOTATION_FLAGS,
            contents: candidate.text,
            extra: {
              ...actionExtra({ kind: 'uri', uri: candidate.uri }),
              ...borderExtra(DEFAULT_BORDER),
            },
          });
          await doc.apply(new AddAnnotationCommand(doc, draft));
        }
      },
    );
    await this.refresh();
    return candidates.length;
  }
}

/** A link the file itself carries, as an action. */
function engineAction(doc: Document, link: Link): LinkAction {
  if (link.uri) return { kind: 'uri', uri: link.uri };
  if (link.dest) {
    const target = doc.state.pages[link.dest.page];
    if (target) return { kind: 'page', page: target.id, fit: link.dest.fit };
  }
  return { kind: 'none' };
}

/** A rectangle as a key, so a model link and the engine's view of it are recognised as one. */
function rectKey(rect: PdfRect): string {
  const n = (v: number): string => v.toFixed(1);
  return `${n(rect.x0)},${n(rect.y0)},${n(rect.x1)},${n(rect.y1)}`;
}

/**
 * A page's annotations, **without re-reading them from the engine** when the model already has
 * them.
 *
 * `Document.loadAnnotations` replaces the model's list with what PDFium says, and PDFium cannot
 * create five of the subtypes this application offers — a Line dimension, a Caret, a Polygon.
 * Calling it behind the reader's back therefore deletes the measurement they have just drawn.
 * A page nobody has looked at yet is still loaded once, because there is nothing to lose.
 */
async function annotationsOf(
  doc: Document,
  pageId: ModelId,
): Promise<ReadonlyArray<ModelAnnotation>> {
  if (pageId in doc.state.annotations) return doc.annotations(pageId);
  return await doc.loadAnnotations(pageId);
}

/** `/Border` and `/H` as the annotation's `extra` holds them. */
function borderExtra(border: LinkBorder): Record<string, unknown> {
  return {
    linkBorderArray: [0, 0, border.width],
    linkHighlight: highlightName(border.highlight),
    linkBorder: { style: border.style, highlight: border.highlight },
    ...(border.style === 'dashed' && border.width > 0 ? { dashArray: [3, 2] } : { dashArray: [] }),
  };
}

function highlightName(highlight: LinkBorder['highlight']): string {
  switch (highlight) {
    case 'none':
      return 'N';
    case 'outline':
      return 'O';
    case 'push':
      return 'P';
    default:
      return 'I';
  }
}

function normalise(rect: PdfRect): PdfRect {
  return {
    x0: Math.min(rect.x0, rect.x1),
    y0: Math.min(rect.y0, rect.y1),
    x1: Math.max(rect.x0, rect.x1),
    y1: Math.max(rect.y0, rect.y1),
  };
}

/** Two rectangles that name the same area, within a quarter of a point. */
function sameRect(a: PdfRect, b: PdfRect): boolean {
  return (
    Math.abs(a.x0 - b.x0) < 0.25 &&
    Math.abs(a.y0 - b.y0) < 0.25 &&
    Math.abs(a.x1 - b.x1) < 0.25 &&
    Math.abs(a.y1 - b.y1) < 0.25
  );
}
