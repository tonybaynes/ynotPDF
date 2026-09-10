/**
 * M60's own slice of the document: the tab order, and the helpers that turn a `ModelField` into
 * something drawable.
 *
 * Tab order is not a property of a field or of a widget — it is a property of a *page*, and the
 * PDF says so: `/Tabs` names a rule (`R` by row, `C` by column, `S` by structure) and a manual
 * order is the order of the page's `/Annots`. The model has no place for a per-page form setting,
 * so it lives in `Document.custom` under this module's namespace, which is journalled, undone and
 * recovered with everything else (M20's `SetCustomCommand`).
 */

import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import { fieldDesignOf, widgetAppearanceOf, type ModelField, type ModelWidget } from '@core/model';
import type { FieldDesign, WidgetAppearance } from '@engine/forms/model';
import { TAB_ORDER_MODES, type TabOrderMode } from '@engine/forms/model';
import type { PdfRect } from '@shared/pdf';

/** The `Document.custom` namespace this module keeps its per-document state in. */
export const FORMS_NAMESPACE = 'forms';

/** One field and one of its widgets, which is the unit everything on a page acts on. */
export interface WidgetRef {
  readonly field: ModelField;
  readonly widget: ModelWidget;
  readonly design: FieldDesign;
  readonly appearance: WidgetAppearance;
  /** `<fieldId>:<widgetId>` — the id the layer, the selection and the commands use. */
  readonly key: string;
}

export function widgetKey(fieldId: ModelId, widgetId: ModelId): string {
  return `${fieldId}:${widgetId}`;
}

export function splitWidgetKey(key: string): { fieldId: string; widgetId: string } | null {
  const at = key.indexOf(':');
  if (at < 0) return null;
  return { fieldId: key.slice(0, at), widgetId: key.slice(at + 1) };
}

/** Every widget of every real field, in field order. Synthetic tree nodes have none. */
export function allWidgets(doc: Document): WidgetRef[] {
  const out: WidgetRef[] = [];
  for (const field of doc.state.fields) {
    if (field.synthetic) continue;
    const design = fieldDesignOf(field);
    for (const widget of field.widgets) {
      out.push({
        field,
        widget,
        design,
        appearance: widgetAppearanceOf(widget, design),
        key: widgetKey(field.id, widget.id),
      });
    }
  }
  return out;
}

/** The widgets on one page, in the order the page's tab order puts them. */
export function widgetsOnPage(doc: Document, pageId: ModelId): WidgetRef[] {
  const mine = allWidgets(doc).filter((w) => w.widget.pageId === pageId);
  return orderWidgets(mine, tabModeFor(doc, pageId), manualOrderFor(doc, pageId));
}

/** The per-page tab settings, as stored. */
interface TabState {
  readonly modes: Readonly<Record<string, TabOrderMode>>;
  /** Widget keys in manual order, per page. */
  readonly order: Readonly<Record<string, ReadonlyArray<string>>>;
}

function tabState(doc: Document): TabState {
  const bag = doc.custom(FORMS_NAMESPACE);
  const modes = bag['tabModes'];
  const order = bag['tabOrder'];
  return {
    modes: isRecordOf(modes, isTabMode) ? modes : {},
    order: isRecordOf(order, isStringArray) ? order : {},
  };
}

function isTabMode(value: unknown): value is TabOrderMode {
  return typeof value === 'string' && (TAB_ORDER_MODES as ReadonlyArray<string>).includes(value);
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isRecordOf<T>(
  value: unknown,
  check: (v: unknown) => v is T,
): value is Readonly<Record<string, T>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(check)
  );
}

/** The tab order a page uses. Rows are the default, which is how a form is read. */
export function tabModeFor(doc: Document, pageId: ModelId): TabOrderMode {
  return tabState(doc).modes[pageId] ?? 'row';
}

/** The manual order a page has been given, or an empty list when it has none. */
export function manualOrderFor(doc: Document, pageId: ModelId): ReadonlyArray<string> {
  return tabState(doc).order[pageId] ?? [];
}

