/**
 * Writes a designed AcroForm (M60, ADR 0019).
 *
 * When `WritePlan.form` is present the session changed a form's *structure*, and PDFium cannot
 * hold a field it did not open — it creates ten annotation subtypes and `Widget` is not one of
 * them. So the whole form is rebuilt here with pdf-lib: every existing widget annotation is
 * detached, `/AcroForm /Fields` is emptied, and the plan is written in its place.
 *
 * Three things make that safe rather than reckless:
 *
 * - the plan is built from the model's field list, which came from the engine's read of *every*
 *   field in the file, so nothing that was there is missing from it;
 * - a signature field that already holds a signature keeps its `/V` object by reference, and the
 *   caller is warned that a full rewrite has broken the signature anyway (ADR 0010);
 * - an XFA form never reaches here, because it opens read-only.
 *
 * Every widget gets a generated `/AP`, and `/NeedAppearances` is left off — which is what makes a
 * form we designed look the same in Acrobat, in Chrome and here.
 */

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFContext,
  type PDFDocument,
} from 'pdf-lib';
import type { PlannedForm, PlannedFormField, PlannedFormWidget, PlannedTabOrder } from '../Writer';
import type { AppearanceStream } from '../appearance/types';
import { joinFieldName, splitFieldName, tabsName } from '../forms/model';

/** What the writer may report back, and where it puts the appearance streams. */
export interface FormWriteContext {
  warn(message: string): void;
  /** Attaches a generated stream under `/AP /N`, or under `/AP /N /<state>` when `state` is given. */
  attach(dict: PDFDict, stream: AppearanceStream, state?: string): void;
  /** Resolves a `WritePlan.xobjects` key to the object the writer embedded for it. */
  xobject(key: string): PDFRef | undefined;
  /** Records the fonts a stream used so they reach `/AcroForm /DR /Font`. */
  fonts(stream: AppearanceStream): void;
}

/** `/F` bit 3 (Print) — the flag a widget wants unless the designer turned printing off. */
export const ANNOT_PRINT = 4;

const BORDER_STYLE_NAME: Readonly<Record<PlannedFormWidget['borderStyle'], string>> = {
  solid: 'S',
  dashed: 'D',
  beveled: 'B',
  inset: 'I',
  underline: 'U',
};

const HIGHLIGHT_NAME: Readonly<Record<PlannedFormWidget['highlight'], string>> = {
  none: 'N',
  invert: 'I',
  outline: 'O',
  push: 'P',
};

function text(value: string): PDFHexString {
  return PDFHexString.fromText(value);
}

/** `0xRRGGBB` as the three-number colour array `/MK` wants. */
function colourArray(ctx: PDFContext, colour: number): PDFArray {
  return ctx.obj([
    ((colour >> 16) & 0xff) / 255,
    ((colour >> 8) & 0xff) / 255,
    (colour & 0xff) / 255,
  ]);
}

/**
 * Rebuilds the form. Returns false when there was nothing to do, so the caller can leave the
 * phase out of `applied`.
 */
