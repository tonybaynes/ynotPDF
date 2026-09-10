/**
 * The form, as instructions for the writer (M60, ADR 0019).
 *
 * Pure, like the rest of `buildWritePlan`: a `Document` in, JSON-shaped data out. M21 calls
 * `plannedFormFor` exactly as it calls M50's `plannedObjectsFor`, so the plan builder needs to
 * know nothing about form fields and this module needs to know nothing about saving.
 *
 * Every widget's appearance stream is generated here rather than in the writer, because the same
 * generator draws the widget on screen: what is saved is what was shown.
 */

import type { Document } from '@core/Document';
import { fieldDesignOf, widgetAppearanceOf, type ModelField } from '@core/model';
import { widgetAppearance } from '@engine/forms/appearance';
import { formatDefaultAppearance } from '@engine/forms/da';
import {
  BUTTON_FLAGS,
  fieldTypeOf,
  flagBit,
  hasFlag,
  type FieldDesign,
  type TabOrderMode,
} from '@engine/forms/model';
import { BARCODE_KEY, ROLE_KEY } from '@engine/pdfium/rawform';
import type {
  PlannedFieldAction,
  PlannedFieldType,
  PlannedForm,
  PlannedFormField,
  PlannedFormWidget,
  PlannedTabOrder,
} from '@engine/Writer';
import type { DictValue } from '@engine/appearance/dict';
import { manualOrderFor, orderWidgets, tabModeFor, widgetKey, type WidgetRef } from './model';

/** `/FT` names, from the model's role. */
const FT: Readonly<Record<string, PlannedFieldType>> = {
  text: 'Tx',
  checkbox: 'Btn',
  radio: 'Btn',
  combobox: 'Ch',
  listbox: 'Ch',
  button: 'Btn',
  signature: 'Sig',
  unknown: 'Tx',
};

/** `/F`: bit 3 print, bit 2 hidden. */
function annotationFlags(hidden: boolean, noPrint: boolean): number {
  return (hidden ? 2 : 0) | (noPrint ? 0 : 4);
}

/**
 * The whole form, or null when the document has no fields at all — in which case the writer's
 * rebuild would only empty an `/AcroForm` that may still be doing something useful.
 */
export function plannedFormFor(
  doc: Document,
  warn: (message: string) => void,
): PlannedForm | null {
  const fields = doc.state.fields.filter((f) => !f.synthetic);
  if (fields.length === 0) return null;

  // Tab position per widget: worked out per page, so the writer can append `/Annots` in order.
  const tabIndexOf = new Map<string, number>();
  const tabs: Array<PlannedTabOrder | null> = [];
  for (const page of doc.state.pages) {
    const mode = tabModeFor(doc, page.id);
    const onPage: WidgetRef[] = [];
    for (const field of fields) {
      const design = fieldDesignOf(field);
      for (const widget of field.widgets) {
        if (widget.pageId !== page.id) continue;
        onPage.push({
          field,
          widget,
          design,
          appearance: widgetAppearanceOf(widget, design),
          key: widgetKey(field.id, widget.id),
        });
      }
    }
    orderWidgets(onPage, mode, manualOrderFor(doc, page.id)).forEach((w, i) => {
      tabIndexOf.set(w.key, i);
    });
    tabs.push(planTabMode(mode));
  }

  const planned: PlannedFormField[] = [];
  for (const field of fields) {
    const design = fieldDesignOf(field);
    const entries = privateEntries(design);
    const widgets = plannedWidgets(doc, field, design, tabIndexOf, warn);
    if (widgets.length === 0) {
      warn(`The field "${field.name}" has no widget on any page, so it was left out`);
      continue;
    }
    planned.push({
      name: field.name,
      type: FT[design.role] ?? FT[fieldTypeOf(design.role)] ?? 'Tx',
      flags: design.flags,
      value: field.value === '' ? null : field.value,
      defaultValue: design.defaultValue,
      tooltip: design.tooltip,
      defaultAppearance: formatDefaultAppearance({
        font: design.font,
        size: design.fontSize,
        color: design.textColor,
      }),
      align: design.align,
      maxLength: design.maxLength,
      topIndex: design.topIndex,
      options: design.role === 'combobox' || design.role === 'listbox' ? design.options : [],
      actions: plannedActions(design),
      ...(entries ? { entries } : {}),
      widgets,
    });
  }
  return {
    fields: planned,
    tabs,
    defaultAppearance: formatDefaultAppearance({ font: 'Helvetica', size: 9, color: 0x000000 }),
    quadding: null,
  };
}

/** `structure` has no structure tree to read before M111, so it is written as rows. */
function planTabMode(mode: TabOrderMode): PlannedTabOrder {
  return mode;
}