/** The custom-bag value that sets a page's mode, for `SetCustomCommand`. */
export function tabModesWith(
  doc: Document,
  pageId: ModelId,
  mode: TabOrderMode,
): Readonly<Record<string, TabOrderMode>> {
  return { ...tabState(doc).modes, [pageId]: mode };
}

/** The custom-bag value that sets a page's manual order. */
export function tabOrderWith(
  doc: Document,
  pageId: ModelId,
  keys: ReadonlyArray<string>,
): Readonly<Record<string, ReadonlyArray<string>>> {
  return { ...tabState(doc).order, [pageId]: [...keys] };
}

/**
 * Sorts a page's widgets.
 *
 * `row` and `column` band the boxes so two fields whose vertical spans overlap are on the same
 * line however their tops differ — which is what a form laid out by eye looks like. `structure`
 * has no structure tree to read before M111, so it falls back to rows and the properties panel
 * says so in words. `manual` follows the stored list, with anything not in it appended in row
 * order so a newly drawn field is never lost.
 */
export function orderWidgets(
  widgets: ReadonlyArray<WidgetRef>,
  mode: TabOrderMode,
  manual: ReadonlyArray<string>,
): WidgetRef[] {
  if (mode === 'manual') {
    const byKey = new Map(widgets.map((w) => [w.key, w]));
    const out: WidgetRef[] = [];
    for (const key of manual) {
      const found = byKey.get(key);
      if (found) {
        out.push(found);
        byKey.delete(key);
      }
    }
    return [...out, ...sortByBand([...byKey.values()], 'row')];
  }
  return sortByBand(widgets, mode === 'column' ? 'column' : 'row');
}

/** Row- or column-major order over the widget rectangles. */
function sortByBand(widgets: ReadonlyArray<WidgetRef>, mode: 'row' | 'column'): WidgetRef[] {
  const items = widgets.map((w) => ({ w, rect: w.widget.rect }));
  const sorted =
    mode === 'column'
      ? [...items].sort((a, b) => a.rect.x0 - b.rect.x0 || b.rect.y1 - a.rect.y1)
      : [...items].sort((a, b) => b.rect.y1 - a.rect.y1 || a.rect.x0 - b.rect.x0);
  const bands: Array<Array<(typeof sorted)[number]>> = [];
  for (const item of sorted) {
    const span =
      mode === 'column'
        ? { lo: item.rect.x0, hi: item.rect.x1 }
        : { lo: item.rect.y0, hi: item.rect.y1 };
    const last = bands[bands.length - 1];
    const prevItem = last?.[last.length - 1];
    if (last && prevItem) {
      const prev =
        mode === 'column'
          ? { lo: prevItem.rect.x0, hi: prevItem.rect.x1 }
          : { lo: prevItem.rect.y0, hi: prevItem.rect.y1 };
      const overlap = Math.min(prev.hi, span.hi) - Math.max(prev.lo, span.lo);
      const shorter = Math.min(prev.hi - prev.lo, span.hi - span.lo);
      if (overlap > shorter / 2) {
        last.push(item);
        continue;
      }
    }
    bands.push([item]);
  }
  return bands
    .flatMap((band) =>
      mode === 'column'
        ? [...band].sort((a, b) => b.rect.y1 - a.rect.y1)
        : [...band].sort((a, b) => a.rect.x0 - b.rect.x0),
    )
    .map((i) => i.w);
}

/** The union of some rectangles, or null for none. */
export function unionRect(rects: ReadonlyArray<PdfRect>): PdfRect | null {
  let out: PdfRect | null = null;
  for (const r of rects) {
    out = out
      ? {
          x0: Math.min(out.x0, r.x0),
          y0: Math.min(out.y0, r.y0),
          x1: Math.max(out.x1, r.x1),
          y1: Math.max(out.y1, r.y1),
        }
      : r;
  }
  return out;
}

/** `x0 <= x1`, `y0 <= y1`. */
export function normaliseRect(r: PdfRect): PdfRect {
  return {
    x0: Math.min(r.x0, r.x1),
    y0: Math.min(r.y0, r.y1),
    x1: Math.max(r.x0, r.x1),
    y1: Math.max(r.y0, r.y1),
  };
}