export function writeForm(
  doc: PDFDocument,
  form: PlannedForm,
  pageRefAt: (index: number) => PDFRef | undefined,
  context: FormWriteContext,
): boolean {
  const ctx = doc.context;
  const catalog = doc.catalog;

  const acro = ensureAcroForm(doc);
  const existing = readExistingValues(doc, ctx);
  detachWidgets(doc, ctx);

  // `/Fields` is rebuilt from scratch; the hierarchy comes from the dotted names.
  const roots: PDFRef[] = [];
  const nodes = new Map<string, { dict: PDFDict; ref: PDFRef; kids: PDFArray }>();

  /** Finds or creates the intermediate node for a dotted prefix. */
  const nodeFor = (name: string): { dict: PDFDict; ref: PDFRef; kids: PDFArray } | null => {
    if (name === '') return null;
    const found = nodes.get(name);
    if (found) return found;
    const parts = splitFieldName(name);
    const dict = ctx.obj({});
    dict.set(PDFName.of('T'), text(parts[parts.length - 1] ?? name));
    const kids = ctx.obj([]);
    dict.set(PDFName.of('Kids'), kids);
    const ref = ctx.register(dict);
    const entry = { dict, ref, kids };
    nodes.set(name, entry);
    const parent = nodeFor(joinFieldName(parts.slice(0, -1)));
    if (parent) {
      dict.set(PDFName.of('Parent'), parent.ref);
      parent.kids.push(ref);
    } else {
      roots.push(ref);
    }
    return entry;
  };

  const perPage = new Map<number, Array<{ ref: PDFRef; tabIndex: number }>>();
  let wrote = 0;

  for (const field of form.fields) {
    const parts = splitFieldName(field.name);
    if (parts.length === 0) {
      context.warn('A field with no name could not be saved');
      continue;
    }
    const dict = ctx.obj({});
    const ref = ctx.register(dict);
    writeFieldEntries(ctx, dict, field);

    if (field.keepValue) {
      const kept = existing.get(field.name);
      if (kept) dict.set(PDFName.of('V'), kept);
      else if (field.value !== null) dict.set(PDFName.of('V'), text(field.value));
    }

    const parent = nodeFor(joinFieldName(parts.slice(0, -1)));
    if (parent) {
      dict.set(PDFName.of('Parent'), parent.ref);
      parent.kids.push(ref);
    } else {
      roots.push(ref);
    }

    const widgetRefs = writeWidgets(ctx, field, dict, ref, pageRefAt, context);
    for (const widget of widgetRefs) {
      const list = perPage.get(widget.page) ?? [];
      list.push({ ref: widget.ref, tabIndex: widget.tabIndex });
      perPage.set(widget.page, list);
    }
    wrote++;
  }

  const fields = ctx.obj([...roots]);
  acro.set(PDFName.of('Fields'), fields);
  if (form.defaultAppearance !== null) {
    acro.set(PDFName.of('DA'), PDFString.of(form.defaultAppearance));
  }
  if (form.quadding !== null) acro.set(PDFName.of('Q'), PDFNumber.of(form.quadding));
  // We generate every appearance, so no viewer needs to.
  acro.delete(PDFName.of('NeedAppearances'));
  if (form.fields.some((f) => f.type === 'Sig')) {
    acro.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  } else {
    acro.delete(PDFName.of('SigFlags'));
  }
  catalog.set(PDFName.of('AcroForm'), acro);

  // The widgets, appended to their pages in plan order — which is what manual tab order means.
  const pages = doc.getPages();
  perPage.forEach((refs, index) => {
    const page = pages[index];
    if (!page) return;
    const annots = page.node.Annots() ?? ctx.obj([]);
    for (const entry of [...refs].sort((a, b) => a.tabIndex - b.tabIndex)) annots.push(entry.ref);
    page.node.set(PDFName.of('Annots'), annots);
  });

  form.tabs.forEach((mode, index) => {
    const page = pages[index];
    if (!page) return;
    writeTabs(page.node, mode);
  });

  return wrote > 0;
}

/** The catalogue's `/AcroForm`, created when the base has none. */
function ensureAcroForm(doc: PDFDocument): PDFDict {
  const existing = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (existing) return existing;
  const dict = doc.context.obj({});
  dict.set(PDFName.of('Fields'), doc.context.obj([]));
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(dict));
  return dict;
}

/** `/V` objects of the base's fields, by fully-qualified name, for `keepValue`. */
function readExistingValues(doc: PDFDocument, ctx: PDFContext): Map<string, PDFRef | PDFDict> {
  const out = new Map<string, PDFRef | PDFDict>();
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acro) return out;
  const walk = (array: PDFArray | undefined, prefix: string, depth: number): void => {
    if (!array || depth > 16) return;
    for (const item of array.asArray()) {
      const dict = ctx.lookupMaybe(item, PDFDict);
      if (!dict) continue;
      const raw = dict.lookup(PDFName.of('T'));
      const partial =
        raw instanceof PDFString || raw instanceof PDFHexString ? raw.decodeText() : '';
      const name = partial === '' ? prefix : prefix === '' ? partial : `${prefix}.${partial}`;
      const value = dict.get(PDFName.of('V'));
      if (partial !== '' && value !== undefined && !out.has(name)) {
        if (value instanceof PDFRef) out.set(name, value);
        else {
          const resolved = ctx.lookupMaybe(value, PDFDict);
          if (resolved) out.set(name, resolved);
        }
      }
      walk(dict.lookupMaybe(PDFName.of('Kids'), PDFArray), name, depth + 1);
    }
  };
  walk(acro.lookupMaybe(PDFName.of('Fields'), PDFArray), '', 0);
  return out;
}

/** Removes every `Widget` annotation from every page, so the rebuild has a clean slate. */
function detachWidgets(doc: PDFDocument, ctx: PDFContext): void {
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const kept = annots.asArray().filter((item) => {
      const dict = ctx.lookupMaybe(item, PDFDict);
      const subtype = dict?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
      return subtype !== 'Widget';
    });
    page.node.set(PDFName.of('Annots'), ctx.obj([...kept]));
  }
}

