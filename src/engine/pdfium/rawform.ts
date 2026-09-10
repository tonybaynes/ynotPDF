/**
 * Reads a form's *design* out of the file (M60, ADR 0019).
 *
 * PDFium's form API answers a field's name, type, value, flags and options, and nothing else.
 * Everything a properties dialog edits — `/DA`, `/Q`, `/MaxLen`, `/TI`, the export values behind
 * `/Opt`'s labels, `/AA`, and the whole of each widget's `/MK`, `/BS`, `/AS`, `/H` and `/F` —
 * lives in sub-dictionaries its API cannot reach. So they are read here with pdf-lib's object
 * parser, exactly as `rawdoc.ts` reads `/OCProperties` for the same reason.
 *
 * Read-only, and it never throws: a malformed form reports the fields it could make sense of.
 */

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFObject,
} from 'pdf-lib';
import { parseDefaultAppearance } from '../forms/da';
import {
  BUTTON_FLAGS,
  CHECK_STYLE_GLYPH,
  DEFAULT_BARCODE,
  DEFAULT_WIDGET_APPEARANCE,
  buttonLayoutOf,
  defaultFieldDesign,
  flagBit,
  hasFlag,
  tabModeOf,
  type BarcodeSpec,
  type BarcodeSymbology,
  type BorderStyle,
  type CheckStyle,
  type FieldAction,
  type FieldAlign,
  type FieldDesign,
  type FieldOption,
  type FieldRole,
  type TabOrderMode,
  type WidgetAppearance,
  type WidgetHighlight,
} from '../forms/model';
import { colorArrayToRgb } from './rawdoc';

/** One widget of a field, as the file has it. */
export interface RawWidget {
  /** Page index the widget is on, or -1 when its `/P` names no page in the tree. */
  readonly page: number;
  /** Position in that page's `/Annots`. */
  readonly index: number;
  readonly appearance: WidgetAppearance;
}

/** One field, keyed elsewhere by its fully-qualified name. */
export interface RawField {
  readonly name: string;
  readonly design: FieldDesign;
  readonly widgets: ReadonlyArray<RawWidget>;
  /** True when the field's `/V` is a signature dictionary rather than a value we can rewrite. */
  readonly signed: boolean;
}

export interface RawForm {
  readonly fields: ReadonlyArray<RawField>;
  /** `/AcroForm /DA`. */
  readonly defaultAppearance: string | null;
  /** `/AcroForm /Q`. */
  readonly quadding: number | null;
  /** Whether the catalogue declares XFA — a form we open read-only (`PLAN.md` §1, Parked). */
  readonly hasXfa: boolean;
  /** `/Tabs` per page index. */
  readonly tabs: ReadonlyArray<TabOrderMode | null>;
}

export const EMPTY_RAW_FORM: RawForm = {
  fields: [],
  defaultAppearance: null,
  quadding: null,
  hasXfa: false,
  tabs: [],
};

/** Our private field-dictionary keys (ADR 0019). */
export const ROLE_KEY = 'YNOTRole';
export const BARCODE_KEY = 'YNOTBarcode';

function textOf(value: unknown): string | undefined {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  return undefined;
}

function nameOf(value: unknown): string | undefined {
  return value instanceof PDFName ? value.decodeText() : undefined;
}

function numberOf(value: unknown): number | undefined {
  return value instanceof PDFNumber ? value.asNumber() : undefined;
}

/** A colour array under `key`, as `0xRRGGBB`; an empty array means "no colour", which is null. */
function colourAt(dict: PDFDict | undefined, key: string): number | null | undefined {
  const array = dict?.lookupMaybe(PDFName.of(key), PDFArray);
  if (!array) return undefined;
  if (array.size() === 0) return null;
  const nums = array.asArray().map((v) => numberOf(v) ?? 0);
  return colorArrayToRgb(nums) ?? null;
}

/** The check style a `/MK /CA` glyph names, or the default when it names none of them. */
function checkStyleOf(glyph: string | undefined): CheckStyle {
  if (!glyph) return DEFAULT_WIDGET_APPEARANCE.checkStyle;
  const found = (Object.keys(CHECK_STYLE_GLYPH) as CheckStyle[]).find(
    (style) => CHECK_STYLE_GLYPH[style] === glyph[0],
  );
  return found ?? DEFAULT_WIDGET_APPEARANCE.checkStyle;
}

function borderStyleOf(name: string | undefined): BorderStyle {
  switch (name) {
    case 'D':
      return 'dashed';
    case 'B':
      return 'beveled';
    case 'I':
      return 'inset';
    case 'U':
      return 'underline';
    default:
      return 'solid';
  }
}

function highlightOf(name: string | undefined): WidgetHighlight {
  switch (name) {
    case 'N':
      return 'none';
    case 'O':
      return 'outline';
    case 'P':
    case 'T':
      return 'push';
    default:
      return 'invert';
  }
}

