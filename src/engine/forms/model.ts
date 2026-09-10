/**
 * The AcroForm field model as plain data (M60, ADR 0019).
 *
 * One declaration, four consumers: `rawdoc.ts` fills it when a file is opened, the appearance
 * generators in `appearance.ts` draw from it, the document model stores it, and the write plan
 * carries it back to the file. Nothing here imports a PDF library or PDFium — it is types, bit
 * constants and pure functions, so it unit-tests in plain Node.
 *
 * Geometry is PDF user space (points, origin bottom-left), as everywhere else.
 */

import type { AppearanceFont } from '../appearance/types';

/** AcroForm field types (PDF 12.7.4) — the `/FT` values, plus our own "we could not tell". */
export type FormFieldType =
  'text' | 'checkbox' | 'radio' | 'combobox' | 'listbox' | 'button' | 'signature' | 'unknown';

/**
 * What the designer offers. Nine of these are `/FT` values; `image`, `date` and `barcode` are
 * standard fields wearing a hat, recorded in `/YNOTRole` so a reopen finds them again (ADR 0019).
 */
export type FieldRole =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'combobox'
  | 'listbox'
  | 'button'
  | 'signature'
  | 'image'
  | 'date'
  | 'barcode';

export const FIELD_ROLES: ReadonlyArray<FieldRole> = [
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

/** The words the ribbon, the palette and the Fields panel use for each role. */
export const FIELD_ROLE_LABELS: Readonly<Record<FieldRole, string>> = {
  text: 'Text field',
  checkbox: 'Check box',
  radio: 'Radio button',
  combobox: 'Combo box',
  listbox: 'List box',
  button: 'Push button',
  signature: 'Signature field',
  image: 'Image field',
  date: 'Date field',
  barcode: 'Barcode field',
};

/** The `/FT` a role is written as. */
export function fieldTypeOf(role: FieldRole): FormFieldType {
  switch (role) {
    case 'image':
      return 'button';
    case 'date':
    case 'barcode':
      return 'text';
    default:
      return role;
  }
}

/** The role a plain `/FT` reading means, before `/YNOTRole` refines it. */
export function roleOfType(type: FormFieldType): FieldRole {
  return type === 'unknown' ? 'text' : type;
}

// ---- `/Ff` flag bits (PDF 32000-1 tables 226-230) ----------------------------------------------

/**
 * The bit *numbers* the PDF tables use — 1-based, and deliberately kept that way so a reader can
 * check them against the spec without arithmetic. `flagBit` turns one into a mask.
 *
 * They are grouped by `/FT` because the same bit means different things: bit 22 is "do not
 * scroll" on a text field and "multi-select" on a choice field, and no single flat table can say
 * that honestly.
 */
export const COMMON_FLAGS = { readOnly: 1, required: 2, noExport: 3 } as const;

/** Table 227 — button fields. */
export const BUTTON_FLAGS = { noToggleToOff: 15, radio: 16, pushButton: 17, unison: 26 } as const;

/** Table 228 — text fields. */
export const TEXT_FLAGS = {
  multiline: 13,
  password: 14,
  fileSelect: 21,
  doNotSpellCheck: 23,
  doNotScroll: 24,
  comb: 25,
  richText: 26,
} as const;

/** Table 230 — choice fields. */
export const CHOICE_FLAGS = {
  combo: 18,
  edit: 19,
  sort: 20,
  multiSelect: 22,
  doNotSpellCheck: 23,
  commitOnSelChange: 27,
} as const;

/** The mask for a 1-based spec bit number. Bit 1 is 1, bit 13 is 4096. */
export function flagBit(bit: number): number {
  return bit <= 0 ? 0 : 2 ** (bit - 1);
}

export function hasFlag(flags: number, bit: number): boolean {
  return (flags & flagBit(bit)) !== 0;
}

export function withFlag(flags: number, bit: number, on: boolean): number {
  const mask = flagBit(bit);
  return on ? flags | mask : flags & ~mask;
}

// ---- design ------------------------------------------------------------------------------------

/** One choice of a combo or list box: what is shown, and what is exported. */
export interface FieldOption {
  /** `/Opt` export value — the second string of a pair, or the only one. */
  readonly value: string;
  /** What the reader sees. Equal to `value` for a single-string entry. */
  readonly label: string;
}

/** Text alignment inside a field: `/Q`. */
export type FieldAlign = 0 | 1 | 2;

/** The glyph a check box or radio draws when it is on: `/MK /CA`, a ZapfDingbats character. */
export type CheckStyle = 'check' | 'circle' | 'cross' | 'diamond' | 'square' | 'star';

export const CHECK_STYLES: ReadonlyArray<CheckStyle> = [
  'check',
  'circle',
  'cross',
  'diamond',
  'square',
  'star',
];

export const CHECK_STYLE_LABELS: Readonly<Record<CheckStyle, string>> = {
  check: 'Check',
  circle: 'Circle',
  cross: 'Cross',
  diamond: 'Diamond',
  square: 'Square',
  star: 'Star',
};

/** `/MK /CA` characters in ZapfDingbats — the encoding Acrobat established and every viewer follows. */
export const CHECK_STYLE_GLYPH: Readonly<Record<CheckStyle, string>> = {
  check: '4',
  circle: 'l',
  cross: '8',
  diamond: 'u',
  square: 'n',
  star: 'H',
};

/** `/BS /S` — how a widget's border is drawn. */
export type BorderStyle = 'solid' | 'dashed' | 'beveled' | 'inset' | 'underline';

export const BORDER_STYLES: ReadonlyArray<BorderStyle> = [
  'solid',
  'dashed',
  'beveled',
  'inset',
  'underline',
];

export const BORDER_STYLE_LABELS: Readonly<Record<BorderStyle, string>> = {
  solid: 'Solid',
  dashed: 'Dashed',
  beveled: 'Beveled',
  inset: 'Inset',
  underline: 'Underline',
};

/** `/MK /TP` — where a push button's caption sits relative to its icon. */
export type ButtonLayout =
  | 'caption-only'
  | 'icon-only'
  | 'caption-below'
  | 'caption-above'
  | 'caption-right'
  | 'caption-left'
  | 'caption-overlaid';

export const BUTTON_LAYOUTS: ReadonlyArray<ButtonLayout> = [
  'caption-only',
  'icon-only',
  'caption-below',
  'caption-above',
  'caption-right',
  'caption-left',
  'caption-overlaid',
];

export const BUTTON_LAYOUT_LABELS: Readonly<Record<ButtonLayout, string>> = {
  'caption-only': 'Caption only',
  'icon-only': 'Icon only',
  'caption-below': 'Caption below icon',
  'caption-above': 'Caption above icon',
  'caption-right': 'Caption to the right',
  'caption-left': 'Caption to the left',
  'caption-overlaid': 'Caption over icon',
};

/** `/MK /TP` is a number 0..6 in the order above. */
export function buttonLayoutValue(layout: ButtonLayout): number {
  const index = BUTTON_LAYOUTS.indexOf(layout);
  return index < 0 ? 0 : index;
}

export function buttonLayoutOf(value: number): ButtonLayout {
  return BUTTON_LAYOUTS[value] ?? 'caption-only';
}

/** `/H` — what a widget does while the pointer is down on it. */
export type WidgetHighlight = 'none' | 'invert' | 'outline' | 'push';

export const WIDGET_HIGHLIGHTS: ReadonlyArray<WidgetHighlight> = [
  'none',
  'invert',
  'outline',
  'push',
];

/** The symbologies the barcode field offers. Each is a bwip-js `bcid`. */
export type BarcodeSymbology = 'pdf417' | 'qrcode' | 'datamatrix';

export const BARCODE_SYMBOLOGIES: ReadonlyArray<BarcodeSymbology> = [
  'pdf417',
  'qrcode',
  'datamatrix',
];

export const BARCODE_SYMBOLOGY_LABELS: Readonly<Record<BarcodeSymbology, string>> = {
  pdf417: 'PDF417',
  qrcode: 'QR Code',
  datamatrix: 'Data Matrix',
};

/** What a barcode field draws from its value. */
export interface BarcodeSpec {
  readonly symbology: BarcodeSymbology;
  /**
   * Error-correction level. PDF417 takes 0..8, QR takes 1..4 (L, M, Q, H) and Data Matrix has
   * none — it is fixed by the symbology, so the control is hidden for it.
   */
  readonly errorCorrection: number;
  /** The side of one module, in points. Bigger is more scannable and takes more room. */
  readonly cellSize: number;
}

export const DEFAULT_BARCODE: BarcodeSpec = {
  symbology: 'pdf417',
  errorCorrection: 5,
  cellSize: 1,
};

/**
 * One `/AA` entry, carried as data (ADR 0019). M60 edits the list; M61 gives the entries meaning.
 * `trigger` is the `/AA` key (`K` keystroke, `F` format, `V` validate, `C` calculate, `U` mouse
 * up, `D` mouse down, `E` enter, `X` exit, `Fo` focus, `Bl` blur).
 */
export interface FieldAction {
  readonly trigger: string;
  /** `/S` — the action type: `JavaScript`, `SubmitForm`, `ResetForm`, `URI`, `GoTo`, `Named`. */
  readonly type: string;
  /** For `JavaScript`, the script; for `URI`, the address; for `Named`, the name. */
  readonly value: string;
}

/** The `/AA` triggers a field may carry, and the words the Actions tab uses for them. */
export const ACTION_TRIGGERS: ReadonlyArray<{ readonly key: string; readonly label: string }> = [
  { key: 'U', label: 'Mouse up' },
  { key: 'D', label: 'Mouse down' },
  { key: 'E', label: 'Mouse enter' },
  { key: 'X', label: 'Mouse exit' },
  { key: 'Fo', label: 'Field receives focus' },
  { key: 'Bl', label: 'Field loses focus' },
  { key: 'K', label: 'Key pressed' },
  { key: 'F', label: 'Value is formatted' },
  { key: 'V', label: 'Value is validated' },
  { key: 'C', label: 'Value is calculated' },
];

/** The action types the editor offers. */
export const ACTION_TYPES: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: 'JavaScript', label: 'Run a script' },
  { value: 'ResetForm', label: 'Reset the form' },
  { value: 'SubmitForm', label: 'Submit the form' },
  { value: 'URI', label: 'Open a web address' },
  { value: 'Named', label: 'Run a named action' },
];

