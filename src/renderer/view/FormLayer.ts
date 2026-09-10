/**
 * `FormLayer` — the form-widget layer M00 reserved, filled in by M60.
 *
 * Unlike `AnnotationLayer` and `ObjectLayer`, which draw only the chrome of editing, this layer
 * draws the fields themselves: a real `<input>`, `<textarea>`, `<select>` or `<button>` per
 * widget, positioned over the page. Three things make that the right answer rather than an
 * indulgence (ADR 0019):
 *
 * - a field the designer just drew is not in PDFium at all, because PDFium cannot create a widget
 *   annotation — so the engine could not draw it even if we wanted it to;
 * - typing has to appear as it is typed, and a round trip through the worker for every keystroke
 *   is not an editor;
 * - a real labelled control with a focus ring is what a screen reader and a keyboard need, and a
 *   real control hidden under a bitmap is a lie.
 *
 * While this layer is mounted the viewer renders the page with `forms: false`, so PDFium does not
 * draw the widgets as well. The colours come from the field's own `/MK` and `/DA` — a field's
 * appearance is document content, not interface, the same rule M30 set for annotation colours —
 * and the chrome around it (selection, handles, tab numbers, the required outline) is theme
 * tokens in the stylesheet.
 *
 * Controls are built once per widget and only *moved* afterwards, because rebuilding one would
 * take the caret out of it mid-word.
 */

import { contentBox, effectiveBorderWidth, TEXT_PADDING } from '@engine/forms/appearance';
import { barcodeSymbol } from '@engine/forms/barcode';
import {
  CHECK_STYLE_GLYPH,
  isComb,
  isEditableChoice,
  isMultiline,
  isMultiSelect,
  isPassword,
  isReadOnly,
  isRequired,
  type FieldDesign,
  type FieldOption,
  type WidgetAppearance,
} from '@engine/forms/model';
import { metricFont } from '@engine/appearance/types';
import type { PdfPoint, PdfRect } from '@shared/pdf';
import { BOX_HANDLES, HANDLE_SIZE, type BoxHandle } from './AnnotationLayer';
import type { DocumentView } from './DocumentView';
import type { PageView } from './PageView';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One widget, as the layer needs it. */
export interface LayerWidget {
  readonly key: string;
  readonly page: number;
  readonly rect: PdfRect;
  readonly design: FieldDesign;
  readonly appearance: WidgetAppearance;
  /** Fully-qualified field name — the accessible name when there is no tooltip. */
  readonly fieldName: string;
  readonly value: string;
  readonly options: ReadonlyArray<FieldOption>;
  /** True when this widget's export value is the field's current one. */
  readonly on: boolean;
}

/** What the layer tells its owner when the reader changes something. */
export interface FormLayerHandlers {
  /** A control's value changed as it is being typed or picked. */
  onInput?(key: string, value: string): void;
  /** The control lost focus or the reader pressed Enter — commit the value. */
  onCommit?(key: string, value: string): void;
  onFocus?(key: string): void;
  /** Tab past the last field of the document, or Shift+Tab before the first. */
  onTabOut?(key: string, backwards: boolean): void;
  /** A push button was pressed. */
  onActivate?(key: string): void;
}

export type FormMode = 'fill' | 'design' | 'off';

interface PaneBinding {
  readonly view: DocumentView;
  readonly dispose: () => void;
}

interface PageState {
  widgets: ReadonlyArray<LayerWidget>;
  selected: ReadonlySet<string>;
  hover: string | null;
  /** Tab numbers to draw over the widgets, by key. */
  tabNumbers: ReadonlyMap<string, number> | null;
}

interface Built {
  readonly root: HTMLDivElement;
  readonly control: HTMLElement;
  widget: LayerWidget;
  /** The last value pushed into the control, so an outside change is not fought with typing. */
  lastValue: string;
}

/** How far outside a widget a pointer still counts as on its resize handle, in CSS pixels. */
const HANDLE_SLACK = 3;

export class FormLayer {
  private readonly panes: PaneBinding[] = [];
  private readonly pages = new Map<number, PageState>();
  private readonly built = new Map<string, Built>();
  private readonly handlers: FormLayerHandlers;
  private mode: FormMode = 'fill';
  private highlight = true;
  private frame = 0;
  private disposed = false;
  private seq = 0;

  constructor(handlers: FormLayerHandlers = {}) {
    this.handlers = handlers;
  }