/** Reads `/Opt`: a plain string is its own export value, a pair is `[export, label]`. */
function optionsOf(
  array: PDFArray | undefined,
  resolve: (v: PDFObject | undefined) => unknown,
): FieldOption[] {
  if (!array) return [];
  const out: FieldOption[] = [];
  for (const item of array.asArray()) {
    const value = resolve(item);
    const single = textOf(value);
    if (single !== undefined) {
      out.push({ value: single, label: single });
      continue;
    }
    if (value instanceof PDFArray && value.size() >= 1) {
      const exported = textOf(resolve(value.get(0))) ?? '';
      const label = textOf(resolve(value.get(1))) ?? exported;
      out.push({ value: exported, label });
    }
  }
  return out;
}

/** Reads an `/AA` dictionary into the flat action list the editor works with. */
function actionsOf(
  aa: PDFDict | undefined,
  resolve: (v: PDFObject | undefined) => unknown,
): FieldAction[] {
  if (!aa) return [];
  const out: FieldAction[] = [];
  for (const [key, raw] of aa.entries()) {
    const action = resolve(raw);
    if (!(action instanceof PDFDict)) continue;
    const type = nameOf(resolve(action.get(PDFName.of('S')))) ?? '';
    const js = resolve(action.get(PDFName.of('JS')));
    const uri = resolve(action.get(PDFName.of('URI')));
    const named = nameOf(resolve(action.get(PDFName.of('N'))));
    const value = textOf(js) ?? textOf(uri) ?? named ?? '';
    out.push({ trigger: key.decodeText(), type, value });
  }
  return out;
}

/** `/YNOTBarcode` back into a spec; anything missing falls back to the default. */
function barcodeOf(dict: PDFDict | undefined): BarcodeSpec | null {
  if (!dict) return null;
  const symbology = nameOf(dict.lookup(PDFName.of('Symbology')));
  const known: ReadonlyArray<BarcodeSymbology> = ['pdf417', 'qrcode', 'datamatrix'];
  return {
    symbology: known.find((s) => s === symbology) ?? DEFAULT_BARCODE.symbology,
    errorCorrection: numberOf(dict.lookup(PDFName.of('EC'))) ?? DEFAULT_BARCODE.errorCorrection,
    cellSize: numberOf(dict.lookup(PDFName.of('CellSize'))) ?? DEFAULT_BARCODE.cellSize,
  };
}

const DATE_FORMAT_RE = /AFDate_FormatEx\s*\(\s*["']([^"']*)["']/;

/**
 * The role a field plays. `/YNOTRole` says it outright; without one the shape of the dictionary
 * is read instead, so a form built by another editor still opens as an image or a date field
 * rather than as a button and a text box.
 */
function roleOf(
  dict: PDFDict,
  ft: string | undefined,
  flags: number,
  widgets: ReadonlyArray<RawWidget>,
  actions: ReadonlyArray<FieldAction>,
): FieldRole {
  const declared = nameOf(dict.lookup(PDFName.of(ROLE_KEY)));
  const known: ReadonlyArray<FieldRole> = [
    'text',
    'checkbox',
    'radio',
    'combobox',
    'listbox',
    'button',
    'signature',
    'image',
    'date',
    'barcode',
  ];
  const match = known.find((r) => r === declared);
  if (match) return match;
  switch (ft) {
    case 'Btn': {
      if (hasFlag(flags, BUTTON_FLAGS.pushButton)) {
        const first = widgets[0];
        const iconOnly = first?.appearance.layout === 'icon-only';
        return iconOnly ? 'image' : 'button';
      }
      return hasFlag(flags, BUTTON_FLAGS.radio) ? 'radio' : 'checkbox';
    }
    case 'Ch':
      return hasFlag(flags, 18) ? 'combobox' : 'listbox';
    case 'Sig':
      return 'signature';
    default: {
      const format = actions.find((a) => a.trigger === 'F');
      return format && DATE_FORMAT_RE.test(format.value) ? 'date' : 'text';
    }
  }
}

/**
 * Reads the whole form. `bytes` must already be decrypted — pdf-lib does not decrypt strings, so
 * the caller passes what PDFium re-serialised without security, exactly as `readRawInfo` does.
 */
export async function readRawForm(bytes: Uint8Array): Promise<RawForm> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
  } catch {
    return EMPTY_RAW_FORM;
  }
  try {
    return readForm(doc);
  } catch {
    return EMPTY_RAW_FORM;
  }
}