/** Everything the properties dialog edits about a *field* (as opposed to one of its widgets). */
export interface FieldDesign {
  readonly role: FieldRole;
  /** `/Ff`, authoritative: `readOnly` and `required` on the field are read from it. */
  readonly flags: number;
  /** `/TU` — the tooltip, and the accessible name of every widget. */
  readonly tooltip: string | null;
  /** `/DV` — what Reset Form puts back. */
  readonly defaultValue: string | null;
  /** `/Opt` for a choice field; the export values of a radio group's kids. */
  readonly options: ReadonlyArray<FieldOption>;
  /** `/MaxLen`, also the number of comb cells. */
  readonly maxLength: number | null;
  /** `/Q`. */
  readonly align: FieldAlign;
  /** `/DA` font. */
  readonly font: AppearanceFont;
  /** `/DA` size in points; 0 means "auto" — fit the box. */
  readonly fontSize: number;
  /** `/DA` colour, `0xRRGGBB`. */
  readonly textColor: number;
  /** A date field's display format, e.g. `"dd/mm/yyyy"`. */
  readonly dateFormat: string | null;
  readonly barcode: BarcodeSpec | null;
  readonly actions: ReadonlyArray<FieldAction>;
  /** `/TI` — the first option a list box shows. */
  readonly topIndex: number;
}