/** `/Tabs`, or its removal for a manual order. */
function writeTabs(
  node: { set(k: PDFName, v: PDFName): void; delete(k: PDFName): void },
  mode: PlannedTabOrder | null,
): void {
  if (mode === null) return;
  const name = tabsName(mode);
  if (name === null) node.delete(PDFName.of('Tabs'));
  else node.set(PDFName.of('Tabs'), PDFName.of(name));
}

/** Everything on the field dictionary that is not a widget. */
function writeFieldEntries(ctx: PDFContext, dict: PDFDict, field: PlannedFormField): void {
  const parts = splitFieldName(field.name);
  dict.set(PDFName.of('T'), text(parts[parts.length - 1] ?? field.name));
  dict.set(PDFName.of('FT'), PDFName.of(field.type));
  if (field.flags !== 0) dict.set(PDFName.of('Ff'), PDFNumber.of(field.flags));
  if (!field.keepValue && field.value !== null) {
    // A check box or radio stores its state as a name, not a string: `/V /Yes`, `/V /Off`.
    if (field.type === 'Btn') dict.set(PDFName.of('V'), PDFName.of(pdfName(field.value)));
    else dict.set(PDFName.of('V'), text(field.value));
  }
  if (field.defaultValue !== null) {
    if (field.type === 'Btn') dict.set(PDFName.of('DV'), PDFName.of(pdfName(field.defaultValue)));
    else dict.set(PDFName.of('DV'), text(field.defaultValue));
  }
  if (field.tooltip !== null && field.tooltip !== '') {
    dict.set(PDFName.of('TU'), text(field.tooltip));
  }
  if (field.defaultAppearance !== null) {
    dict.set(PDFName.of('DA'), PDFString.of(field.defaultAppearance));
  }
  if (field.align !== null && field.align !== 0)
    dict.set(PDFName.of('Q'), PDFNumber.of(field.align));
  if (field.maxLength !== null && field.maxLength > 0) {
    dict.set(PDFName.of('MaxLen'), PDFNumber.of(field.maxLength));
  }
  if (field.topIndex !== null && field.topIndex > 0) {
    dict.set(PDFName.of('TI'), PDFNumber.of(field.topIndex));
  }
  if (field.options.length > 0 && field.type === 'Ch') {
    dict.set(
      PDFName.of('Opt'),
      ctx.obj(
        field.options.map((o) =>
          o.label === o.value ? text(o.value) : ctx.obj([text(o.value), text(o.label)]),
        ),
      ),
    );
  }
  if (field.actions.length > 0) {
    const aa = ctx.obj({});
    for (const action of field.actions) {
      const entry = ctx.obj({});
      entry.set(PDFName.of('S'), PDFName.of(pdfName(action.type)));
      switch (action.type) {
        case 'JavaScript':
          entry.set(PDFName.of('JS'), text(action.value));
          break;
        case 'URI':
          entry.set(PDFName.of('URI'), PDFString.of(action.value));
          break;
        case 'Named':
          entry.set(PDFName.of('N'), PDFName.of(pdfName(action.value)));
          break;
        default:
          break;
      }
      aa.set(PDFName.of(pdfName(action.trigger)), entry);
    }
    dict.set(PDFName.of('AA'), aa);
  }
  for (const [key, value] of Object.entries(field.entries ?? {})) {
    if (value === null) {
      dict.delete(PDFName.of(key));
      continue;
    }
    const written = plainValue(ctx, value);
    if (written !== undefined) dict.set(PDFName.of(key), written);
  }
}

/** The subset of `DictValue` a field's private entries use — names, numbers, strings, dicts. */
function plainValue(
  ctx: PDFContext,
  value: { readonly kind: string; readonly value: unknown },
): PDFArray | PDFDict | PDFName | PDFNumber | PDFHexString | undefined {
  switch (value.kind) {
    case 'name':
      return PDFName.of(pdfName(String(value.value)));
    case 'string':
      return text(String(value.value));
    case 'number':
      return PDFNumber.of(Number(value.value));
    case 'numbers':
      return ctx.obj((value.value as ReadonlyArray<number>).map((n) => PDFNumber.of(n)));
    case 'dict': {
      const dict = ctx.obj({});
      for (const [key, entry] of Object.entries(
        value.value as Readonly<Record<string, { kind: string; value: unknown } | null>>,
      )) {
        if (!entry) continue;
        const written = plainValue(ctx, entry);
        if (written !== undefined) dict.set(PDFName.of(key), written);
      }
      return dict;
    }
    default:
      return undefined;
  }
}

/** A string as a PDF name: no delimiters, never empty. */
function pdfName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.+-]/g, '');
  return cleaned === '' ? 'Off' : cleaned;
}

interface WrittenWidget {
  readonly page: number;
  readonly tabIndex: number;
  readonly ref: PDFRef;
}

