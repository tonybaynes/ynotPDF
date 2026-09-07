/**
 * PDFium public-API constants used by the adapter (from `public/fpdfview.h`, `fpdf_annot.h`,
 * `fpdf_doc.h`, `fpdf_formfill.h`, `fpdf_edit.h`, `fpdf_save.h`). Values are stable ABI.
 */

/** `FPDF_GetLastError()` codes. */
export const FPDF_ERR = {
  SUCCESS: 0,
  UNKNOWN: 1,
  FILE: 2,
  FORMAT: 3,
  PASSWORD: 4,
  SECURITY: 5,
  PAGE: 6,
  XFALOAD: 7,
  XFALAYOUT: 8,
} as const;

/** Render flags for `FPDF_RenderPageBitmap*` and `FPDF_FFLDraw`. */
export const RENDER = {
  ANNOT: 0x01,
  LCD_TEXT: 0x02,
  NO_NATIVETEXT: 0x04,
  GRAYSCALE: 0x08,
  REVERSE_BYTE_ORDER: 0x10,
  CONVERT_FILL_TO_STROKE: 0x20,
  LIMITEDIMAGECACHE: 0x200,
  FORCEHALFTONE: 0x400,
  PRINTING: 0x800,
  NO_SMOOTHTEXT: 0x1000,
  NO_SMOOTHIMAGE: 0x2000,
  NO_SMOOTHPATH: 0x4000,
} as const;

/** Progressive render status. */
export const RENDER_STATUS = { READY: 0, TOBECONTINUED: 1, DONE: 2, FAILED: 3 } as const;

/** Bitmap formats for `FPDFBitmap_CreateEx`. */
export const BITMAP = { GRAY: 1, BGR: 2, BGRX: 3, BGRA: 4 } as const;

/** `FPDF_SaveAsCopy` flags. */
export const SAVE = { INCREMENTAL: 1, NO_INCREMENTAL: 2, REMOVE_SECURITY: 3 } as const;

/** `FPDFPageObj_GetType`. */
export const PAGEOBJ = { UNKNOWN: 0, TEXT: 1, PATH: 2, IMAGE: 3, SHADING: 4, FORM: 5 } as const;

/** `FPDF_GetFormType`. */
export const FORMTYPE = { NONE: 0, ACRO_FORM: 1, XFA_FULL: 2, XFA_FOREGROUND: 3 } as const;

/** `FPDFAnnot_GetSubtype`. Index = PDFium enum value. */
export const ANNOT_SUBTYPES = [
  'Unknown',
  'Text',
  'Link',
  'FreeText',
  'Line',
  'Square',
  'Circle',
  'Polygon',
  'PolyLine',
  'Highlight',
  'Underline',
  'Squiggly',
  'StrikeOut',
  'Stamp',
  'Caret',
  'Ink',
  'Popup',
  'FileAttachment',
  'Sound',
  'Movie',
  'Widget',
  'Screen',
  'PrinterMark',
  'TrapNet',
  'Watermark',
  '3D',
  'RichMedia',
  'XFAWidget',
  'Redact',
] as const;

/** Annotation flag bits (`/F`). */
export const ANNOT_FLAG = {
  INVISIBLE: 1 << 0,
  HIDDEN: 1 << 1,
  PRINT: 1 << 2,
  NOZOOM: 1 << 3,
  NOROTATE: 1 << 4,
  NOVIEW: 1 << 5,
  READONLY: 1 << 6,
  LOCKED: 1 << 7,
  TOGGLENOVIEW: 1 << 8,
} as const;

/** `FPDFAnnot_GetColor` colour type. */
export const ANNOT_COLORTYPE = { COLOR: 0, INTERIOR: 1 } as const;

/** `FPDFAnnot_GetFormFieldType`. */
export const FORMFIELD = {
  UNKNOWN: 0,
  PUSHBUTTON: 1,
  CHECKBOX: 2,
  RADIOBUTTON: 3,
  COMBOBOX: 4,
  LISTBOX: 5,
  TEXTFIELD: 6,
  SIGNATURE: 7,
} as const;

/** Form field flag bits (`/Ff`). */
export const FIELDFLAG = { READONLY: 1 << 0, REQUIRED: 1 << 1, NOEXPORT: 1 << 2 } as const;

/** `FPDFAction_GetType`. */
export const ACTION = {
  UNSUPPORTED: 0,
  GOTO: 1,
  REMOTEGOTO: 2,
  URI: 3,
  LAUNCH: 4,
  EMBEDDEDGOTO: 5,
} as const;

/** `FPDFDest_GetView` modes. */
export const DEST_VIEW = {
  UNKNOWN: 0,
  XYZ: 1,
  FIT: 2,
  FITH: 3,
  FITV: 4,
  FITR: 5,
  FITB: 6,
  FITBH: 7,
  FITBV: 8,
} as const;

/** Standard security handler permission bits (PDF 32000-1 table 22), 1-based bit positions. */
export const PERMISSION_BIT = {
  PRINT: 3,
  MODIFY: 4,
  COPY: 5,
  ANNOTATE: 6,
  FILL_FORMS: 9,
  EXTRACT_ACCESSIBILITY: 10,
  ASSEMBLE: 11,
  PRINT_HIGH: 12,
} as const;

/** Font descriptor flags (`/Flags`, PDF 32000-1 table 123) as PDFium reports them. */
export const FONT_FLAG = {
  FIXED_PITCH: 1 << 0,
  SERIF: 1 << 1,
  SYMBOLIC: 1 << 2,
  SCRIPT: 1 << 3,
  NONSYMBOLIC: 1 << 5,
  ITALIC: 1 << 6,
  ALL_CAP: 1 << 16,
  SMALL_CAP: 1 << 17,
  FORCE_BOLD: 1 << 18,
} as const;