/** Everything the properties dialog edits about one *widget* of a field. */
export interface WidgetAppearance {
  /** `/MK /BC`, `0xRRGGBB`, or null for no border colour at all. */
  readonly borderColor: number | null;
  /** `/MK /BG`, or null for a transparent box — which is what most form boxes are. */
  readonly fillColor: number | null;
  /** `/BS /W`. */
  readonly borderWidth: number;
  readonly borderStyle: BorderStyle;
  /** `/BS /D` when the style is dashed. */
  readonly dashArray: ReadonlyArray<number>;
  /** `/MK /R` — the contents' rotation inside the box, anticlockwise degrees. */
  readonly rotation: 0 | 90 | 180 | 270;
  readonly checkStyle: CheckStyle;
  /** `/MK /CA` for a push button. */
  readonly caption: string | null;
  /** `/MK /RC`. */
  readonly rolloverCaption: string | null;
  /** `/MK /AC`. */
  readonly downCaption: string | null;
  readonly layout: ButtonLayout;
  /** `WritePlan.xobjects` key of the picture a button or image field draws (`/MK /I`). */
  readonly iconKey: string | null;
  /** `/AS` and the `/AP /N` key: the export value this widget turns the field to when picked. */
  readonly exportValue: string;
  readonly highlight: WidgetHighlight;
  /** `/F` bit 2 — the widget is not drawn at all. */
  readonly hidden: boolean;
  /** `/F` bit 3 clear — the widget is on screen but not on paper. */
  readonly noPrint: boolean;
}

