/**
 * `FormService` (M60) — everything that fills in and designs a form. Registered as `"forms"`.
 *
 * What it owns:
 *
 * - **one `FormLayer` per open tab**, mounted whenever the document has fields or the designer is
 *   running, and the viewer's `forms: false` flag while it is (ADR 0019);
 * - **the mode**: `fill` (real controls, typing, tabbing) or `design` (the tool owns the pointer,
 *   controls are inert and selectable);
 * - **the selection**, as widget keys `<fieldId>:<widgetId>`, because a radio group's three
 *   buttons are three widgets of one field and a designer moves them one at a time;
 * - **every change**, each one a `Command` from `commands.ts`, so undo, autosave and recovery all
 *   work without this file knowing they exist;
 * - **the tab order** per page, and the numbers overlay that shows it.
 *
 * Pointer handling is `FormController`'s, for the reason M30 and M50 both found: a drag has to go
 * on producing coordinates after the pointer has left the page it started on.
 */

import type { ShellServices } from '@app/services';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import { CompositeCommand } from '@core/Command';
import { SetCustomCommand } from '@core/commands';
import type { Registry } from '@core/Registry';
import { fieldDesignOf, widgetAppearanceOf, type ModelField, type ModelWidget } from '@core/model';
import { SetFieldValueCommand } from '@core/commands';
import {
  defaultFieldDesign,
  defaultFieldSize,
  defaultWidgetAppearance,
  fieldNameProblem,
  FIELD_ROLE_LABELS,
  isFillable,
  isReadOnly,
  nextFreeName,
  partialName,
  type FieldDesign,
  type FieldRole,
  type TabOrderMode,
  type WidgetAppearance,
} from '@engine/forms/model';
import type { PdfRect } from '@shared/pdf';
import { FormLayer, type FormMode, type LayerWidget } from '@view/FormLayer';
import type { Viewer } from '@modules/M11-viewer/Viewer';
import { VIEWER_SERVICE, type ViewerService } from '@modules/M11-viewer/ViewerService';
import { DOCUMENT_SERVICE, type DocumentService } from '@modules/M20-document-model/manifest';
import { alignDelta, distributeDeltas, type AlignEdge } from '@modules/M50-object-model/geometry';
import {
  AddFieldCommand,
  FormValueCommand,
  RemoveFieldCommand,
  UpdateFieldCommand,
  registerFormCodecs,
} from './commands';
import {
  FORMS_NAMESPACE,
  manualOrderFor,
  normaliseRect,
  orderWidgets,
  splitWidgetKey,
  tabModeFor,
  tabModesWith,
  tabOrderWith,
  unionRect,
  widgetKey,
  widgetsOnPage,
  type WidgetRef,
} from './model';
import {
  DEFAULT_FORM_SETTINGS,
  ipcSettingsStorage,
  readSettings,
  writeSetting,
  type FormSettings,
  type SettingsStorage,
} from './settings';

export const FORM_SERVICE = 'forms';
export const FIELD_PANEL_ID = 'nav.fields';
export const FIELD_PROPERTIES_PANEL_ID = 'props.field';
/** The first line of the clipboard payload; the rest is JSON. */
export const CLIPBOARD_MARKER = 'ynotPDF form fields v1';

interface TabState {
  readonly tabId: string;
  readonly layer: FormLayer;
  selection: string[];
  page: number | null;
  showTabOrder: boolean;
  readonly disposers: Array<() => void>;
}

/** What the properties panel and the Fields panel read. */
export interface FieldSelection {
  readonly widgets: ReadonlyArray<WidgetRef>;
  readonly fields: ReadonlyArray<ModelField>;
  readonly bounds: PdfRect | null;
  readonly page: number | null;
}

export interface FormServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
  readonly storage?: SettingsStorage;
}

