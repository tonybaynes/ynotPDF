/**
 * `ObjectService` (M50) — everything that selects and changes page objects. Registered as the
 * service `"objects"`.
 *
 * What it owns:
 * - **One `ObjectLayer` per open tab** and, per page, the engine's object list, the text blocks
 *   made from it, the live ids that name each object, and the groups.
 * - **The selection**, as *units*: a text block (`t<index>`), a single object (`b<n>` / `p<n>`).
 *   Selecting any unit of a group selects the group; commands act on the object ids underneath.
 * - **Every change**, each one a `Command` from `commands.ts`: transform (move, resize, rotate,
 *   flip, align, distribute, nudge), delete, paste, duplicate, z-order, group, style.
 * - **The clipboard**, as a marker line plus JSON of one-page PDFs, so an object pastes into
 *   another window of the app — and another document — with its resources.
 *
 * Pointer handling is `ObjectController`'s, for the same reason M30 keeps it apart: a drag has
 * to keep producing coordinates after leaving the page it began on.
 */

import type { ShellServices } from '@app/services';
import type { ShellState } from '@app/shell';
import type { Registry } from '@core/Registry';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import type { Store } from '@core/Store';
import type { ObjectPath, PageObject, TextRun } from '@engine/PdfEngine';
import { invert, multiply, translation } from '@engine/content/matrix';
import { hasBridge, invoke } from '@shared/ipc';
import type { ObjectStyle, PdfMatrix, PdfPoint, PdfRect } from '@shared/pdf';
import type { BoxHandle } from '@view/AnnotationLayer';
import {
  ObjectLayer,
  type LayerGuide,
  type LayerObject,
  type ObjectHandle,
} from '@view/ObjectLayer';
import type { Viewer } from '@modules/M11-viewer/Viewer';
import { VIEWER_SERVICE, type ViewerService } from '@modules/M11-viewer/ViewerService';
import { DOCUMENT_SERVICE, type DocumentService } from '@modules/M20-document-model/manifest';
import { blockOf, textBlocks, type TextBlock } from './blocks';
import {
  DeleteObjectsCommand,
  InsertObjectCommand,
  ReorderObjectsCommand,
  SetGroupsCommand,
  SetObjectStyleCommand,
  TransformObjectsCommand,
  registerObjectCodecs,
} from './commands';
import {
  alignDelta,
  distributeDeltas,
  flipMatrix,
  resizeMatrix,
  rotateMatrix,
  snapMove,
  unionRect,
  type AlignEdge,
  type SnapResult,
} from './geometry';
import { OBJECTS_NAMESPACE, liveIds, readObjectsState, toBase64, type PageGroups } from './model';
import {
  DEFAULT_OBJECT_SETTINGS,
  ipcSettingsStorage,
  readSettings,
  writeSetting,
  type ObjectFilter,
  type ObjectSettings,
  type SettingsStorage,
} from './settings';

export const OBJECT_SERVICE = 'objects';
export const OBJECT_PANEL_ID = 'props.object';
/** The first line of the clipboard payload; the rest is JSON. */
export const CLIPBOARD_MARKER = 'ynotPDF objects v1';

export type ArrangeOp = 'front' | 'back' | 'forward' | 'backward';

/** One page's objects as the service holds them. */
export interface PageData {
  readonly objects: ReadonlyArray<PageObject>;
  /** Live id per engine index. */
  readonly ids: ReadonlyArray<string>;
  readonly blocks: ReadonlyArray<TextBlock>;
  readonly groups: PageGroups;
  /** Path geometry, read on demand; `null` once known to be unavailable. */
  readonly paths: Map<number, ObjectPath | null>;
}

interface TabState {
  readonly tabId: string;
  readonly layer: ObjectLayer;
  readonly pages: Map<number, PageData>;
  selection: string[];
  page: number | null;
  hover: string | null;
  readonly disposers: Array<() => void>;
  /** Pages being re-read right now, so the read's own `page:changed` does not start another. */
  readonly loading: Set<number>;
  /** Pages that changed again while being read, to be read once more afterwards. */
  readonly dirty: Set<number>;
}

/** A selectable unit: a text block or one non-text object. */
export interface Unit {
  readonly id: string;
  readonly kind: 'text' | 'path' | 'image' | 'shading' | 'form';
  readonly rect: PdfRect;
  /** Object ids underneath (a block has several). */
  readonly objectIds: ReadonlyArray<string>;
  readonly indexes: ReadonlyArray<number>;
}

export interface SelectionInfo {
  readonly page: number;
  readonly units: ReadonlyArray<Unit>;
  readonly objectIds: ReadonlyArray<string>;
  readonly objects: ReadonlyArray<PageObject>;
  readonly bounds: PdfRect | null;
}

interface ClipboardObject {
  readonly pdf: string;
  readonly kind: PageObject['kind'];
  readonly rect: PdfRect;
}

export interface ObjectServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
  readonly storage?: SettingsStorage;
}