export const DEFAULT_WIDGET_APPEARANCE: WidgetAppearance = {
  borderColor: 0x000000,
  fillColor: null,
  borderWidth: 1,
  borderStyle: 'solid',
  dashArray: [3],
  rotation: 0,
  checkStyle: 'check',
  caption: null,
  rolloverCaption: null,
  downCaption: null,
  layout: 'caption-only',
  iconKey: null,
  exportValue: 'Yes',
  highlight: 'invert',
  hidden: false,
  noPrint: false,
};

/** A field's design as it starts life, before the reader changes anything. */
export function defaultFieldDesign(role: FieldRole): FieldDesign {
  const flags =
    role === 'button' || role === 'image'
      ? flagBit(BUTTON_FLAGS.pushButton)
      : role === 'radio'
        ? flagBit(BUTTON_FLAGS.radio)
        : role === 'combobox'
          ? flagBit(CHOICE_FLAGS.combo)
          : 0;
  return {
    role,
    flags,
    tooltip: null,
    defaultValue: null,
    options: [],
    maxLength: null,
    align: 0,
    font: 'Helvetica',
    fontSize: role === 'checkbox' || role === 'radio' ? 0 : 9,
    textColor: 0x000000,
    dateFormat: role === 'date' ? 'dd/mm/yyyy' : null,
    barcode: role === 'barcode' ? DEFAULT_BARCODE : null,
    actions: [],
    topIndex: 0,
  };
}

/** The widget defaults a freshly drawn field of `role` gets. */
export function defaultWidgetAppearance(role: FieldRole): WidgetAppearance {
  switch (role) {
    case 'button':
    case 'image':
      return {
        ...DEFAULT_WIDGET_APPEARANCE,
        fillColor: 0xd0d0d0,
        caption: role === 'button' ? 'Button' : null,
        layout: role === 'image' ? 'icon-only' : 'caption-only',
      };
    case 'checkbox':
    case 'radio':
      return { ...DEFAULT_WIDGET_APPEARANCE, exportValue: role === 'radio' ? 'Choice 1' : 'Yes' };
    case 'signature':
      return { ...DEFAULT_WIDGET_APPEARANCE, borderWidth: 1 };
    default:
      return DEFAULT_WIDGET_APPEARANCE;
  }
}