/** The same read, for a document already parsed. */
export function readForm(doc: PDFDocument): RawForm {
  const ctx = doc.context;
  const resolve = (value: PDFObject | undefined): unknown =>
    value === undefined ? undefined : ctx.lookup(value);
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const pages = doc.getPages();
  const pageIndexByRef = new Map<string, number>();
  pages.forEach((page, i) => {
    pageIndexByRef.set(page.ref.toString(), i);
  });
  const tabs = pages.map((page) => tabModeOf(nameOf(page.node.get(PDFName.of('Tabs')))));
  if (!acro) return { ...EMPTY_RAW_FORM, tabs };

  const acroDa = textOf(resolve(acro.get(PDFName.of('DA')))) ?? null;
  const acroQ = numberOf(resolve(acro.get(PDFName.of('Q')))) ?? null;
  const hasXfa = acro.get(PDFName.of('XFA')) !== undefined;

  /** Where each annotation dictionary sits: page index and position in `/Annots`. */
  const widgetPlace = new Map<string, { page: number; index: number }>();
  pages.forEach((page, pi) => {
    const annots = page.node.Annots();
    if (!annots) return;
    annots.asArray().forEach((item, index) => {
      if (item instanceof PDFRef) widgetPlace.set(item.toString(), { page: pi, index });
    });
  });

  const fields: RawField[] = [];
  const seen = new Set<string>();

  const readWidget = (dict: PDFDict, ref: PDFRef | null, inherited: InheritedWidget): RawWidget => {
    const mk = dict.lookupMaybe(PDFName.of('MK'), PDFDict);
    const bs = dict.lookupMaybe(PDFName.of('BS'), PDFDict);
    const dash = bs?.lookupMaybe(PDFName.of('D'), PDFArray);
    const flagsValue = numberOf(resolve(dict.get(PDFName.of('F')))) ?? 4;
    const place = ref ? widgetPlace.get(ref.toString()) : undefined;
    const iconRef = mk?.get(PDFName.of('I'));
    const appearance: WidgetAppearance = {
      borderColor: colourAt(mk, 'BC') ?? (mk ? null : DEFAULT_WIDGET_APPEARANCE.borderColor),
      fillColor: colourAt(mk, 'BG') ?? null,
      borderWidth: numberOf(resolve(bs?.get(PDFName.of('W')))) ?? 1,
      borderStyle: borderStyleOf(nameOf(resolve(bs?.get(PDFName.of('S'))))),
      dashArray: dash
        ? dash.asArray().map((v) => numberOf(v) ?? 0)
        : DEFAULT_WIDGET_APPEARANCE.dashArray,
      rotation: ((((numberOf(resolve(mk?.get(PDFName.of('R')))) ?? 0) % 360) + 360) % 360) as 0,
      checkStyle: checkStyleOf(textOf(resolve(mk?.get(PDFName.of('CA'))))),
      caption: inherited.isButton ? (textOf(resolve(mk?.get(PDFName.of('CA')))) ?? null) : null,
      rolloverCaption: textOf(resolve(mk?.get(PDFName.of('RC')))) ?? null,
      downCaption: inherited.isButton ? (textOf(resolve(mk?.get(PDFName.of('AC')))) ?? null) : null,
      layout: buttonLayoutOf(numberOf(resolve(mk?.get(PDFName.of('TP')))) ?? 0),
      iconKey: iconRef === undefined ? null : `field-icon-${ref?.objectNumber ?? 0}`,
      exportValue: exportValueOf(dict, resolve),
      highlight: highlightOf(nameOf(resolve(dict.get(PDFName.of('H'))))),
      hidden: (flagsValue & 2) !== 0,
      noPrint: (flagsValue & 4) === 0,
    };
    return { page: place?.page ?? -1, index: place?.index ?? -1, appearance };
  };

  const walk = (array: PDFArray | undefined, prefix: string, depth: number): void => {
    if (!array || depth > 16) return;
    for (const item of array.asArray()) {
      const ref = item instanceof PDFRef ? item : null;
      const dict = ctx.lookupMaybe(item, PDFDict);
      if (!dict) continue;
      const partial = textOf(resolve(dict.get(PDFName.of('T')))) ?? '';
      const name = partial === '' ? prefix : prefix === '' ? partial : `${prefix}.${partial}`;
      const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
      // A node whose kids carry their own `/T` is a hierarchy node; kids without one are the
      // field's widgets, which is how a radio group and a field on several pages are written.
      const kidsAreFields =
        kids
          ?.asArray()
          .some((kid) => ctx.lookupMaybe(kid, PDFDict)?.get(PDFName.of('T')) !== undefined) ===
        true;
      if (kidsAreFields) {
        walk(kids, name, depth + 1);
        continue;
      }
      if (name === '' || seen.has(name)) continue;
      seen.add(name);

      const ft = nameOf(resolve(inheritedGet(ctx, dict, 'FT')));
      const flags = numberOf(resolve(inheritedGet(ctx, dict, 'Ff'))) ?? 0;
      const isButton = ft === 'Btn' && hasFlag(flags, BUTTON_FLAGS.pushButton);
      const widgets: RawWidget[] = [];
      if (kids && kids.size() > 0) {
        for (const kid of kids.asArray()) {
          const kidDict = ctx.lookupMaybe(kid, PDFDict);
          if (kidDict) {
            widgets.push(readWidget(kidDict, kid instanceof PDFRef ? kid : null, { isButton }));
          }
        }
      } else {
        widgets.push(readWidget(dict, ref, { isButton }));
      }

      const actions = actionsOf(dict.lookupMaybe(PDFName.of('AA'), PDFDict), resolve);
      const role = roleOf(dict, ft, flags, widgets, actions);
      const da = textOf(resolve(inheritedGet(ctx, dict, 'DA'))) ?? acroDa;
      const parsed = parseDefaultAppearance(da);
      const base = defaultFieldDesign(role);
      const dateAction = actions.find((a) => a.trigger === 'F');
      const dateFormat =
        role === 'date'
          ? (DATE_FORMAT_RE.exec(dateAction?.value ?? '')?.[1] ?? base.dateFormat)
          : null;
      const value = resolve(dict.get(PDFName.of('V')));
      const design: FieldDesign = {
        role,
        flags,
        tooltip: textOf(resolve(dict.get(PDFName.of('TU')))) ?? null,
        defaultValue: defaultValueOf(resolve(dict.get(PDFName.of('DV')))),
        options:
          role === 'radio'
            ? widgets.map((w) => ({
                value: w.appearance.exportValue,
                label: w.appearance.exportValue,
              }))
            : optionsOf(dict.lookupMaybe(PDFName.of('Opt'), PDFArray), resolve),
        maxLength: numberOf(resolve(inheritedGet(ctx, dict, 'MaxLen'))) ?? null,
        align: (numberOf(resolve(inheritedGet(ctx, dict, 'Q'))) ?? acroQ ?? 0) as FieldAlign,
        font: parsed.font,
        fontSize: parsed.size,
        textColor: parsed.color,
        dateFormat,
        barcode:
          role === 'barcode'
            ? (barcodeOf(dict.lookupMaybe(PDFName.of(BARCODE_KEY), PDFDict)) ?? DEFAULT_BARCODE)
            : null,
        actions,
        topIndex: numberOf(resolve(dict.get(PDFName.of('TI')))) ?? 0,
      };
      fields.push({ name, design, widgets, signed: ft === 'Sig' && value instanceof PDFDict });
    }
  };

  walk(acro.lookupMaybe(PDFName.of('Fields'), PDFArray), '', 0);
  return { fields, defaultAppearance: acroDa, quadding: acroQ, hasXfa, tabs };
}