export class ObjectService {
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly storage: SettingsStorage;
  private readonly tabs = new Map<string, TabState>();
  private readonly listeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];
  private settingsValue: ObjectSettings = DEFAULT_OBJECT_SETTINGS;
  private filterValue: ObjectFilter = 'all';
  /**
   * The last payload we put on the OS clipboard. Windows' clipboard can wedge — writes report
   * success and reads come back empty — so a paste in the same session falls back to this when
   * the OS hands back nothing at all (never when it holds something else).
   */
  private memoryClipboard: string | null = null;
  private disposed = false;

  constructor(options: ObjectServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.storage = options.storage ?? ipcSettingsStorage();
    registerObjectCodecs();
    void readSettings(this.storage).then((s) => {
      if (!this.disposed) this.settingsValue = s;
    });
    this.disposers.push(
      this.shell.documents.onClosed((tab) => {
        this.dropTab(tab.id);
      }),
      this.shell.selection.subscribe((next) => {
        // Another module took the selection: ours is gone.
        if (next.kind !== 'objects') {
          const state = this.activeTab();
          if (state && state.selection.length > 0) this.applySelection(state, state.page, []);
        }
      }),
      this.shell.ui.subscribe((ui) => {
        if (!isObjectTool(ui.activeTool)) this.deselect();
      }),
    );
  }

  // ---- lookups ----------------------------------------------------------------------------------

  get settings(): ObjectSettings {
    return this.settingsValue;
  }

  get filter(): ObjectFilter {
    return this.filterValue;
  }

  setFilter(filter: ObjectFilter): void {
    if (this.filterValue === filter) return;
    this.filterValue = filter;
    this.deselect();
    this.shell.invalidate();
  }

  async setSetting<K extends keyof ObjectSettings>(
    key: K,
    value: ObjectSettings[K],
  ): Promise<void> {
    this.settingsValue = { ...this.settingsValue, [key]: value };
    await writeSetting(this.storage, key, value);
    this.shell.invalidate();
    this.notify();
  }

  private viewerService(): ViewerService | null {
    return this.registry.hasService(VIEWER_SERVICE)
      ? this.registry.service<ViewerService>(VIEWER_SERVICE)
      : null;
  }

  private documentService(): DocumentService | null {
    return this.registry.hasService(DOCUMENT_SERVICE)
      ? this.registry.service<DocumentService>(DOCUMENT_SERVICE)
      : null;
  }

  activeViewer(): Viewer | null {
    return this.viewerService()?.active ?? null;
  }

  activeDocument(): Document | null {
    return this.documentService()?.active ?? null;
  }

  activeTabId(): string | null {
    return this.shell.documents.active?.id ?? null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  // ---- tabs and pages -----------------------------------------------------------------------------

  private activeTab(): TabState | null {
    const tabId = this.activeTabId();
    return tabId ? this.tabState(tabId) : null;
  }

  /** The tab's state, wiring the layer and the document listener the first time. */
  private tabState(tabId: string): TabState | null {
    const existing = this.tabs.get(tabId);
    if (existing) return existing;
    const viewer = this.viewerService()?.get(tabId);
    const document = this.documentService()?.get(tabId);
    if (!viewer || !document) return null;
    const layer = new ObjectLayer();
    for (const pane of viewer.allPanes) layer.attach(pane);
    const state: TabState = {
      tabId,
      layer,
      pages: new Map(),
      selection: [],
      page: null,
      hover: null,
      disposers: [],
      loading: new Set(),
      dirty: new Set(),
    };
    state.disposers.push(
      document.events.on('page:changed', (e) => {
        if (e.what !== 'objects') return;
        const page = document.pageIndex(e.pageId);
        if (page < 0) return;
        // `Document.loadObjects` raises this same event (with the objects filled in); a command
        // raises it with `objects: null`. While a read is in flight, only the latter is news —
        // remember it rather than start another read from inside the first.
        if (state.loading.has(page)) {
          if (document.state.pages[page]?.objects === null) state.dirty.add(page);
          return;
        }
        if (document.state.pages[page]?.objects !== null && state.pages.has(page)) return;
        void this.reloadPage(state, document, page);
      }),
      document.events.on('page:removed', () => {
        state.pages.clear();
        this.applySelection(state, null, []);
      }),
    );
    this.tabs.set(tabId, state);
    return state;
  }

  private dropTab(tabId: string): void {
    const state = this.tabs.get(tabId);
    if (!state) return;
    for (const d of state.disposers.splice(0)) d();
    state.layer.dispose();
    this.tabs.delete(tabId);
  }

  /** The layer of a tab, for the controller. */
  layerFor(tabId: string): ObjectLayer | null {
    return this.tabState(tabId)?.layer ?? null;
  }

  /** Reads a page's objects (and text runs, for blocks) into the active tab. */
  async ensurePage(page: number): Promise<PageData | null> {
    const state = this.activeTab();
    const document = this.activeDocument();
    if (!state || !document) return null;
    const cached = state.pages.get(page);
    if (cached) return cached;
    return await this.reloadPage(state, document, page);
  }

  private async reloadPage(
    state: TabState,
    document: Document,
    page: number,
  ): Promise<PageData | null> {
    const modelPage = document.state.pages[page];
    const index = modelPage ? document.enginePage(modelPage.id) : undefined;
    if (!modelPage || index === undefined) return null;
    const previous = state.pages.get(page);
    state.loading.add(page);
    let objects: ReadonlyArray<PageObject>;
    let runs: ReadonlyArray<TextRun>;
    try {
      objects = await document.loadObjects(modelPage.id);
      runs = objects.some((o) => o.kind === 'text')
        ? await document.engine.textRuns(document.handle, index)
        : [];
    } finally {
      state.loading.delete(page);
    }
    if (this.disposed || !this.tabs.has(state.tabId)) return null;
    const objectsState = readObjectsState(document.custom(OBJECTS_NAMESPACE));
    const data: PageData = {
      objects,
      ids: liveIds(objectsState.pages[modelPage.id] ?? null, objects.length),
      blocks: textBlocks(page, runs, objects),
      groups: objectsState.groups[modelPage.id] ?? {},
      paths: new Map(),
    };
    state.pages.set(page, data);
    state.layer.setObjects(page, this.units(data).map(toLayerObject));
    if (previous) {
      // Tiles are stale after a change; the other pages repaint from cache.
      const viewer = this.viewerService();
      viewer?.renderer.forgetPage(state.tabId, page);
      viewer?.get(state.tabId)?.refresh();
      // Keep whatever of the selection still exists.
      if (state.page === page) {
        const alive = new Set(this.units(data).map((u) => u.id));
        this.applySelection(
          state,
          page,
          state.selection.filter((id) => alive.has(id)),
        );
      }
    }
    this.notify();
    if (state.dirty.delete(page)) return await this.reloadPage(state, document, page);
    return data;
  }

  /** Reads every page a pane shows. */
  async refresh(): Promise<void> {
    const viewer = this.activeViewer();
    const state = this.activeTab();
    if (!viewer || !state) return;
    const pages = new Set<number>();
    for (const pane of viewer.allPanes) for (const r of pane.layoutTable.rects) pages.add(r.page);
    for (const page of pages) if (!state.pages.has(page)) await this.ensurePage(page);
  }

  /** Forgets every page of the active tab (a reload, a page reorder). */
  forget(): void {
    const state = this.activeTab();
    if (!state) return;
    state.pages.clear();
    state.layer.clear();
    this.applySelection(state, null, []);
  }

  // ---- units ----------------------------------------------------------------------------------------

  /** The selectable units of a page: one per text block, one per other object. */
  units(data: PageData): Unit[] {
    const out: Unit[] = [];
    const inBlock = new Set<number>();
    for (const b of data.blocks) {
      for (const m of b.members) inBlock.add(m);
      out.push({
        id: b.id,
        kind: 'text',
        rect: b.rect,
        objectIds: b.members.map((m) => data.ids[m] ?? ''),
        indexes: b.members,
      });
    }
    data.objects.forEach((o, i) => {
      if (inBlock.has(i)) return;
      const id = data.ids[i] ?? '';
      out.push({ id, kind: o.kind, rect: o.rect, objectIds: [id], indexes: [i] });
    });
    // Z-order: a block sits where its first member does.
    return out.sort((a, b) => (a.indexes[0] ?? 0) - (b.indexes[0] ?? 0));
  }

  private unitById(data: PageData, id: string): Unit | null {
    return this.units(data).find((u) => u.id === id) ?? null;
  }

  /** Whether the current filter lets a unit be picked. */
  private passesFilter(unit: Unit, _data: PageData): boolean {
    if (this.filterValue === 'all') return true;
    if (unit.kind === 'form') {
      // A pasted object counts as what it was copied from.
      const document = this.activeDocument();
      const pageId = document?.state.pages[this.activeTab()?.page ?? -1]?.id;
      const live = pageId
        ? readObjectsState(document?.custom(OBJECTS_NAMESPACE) ?? {}).pages[pageId]?.live
        : undefined;
      const entry = live?.find((o) => o.id === unit.id);
      return entry?.kind === 'pasted' && entry.from === this.filterValue;
    }
    return unit.kind === this.filterValue;
  }

  /** Grows a set of unit ids to whole groups. */
  private expandGroups(data: PageData, ids: ReadonlyArray<string>): string[] {
    const units = this.units(data);
    const objectToUnit = new Map<string, string>();
    for (const u of units) for (const o of u.objectIds) objectToUnit.set(o, u.id);
    const wanted = new Set(ids);
    let grew = true;
    while (grew) {
      grew = false;
      const objectIds = new Set<string>();
      for (const u of units) if (wanted.has(u.id)) for (const o of u.objectIds) objectIds.add(o);
      for (const members of Object.values(data.groups)) {
        if (!members.some((m) => objectIds.has(m))) continue;
        for (const m of members) {
          const unit = objectToUnit.get(m);
          if (unit && !wanted.has(unit)) {
            wanted.add(unit);
            grew = true;
          }
        }
      }
    }
    return units.filter((u) => wanted.has(u.id)).map((u) => u.id);
  }

  // ---- selection ----------------------------------------------------------------------------------

  get selection(): ReadonlyArray<string> {
    return this.activeTab()?.selection ?? [];
  }

  get selectionPage(): number | null {
    return this.activeTab()?.page ?? null;
  }

  private applySelection(state: TabState, page: number | null, ids: string[]): void {
    state.selection = ids;
    state.page = ids.length > 0 ? page : null;
    if (page !== null && ids.length > 0) state.layer.setSelection(page, ids);
    else state.layer.clearSelection();
    const data = page !== null ? state.pages.get(page) : undefined;
    if (ids.length > 0 && page !== null && data) {
      const indexes = this.units(data)
        .filter((u) => ids.includes(u.id))
        .flatMap((u) => [...u.indexes]);
      const current = this.shell.selection.as('objects');
      if (current?.page !== page || current.indexes.join() !== indexes.join()) {
        this.shell.selection.set({ kind: 'objects', page, indexes });
      }
    } else if (this.shell.selection.kind === 'objects') {
      this.shell.selection.clear();
    }
    this.shell.invalidate();
    this.notify();
  }

  /** Selects units on a page (growing to their groups). `additive` toggles them instead. */
  select(page: number, ids: ReadonlyArray<string>, additive = false): void {
    const state = this.activeTab();
    const data = state?.pages.get(page);
    if (!state || !data) return;
    let next: string[];
    if (additive && state.page === page) {
      const current = new Set(state.selection);
      for (const id of this.expandGroups(data, ids)) {
        if (current.has(id)) current.delete(id);
        else current.add(id);
      }
      next = [...current];
    } else {
      next = this.expandGroups(data, ids);
    }
    this.applySelection(state, page, next);
  }

  deselect(): void {
    const state = this.activeTab();
    if (!state || state.selection.length === 0) return;
    this.applySelection(state, null, []);
  }

  async selectAll(page?: number): Promise<void> {
    const target = page ?? this.activeTab()?.page ?? this.activeViewer()?.state.page ?? 0;
    const data = await this.ensurePage(target);
    const state = this.activeTab();
    if (!data || !state) return;
    const ids = this.units(data)
      .filter((u) => this.passesFilter(u, data))
      .map((u) => u.id);
    this.applySelection(state, target, ids);
  }

  /** Selects what is under a point, bounds first and then the path's own geometry. */
  async selectAt(page: number, point: PdfPoint, additive: boolean): Promise<boolean> {
    const data = await this.ensurePage(page);
    if (!data) return false;
    const hit = await this.unitAt(page, data, point);
    if (!hit) {
      if (!additive) this.deselect();
      return false;
    }
    this.select(page, [hit.id], additive);
    return true;
  }

  /** The topmost unit under a point that passes the filter and the precise test. */
  async unitAt(page: number, data: PageData, point: PdfPoint): Promise<Unit | null> {
    const units = this.units(data).filter((u) => this.passesFilter(u, data));
    const scale = this.activeViewer()?.pane.zoom ?? 1;
    const slack = 2 / Math.max(scale, 1e-6);
    for (let i = units.length - 1; i >= 0; i--) {
      const u = units[i];
      if (!u) continue;
      const r = u.rect;
      if (
        point.x < r.x0 - slack ||
        point.x > r.x1 + slack ||
        point.y < r.y0 - slack ||
        point.y > r.y1 + slack
      ) {
        continue;
      }
      if (u.kind === 'path') {
        const index = u.indexes[0] ?? -1;
        const path = await this.pathOf(data, page, index);
        const object = data.objects[index];
        if (
          path &&
          object &&
          !hitsPath(path, point, Math.max((object.strokeWidth ?? 1) / 2, 3 / scale))
        ) {
          continue;
        }
      }
      return u;
    }
    return null;
  }

  private async pathOf(data: PageData, page: number, index: number): Promise<ObjectPath | null> {
    const cached = data.paths.get(index);
    if (cached !== undefined) return cached;
    const document = this.activeDocument();
    const modelPage = document?.state.pages[page];
    const engineIndex = modelPage ? document?.enginePage(modelPage.id) : undefined;
    let path: ObjectPath | null = null;
    if (document && engineIndex !== undefined) {
      try {
        path = await document.engine.objectPath(document.handle, engineIndex, index);
      } catch {
        path = null;
      }
    }
    data.paths.set(index, path);
    return path;
  }

  /** Selects every unit a marquee touches. */
  selectWithin(page: number, rect: PdfRect, additive: boolean): void {
    const state = this.activeTab();
    const data = state?.pages.get(page);
    if (!state || !data) return;
    const ids = this.units(data)
      .filter((u) => this.passesFilter(u, data))
      .filter(
        (u) =>
          u.rect.x1 >= rect.x0 &&
          u.rect.x0 <= rect.x1 &&
          u.rect.y1 >= rect.y0 &&
          u.rect.y0 <= rect.y1,
      )
      .map((u) => u.id);
    if (ids.length === 0 && !additive) {
      this.deselect();
      return;
    }
    this.select(page, ids, additive);
  }

  /** Outlines the unit under the pointer. */
  async hover(page: number, point: PdfPoint): Promise<void> {
    const state = this.activeTab();
    const data = state?.pages.get(page);
    if (!state || !data) return;
    const unit = await this.unitAt(page, data, point);
    const id = unit?.id ?? null;
    if (state.hover === id) return;
    state.hover = id;
    state.layer.setHover(page, id);
  }

  clearHover(): void {
    const state = this.activeTab();
    if (!state?.hover) return;
    state.hover = null;
    state.layer.setHover(null, null);
  }

  /** What is selected, resolved to objects. */
  selected(): SelectionInfo | null {
    const state = this.activeTab();
    if (!state) return null;
    if (state.page === null || state.selection.length === 0) return null;
    const data = state.pages.get(state.page);
    if (!data) return null;
    const units = this.units(data).filter((u) => state.selection.includes(u.id));
    const objectIds = units.flatMap((u) => [...u.objectIds]);
    const objects = units
      .flatMap((u) => u.indexes.map((i) => data.objects[i]))
      .filter((o): o is PageObject => o !== undefined);
    return {
      page: state.page,
      units,
      objectIds,
      objects,
      bounds: unionRect(units.map((u) => u.rect)),
    };
  }

  selectionBounds(): PdfRect | null {
    return this.selected()?.bounds ?? null;
  }

  /** A short description for the panel heading and the palette. */
  describe(): string {
    const info = this.selected();
    if (!info) return 'No object selected';
    if (info.units.length > 1) return `${info.units.length} objects`;
    const u = info.units[0];
    if (!u) return 'Object';
    switch (u.kind) {
      case 'text': {
        const block = this.activeTab()
          ?.pages.get(info.page)
          ?.blocks.find((b) => b.id === u.id);
        const text = block?.text ?? '';
        return text ? `Text: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}` : 'Text';
      }
      case 'image':
        return 'Image';
      case 'path':
        return 'Shape';
      case 'shading':
        return 'Shading';
      case 'form':
        return 'Pasted object';
    }
  }

  // ---- overlay helpers for the controller -------------------------------------------------------------

  handleAt(page: number, point: PdfPoint, scale: number): ObjectHandle | null {
    const state = this.activeTab();
    if (state?.page !== page) return null;
    return state.layer.handleAt(page, point, scale);
  }

  setPreview(page: number, matrix: PdfMatrix | null): void {
    this.activeTab()?.layer.setPreview(page, matrix);
  }

  setGuides(page: number, guides: ReadonlyArray<LayerGuide>): void {
    this.activeTab()?.layer.setGuides(page, guides);
  }

  clearGuides(): void {
    this.activeTab()?.layer.clearGuides();
  }

  setMarquee(marquee: { page: number; rect: PdfRect } | null): void {
    this.activeTab()?.layer.setMarquee(marquee);
  }

  /** Where a move of the selection's bounds to `moved` would snap. */
  snapFor(page: number, moved: PdfRect): SnapResult {
    const state = this.activeTab();
    const data = state?.pages.get(page);
    const viewer = this.activeViewer();
    const document = this.activeDocument();
    const selected = new Set(state?.selection ?? []);
    const others = data
      ? this.units(data)
          .filter((u) => !selected.has(u.id))
          .map((u) => u.rect)
      : [];
    const modelPage = document?.state.pages[page];
    const gridOn = viewer?.overlays.grid ?? false;
    const snapGrid = this.viewerService()?.settings.snapToGrid ?? false;
    return snapMove(moved, {
      tolerance: this.settingsValue.snapTolerance,
      ...(this.settingsValue.snapToObjects
        ? { objects: others, page: modelPage?.cropBox ?? null }
        : {}),
      ...(this.settingsValue.snapToGuides && viewer ? { guides: viewer.guides.forPage(page) } : {}),
      ...(gridOn && snapGrid && viewer ? { grid: viewer.overlays.gridSpacing } : {}),
    });
  }

  /** Puts a few words in the status bar ("Snapped to: Left edges"). */
  showStatus(text: string | null): void {
    if (!this.registry.hasService('shell')) return;
    const store = this.registry.service<Store<ShellState>>('shell');
    store.set({ statusMessage: text ?? 'Ready' });
  }

  // ---- changes ------------------------------------------------------------------------------------

  private pageIdOf(page: number): ModelId | null {
    return this.activeDocument()?.state.pages[page]?.id ?? null;
  }

  /** Applies one page-space matrix to the selection, as one undoable command. */
  async transform(delta: PdfMatrix, label = 'Move object'): Promise<void> {
    const info = this.selected();
    const document = this.activeDocument();
    const pageId = info ? this.pageIdOf(info.page) : null;
    if (!info || !document || !pageId) return;
    await document.apply(
      new TransformObjectsCommand(document, pageId, info.objectIds, delta, label),
    );
  }

  async nudge(dx: number, dy: number): Promise<void> {
    await this.transform(translation(dx, dy), 'Nudge object');
  }

  async resizeTo(handle: BoxHandle, to: PdfPoint, proportional: boolean): Promise<void> {
    const bounds = this.selectionBounds();
    if (!bounds) return;
    await this.transform(resizeMatrix(bounds, handle, to, proportional), 'Resize object');
  }

  async rotateBy(degrees: number): Promise<void> {
    const bounds = this.selectionBounds();
    if (!bounds) return;
    await this.transform(rotateMatrix(bounds, degrees), 'Rotate object');
  }

  async flip(axis: 'horizontal' | 'vertical'): Promise<void> {
    const bounds = this.selectionBounds();
    if (!bounds) return;
    await this.transform(flipMatrix(bounds, axis), 'Flip object');
  }

  /** Moves and/or scales the selection so its bounds become the given values (panel fields). */
  async setBounds(patch: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }): Promise<void> {
    const b = this.selectionBounds();
    if (!b) return;
    const width = b.x1 - b.x0;
    const height = b.y1 - b.y0;
    const targetW = Math.max(1, patch.width ?? width);
    const targetH = Math.max(1, patch.height ?? height);
    const x = patch.x ?? b.x0;
    const y = patch.y ?? b.y0;
    const scale: PdfMatrix = [
      targetW / Math.max(width, 1e-6),
      0,
      0,
      targetH / Math.max(height, 1e-6),
      0,
      0,
    ];
    // Scale about the origin, then put the bottom-left where it is asked to be.
    const scaled = multiply(translation(-b.x0, -b.y0), scale);
    const delta = multiply(scaled, translation(x, y));
    await this.transform(
      delta,
      patch.width !== undefined || patch.height !== undefined ? 'Resize object' : 'Move object',
    );
  }

  async remove(): Promise<void> {
    const info = this.selected();
    const document = this.activeDocument();
    const pageId = info ? this.pageIdOf(info.page) : null;
    if (!info || !document || !pageId) return;
    this.deselect();
    await document.apply(new DeleteObjectsCommand(document, pageId, info.objectIds));
  }

  // ---- clipboard ----------------------------------------------------------------------------------

  private async clipboardObjects(info: SelectionInfo): Promise<ClipboardObject[]> {
    const document = this.activeDocument();
    const modelPage = document?.state.pages[info.page];
    const engineIndex = modelPage ? document?.enginePage(modelPage.id) : undefined;
    if (!document || engineIndex === undefined) return [];
    const out: ClipboardObject[] = [];
    for (const u of info.units) {
      for (const index of u.indexes) {
        const object = document.state.pages[info.page]?.objects?.[index];
        const pdf = await document.engine.objectAsPdf(document.handle, engineIndex, index);
        out.push({
          pdf: toBase64(pdf),
          kind: object?.kind ?? 'form',
          rect: object?.rect ?? u.rect,
        });
      }
    }
    return out;
  }

  async copy(): Promise<boolean> {
    const info = this.selected();
    if (!info) return false;
    const items = await this.clipboardObjects(info);
    if (items.length === 0) return false;
    const text = `${CLIPBOARD_MARKER}\n${JSON.stringify(items)}`;
    this.memoryClipboard = text;
    return await writeText(text);
  }

  async cut(): Promise<boolean> {
    if (!(await this.copy())) return false;
    await this.remove();
    return true;
  }

  /** Pastes in place, on the current page, on top. Returns how many objects arrived. */
  async paste(): Promise<number> {
    let text = await readText();
    if (text.trim() === '' && this.memoryClipboard !== null) text = this.memoryClipboard;
    const items = decodeClipboard(text);
    if (items.length === 0) return 0;
    const page = this.activeTab()?.page ?? this.activeViewer()?.state.page ?? 0;
    return await this.insertAll(items, page, [1, 0, 0, 1, 0, 0], 'Paste object');
  }

  /** Copies the selection onto the same page, offset a little so it can be seen. */
  async duplicate(): Promise<number> {
    const info = this.selected();
    if (!info) return 0;
    const items = await this.clipboardObjects(info);
    return await this.insertAll(items, info.page, translation(10, -10), 'Duplicate object');
  }

  private async insertAll(
    items: ReadonlyArray<ClipboardObject>,
    page: number,
    matrix: PdfMatrix,
    label: string,
  ): Promise<number> {
    const document = this.activeDocument();
    const pageId = this.pageIdOf(page);
    if (!document || !pageId) return 0;
    await this.ensurePage(page);
    const inserted: string[] = [];
    await document.batch(label, async () => {
      for (const item of items) {
        const command = new InsertObjectCommand(
          document,
          pageId,
          item.pdf,
          matrix,
          item.kind,
          label,
        );
        await document.apply(command);
        if (command.insertedId) inserted.push(command.insertedId);
      }
    });
    const state = this.activeTab();
    const data = state ? await this.reloadPage(state, document, page) : null;
    if (state && data) {
      const units = this.units(data).filter((u) => u.objectIds.some((o) => inserted.includes(o)));
      this.applySelection(
        state,
        page,
        units.map((u) => u.id),
      );
    }
    return inserted.length;
  }

  // ---- align, distribute, arrange ----------------------------------------------------------------------

  async align(edge: AlignEdge): Promise<void> {
    const info = this.selected();
    const document = this.activeDocument();
    const pageId = info ? this.pageIdOf(info.page) : null;
    if (!info || !document || !pageId || !info.bounds) return;
    const reference =
      this.settingsValue.alignTo === 'page' || info.units.length < 2
        ? (document.state.pages[info.page]?.cropBox ?? info.bounds)
        : info.bounds;
    await document.batch(`Align ${edge}`, async () => {
      for (const u of info.units) {
        await document.apply(
          new TransformObjectsCommand(
            document,
            pageId,
            u.objectIds,
            alignDelta(u.rect, edge, reference),
            'Align object',
          ),
        );
      }
    });
  }

  async distribute(axis: 'horizontal' | 'vertical'): Promise<void> {
    const info = this.selected();
    const document = this.activeDocument();
    const pageId = info ? this.pageIdOf(info.page) : null;
    if (!info || !document || !pageId || info.units.length < 3) return;
    const deltas = distributeDeltas(
      info.units.map((u) => u.rect),
      axis,
    );
    await document.batch(`Distribute ${axis}`, async () => {
      for (const [i, u] of info.units.entries()) {
        const delta = deltas[i];
        if (!delta) continue;
        await document.apply(
          new TransformObjectsCommand(document, pageId, u.objectIds, delta, 'Distribute object'),
        );
      }
    });
  }

  /** The new engine order for a z-order operation on the selected indexes. */
  static arrangeOrder(count: number, selected: ReadonlySet<number>, op: ArrangeOp): number[] {
    const all = Array.from({ length: count }, (_v, i) => i);
    const picked = all.filter((i) => selected.has(i));
    const rest = all.filter((i) => !selected.has(i));
    switch (op) {
      case 'front':
        return [...rest, ...picked];
      case 'back':
        return [...picked, ...rest];
      case 'forward': {
        const order = [...all];
        for (let i = order.length - 2; i >= 0; i--) {
          const a = order[i];
          const b = order[i + 1];
          if (a !== undefined && b !== undefined && selected.has(a) && !selected.has(b)) {
            order[i] = b;
            order[i + 1] = a;
          }
        }
        return order;
      }
      case 'backward': {
        const order = [...all];
        for (let i = 1; i < order.length; i++) {
          const a = order[i];
          const b = order[i - 1];
          if (a !== undefined && b !== undefined && selected.has(a) && !selected.has(b)) {
            order[i] = b;
            order[i - 1] = a;
          }
        }
        return order;
      }
    }
  }

  async arrange(op: ArrangeOp): Promise<void> {
    const info = this.selected();
    const document = this.activeDocument();
    const pageId = info ? this.pageIdOf(info.page) : null;
    const data = this.activeTab()?.pages.get(info?.page ?? -1);
    if (!info || !document || !pageId || !data) return;
    const selected = new Set(info.units.flatMap((u) => [...u.indexes]));
    const order = ObjectService.arrangeOrder(data.objects.length, selected, op);
    if (order.every((v, i) => v === i)) return;
    const labels: Record<ArrangeOp, string> = {
      front: 'Bring to front',
      back: 'Send to back',
      forward: 'Bring forward',
      backward: 'Send backward',
    };
    const keep = [...info.units.map((u) => u.id)];
    await document.apply(new ReorderObjectsCommand(document, pageId, order, labels[op]));
    // Ids survive a reorder; blocks are renamed by their first member, so re-resolve by objects.
    const state = this.activeTab();
    const fresh = state?.pages.get(info.page);
    if (state && fresh) {
      const wanted = new Set(info.objectIds);
      const ids = this.units(fresh)
        .filter((u) => u.objectIds.some((o) => wanted.has(o)))
        .map((u) => u.id);
      this.applySelection(state, info.page, ids.length > 0 ? ids : keep);
    }
  }

  // ---- groups ---------------------------------------------------------------------------------------

  canGroup(): boolean {
    const info = this.selected();
    return (info?.units.length ?? 0) > 1;
  }

  canUngroup(): boolean {
    const info = this.selected();
    const data = this.activeTab()?.pages.get(info?.page ?? -1);
    if (!info || !data) return false;
    const objectIds = new Set(info.objectIds);
    return Object.values(data.groups).some((members) => members.some((m) => objectIds.has(m)));
  }

  async group(): Promise<void> {
    const info = this.selected();
    const document = this.activeDocument();
    const pageId = info ? this.pageIdOf(info.page) : null;
    const data = this.activeTab()?.pages.get(info?.page ?? -1);
    if (!info || !document || !pageId || !data || info.units.length < 2) return;
    const members = new Set(info.objectIds);
    // Groups the selection swallows go; the new one takes every member.
    const groups: Record<string, ReadonlyArray<string>> = {};
    for (const [id, m] of Object.entries(data.groups)) {
      if (!m.some((o) => members.has(o))) groups[id] = m;
    }
    let n = 1;
    while (groups[`g${n}`]) n++;
    groups[`g${n}`] = [...members];
    await document.apply(new SetGroupsCommand(document, pageId, groups, 'Group objects'));
  }

  async ungroup(): Promise<void> {
    const info = this.selected();
    const document = this.activeDocument();
    const pageId = info ? this.pageIdOf(info.page) : null;
    const data = this.activeTab()?.pages.get(info?.page ?? -1);
    if (!info || !document || !pageId || !data) return;
    const members = new Set(info.objectIds);
    const groups: Record<string, ReadonlyArray<string>> = {};
    for (const [id, m] of Object.entries(data.groups)) {
      if (!m.some((o) => members.has(o))) groups[id] = m;
    }
    await document.apply(new SetGroupsCommand(document, pageId, groups, 'Ungroup objects'));
  }

  // ---- style --------------------------------------------------------------------------------------------

  /** Sets stroke and fill properties on every selected path. */
  async setStyle(style: ObjectStyle): Promise<void> {
    const info = this.selected();
    const document = this.activeDocument();
    const pageId = info ? this.pageIdOf(info.page) : null;
    const data = this.activeTab()?.pages.get(info?.page ?? -1);
    if (!info || !document || !pageId || !data) return;
    const live = readObjectsState(document.custom(OBJECTS_NAMESPACE)).pages[pageId]?.live ?? [];
    const paths = info.units.filter((u) => u.kind === 'path');
    if (paths.length === 0) return;
    await document.batch('Change object style', async () => {
      for (const u of paths) {
        const index = u.indexes[0] ?? -1;
        const id = u.objectIds[0] ?? '';
        const object = data.objects[index];
        const entry = live.find((o) => o.id === id);
        const previous: ObjectStyle = {
          ...(style.fillColor !== undefined ? { fillColor: object?.fillColor ?? 0 } : {}),
          ...(style.strokeColor !== undefined ? { strokeColor: object?.strokeColor ?? 0 } : {}),
          ...(style.strokeWidth !== undefined ? { strokeWidth: object?.strokeWidth ?? 1 } : {}),
          ...(style.dash !== undefined
            ? { dash: (entry?.kind === 'base' ? entry.style?.dash : undefined) ?? [] }
            : {}),
        };
        await document.apply(new SetObjectStyleCommand(document, pageId, id, style, previous));
      }
    });
  }

  /** The dash a selected path currently has, as far as the model knows. */
  currentDash(): ReadonlyArray<number> {
    const info = this.selected();
    const document = this.activeDocument();
    const pageId = info ? this.pageIdOf(info.page) : null;
    if (!info || !document || !pageId) return [];
    const id = info.units.find((u) => u.kind === 'path')?.objectIds[0];
    const live = readObjectsState(document.custom(OBJECTS_NAMESPACE)).pages[pageId]?.live ?? [];
    const entry = live.find((o) => o.id === id);
    return entry?.kind === 'base' ? (entry.style?.dash ?? []) : [];
  }

  /** The text block a unit id names, for the panel. */
  blockFor(page: number, unitId: string): TextBlock | null {
    const data = this.activeTab()?.pages.get(page);
    if (!data) return null;
    const b = data.blocks.find((x) => x.id === unitId);
    if (b) return b;
    const index = Number(unitId.slice(1));
    return Number.isFinite(index) ? blockOf(data.blocks, index) : null;
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposers.splice(0)) d();
    for (const tabId of [...this.tabs.keys()]) this.dropTab(tabId);
  }
}