/** The size, in points, a freshly drawn field of `role` gets when it is clicked rather than dragged. */
export function defaultFieldSize(role: FieldRole): {
  readonly width: number;
  readonly height: number;
} {
  switch (role) {
    case 'checkbox':
    case 'radio':
      return { width: 14, height: 14 };
    case 'listbox':
      return { width: 160, height: 60 };
    case 'button':
      return { width: 100, height: 24 };
    case 'image':
      return { width: 96, height: 72 };
    case 'signature':
      return { width: 200, height: 48 };
    case 'barcode':
      return { width: 144, height: 72 };
    default:
      return { width: 180, height: 20 };
  }
}

// ---- flags as questions -------------------------------------------------------------------------

export function isReadOnly(design: FieldDesign): boolean {
  return hasFlag(design.flags, COMMON_FLAGS.readOnly);
}

export function isRequired(design: FieldDesign): boolean {
  return hasFlag(design.flags, COMMON_FLAGS.required);
}

export function isMultiline(design: FieldDesign): boolean {
  return design.role === 'text' && hasFlag(design.flags, TEXT_FLAGS.multiline);
}

export function isPassword(design: FieldDesign): boolean {
  return design.role === 'text' && hasFlag(design.flags, TEXT_FLAGS.password);
}

export function isComb(design: FieldDesign): boolean {
  return (
    design.role === 'text' &&
    hasFlag(design.flags, TEXT_FLAGS.comb) &&
    (design.maxLength ?? 0) > 0 &&
    !hasFlag(design.flags, TEXT_FLAGS.multiline)
  );
}

export function isEditableChoice(design: FieldDesign): boolean {
  return design.role === 'combobox' && hasFlag(design.flags, CHOICE_FLAGS.edit);
}

export function isMultiSelect(design: FieldDesign): boolean {
  return design.role === 'listbox' && hasFlag(design.flags, CHOICE_FLAGS.multiSelect);
}

export function isSorted(design: FieldDesign): boolean {
  return (
    (design.role === 'combobox' || design.role === 'listbox') &&
    hasFlag(design.flags, CHOICE_FLAGS.sort)
  );
}

/** True for the roles a reader can type or choose a value into. */
export function isFillable(design: FieldDesign): boolean {
  switch (design.role) {
    case 'button':
    case 'image':
    case 'signature':
      return false;
    default:
      return !isReadOnly(design);
  }
}

// ---- field names --------------------------------------------------------------------------------

/** A dotted field name split into its `/T` chain. */
export function splitFieldName(name: string): string[] {
  return name.split('.').filter((part) => part !== '');
}

export function joinFieldName(parts: ReadonlyArray<string>): string {
  return parts.filter((p) => p !== '').join('.');
}

/** The last segment — the field's own `/T`. */
export function partialName(name: string): string {
  const parts = splitFieldName(name);
  return parts[parts.length - 1] ?? '';
}

/** The dotted name of the parent node, or `""` at the root. */
export function parentName(name: string): string {
  return joinFieldName(splitFieldName(name).slice(0, -1));
}

/**
 * Why a name cannot be used, in words for the reader, or null when it can.
 *
 * A `/T` may not contain a full stop — that is what builds the hierarchy — and PDF 12.7.3.2 is
 * clear that two fields with the same fully-qualified name are *the same field*, which is exactly
 * what a radio group is and exactly what a typo should not silently create.
 */
export function fieldNameProblem(
  name: string,
  taken: ReadonlyArray<string>,
  self?: string,
): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'A field needs a name.';
  const parts = trimmed.split('.');
  if (parts.some((p) => p.trim() === '')) {
    return 'A dot separates the parts of a name, so a name cannot start or end with one, or have two in a row.';
  }
  // eslint-disable-next-line no-control-regex -- a control character in a `/T` is exactly what we are refusing
  if (/[ -]/.test(trimmed)) return 'A name cannot contain control characters.';
  if (trimmed !== self && taken.includes(trimmed)) {
    return `Another field is already called "${trimmed}". Two fields with the same name are one field, sharing a value.`;
  }
  return null;
}