export class FormService {
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly storage: SettingsStorage;
  private readonly tabs = new Map<string, TabState>();
  private readonly listeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];
  private settingsValue: FormSettings = DEFAULT_FORM_SETTINGS;
  private modeValue: FormMode = 'fill';
  private disposed = false;
  /** The last payload this session put on the clipboard, for the Windows clipboard's bad days. */
  private memoryClipboard: string | null = null;

  constructor(options: FormServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.storage = options.storage ?? ipcSettingsStorage();
    registerFormCodecs();
    void readSettings(this.storage).then((s) => {
      if (this.disposed) return;
      this.settingsValue = s;
      this.refreshAll();
    });
    this.disposers.push(
      this.shell.documents.onClosed((tab) => {
        this.dropTab(tab.id);
      }),
      this.shell.documents.subscribe(() => {
        this.refreshAll();
      }),
      this.shell.selection.subscribe((next) => {
        if (next.kind !== 'fields') {
          const state = this.activeTab();
          if (state && state.selection.length > 0) this.applySelection(state, []);
        }
      }),
    );
  }

  // ---- lookups ------------------------------------------------------------------------------

  get settings(): FormSettings {
    return this.settingsValue;
  }

  get mode(): FormMode {
    return this.modeValue;
  }

  async setSetting<K extends keyof FormSettings>(key: K, value: FormSettings[K]): Promise<void> {
    this.settingsValue = { ...this.settingsValue, [key]: value };
    await writeSetting(this.storage, key, value);
    this.refreshAll();
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

  // ---- tabs ---------------------------------------------------------------------------------

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
    const layer = new FormLayer({
      onInput: (key, value) => {
        this.typed(key, value);
      },
      onCommit: (key, value) => {
        void this.commitValue(key, value, true);
      },
      onFocus: (key) => {
        this.focusWidget(key);
      },
      onActivate: (key) => {
        this.activateButton(key);
      },
    });
    for (const pane of viewer.allPanes) layer.attach(pane);
    const state: TabState = {
      tabId,
      layer,
      selection: [],
      page: null,
      showTabOrder: false,
      disposers: [],
    };
    state.disposers.push(
      document.events.on('field:changed', () => {
        this.refresh(state, document);
      }),
      document.events.on('page:removed', () => {
        state.selection = [];
        this.refresh(state, document);
      }),
      document.events.on('page:moved', () => {
        this.refresh(state, document);
      }),
    );
    this.tabs.set(tabId, state);
    this.refresh(state, document);
    return state;
  }

  private dropTab(tabId: string): void {
    const state = this.tabs.get(tabId);
    if (!state) return;
    for (const d of state.disposers.splice(0)) d();
    state.layer.dispose();
    this.tabs.delete(tabId);
    if (this.tabs.size === 0) this.viewerService()?.setFormsVisible(true);
  }

  /** The layer of a tab, for the controller. */
  layerFor(tabId: string): FormLayer | null {
    return this.tabState(tabId)?.layer ?? null;
  }

  /** Re-reads every open tab's fields into its layer. */
  refreshAll(): void {
    for (const [tabId, state] of this.tabs) {
      const document = this.documentService()?.get(tabId);
      if (document) this.refresh(state, document);
    }
    const active = this.activeTab();
    if (active) this.notify();
  }

  /**
   * Pushes the document's fields into the layer, page by page.
   *
   * The viewer's `forms` flag is turned off as soon as a document with fields is seen and back on
   * when the last one closes: the layer draws them from here on, and PDFium drawing them too
   * would put two renderers on one page (ADR 0019).
   */
  private refresh(state: TabState, document: Document): void {
    const hasFields = document.state.fields.some((f) => !f.synthetic);
    this.viewerService()?.setFormsVisible(!hasFields);
    state.layer.setMode(hasFields || this.modeValue === 'design' ? this.modeValue : 'off');
    state.layer.setHighlight(this.settingsValue.highlightFields);
    document.state.pages.forEach((page, index) => {
      const refs = widgetsOnPage(document, page.id);
      state.layer.setWidgets(
        index,
        refs.map((ref) => toLayerWidget(ref, index)),
      );
      state.layer.setSelection(index, state.selection);
      state.layer.setTabNumbers(
        index,
        state.showTabOrder ? new Map(refs.map((r, i) => [r.key, i])) : null,
      );
    });
    this.notify();
  }

  // ---- mode ---------------------------------------------------------------------------------

  setMode(mode: FormMode): void {
    if (this.modeValue === mode) return;
    this.modeValue = mode;
    if (mode !== 'design') this.deselect();
    this.refreshAll();
    this.shell.invalidate();
  }

  get highlight(): boolean {
    return this.settingsValue.highlightFields;
  }

  toggleHighlight(): void {
    void this.setSetting('highlightFields', !this.settingsValue.highlightFields);
  }

  get tabOrderShown(): boolean {
    return this.activeTab()?.showTabOrder ?? false;
  }

  toggleTabOrder(): void {
    const state = this.activeTab();
    const document = this.activeDocument();
    if (!state || !document) return;
    state.showTabOrder = !state.showTabOrder;
    this.refresh(state, document);
    this.shell.invalidate();
  }

  // ---- selection ----------------------------------------------------------------------------

  get selection(): ReadonlyArray<string> {
    return this.activeTab()?.selection ?? [];
  }

  /** The selected widgets, their fields, and the bounding box the handles are drawn on. */
  selectionInfo(): FieldSelection {
    const state = this.activeTab();
    const document = this.activeDocument();
    if (!state || !document) return { widgets: [], fields: [], bounds: null, page: null };
    const keys = new Set(state.selection);
    const widgets: WidgetRef[] = [];
    for (const field of document.state.fields) {
      if (field.synthetic) continue;
      const design = fieldDesignOf(field);
      for (const widget of field.widgets) {
        const key = widgetKey(field.id, widget.id);
        if (!keys.has(key)) continue;
        widgets.push({
          field,
          widget,
          design,
          appearance: widgetAppearanceOf(widget, design),
          key,
        });
      }
    }
    const fields = [...new Map(widgets.map((w) => [w.field.id, w.field])).values()];
    return {
      widgets,
      fields,
      bounds: unionRect(widgets.map((w) => w.widget.rect)),
      page: state.page,
    };
  }

  select(keys: ReadonlyArray<string>, page?: number): void {
    const state = this.activeTab();
    if (!state) return;
    if (page !== undefined) state.page = page;
    this.applySelection(state, keys);
  }

  toggleSelected(key: string, page: number): void {
    const state = this.activeTab();
    if (!state) return;
    state.page = page;
    const next = state.selection.includes(key)
      ? state.selection.filter((k) => k !== key)
      : [...state.selection, key];
    this.applySelection(state, next);
  }

  deselect(): void {
    const state = this.activeTab();
    if (state) this.applySelection(state, []);
  }

  /** Selects every field on the page under the pointer, or on page 0 when there is none. */
  selectAllOnPage(page?: number): void {
    const state = this.activeTab();
    const document = this.activeDocument();
    if (!state || !document) return;
    const index = page ?? state.page ?? 0;
    const modelPage = document.state.pages[index];
    if (!modelPage) return;
    state.page = index;
    this.applySelection(
      state,
      widgetsOnPage(document, modelPage.id).map((w) => w.key),
    );
  }

  private applySelection(state: TabState, keys: ReadonlyArray<string>): void {
    state.selection = [...keys];
    const document = this.documentService()?.get(state.tabId);
    if (document) {
      document.state.pages.forEach((_page, index) => {
        state.layer.setSelection(index, keys);
      });
    }
    if (keys.length > 0) {
      this.shell.selection.set({ kind: 'fields', names: [...keys] });
    } else if (this.shell.selection.current.kind === 'fields') {
      this.shell.selection.clear();
    }
    this.shell.invalidate();
    this.notify();
  }

  setHover(page: number | null, key: string | null): void {
    this.activeTab()?.layer.setHover(page, key);
  }

  // ---- filling ------------------------------------------------------------------------------

  /**
   * A keystroke.
   *
   * The control itself is showing what was typed — it is a real `<input>` — so nothing is written
   * to the model here. Two things do happen: a **word boundary commits**, which is what makes
   * undo step back a word at a time rather than emptying the whole field, and a field that is now
   * full hands the keyboard on when auto-tab is set.
   */
  private typed(key: string, value: string): void {
    const found = this.resolve(key);
    if (!found) return;
    const design = fieldDesignOf(found.field);
    const settings = this.settingsValue;
    const full =
      design.maxLength !== null &&
      design.maxLength > 0 &&
      Array.from(value).length >= design.maxLength;
    if (settings.autoTab && full) {
      void this.commitValue(key, value).then(() => {
        this.focusNext(false);
      });
      return;
    }
    if (/\s$/.test(value)) void this.commitValue(key, value, true);
  }

  /**
   * Commits a value as a `Command`.
   *
   * A field the file already had goes through M20's `SetFieldValueCommand`, which pushes the
   * value into PDFium so the engine's own bytes carry it; a field this session designed has no
   * engine counterpart, so it takes `FormValueCommand` and reaches the file through the rebuild.
   * Both merge, so a word typed into a field is one undo step; `breakAfter` ends that step, which
   * is how a space makes undo word-wise.
   */
  async commitValue(key: string, value: string, breakAfter = false): Promise<void> {
    const found = this.resolve(key);
    if (!found) return;
    const { document, field } = found;
    const design = fieldDesignOf(field);
    if (!isFillable(design)) return;
    /*
     * The model is the guard once a commit has settled, and `committing` is the guard while one
     * is in flight. Both are needed: a control raises `change` and then `blur` with the same
     * value, and without the second guard the blur would start its own command before the
     * change's had reached the model — landing an undo step that undoes to the value it is
     * already at, which reads to the reader as an undo that did nothing.
     */
    if ((this.committing.get(field.id) ?? field.value) === value) return;
    const command = this.isDesigned(document, field)
      ? new FormValueCommand(document, field.id, value)
      : new SetFieldValueCommand(document, field.id, value);
    this.committing.set(field.id, value);
    try {
      await document.apply(command);
    } finally {
      this.committing.delete(field.id);
    }
    if (breakAfter) document.breakMerge();
    this.refreshAll();
  }

  /** Values whose command is in flight, by field id. See `commitValue`. */
  private readonly committing = new Map<string, string>();

  /** A push button has no value; the actions it runs are M61's. */
  private activateButton(key: string): void {
    const found = this.resolve(key);
    if (!found) return;
    this.shell.toasts.show({
      kind: 'info',
      text: `"${found.field.name}" has no action yet. Field actions arrive with the form-logic module.`,
    });
  }

  /** Puts every field back to its `/DV`, in one undo step. */
  async resetForm(): Promise<void> {
    const document = this.activeDocument();
    if (!document) return;
    const commands = [];
    for (const field of document.state.fields) {
      if (field.synthetic) continue;
      const design = fieldDesignOf(field);
      const wanted = design.defaultValue ?? '';
      if (field.value === wanted) continue;
      commands.push(
        this.isDesigned(document, field)
          ? new FormValueCommand(document, field.id, wanted)
          : new SetFieldValueCommand(document, field.id, wanted),
      );
    }
    if (commands.length === 0) {
      this.shell.toasts.show({ kind: 'info', text: 'Every field is already at its default.' });
      return;
    }
    await document.apply(new CompositeCommand('form.reset', 'Reset form', commands));
    this.refreshAll();
  }

  // ---- focus and tabbing ---------------------------------------------------------------------

  private focusWidget(key: string): void {
    const state = this.activeTab();
    if (!state) return;
    const parts = splitWidgetKey(key);
    const document = this.activeDocument();
    if (!parts || !document) return;
    const field = document.field(parts.fieldId as ModelId);
    const widget = field?.widgets.find((w) => w.id === parts.widgetId);
    if (widget) state.page = document.pageIndex(widget.pageId);
    if (this.modeValue === 'design') this.applySelection(state, [key]);
  }

  /** Moves the keyboard to the next (or previous) field in tab order, across pages. */
  focusNext(backwards: boolean): boolean {
    const state = this.activeTab();
    const document = this.activeDocument();
    if (!state || !document) return false;
    const ordered: WidgetRef[] = [];
    for (const page of document.state.pages) ordered.push(...widgetsOnPage(document, page.id));
    const fillable = ordered.filter((w) => isFillable(w.design));
    if (fillable.length === 0) return false;
    const current = state.layer.focusedKey();
    const at = current === null ? -1 : fillable.findIndex((w) => w.key === current);
    const next = at < 0 ? (backwards ? fillable.length - 1 : 0) : at + (backwards ? -1 : 1);
    const target = fillable[(next + fillable.length) % fillable.length];
    if (!target) return false;
    const page = document.pageIndex(target.widget.pageId);
    if (page >= 0) this.activeViewer()?.goToPage(page);
    return state.layer.focusWidget(target.key);
  }

  // ---- designing ------------------------------------------------------------------------------

  /** Every name in use, so a new field never silently joins an existing one. */
  takenNames(document: Document): string[] {
    return document.state.fields.filter((f) => !f.synthetic).map((f) => f.name);
  }

  /** The name a new field of `role` is offered. */
  nameFor(document: Document, role: FieldRole): string {
    const prefix = this.settingsValue.namePrefix;
    const base = `${prefix}${FIELD_ROLE_LABELS[role].replace(/ .*/, '')} 1`;
    return nextFreeName(base, this.takenNames(document));
  }

  /**
   * Creates a field. `rect` is where it was drawn; a click rather than a drag gives a zero-size
   * rectangle, which becomes the role's default size with its top-left where the click was.
   */
  async createField(role: FieldRole, page: number, rect: PdfRect): Promise<ModelField | null> {
    const document = this.activeDocument();
    const state = this.activeTab();
    if (!document || !state) return null;
    const modelPage = document.state.pages[page];
    if (!modelPage) return null;
    const box = this.sizeFor(role, rect);
    const design = defaultFieldDesign(role);
    const appearance = defaultWidgetAppearance(role);
    const name = this.nameFor(document, role);
    const widget: ModelWidget = {
      id: document.ids.next('widget'),
      pageId: modelPage.id,
      rect: box,
      annotationId: null,
      appearance,
    };
    const field: ModelField = {
      id: document.ids.next('field'),
      name,
      partialName: partialName(name),
      parentId: null,
      childIds: [],
      type:
        design.role === 'image'
          ? 'button'
          : design.role === 'date' || design.role === 'barcode'
            ? 'text'
            : design.role,
      value: '',
      defaultValue: null,
      readOnly: false,
      required: false,
      options: design.options,
      tooltip: null,
      widgets: [widget],
      synthetic: false,
      design,
    };
    this.markCreated(field.id);
    await document.apply(
      new AddFieldCommand(document, field, `Add ${FIELD_ROLE_LABELS[role].toLowerCase()}`),
    );
    state.page = page;
    this.refreshAll();
    this.applySelection(state, [widgetKey(field.id, widget.id)]);
    return field;
  }

  private sizeFor(role: FieldRole, rect: PdfRect): PdfRect {
    const r = normaliseRect(rect);
    const width = r.x1 - r.x0;
    const height = r.y1 - r.y0;
    if (width >= 4 && height >= 4) return this.snap(r);
    const size = defaultFieldSize(role);
    return this.snap({ x0: r.x0, y0: r.y0 - size.height, x1: r.x0 + size.width, y1: r.y0 });
  }

  /** Rounds a rectangle to the grid when the reader asked for that. */
  snap(rect: PdfRect): PdfRect {
    if (!this.settingsValue.snapToGrid) return rect;
    const step = Math.max(1, this.settingsValue.gridStep);
    const to = (n: number): number => Math.round(n / step) * step;
    return { x0: to(rect.x0), y0: to(rect.y0), x1: to(rect.x1), y1: to(rect.y1) };
  }

  /** Replaces a field, as one undoable step. `label` is what the Undo menu says. */
  async updateField(field: ModelField, label: string): Promise<void> {
    const document = this.activeDocument();
    if (!document) return;
    await document.apply(new UpdateFieldCommand(document, field, label));
    this.refreshAll();
  }

  /** Changes a field's design, keeping everything else. */
  async setDesign(
    fieldId: ModelId,
    patch: Partial<FieldDesign>,
    label = 'Change field',
  ): Promise<void> {
    const document = this.activeDocument();
    const field = document?.field(fieldId);
    if (!document || !field) return;
    const design = { ...fieldDesignOf(field), ...patch };
    await this.updateField(
      {
        ...field,
        design,
        readOnly: isReadOnly(design),
        options: design.options,
        tooltip: design.tooltip,
        defaultValue: design.defaultValue,
      },
      label,
    );
  }

  /** Changes one widget's appearance, keeping everything else. */
  async setWidgetAppearance(
    key: string,
    patch: Partial<WidgetAppearance>,
    label = 'Change appearance',
  ): Promise<void> {
    const found = this.resolve(key);
    if (!found) return;
    const { field, widget } = found;
    const design = fieldDesignOf(field);
    const appearance = { ...widgetAppearanceOf(widget, design), ...patch };
    await this.updateField(
      {
        ...field,
        widgets: field.widgets.map((w) => (w.id === widget.id ? { ...w, appearance } : w)),
      },
      label,
    );
  }

  /** Renames a field, refusing a name that would silently merge it with another. */
  async rename(fieldId: ModelId, name: string): Promise<string | null> {
    const document = this.activeDocument();
    const field = document?.field(fieldId);
    if (!document || !field) return 'That field is no longer in the document.';
    const problem = fieldNameProblem(name, this.takenNames(document), field.name);
    if (problem) return problem;
    const trimmed = name.trim();
    await this.updateField(
      { ...field, name: trimmed, partialName: partialName(trimmed) },
      'Rename field',
    );
    return null;
  }

  /** Moves or resizes the selected widgets. */
  async moveSelection(dx: number, dy: number): Promise<void> {
    await this.transformSelection(
      (rect) => ({
        x0: rect.x0 + dx,
        y0: rect.y0 + dy,
        x1: rect.x1 + dx,
        y1: rect.y1 + dy,
      }),
      'Move field',
    );
  }

  /** Applies a rectangle transform to every selected widget, in one undo step. */
  async transformSelection(
    transform: (rect: PdfRect, ref: WidgetRef) => PdfRect,
    label: string,
  ): Promise<void> {
    const document = this.activeDocument();
    const selection = this.selectionInfo();
    if (!document || selection.widgets.length === 0) return;
    const byField = new Map<ModelId, ModelField>();
    for (const ref of selection.widgets) {
      const current = byField.get(ref.field.id) ?? ref.field;
      byField.set(ref.field.id, {
        ...current,
        widgets: current.widgets.map((w) =>
          w.id === ref.widget.id
            ? { ...w, rect: this.snap(normaliseRect(transform(w.rect, ref))) }
            : w,
        ),
      });
    }
    const commands = [...byField.values()].map((f) => new UpdateFieldCommand(document, f, label));
    await document.apply(
      commands.length === 1 && commands[0]
        ? commands[0]
        : new CompositeCommand('form.transform', label, commands),
    );
    this.refreshAll();
  }

  /**
   * Resizes the selection by dragging one handle of its bounding box.
   *
   * Which handle was dragged is already in `to` — the controller works out the new bounding box
   * and hands it over — so every widget is scaled by the same factors, which is what keeps a row
   * of fields a row after a corner drag.
   */
  async resizeSelection(bounds: PdfRect, to: PdfRect): Promise<void> {
    const sx = bounds.x1 - bounds.x0 === 0 ? 1 : (to.x1 - to.x0) / (bounds.x1 - bounds.x0);
    const sy = bounds.y1 - bounds.y0 === 0 ? 1 : (to.y1 - to.y0) / (bounds.y1 - bounds.y0);
    await this.transformSelection(
      (rect) => ({
        x0: to.x0 + (rect.x0 - bounds.x0) * sx,
        y0: to.y0 + (rect.y0 - bounds.y0) * sy,
        x1: to.x0 + (rect.x1 - bounds.x0) * sx,
        y1: to.y0 + (rect.y1 - bounds.y0) * sy,
      }),
      'Resize field',
    );
  }

  /** Aligns the selected fields to each other, or to the page. */
  async align(edge: AlignEdge): Promise<void> {
    const document = this.activeDocument();
    const selection = this.selectionInfo();
    if (!document || selection.widgets.length < 2 || !selection.bounds) return;
    const reference = selection.bounds;
    await this.transformSelection((rect) => {
      const delta = alignDelta(rect, edge, reference);
      return {
        x0: rect.x0 + delta[4],
        y0: rect.y0 + delta[5],
        x1: rect.x1 + delta[4],
        y1: rect.y1 + delta[5],
      };
    }, 'Align fields');
  }

  /** Spaces the selected fields evenly. Needs three. */
  async distribute(axis: 'horizontal' | 'vertical'): Promise<void> {
    const selection = this.selectionInfo();
    if (selection.widgets.length < 3) return;
    const rects = selection.widgets.map((w) => w.widget.rect);
    const deltas = distributeDeltas(rects, axis);
    const byKey = new Map(selection.widgets.map((w, i) => [w.key, deltas[i]]));
    await this.transformSelection((rect, ref) => {
      const d = byKey.get(ref.key) ?? [1, 0, 0, 1, 0, 0];
      return { x0: rect.x0 + d[4], y0: rect.y0 + d[5], x1: rect.x1 + d[4], y1: rect.y1 + d[5] };
    }, 'Distribute fields');
  }

  /**
   * Makes every selected field the same size as the first one selected — which is the one the
   * reader clicked first, and the one Foxit calls the anchor.
   */
  async matchSize(what: 'width' | 'height' | 'both'): Promise<void> {
    const selection = this.selectionInfo();
    const first = selection.widgets[0];
    if (!first || selection.widgets.length < 2) return;
    const width = first.widget.rect.x1 - first.widget.rect.x0;
    const height = first.widget.rect.y1 - first.widget.rect.y0;
    await this.transformSelection(
      (rect) => ({
        x0: rect.x0,
        y0: what === 'width' ? rect.y0 : rect.y1 - height,
        x1: what === 'height' ? rect.x1 : rect.x0 + width,
        y1: rect.y1,
      }),
      'Match field size',
    );
  }

  /** Deletes every selected field. A field is deleted whole, widgets and all. */
  async deleteSelection(): Promise<void> {
    const document = this.activeDocument();
    const selection = this.selectionInfo();
    if (!document || selection.fields.length === 0) return;
    const commands = selection.fields.map((f) => new RemoveFieldCommand(document, f.id));
    await document.apply(
      commands.length === 1 && commands[0]
        ? commands[0]
        : new CompositeCommand('form.delete', 'Delete fields', commands),
    );
    this.deselect();
    this.refreshAll();
  }

  /**
   * Copies the selected fields onto every other page, or onto the pages named.
   *
   * A duplicate is a *new field* with a new name, not another widget of the same one: two widgets
   * of one field share a value, which is right for "sign here on every page" and wrong for
   * "initial each page".
   */
  async duplicateToPages(pages: ReadonlyArray<number>): Promise<number> {
    const document = this.activeDocument();
    const selection = this.selectionInfo();
    if (!document || selection.fields.length === 0 || pages.length === 0) return 0;
    const taken = this.takenNames(document);
    const commands = [];
    for (const page of pages) {
      const modelPage = document.state.pages[page];
      if (!modelPage) continue;
      for (const field of selection.fields) {
        const name = nextFreeName(field.name, taken);
        taken.push(name);
        const id = document.ids.next('field');
        this.markCreated(id);
        commands.push(
          new AddFieldCommand(
            document,
            {
              ...field,
              id,
              name,
              partialName: partialName(name),
              parentId: null,
              childIds: [],
              widgets: field.widgets.map((w) => ({
                ...w,
                id: document.ids.next('widget'),
                pageId: modelPage.id,
              })),
            },
            'Duplicate fields',
          ),
        );
      }
    }
    if (commands.length === 0) return 0;
    await document.apply(new CompositeCommand('form.duplicate', 'Duplicate fields', commands));
    this.refreshAll();
    return commands.length;
  }

  // ---- clipboard -----------------------------------------------------------------------------

  /** Copies the selected fields as JSON under a marker line, so a paste elsewhere rebuilds them. */
  async copy(): Promise<number> {
    const selection = this.selectionInfo();
    if (selection.fields.length === 0) return 0;
    const payload = `${CLIPBOARD_MARKER}\n${JSON.stringify(
      selection.fields.map((f) => ({
        name: f.name,
        design: fieldDesignOf(f),
        value: f.value,
        widgets: f.widgets.map((w) => ({
          rect: w.rect,
          appearance: widgetAppearanceOf(w, fieldDesignOf(f)),
        })),
      })),
    )}`;
    this.memoryClipboard = payload;
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      // A clipboard that refuses still leaves the in-session copy, which is what a paste in the
      // same window needs — and is the only case Windows' clipboard reliably wedges on.
    }
    return selection.fields.length;
  }

  async cut(): Promise<number> {
    const n = await this.copy();
    if (n > 0) await this.deleteSelection();
    return n;
  }

  /** Pastes fields onto `page`, offset when they came from the same page. */
  async paste(page: number): Promise<number> {
    const document = this.activeDocument();
    const state = this.activeTab();
    if (!document || !state) return 0;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // Windows' clipboard can wedge: a read comes back empty or throws even though our own
      // write reported success. The in-session copy is what a paste in the same window needs.
      text = '';
    }
    if (!text.startsWith(CLIPBOARD_MARKER)) text = this.memoryClipboard ?? '';
    if (!text.startsWith(CLIPBOARD_MARKER)) return 0;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(CLIPBOARD_MARKER.length));
    } catch {
      return 0;
    }
    if (!Array.isArray(parsed)) return 0;
    const modelPage = document.state.pages[page];
    if (!modelPage) return 0;
    const taken = this.takenNames(document);
    const commands = [];
    const keys: string[] = [];
    for (const entry of parsed as ReadonlyArray<Record<string, unknown>>) {
      const name = typeof entry['name'] === 'string' ? entry['name'] : 'Field';
      const design = entry['design'] as FieldDesign | undefined;
      const widgets = Array.isArray(entry['widgets'])
        ? (entry['widgets'] as ReadonlyArray<{ rect: PdfRect; appearance: WidgetAppearance }>)
        : [];
      if (!design || widgets.length === 0) continue;
      const fresh = nextFreeName(name, taken);
      taken.push(fresh);
      const fieldId = document.ids.next('field');
      const modelWidgets: ModelWidget[] = widgets.map((w) => ({
        id: document.ids.next('widget'),
        pageId: modelPage.id,
        rect: offset(w.rect, 12, -12),
        annotationId: null,
        appearance: w.appearance,
      }));
      keys.push(...modelWidgets.map((w) => widgetKey(fieldId, w.id)));
      this.markCreated(fieldId);
      commands.push(
        new AddFieldCommand(
          document,
          {
            id: fieldId,
            name: fresh,
            partialName: partialName(fresh),
            parentId: null,
            childIds: [],
            type:
              design.role === 'image'
                ? 'button'
                : design.role === 'date' || design.role === 'barcode'
                  ? 'text'
                  : design.role,
            value: typeof entry['value'] === 'string' ? entry['value'] : '',
            defaultValue: design.defaultValue,
            readOnly: isReadOnly(design),
            required: false,
            options: design.options,
            tooltip: design.tooltip,
            widgets: modelWidgets,
            synthetic: false,
            design,
          },
          'Paste fields',
        ),
      );
    }
    if (commands.length === 0) return 0;
    await document.apply(new CompositeCommand('form.paste', 'Paste fields', commands));
    state.page = page;
    this.refreshAll();
    this.applySelection(state, keys);
    return commands.length;
  }

  // ---- tab order -----------------------------------------------------------------------------

  /** The tab order of a page, as widget references in order. */
  tabOrderOf(page: number): WidgetRef[] {
    const document = this.activeDocument();
    const modelPage = document?.state.pages[page];
    if (!document || !modelPage) return [];
    return widgetsOnPage(document, modelPage.id);
  }

  tabModeOf(page: number): TabOrderMode {
    const document = this.activeDocument();
    const modelPage = document?.state.pages[page];
    return document && modelPage ? tabModeFor(document, modelPage.id) : 'row';
  }

  /** Sets how a page orders its fields for tabbing. */
  async setTabMode(page: number, mode: TabOrderMode): Promise<void> {
    const document = this.activeDocument();
    const modelPage = document?.state.pages[page];
    if (!document || !modelPage) return;
    const value: Record<string, unknown> = {
      tabModes: tabModesWith(document, modelPage.id, mode),
      tabOrder: manualOrderFor(document, modelPage.id).length
        ? tabOrderWith(document, modelPage.id, manualOrderFor(document, modelPage.id))
        : tabOrderWith(document, modelPage.id, []),
    };
    await document.apply(new SetCustomCommand(document, FORMS_NAMESPACE, value, 'Set tab order'));
    this.refreshAll();
  }

  /** Sets an explicit order for a page and switches it to manual. */
  async setManualOrder(page: number, keys: ReadonlyArray<string>): Promise<void> {
    const document = this.activeDocument();
    const modelPage = document?.state.pages[page];
    if (!document || !modelPage) return;
    const value: Record<string, unknown> = {
      tabModes: tabModesWith(document, modelPage.id, 'manual'),
      tabOrder: tabOrderWith(document, modelPage.id, keys),
    };
    await document.apply(new SetCustomCommand(document, FORMS_NAMESPACE, value, 'Set tab order'));
    this.refreshAll();
  }

  /** Re-sorts a page into row, column or structure order and stores it as the manual order. */
  async autoOrder(page: number, mode: TabOrderMode): Promise<void> {
    const document = this.activeDocument();
    const modelPage = document?.state.pages[page];
    if (!document || !modelPage) return;
    const ordered = orderWidgets(
      widgetsOnPage(document, modelPage.id),
      mode,
      manualOrderFor(document, modelPage.id),
    );
    await this.setManualOrder(
      page,
      ordered.map((w) => w.key),
    );
    await this.setTabMode(page, mode);
  }

  // ---- helpers -------------------------------------------------------------------------------

  /** A widget key back into the document, or null when it names nothing any more. */
  resolve(key: string): { document: Document; field: ModelField; widget: ModelWidget } | null {
    const document = this.activeDocument();
    const parts = splitWidgetKey(key);
    if (!document || !parts) return null;
    const field = document.field(parts.fieldId as ModelId);
    const widget = field?.widgets.find((w) => w.id === parts.widgetId);
    return field && widget ? { document, field, widget } : null;
  }

  /**
   * Whether a field was created in this session rather than read from the file.
   *
   * The engine is the authority on what it can take: `setFieldValue` throws for a field PDFium
   * has never heard of. Nothing in the model records where a field came from, so the ids of the
   * ones this session made are kept here — a set that empties itself when the tab closes because
   * the service does.
   */
  private isDesigned(_document: Document, field: ModelField): boolean {
    return this.createdHere.has(field.id);
  }

  /** Field ids this session created, so a value knows which command to take. */
  private readonly createdHere = new Set<string>();

  /** Records a field as ours (called by `createField` and the paste path). */
  markCreated(fieldId: ModelId): void {
    this.createdHere.add(fieldId);
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposers.splice(0)) d();
    for (const tabId of [...this.tabs.keys()]) this.dropTab(tabId);
    this.listeners.clear();
  }
}

function offset(rect: PdfRect, dx: number, dy: number): PdfRect {
  return { x0: rect.x0 + dx, y0: rect.y0 + dy, x1: rect.x1 + dx, y1: rect.y1 + dy };
}

/** A model widget as the layer wants it. */
function toLayerWidget(ref: WidgetRef, page: number): LayerWidget {
  return {
    key: ref.key,
    page,
    rect: ref.widget.rect,
    design: ref.design,
    appearance: ref.appearance,
    fieldName: ref.field.name,
    value: ref.field.value,
    options: ref.design.options,
    on: ref.field.value === ref.appearance.exportValue,
  };
}