  attach(view: DocumentView): void {
    const onScroll = (): void => {
      this.schedule();
    };
    view.scroller.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(() => {
      this.schedule();
    });
    observer.observe(view.scroller);
    this.panes.push({
      view,
      dispose: () => {
        view.scroller.removeEventListener('scroll', onScroll);
        observer.disconnect();
      },
    });
    this.schedule();
  }

  setMode(mode: FormMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    for (const entry of this.built.values()) this.applyMode(entry);
    this.schedule();
  }

  get currentMode(): FormMode {
    return this.mode;
  }

  setHighlight(on: boolean): void {
    if (this.highlight === on) return;
    this.highlight = on;
    this.schedule();
  }

  private page(page: number): PageState {
    let s = this.pages.get(page);
    if (!s) {
      s = { widgets: [], selected: new Set(), hover: null, tabNumbers: null };
      this.pages.set(page, s);
    }
    return s;
  }

  setWidgets(page: number, widgets: ReadonlyArray<LayerWidget>): void {
    this.page(page).widgets = widgets;
    this.schedule();
  }

  widgetsOf(page: number): ReadonlyArray<LayerWidget> {
    return this.pages.get(page)?.widgets ?? [];
  }

  clear(): void {
    this.pages.clear();
    for (const entry of this.built.values()) entry.root.remove();
    this.built.clear();
    this.schedule();
  }

  setSelection(page: number, keys: Iterable<string>): void {
    this.page(page).selected = new Set(keys);
    this.schedule();
  }

  clearSelection(): void {
    for (const state of this.pages.values()) state.selected = new Set();
    this.schedule();
  }

  setHover(page: number | null, key: string | null): void {
    for (const [index, state] of this.pages) state.hover = index === page ? key : null;
    this.schedule();
  }

  /** Shows the tab position over each widget of a page, or removes the numbers with `null`. */
  setTabNumbers(page: number, numbers: ReadonlyMap<string, number> | null): void {
    this.page(page).tabNumbers = numbers;
    this.schedule();
  }