/** `Copy`, `Copy 2`, … — the next free name beside `base`. */
export function nextFreeName(base: string, taken: ReadonlyArray<string>): string {
  if (!taken.includes(base)) return base;
  const parts = splitFieldName(base);
  const last = parts[parts.length - 1] ?? base;
  const stem = /^(.*?)(\d+)$/.exec(last);
  const prefix = stem ? (stem[1] ?? '') : `${last} `;
  let n = stem ? Number(stem[2]) + 1 : 2;
  for (;;) {
    const candidate = joinFieldName([...parts.slice(0, -1), `${prefix}${n}`]);
    if (!taken.includes(candidate)) return candidate;
    n++;
  }
}

// ---- tab order ----------------------------------------------------------------------------------

/** `/Tabs` — how a page orders its annotations for tabbing. */
export type TabOrderMode = 'row' | 'column' | 'structure' | 'manual';

export const TAB_ORDER_MODES: ReadonlyArray<TabOrderMode> = [
  'row',
  'column',
  'structure',
  'manual',
];

export const TAB_ORDER_LABELS: Readonly<Record<TabOrderMode, string>> = {
  row: 'By row',
  column: 'By column',
  structure: 'By document structure',
  manual: 'Manual',
};

/** `/Tabs` name for a mode; manual has none — the order of `/Annots` is the order. */
export function tabsName(mode: TabOrderMode): string | null {
  switch (mode) {
    case 'row':
      return 'R';
    case 'column':
      return 'C';
    case 'structure':
      return 'S';
    default:
      return null;
  }
}

export function tabModeOf(name: string | null | undefined): TabOrderMode | null {
  switch (name) {
    case 'R':
      return 'row';
    case 'C':
      return 'column';
    case 'S':
      return 'structure';
    default:
      return null;
  }
}

/**
 * Sorts widget boxes into reading order for `row` or `column`.
 *
 * Rows are banded rather than sorted on `y` alone: two boxes whose vertical spans overlap by more
 * than half the shorter one are on the same line however their tops differ, which is what a form
 * laid out by eye actually looks like.
 */
export function tabSort<
  T extends { readonly rect: { x0: number; y0: number; x1: number; y1: number } },
>(items: ReadonlyArray<T>, mode: 'row' | 'column'): T[] {
  const sorted = [...items];
  if (mode === 'column') {
    sorted.sort((a, b) => a.rect.x0 - b.rect.x0 || b.rect.y1 - a.rect.y1);
    const bands = band(sorted, (i) => ({ lo: i.rect.x0, hi: i.rect.x1 }));
    return bands.flatMap((column) => column.sort((a, b) => b.rect.y1 - a.rect.y1));
  }
  sorted.sort((a, b) => b.rect.y1 - a.rect.y1 || a.rect.x0 - b.rect.x0);
  const bands = band(sorted, (i) => ({ lo: i.rect.y0, hi: i.rect.y1 }));
  return bands.flatMap((row) => row.sort((a, b) => a.rect.x0 - b.rect.x0));
}

/** Groups already-sorted items into bands whose spans overlap by more than half. */
function band<T>(items: ReadonlyArray<T>, span: (item: T) => { lo: number; hi: number }): T[][] {
  const out: T[][] = [];
  for (const item of items) {
    const s = span(item);
    const last = out[out.length - 1];
    if (last && last.length > 0) {
      const prev = span(last[last.length - 1] as T);
      const overlap = Math.min(prev.hi, s.hi) - Math.max(prev.lo, s.lo);
      const shorter = Math.min(prev.hi - prev.lo, s.hi - s.lo);
      if (overlap > shorter / 2) {
        last.push(item);
        continue;
      }
    }
    out.push([item]);
  }
  return out;
}