/**
 * Writes the field's widgets.
 *
 * One widget is merged into the field dictionary itself, which is what every producer does and
 * what keeps a simple form small; two or more become `/Kids`. A check box or radio always gets
 * `/Kids` when it has more than one, because each kid carries its own `/AS` and export value.
 */
function writeWidgets(
  ctx: PDFContext,
  field: PlannedFormField,
  fieldDict: PDFDict,
  fieldRef: PDFRef,
  pageRefAt: (index: number) => PDFRef | undefined,
  context: FormWriteContext,
): WrittenWidget[] {
  const out: WrittenWidget[] = [];
  const merged = field.widgets.length === 1;
  const kids: PDFRef[] = [];
  for (const widget of field.widgets) {
    const dict = merged ? fieldDict : ctx.obj({});
    const ref = merged ? fieldRef : ctx.register(dict);
    dict.set(PDFName.of('Type'), PDFName.of('Annot'));
    dict.set(PDFName.of('Subtype'), PDFName.of('Widget'));
    dict.set(
      PDFName.of('Rect'),
      ctx.obj([widget.rect.x0, widget.rect.y0, widget.rect.x1, widget.rect.y1]),
    );
    dict.set(PDFName.of('F'), PDFNumber.of(widget.flags));
    const pageRef = pageRefAt(widget.page);
    if (pageRef) dict.set(PDFName.of('P'), pageRef);
    if (!merged) dict.set(PDFName.of('Parent'), fieldRef);

    const mk = ctx.obj({});
    if (widget.borderColor !== null) mk.set(PDFName.of('BC'), colourArray(ctx, widget.borderColor));
    else mk.set(PDFName.of('BC'), ctx.obj([]));
    if (widget.fillColor !== null) mk.set(PDFName.of('BG'), colourArray(ctx, widget.fillColor));
    if (widget.rotation !== 0) mk.set(PDFName.of('R'), PDFNumber.of(widget.rotation));
    if (widget.caption !== null) mk.set(PDFName.of('CA'), text(widget.caption));
    if (widget.rolloverCaption !== null) mk.set(PDFName.of('RC'), text(widget.rolloverCaption));
    if (widget.downCaption !== null) mk.set(PDFName.of('AC'), text(widget.downCaption));
    if (widget.layout !== 0) mk.set(PDFName.of('TP'), PDFNumber.of(widget.layout));
    if (widget.iconKey !== null) {
      const icon = context.xobject(widget.iconKey);
      if (icon) {
        mk.set(PDFName.of('I'), icon);
        const fit = ctx.obj({});
        fit.set(PDFName.of('SW'), PDFName.of('A'));
        fit.set(PDFName.of('S'), PDFName.of('P'));
        mk.set(PDFName.of('IF'), fit);
      } else {
        context.warn(`The picture for "${field.name}" was not embedded, so the field has none`);
      }
    }
    dict.set(PDFName.of('MK'), mk);

    const bs = ctx.obj({});
    bs.set(PDFName.of('W'), PDFNumber.of(widget.borderWidth));
    bs.set(PDFName.of('S'), PDFName.of(BORDER_STYLE_NAME[widget.borderStyle]));
    if (widget.borderStyle === 'dashed' && widget.dashArray.length > 0) {
      bs.set(PDFName.of('D'), ctx.obj([...widget.dashArray]));
    }
    dict.set(PDFName.of('BS'), bs);
    dict.set(PDFName.of('H'), PDFName.of(HIGHLIGHT_NAME[widget.highlight]));

    const toggling = field.type === 'Btn' && !isPush(field.flags);
    if (toggling) {
      const on = pdfName(widget.exportValue);
      dict.set(PDFName.of('AS'), PDFName.of(widget.on ? on : 'Off'));
      if (widget.appearance) {
        context.fonts(widget.appearance);
        context.attach(dict, widget.appearance, on);
      }
      if (widget.offAppearance) {
        context.fonts(widget.offAppearance);
        context.attach(dict, widget.offAppearance, 'Off');
      }
    } else {
      dict.delete(PDFName.of('AS'));
      if (widget.appearance) {
        context.fonts(widget.appearance);
        context.attach(dict, widget.appearance);
      }
    }

    if (!merged) kids.push(ref);
    out.push({ page: widget.page, tabIndex: widget.tabIndex, ref });
  }
  if (!merged) fieldDict.set(PDFName.of('Kids'), ctx.obj([...kids]));
  return out;
}

/** `/Ff` bit 17 — a push button, which has no on/off state. */
function isPush(flags: number): boolean {
  return (flags & (2 ** 16)) !== 0;
}