function toLayerObject(u: Unit): LayerObject {
  return { id: u.id, rect: u.rect, kind: u.kind };
}

/** Which tools this service listens under. */
export function isObjectTool(toolId: string | null): boolean {
  return toolId?.startsWith('tool.editObject') ?? false;
}

/** Flattens a path to polylines, one per subpath, sampling the béziers. */
function polylines(path: ObjectPath): PdfPoint[][] {
  const out: PdfPoint[][] = [];
  let current: PdfPoint[] = [];
  let pending: PdfPoint[] = [];
  for (const p of path.points) {
    if (p.type === 'move') {
      if (current.length > 0) out.push(current);
      current = [{ x: p.x, y: p.y }];
      pending = [];
    } else if (p.type === 'bezier') {
      pending.push({ x: p.x, y: p.y });
      if (pending.length === 3) {
        const from = current[current.length - 1] ?? pending[0];
        const [c1, c2, to] = pending;
        if (from && c1 && c2 && to) {
          for (let t = 0.125; t <= 1; t += 0.125) {
            const u = 1 - t;
            current.push({
              x:
                u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
              y:
                u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
            });
          }
        }
        pending = [];
      }
    } else {
      current.push({ x: p.x, y: p.y });
    }
    if (p.close && current.length > 0) {
      const first = current[0];
      if (first) current.push(first);
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

function distanceToSegment(p: PdfPoint, a: PdfPoint, b: PdfPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether a point is on a path: inside it when filled, near its outline when stroked. */
export function hitsPath(path: ObjectPath, point: PdfPoint, tolerance: number): boolean {
  const lines = polylines(path);
  if (path.stroke || !path.fill) {
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1];
        const b = line[i];
        if (a && b && distanceToSegment(point, a, b) <= tolerance) return true;
      }
    }
  }
  if (path.fill) {
    // Even-odd over every subpath.
    let inside = false;
    for (const line of lines) {
      for (let i = 0, j = line.length - 1; i < line.length; j = i++) {
        const a = line[i];
        const b = line[j];
        if (!a || !b) continue;
        if (
          a.y > point.y !== b.y > point.y &&
          point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
        ) {
          inside = !inside;
        }
      }
    }
    if (inside) return true;
  }
  return false;
}

// ---- clipboard ------------------------------------------------------------------------------------------

async function writeText(text: string): Promise<boolean> {
  try {
    if (hasBridge()) {
      await invoke('clipboard:write', { text });
      return true;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function readText(): Promise<string> {
  try {
    if (hasBridge()) return (await invoke('clipboard:read')).text;
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

/** The objects a clipboard text carries, validated field by field. */
export function decodeClipboard(text: string): ClipboardObject[] {
  if (!text.startsWith(CLIPBOARD_MARKER)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(CLIPBOARD_MARKER.length));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ClipboardObject[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const rect = r['rect'] as Record<string, unknown> | undefined;
    if (
      typeof r['pdf'] !== 'string' ||
      !rect ||
      !['x0', 'y0', 'x1', 'y1'].every((k) => typeof rect[k] === 'number')
    ) {
      continue;
    }
    const kind = r['kind'];
    out.push({
      pdf: r['pdf'],
      kind:
        kind === 'text' || kind === 'path' || kind === 'image' || kind === 'shading'
          ? kind
          : 'form',
      rect: {
        x0: rect['x0'] as number,
        y0: rect['y0'] as number,
        x1: rect['x1'] as number,
        y1: rect['y1'] as number,
      },
    });
  }
  return out;
}

export { invert as invertMatrix };