/**
 * The private dictionary entries that record a role a `/FT` cannot say (ADR 0019). A plain text
 * field or check box needs none, so it gets none — a file only carries our keys when it has to.
 */
function privateEntries(design: FieldDesign): Readonly<Record<string, DictValue | null>> | null {
  const out: Record<string, DictValue | null> = {};
  if (design.role === 'image' || design.role === 'date' || design.role === 'barcode') {
    out[ROLE_KEY] = { kind: 'name', value: design.role };
  }
  if (design.role === 'barcode' && design.barcode) {
    out[BARCODE_KEY] = {
      kind: 'dict',
      value: {
        Symbology: { kind: 'name', value: design.barcode.symbology },
        EC: { kind: 'number', value: design.barcode.errorCorrection },
        CellSize: { kind: 'number', value: design.barcode.cellSize },
      },
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The `/AA` entries.
 *
 * A date field's format is written as the `AFDate_FormatEx` pair Acrobat established, so the
 * field formats itself in every viewer that runs form JavaScript. We do not run it — the value
 * in `/V` is the value, and M61 is what gives these entries meaning here.
 */
function plannedActions(design: FieldDesign): PlannedFieldAction[] {
  const out = design.actions.filter((a) => a.trigger !== 'F' || design.dateFormat === null);
  if (design.role === 'date' && design.dateFormat !== null) {
    const format = design.dateFormat.replace(/["\\]/g, '');
    out.push({ trigger: 'F', type: 'JavaScript', value: `AFDate_FormatEx("${format}");` });
    if (!out.some((a) => a.trigger === 'K')) {
      out.push({ trigger: 'K', type: 'JavaScript', value: `AFDate_KeystrokeEx("${format}");` });
    }
  }
  return out;
}

function plannedWidgets(
  doc: Document,
  field: ModelField,
  design: FieldDesign,
  tabIndexOf: ReadonlyMap<string, number>,
  warn: (message: string) => void,
): PlannedFormWidget[] {
  const out: PlannedFormWidget[] = [];
  const toggling = FT[design.role] === 'Btn' && !hasFlag(design.flags, BUTTON_FLAGS.pushButton);
  for (const widget of field.widgets) {
    const page = doc.pageIndex(widget.pageId);
    if (page < 0) {
      warn(`A widget of "${field.name}" is on a page that is no longer in the document`);
      continue;
    }
    const appearance = widgetAppearanceOf(widget, design);
    const on = toggling ? field.value === appearance.exportValue : false;
    const draw = (state: 'on' | 'off' | undefined) =>
      widgetAppearance({
        rect: widget.rect,
        design,
        widget: appearance,
        value: field.value,
        ...(state ? { state } : {}),
      });
    out.push({
      page,
      tabIndex: tabIndexOf.get(widgetKey(field.id, widget.id)) ?? 0,
      rect: widget.rect,
      flags: annotationFlags(appearance.hidden, appearance.noPrint),
      borderColor: appearance.borderColor,
      fillColor: appearance.fillColor,
      borderWidth: appearance.borderWidth,
      borderStyle: appearance.borderStyle,
      dashArray: appearance.dashArray,
      rotation: appearance.rotation,
      // A check box's `/MK /CA` is its tick glyph, not a caption; a push button's is its label.
      caption: toggling ? checkGlyph(appearance.checkStyle) : appearance.caption,
      rolloverCaption: appearance.rolloverCaption,
      downCaption: appearance.downCaption,
      layout: layoutValue(appearance.layout),
      iconKey: appearance.iconKey,
      highlight: appearance.highlight,
      exportValue: appearance.exportValue,
      on,
      appearance: draw(toggling ? 'on' : undefined),
      ...(toggling ? { offAppearance: draw('off') } : {}),
    });
  }
  return out;
}

function checkGlyph(style: string): string {
  const glyphs: Readonly<Record<string, string>> = {
    check: '4',
    circle: 'l',
    cross: '8',
    diamond: 'u',
    square: 'n',
    star: 'H',
  };
  return glyphs[style] ?? '4';
}

const LAYOUTS = [
  'caption-only',
  'icon-only',
  'caption-below',
  'caption-above',
  'caption-right',
  'caption-left',
  'caption-overlaid',
];

function layoutValue(layout: string): number {
  const index = LAYOUTS.indexOf(layout);
  return index < 0 ? 0 : index;
}

/** Whether a design has the push-button flag; exported so a caller need not know the bit. */
export function isPushButton(design: FieldDesign): boolean {
  return (design.flags & flagBit(BUTTON_FLAGS.pushButton)) !== 0;
}