  /** The widget under a point in page space, topmost last-drawn first. */
  widgetAt(page: number, point: PdfPoint, slack = 0): LayerWidget | null {
    const list = this.pages.get(page)?.widgets ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const w = list[i];
      if (!w) continue;
      const r = w.rect;
      if (
        point.x >= r.x0 - slack &&
        point.x <= r.x1 + slack &&
        point.y >= r.y0 - slack &&
        point.y <= r.y1 + slack
      ) {
        return w;
      }
    }
    return null;
  }

  /** Widgets whose rectangle intersects `rect` — the marquee's answer. */
  widgetsWithin(page: number, rect: PdfRect): LayerWidget[] {
    return (this.pages.get(page)?.widgets ?? []).filter(
      (w) =>
        w.rect.x0 < rect.x1 && w.rect.x1 > rect.x0 && w.rect.y0 < rect.y1 && w.rect.y1 > rect.y0,
    );
  }

  /** The resize handle of the current selection under a point, or null. */
  handleAt(page: number, point: PdfPoint, scale: number): BoxHandle | null {
    const bounds = this.selectionBounds(page);
    if (!bounds) return null;
    const slack = (HANDLE_SIZE / 2 + HANDLE_SLACK) / Math.max(scale, 1e-6);
    for (const handle of BOX_HANDLES) {
      const p = handlePoint(bounds, handle);
      if (Math.abs(p.x - point.x) <= slack && Math.abs(p.y - point.y) <= slack) return handle;
    }
    return null;
  }

  selectionBounds(page: number): PdfRect | null {
    const state = this.pages.get(page);
    if (!state) return null;
    let out: PdfRect | null = null;
    for (const w of state.widgets) {
      if (!state.selected.has(w.key)) continue;
      out = out
        ? {
            x0: Math.min(out.x0, w.rect.x0),
            y0: Math.min(out.y0, w.rect.y0),
            x1: Math.max(out.x1, w.rect.x1),
            y1: Math.max(out.y1, w.rect.y1),
          }
        : w.rect;
    }
    return out;
  }

  /** Moves the keyboard focus into a widget's control, if it has one that takes focus. */
  focusWidget(key: string): boolean {
    const entry = this.built.get(key);
    if (!entry) return false;
    const control = entry.control;
    if (!(control instanceof HTMLElement) || control.hasAttribute('disabled')) return false;
    control.focus();
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
      control.select();
    }
    return true;
  }

  /** The key of the widget whose control has the focus, or null. */
  focusedKey(): string | null {
    const active = document.activeElement;
    if (!active) return null;
    for (const [key, entry] of this.built) {
      if (entry.control === active || entry.control.contains(active)) return key;
    }
    return null;
  }

  schedule(): void {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  paint(): void {
    if (this.disposed) return;
    const live = new Set<string>();
    for (const { view } of this.panes) {
      for (const rect of view.layoutTable.rects) {
        const pageView = view.pageView(rect.page);
        if (!pageView) continue;
        const state = this.pages.get(rect.page);
        this.paintPage(pageView, state ?? null, live);
      }
    }
    for (const [key, entry] of this.built) {
      if (live.has(key)) continue;
      entry.root.remove();
      this.built.delete(key);
    }
  }

  private paintPage(pageView: PageView, state: PageState | null, live: Set<string>): void {
    const host = pageView.layers.widget;
    host.dataset['mode'] = this.mode;
    host.classList.toggle('form-highlight', this.highlight && this.mode !== 'off');
    if (!state || this.mode === 'off') {
      if (state) for (const w of state.widgets) this.built.get(w.key)?.root.remove();
      host.replaceChildren();
      return;
    }
    // The chrome (selection, handles, tab numbers) is one SVG kept as the first child; the
    // controls are siblings after it, so a rebuild of the chrome never touches a live control.
    let chrome = host.querySelector<SVGSVGElement>(':scope > svg.form-chrome');
    if (!chrome) {
      chrome = document.createElementNS(SVG_NS, 'svg');
      chrome.setAttribute('class', 'form-chrome');
      host.prepend(chrome);
    }
    chrome.setAttribute('width', String(pageView.widthPx));
    chrome.setAttribute('height', String(pageView.heightPx));
    chrome.setAttribute('viewBox', `0 0 ${pageView.widthPx} ${pageView.heightPx}`);
    chrome.replaceChildren();

    for (const widget of state.widgets) {
      live.add(widget.key);
      const entry = this.ensureBuilt(widget, host);
      this.place(entry, pageView, widget);
      this.update(entry, widget);
      entry.root.classList.toggle('selected', state.selected.has(widget.key));
      entry.root.classList.toggle('hovered', state.hover === widget.key);
    }

    const bounds = this.selectionBounds(pageView.index);
    if (bounds && this.mode === 'design') {
      // Two rings, drawn one over the other: `--focus` is white in the dark themes, and a white
      // dashed box on white paper is no box at all.
      chrome.append(rectEl(pageView, bounds, 'form-bounds-back'));
      chrome.append(rectEl(pageView, bounds, 'form-bounds'));
      const half = HANDLE_SIZE / 2;
      for (const handle of BOX_HANDLES) {
        const p = pageView.transform.toDevice(handlePoint(bounds, handle));
        const el = document.createElementNS(SVG_NS, 'rect');
        el.setAttribute('class', 'form-handle');
        el.dataset['handle'] = handle;
        el.setAttribute('x', String(p.x - half));
        el.setAttribute('y', String(p.y - half));
        el.setAttribute('width', String(HANDLE_SIZE));
        el.setAttribute('height', String(HANDLE_SIZE));
        chrome.append(el);
      }
    }

    const numbers = state.tabNumbers;
    if (numbers) {
      for (const widget of state.widgets) {
        const n = numbers.get(widget.key);
        if (n === undefined) continue;
        const p = pageView.transform.toDevice({ x: widget.rect.x0, y: widget.rect.y1 });
        const group = document.createElementNS(SVG_NS, 'g');
        group.setAttribute('class', 'form-tab-number');
        const box = document.createElementNS(SVG_NS, 'rect');
        const label = String(n + 1);
        const w = 12 + label.length * 7;
        box.setAttribute('x', String(p.x));
        box.setAttribute('y', String(p.y - 16));
        box.setAttribute('width', String(w));
        box.setAttribute('height', '16');
        group.append(box);
        const text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('x', String(p.x + w / 2));
        text.setAttribute('y', String(p.y - 4));
        text.setAttribute('text-anchor', 'middle');
        text.textContent = label;
        group.append(text);
        chrome.append(group);
      }
    }
  }

  /** Creates the control for a widget the first time it is seen. */
  private ensureBuilt(widget: LayerWidget, host: HTMLElement): Built {
    const existing = this.built.get(widget.key);
    if (existing?.root.dataset['kind'] === kindOf(widget)) {
      if (existing.root.parentElement !== host) host.append(existing.root);
      existing.widget = widget;
      return existing;
    }
    existing?.root.remove();
    const root = document.createElement('div');
    root.className = 'form-widget';
    root.dataset['key'] = widget.key;
    root.dataset['kind'] = kindOf(widget);
    const control = this.createControl(widget, root);
    root.append(control);
    host.append(root);
    const entry: Built = { root, control, widget, lastValue: widget.value };
    this.built.set(widget.key, entry);
    this.applyMode(entry);
    return entry;
  }

  private createControl(widget: LayerWidget, root: HTMLDivElement): HTMLElement {
    const id = `field-${++this.seq}`;
    const design = widget.design;
    const name = widget.design.tooltip ?? widget.fieldName;
    const kind = kindOf(widget);
    let control: HTMLElement;
    switch (kind) {
      case 'textarea': {
        const el = document.createElement('textarea');
        el.rows = 2;
        control = el;
        break;
      }
      case 'select': {
        const el = document.createElement('select');
        control = el;
        break;
      }
      case 'listbox': {
        const el = document.createElement('select');
        el.size = 4;
        el.multiple = isMultiSelect(design);
        control = el;
        break;
      }
      case 'button': {
        const el = document.createElement('button');
        el.type = 'button';
        control = el;
        break;
      }
      case 'checkbox':
      case 'radio': {
        const el = document.createElement('input');
        el.type = kind;
        if (kind === 'radio') el.name = `radio-${widget.fieldName}`;
        control = el;
        break;
      }
      case 'signature':
      case 'barcode': {
        const el = document.createElement('div');
        el.setAttribute('role', 'img');
        control = el;
        break;
      }
      default: {
        const el = document.createElement('input');
        el.type = design.role === 'date' ? 'text' : isPassword(design) ? 'password' : 'text';
        if (design.maxLength !== null && design.maxLength > 0) el.maxLength = design.maxLength;
        if (design.role === 'date') el.inputMode = 'numeric';
        control = el;
        break;
      }
    }
    control.id = id;
    control.classList.add('form-control');
    control.setAttribute('aria-label', name);
    if (design.tooltip) control.title = design.tooltip;
    if (isRequired(design)) control.setAttribute('aria-required', 'true');
    if (design.role === 'date' && design.dateFormat) {
      control.setAttribute('aria-description', `Date, ${design.dateFormat}`);
    }
    this.bind(control, widget);
    root.dataset['for'] = id;
    return control;
  }

  private bind(control: HTMLElement, widget: LayerWidget): void {
    const key = widget.key;
    const read = (): string => readControl(control, widget);
    control.addEventListener('focus', () => {
      this.handlers.onFocus?.(key);
    });
    if (control instanceof HTMLButtonElement) {
      control.addEventListener('click', () => {
        this.handlers.onActivate?.(key);
      });
      return;
    }
    control.addEventListener('input', () => {
      this.handlers.onInput?.(key, read());
    });
    control.addEventListener('change', () => {
      this.handlers.onCommit?.(key, read());
    });
    control.addEventListener('blur', () => {
      this.handlers.onCommit?.(key, read());
    });
    control.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !(control instanceof HTMLTextAreaElement)) {
        this.handlers.onCommit?.(key, read());
      }
      // Ctrl+Tab inserts a tab inside a multiline field, as the brief asks; a plain Tab still
      // moves to the next field, which is what every other form in the world does.
      if (e.key === 'Tab' && e.ctrlKey && control instanceof HTMLTextAreaElement) {
        e.preventDefault();
        const start = control.selectionStart;
        const end = control.selectionEnd;
        control.value = `${control.value.slice(0, start)}\t${control.value.slice(end)}`;
        control.selectionStart = control.selectionEnd = start + 1;
        this.handlers.onInput?.(key, control.value);
      }
    });
  }

  /** Enables or disables every control for the current mode. */
  private applyMode(entry: Built): void {
    const control = entry.control;
    const readOnly = isReadOnly(entry.widget.design);
    const interactive = this.mode === 'fill' && !readOnly;
    entry.root.classList.toggle('design', this.mode === 'design');
    if (
      control instanceof HTMLInputElement ||
      control instanceof HTMLTextAreaElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLButtonElement
    ) {
      // Read-only stays focusable and readable — `disabled` would hide it from a screen reader
      // and from the tab order, and a reader still needs to know the field is there and what it
      // says. Only design mode takes it out of the tab order, where the tool owns the pointer.
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
        control.readOnly = !interactive;
      } else {
        /*
         * A select or a button is only *disabled* when the field itself is read-only. In design
         * mode nothing on this layer takes a pointer or a tab stop anyway, and leaving the
         * control enabled keeps its text at the field's own contrast rather than the browser's
         * grey.
         */
        control.disabled = this.mode === 'fill' && readOnly;
      }
      control.tabIndex = this.mode === 'design' ? -1 : 0;
      control.setAttribute('aria-readonly', String(!interactive));
    }
  }

  /** Positions a widget's box over the page. */
  private place(entry: Built, pageView: PageView, widget: LayerWidget): void {
    const box = pageView.transform.rectToDevice(widget.rect);
    const style = entry.root.style;
    style.left = `${box.left}px`;
    style.top = `${box.top}px`;
    style.width = `${Math.max(1, box.width)}px`;
    style.height = `${Math.max(1, box.height)}px`;
    const scale = pageView.transform.scale;
    const appearance = widget.appearance;
    const border = effectiveBorderWidth(appearance);
    style.setProperty('--widget-border', `${border * scale}px`);
    style.setProperty(
      '--widget-border-colour',
      appearance.borderColor === null ? 'transparent' : hex(appearance.borderColor),
    );
    style.setProperty(
      '--widget-fill',
      appearance.fillColor === null ? 'transparent' : hex(appearance.fillColor),
    );
    style.setProperty('--widget-ink', hex(widget.design.textColor));
    style.setProperty('--widget-font', cssFont(widget.design));
    const content = contentBox(widget.rect, appearance);
    const fontSize =
      widget.design.fontSize > 0 ? widget.design.fontSize : autoFontSize(widget, content);
    style.setProperty('--widget-size', `${Math.max(1, fontSize * scale)}px`);
    style.setProperty('--widget-pad', `${TEXT_PADDING * scale}px`);
    style.setProperty(
      '--widget-align',
      widget.design.align === 1 ? 'center' : widget.design.align === 2 ? 'right' : 'left',
    );
    entry.root.classList.toggle('required', isRequired(widget.design));
    entry.root.classList.toggle('read-only', isReadOnly(widget.design));
    entry.root.dataset['border'] = appearance.borderStyle;
  }

  /** Pushes the current value and options into an already-built control. */
  private update(entry: Built, widget: LayerWidget): void {
    entry.widget = widget;
    const control = entry.control;
    const design = widget.design;
    if (control instanceof HTMLSelectElement) {
      const wanted = widget.options.map((o) => `${o.value} ${o.label}`).join('');
      if (control.dataset['options'] !== wanted) {
        control.dataset['options'] = wanted;
        control.replaceChildren();
        if (!control.multiple && isEditableChoice(design)) {
          // An editable combo needs a slot for a value that is not one of the options.
          const custom = document.createElement('option');
          custom.value = widget.value;
          custom.textContent = widget.value;
          custom.hidden = true;
          control.append(custom);
        }
        for (const option of widget.options) {
          const el = document.createElement('option');
          el.value = option.value;
          el.textContent = option.label;
          control.append(el);
        }
      }
      const selected = new Set(
        control.multiple ? widget.value.split('\n').filter((v) => v !== '') : [widget.value],
      );
      for (const option of Array.from(control.options))
        option.selected = selected.has(option.value);
      entry.lastValue = widget.value;
      return;
    }
    if (control instanceof HTMLButtonElement) {
      control.textContent = widget.appearance.caption ?? '';
      return;
    }
    if (
      control instanceof HTMLInputElement &&
      (control.type === 'checkbox' || control.type === 'radio')
    ) {
      control.checked = widget.on;
      control.value = widget.appearance.exportValue;
      control.style.setProperty(
        '--widget-glyph',
        `'${CHECK_STYLE_GLYPH[widget.appearance.checkStyle]}'`,
      );
      entry.root.dataset['check'] = widget.appearance.checkStyle;
      return;
    }
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
      // Never fight the reader: while the control has the focus its own value is the truth.
      if (document.activeElement !== control && control.value !== widget.value) {
        control.value = widget.value;
      }
      entry.lastValue = widget.value;
      if (isComb(design) && design.maxLength) {
        entry.root.style.setProperty('--widget-comb', String(design.maxLength));
      }
      return;
    }
    if (design.role === 'barcode') {
      this.paintBarcode(entry, widget);
      return;
    }
    if (design.role === 'signature') {
      control.setAttribute('aria-label', `${design.tooltip ?? widget.fieldName}, unsigned`);
    }
  }

  /** Draws a barcode field's symbol as an inline SVG — the same geometry the file will carry. */
  private paintBarcode(entry: Built, widget: LayerWidget): void {
    const spec = widget.design.barcode;
    const key = `${spec?.symbology ?? ''}|${spec?.errorCorrection ?? ''}|${widget.value}`;
    if (entry.control.dataset['barcode'] === key) return;
    entry.control.dataset['barcode'] = key;
    entry.control.replaceChildren();
    entry.control.setAttribute(
      'aria-label',
      widget.value === ''
        ? `${widget.design.tooltip ?? widget.fieldName}, barcode, no value`
        : `${widget.design.tooltip ?? widget.fieldName}, barcode of ${widget.value}`,
    );
    if (!spec || widget.value === '') return;
    let symbol;
    try {
      symbol = barcodeSymbol(spec, widget.value);
    } catch {
      return;
    }
    if (!symbol) return;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${symbol.width} ${symbol.height}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('class', 'form-barcode');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute(
      'd',
      symbol.polygons
        .map((polygon) =>
          polygon
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`)
            .concat('Z')
            .join(''),
        )
        .join(''),
    );
    svg.append(path);
    entry.control.append(svg);
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const entry of this.built.values()) entry.root.remove();
    this.built.clear();
    for (const pane of this.panes.splice(0)) {
      pane.dispose();
      for (const rect of pane.view.layoutTable.rects) {
        pane.view.pageView(rect.page)?.layers.widget.replaceChildren();
      }
    }
    this.pages.clear();
  }
}

/** Which control a widget needs. */
function kindOf(widget: LayerWidget): string {
  const design = widget.design;
  switch (design.role) {
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'combobox':
      return 'select';
    case 'listbox':
      return 'listbox';
    case 'button':
    case 'image':
      return 'button';
    case 'signature':
      return 'signature';
    case 'barcode':
      return 'barcode';
    default:
      return isMultiline(design) ? 'textarea' : 'text';
  }
}

function readControl(control: HTMLElement, widget: LayerWidget): string {
  if (control instanceof HTMLSelectElement) {
    if (!control.multiple) return control.value;
    return Array.from(control.selectedOptions)
      .map((o) => o.value)
      .join('\n');
  }
  if (control instanceof HTMLInputElement) {
    if (control.type === 'checkbox' || control.type === 'radio') {
      return control.checked ? widget.appearance.exportValue : 'Off';
    }
    return control.value;
  }
  if (control instanceof HTMLTextAreaElement) return control.value;
  return widget.value;
}

/** `0xRRGGBB` as a CSS colour. Document content, not chrome — see the file comment. */
function hex(colour: number): string {
  return `#${(colour & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** The CSS family a `/DA` font maps to. Generic families only: nothing here is embedded. */
function cssFont(design: FieldDesign): string {
  const face = metricFont(design.font);
  if (face.startsWith('Times')) return 'Times, "Liberation Serif", serif';
  if (face.startsWith('Courier')) return '"Courier New", "Liberation Mono", monospace';
  if (face === 'ZapfDingbats' || face === 'Symbol') return 'serif';
  return 'Helvetica, Arial, "Liberation Sans", sans-serif';
}

/** The size auto-sizing would pick, mirrored from the appearance generator. */
function autoFontSize(widget: LayerWidget, content: PdfRect): number {
  const height = content.y1 - content.y0;
  return Math.max(4, Math.min(24, Math.floor(isMultiline(widget.design) ? 10 : height / 1.15)));
}

function handlePoint(r: PdfRect, handle: BoxHandle): PdfPoint {
  const midX = (r.x0 + r.x1) / 2;
  const midY = (r.y0 + r.y1) / 2;
  switch (handle) {
    case 'nw':
      return { x: r.x0, y: r.y1 };
    case 'n':
      return { x: midX, y: r.y1 };
    case 'ne':
      return { x: r.x1, y: r.y1 };
    case 'e':
      return { x: r.x1, y: midY };
    case 'se':
      return { x: r.x1, y: r.y0 };
    case 's':
      return { x: midX, y: r.y0 };
    case 'sw':
      return { x: r.x0, y: r.y0 };
    default:
      return { x: r.x0, y: midY };
  }
}

function rectEl(pageView: PageView, r: PdfRect, className: string): SVGRectElement {
  const b = pageView.transform.rectToDevice(r);
  const el = document.createElementNS(SVG_NS, 'rect');
  el.setAttribute('class', className);
  el.setAttribute('x', String(b.left));
  el.setAttribute('y', String(b.top));
  el.setAttribute('width', String(Math.max(1, b.width)));
  el.setAttribute('height', String(Math.max(1, b.height)));
  return el;
}