interface InheritedWidget {
  readonly isButton: boolean;
}

/** `/FT`, `/Ff`, `/DA`, `/Q` and `/MaxLen` are inheritable through `/Parent` (PDF 12.7.3.1). */
function inheritedGet(
  ctx: PDFDocument['context'],
  dict: PDFDict,
  key: string,
): PDFObject | undefined {
  let node: PDFDict | undefined = dict;
  for (let depth = 0; node !== undefined && depth < 16; depth++) {
    const value = node.get(PDFName.of(key));
    if (value !== undefined) return value;
    const parent: unknown = ctx.lookupMaybe(node.get(PDFName.of('Parent')), PDFDict);
    node = parent instanceof PDFDict ? parent : undefined;
  }
  return undefined;
}

/** `/DV` as text: a name for a check box, a string for everything else. */
function defaultValueOf(value: unknown): string | null {
  return (
    textOf(value) ?? nameOf(value) ?? (value instanceof PDFBool ? String(value.asBoolean()) : null)
  );
}

/**
 * The export value one widget stands for: the key of its `/AP /N` sub-dictionary that is not
 * `/Off`. `/AS` says which state is showing, not which one the widget *is*, so the appearance
 * dictionary is the honest source — a radio kid whose `/AS` is `/Off` still exports "green".
 */
function exportValueOf(dict: PDFDict, resolve: (v: PDFObject | undefined) => unknown): string {
  const ap = dict.lookupMaybe(PDFName.of('AP'), PDFDict);
  const normal = ap ? resolve(ap.get(PDFName.of('N'))) : undefined;
  if (normal instanceof PDFDict) {
    for (const [key] of normal.entries()) {
      const name = key.decodeText();
      if (name !== 'Off') return name;
    }
  }
  const as = nameOf(resolve(dict.get(PDFName.of('AS'))));
  if (as && as !== 'Off') return as;
  return DEFAULT_WIDGET_APPEARANCE.exportValue;
}

/** Whether a `/Ff` value has a bit set. Re-exported so callers need one import. */
export { flagBit, hasFlag };
