/**
 * Reads the few catalogue facts PDFium's public API does not expose (M10): optional-content
 * groups (layers) and the raw XMP packet. Uses pdf-lib's object parser, read-only. For
 * encrypted files the caller passes bytes already decrypted by PDFium (`FPDF_SaveAsCopy` with
 * `FPDF_REMOVE_SECURITY`), because pdf-lib does not decrypt strings.
 */

import type { PDFObject } from 'pdf-lib';
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  ParseSpeeds,
  decodePDFRawStream,
} from 'pdf-lib';
import { parseTreeKey } from '@shared/portfolio';
import { scaleFromNumberFormat, type MeasureScale } from '../appearance/measure';
import { DEFAULT_INITIAL_VIEW } from '../PdfEngine';
import type {
  CollectionField,
  CollectionFolder,
  Destination,
  FontUsage,
  InitialView,
  Layer,
  PdfCollection,
} from '../PdfEngine';

/**
 * The parts of one annotation dictionary PDFium's API cannot give back: `/C`, `/IC` (0xRRGGBB)
 * and the border width it hides behind an appearance stream, plus the number arrays it has no
 * getter for at all — a callout's `/CL` and a free text's or caret's `/RD` (M30).
 */
export interface AnnotColors {
  readonly color?: number;
  readonly interiorColor?: number;
  readonly borderWidth?: number;
  /** `/CL` — a callout's leader line, as flat numbers. */
  readonly callout?: ReadonlyArray<number>;
  /** `/RD` — the inset from `/Rect` to the content, four numbers. */
  readonly padding?: ReadonlyArray<number>;
  /** `/Q` — quadding: 0 left, 1 centre, 2 right. */
  readonly align?: number;
  /** `/Rotate` — rotation of a free text's contents, anticlockwise degrees. */
  readonly rotate?: number;
  /** `/LE` as a Line or PolyLine carries it: two names, start and end (M31). */
  readonly lineEndings?: readonly [string, string];
  /** `/BE /I` when `/BE /S` is `/C` — a cloudy border's intensity (M31). */
  readonly cloudy?: number;
  /** `/BS /D` — the dash pattern (M31). */
  readonly dashArray?: ReadonlyArray<number>;
  /**
   * `/Measure` as a scale (M33, ADR 0018). Rebuilt from the `/D` (or `/X`) number format, since
   * that is what states the arithmetic; `/R` is only words.
   */
  readonly measure?: MeasureScale;
  /** `/LL`, `/LLE`, `/LLO` — a dimension line's leaders (M33). */
  readonly leaderLength?: number;
  readonly leaderExtend?: number;
  readonly leaderOffset?: number;
  /** `/Cap`, `/CP`, `/CO` — whether the value is drawn on the line, where, and nudged how far. */
  readonly caption?: boolean;
  readonly captionPosition?: string;
  readonly captionOffset?: ReadonlyArray<number>;
}

export interface RawInfo {
  readonly layers: ReadonlyArray<Layer>;
  /** OCG name → layer id (first match wins), for `PageObject.layerId` resolution. */
  readonly layerIdByName: ReadonlyMap<string, string>;
  readonly xmp?: string;
  /**
   * Annotation colours straight from the dictionaries, indexed like `FPDFPage_GetAnnot`.
   * PDFium refuses `FPDFAnnot_GetColor` once an appearance stream exists — and it generates
   * one itself for most markup types when the page loads — so this is the fallback.
   */
  annotationColors(page: number): ReadonlyArray<AnnotColors>;
  /**
   * `/EmbeddedFiles` name-tree entries in tree order (the order PDFium enumerates them):
   * the file specification's `/Desc`, the embedded stream's `/Subtype`, and the portfolio
   * collection values in `/CI` — none of which PDFium's attachment API exposes (ADR 0011).
   */
  readonly embeddedFiles: ReadonlyArray<{
    readonly description?: string;
    readonly mimeType?: string;
    readonly collectionFields?: Readonly<Record<string, string>>;
    /** The raw name-tree key, folder prefix included (M42, ADR 0014). */
    readonly treeKey?: string;
    /** Folder the key's `<n>` prefix names; 0 when it has none (M42, ADR 0014). */
    readonly folderId?: number;
  }>;
  /** The catalogue's `/Collection`: the file is a PDF Portfolio (ADR 0011). */
  readonly collection: PdfCollection | null;
  /**
   * Fonts named by the page resources, deduplicated by font object and in first-use order
   * (M72, ADR 0017). PDFium reports the font of a *drawn glyph*; these are the dictionaries.
   */
  readonly fonts: ReadonlyArray<FontUsage>;
  /** How the file asks to be opened (M72, ADR 0017). */
  readonly initialView: InitialView;
  /**
   * The information-dictionary and catalogue entries `FPDF_GetMetaText` cannot reach
   * (M72, ADR 0017): custom Info keys, `/Trapped`, `/Lang` and `/URI /Base`.
   */
  readonly documentInfo: {
    readonly custom?: Readonly<Record<string, string>>;
    readonly trapped?: 'True' | 'False' | 'Unknown';
    readonly lang?: string;
    readonly baseUrl?: string;
  };
}

/** Converts a PDF colour array (gray / RGB / CMYK components 0..1) to 0xRRGGBB. */
export function colorArrayToRgb(components: ReadonlyArray<number>): number | undefined {
  const c = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  switch (components.length) {
    case 1: {
      const g = c(components[0] ?? 0);
      return (g << 16) | (g << 8) | g;
    }
    case 3:
      return (c(components[0] ?? 0) << 16) | (c(components[1] ?? 0) << 8) | c(components[2] ?? 0);
    case 4: {
      const [cy = 0, m = 0, y = 0, k = 0] = components;
      return (c((1 - cy) * (1 - k)) << 16) | (c((1 - m) * (1 - k)) << 8) | c((1 - y) * (1 - k));
    }
    default:
      return undefined; // empty array = transparent / no colour
  }
}

/**
 * A `/Measure` dictionary as a scale (M33, ADR 0018).
 *
 * The distance format (`/D`) is what a length is shown in; a file that gives only `/X` — which is
 * what the spec's default says to fall back on — is read from that instead. Anything malformed is
 * simply absent: a measurement with no scale falls back to the app's own, which is what a reader
 * would rather have than a number computed from a factor that made no sense.
 */
function readMeasure(
  value: unknown,
  resolve: (value: PDFObject | undefined) => unknown,
): MeasureScale | undefined {
  if (!(value instanceof PDFDict)) return undefined;
  const at = (owner: PDFDict, key: string): unknown => resolve(owner.get(PDFName.of(key)));
  for (const axis of ['D', 'X']) {
    const array = at(value, axis);
    if (!(array instanceof PDFArray) || array.size() === 0) continue;
    const format = resolve(array.get(0));
    if (!(format instanceof PDFDict)) continue;
    const unit = at(format, 'U');
    const conversion = at(format, 'C');
    if (!(conversion instanceof PDFNumber)) continue;
    const label =
      unit instanceof PDFHexString || unit instanceof PDFString ? unit.decodeText() : null;
    if (label === null) continue;
    const style = at(format, 'F');
    const denominator = at(format, 'D');
    const scale = scaleFromNumberFormat({
      unit: label,
      conversion: conversion.asNumber(),
      ...(style instanceof PDFName ? { fractionStyle: style.decodeText() } : {}),
      ...(denominator instanceof PDFNumber ? { denominator: denominator.asNumber() } : {}),
    });
    if (scale) return scale;
  }
  return undefined;
}

const XMP_BEGIN = '<?xpacket begin=';
const XMP_END = '<?xpacket end=';

/** Fast path: an uncompressed XMP packet found by scanning the raw bytes (PDF/A mandates this). */
export function scanXmp(bytes: Uint8Array): string | undefined {
  const text = new TextDecoder('latin1').decode(bytes);
  const start = text.indexOf(XMP_BEGIN);
  if (start < 0) return undefined;
  const endMarker = text.indexOf(XMP_END, start);
  if (endMarker < 0) return undefined;
  const close = text.indexOf('?>', endMarker);
  if (close < 0) return undefined;
  const slice = bytes.subarray(start, close + 2);
  return new TextDecoder('utf-8').decode(slice);
}

function textOf(value: unknown): string | undefined {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  return undefined;
}

/** Parses `/OCProperties` and `/Metadata` out of a (decrypted) PDF. Never throws. */
export async function readRawInfo(bytes: Uint8Array): Promise<RawInfo> {
  const empty: RawInfo = {
    layers: [],
    layerIdByName: new Map(),
    annotationColors: () => [],
    embeddedFiles: [],
    collection: null,
    fonts: [],
    initialView: DEFAULT_INITIAL_VIEW,
    documentInfo: {},
  };
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
      parseSpeed: ParseSpeeds.Fastest,
    });
  } catch {
    return { ...empty, ...optional('xmp', scanXmp(bytes)) };
  }
  const ctx = doc.context;
  const catalog = doc.catalog;

  // ---- layers --------------------------------------------------------------------------------
  const layers: Layer[] = [];
  const layerIdByName = new Map<string, string>();
  const ocProps = catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
  if (ocProps) {
    const ocgsArr = ocProps.lookupMaybe(PDFName.of('OCGs'), PDFArray);
    const d = ocProps.lookupMaybe(PDFName.of('D'), PDFDict);
    const refsIn = (key: string): Set<string> => {
      const set = new Set<string>();
      const arr = d?.lookupMaybe(PDFName.of(key), PDFArray);
      if (arr)
        for (const item of arr.asArray()) if (item instanceof PDFRef) set.add(item.toString());
      return set;
    };
    const off = refsIn('OFF');
    const on = refsIn('ON');
    const locked = refsIn('Locked');
    const baseOff = d?.lookupMaybe(PDFName.of('BaseState'), PDFName)?.decodeText() === 'OFF';
    const seen = new Set<string>();
    const add = (ref: PDFRef, depth: number): void => {
      const key = ref.toString();
      if (seen.has(key)) return;
      seen.add(key);
      const dict = ctx.lookupMaybe(ref, PDFDict);
      if (!dict || dict.lookupMaybe(PDFName.of('Type'), PDFName)?.decodeText() !== 'OCG') return;
      const name = textOf(dict.lookup(PDFName.of('Name'))) ?? `Layer ${layers.length + 1}`;
      const id = `ocg.${ref.objectNumber}`;
      const visible = off.has(key) ? false : baseOff ? on.has(key) : true;
      layers.push({ id, name, visible, locked: locked.has(key), depth });
      if (!layerIdByName.has(name)) layerIdByName.set(name, id);
    };
    const walkOrder = (arr: PDFArray, depth: number): void => {
      for (const item of arr.asArray()) {
        if (item instanceof PDFRef) add(item, depth);
        else if (item instanceof PDFArray) walkOrder(item, depth + 1);
        // Strings inside /Order are group labels without an OCG; skipped.
      }
    };
    const order = d?.lookupMaybe(PDFName.of('Order'), PDFArray);
    if (order) walkOrder(order, 0);
    if (ocgsArr) for (const item of ocgsArr.asArray()) if (item instanceof PDFRef) add(item, 0);
  }

  /*
   * ---- XMP ----
   *
   * The catalogue's `/Metadata` first, and the byte scan only as a fallback. Scanning is faster
   * and PDF/A guarantees it finds something, but "something" is the wrong promise: a file that
   * has been rewritten can carry an older packet as an unreferenced object, and a scan would
   * report that one. What the document's metadata *is* is what the catalogue points at.
   */
  let xmp: string | undefined;
  try {
    const meta = catalog.lookup(PDFName.of('Metadata'));
    if (meta instanceof PDFRawStream) {
      xmp = new TextDecoder('utf-8').decode(decodePDFRawStream(meta).decode());
    }
  } catch {
    xmp = undefined;
  }
  xmp ??= scanXmp(bytes);

  const colorCache = new Map<number, ReadonlyArray<AnnotColors>>();
  const annotationColors = (page: number): ReadonlyArray<AnnotColors> => {
    const cached = colorCache.get(page);
    if (cached) return cached;
    const out: AnnotColors[] = [];
    try {
      const annots = doc.getPages()[page]?.node.Annots();
      if (annots) {
        for (const item of annots.asArray()) {
          const dict = ctx.lookupMaybe(item, PDFDict);
          const read = (key: string): number | undefined => {
            const arr = dict?.lookupMaybe(PDFName.of(key), PDFArray);
            if (!arr) return undefined;
            const nums = arr.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0));
            return colorArrayToRgb(nums);
          };
          let borderWidth: number | undefined;
          const bs = dict?.lookupMaybe(PDFName.of('BS'), PDFDict);
          const w = bs?.lookupMaybe(PDFName.of('W'), PDFNumber);
          if (w) borderWidth = w.asNumber();
          else {
            const border = dict?.lookupMaybe(PDFName.of('Border'), PDFArray);
            const third = border?.asArray()[2];
            if (third instanceof PDFNumber) borderWidth = third.asNumber();
          }
          const numbers = (key: string): ReadonlyArray<number> | undefined => {
            const arr = dict?.lookupMaybe(PDFName.of(key), PDFArray);
            if (!arr) return undefined;
            const nums = arr
              .asArray()
              .map((v) => (v instanceof PDFNumber ? v.asNumber() : Number.NaN));
            return nums.some((n) => Number.isNaN(n)) ? undefined : nums;
          };
          const number = (key: string): number | undefined =>
            dict?.lookupMaybe(PDFName.of(key), PDFNumber)?.asNumber();
          /*
           * These are read with `lookup` and `instanceof`, not `lookupMaybe(key, Type)`: the
           * typed form *throws* when the entry exists as another type — a callout's `/LE` is one
           * name, not an array — and a throw here loses the colours of every annotation after it
           * on the page.
           */
          const entryOf = (owner: PDFDict | undefined, key: string): unknown =>
            owner ? ctx.lookup(owner.get(PDFName.of(key))) : undefined;
          // A Line's `/LE` is two names; a callout's is one, which the string pass reads.
          let lineEndings: readonly [string, string] | undefined;
          const le = entryOf(dict, 'LE');
          if (le instanceof PDFArray && le.size() === 2) {
            const a: unknown = le.get(0);
            const b: unknown = le.get(1);
            if (a instanceof PDFName && b instanceof PDFName) {
              lineEndings = [a.decodeText(), b.decodeText()];
            }
          }
          let cloudy: number | undefined;
          const be = entryOf(dict, 'BE');
          if (be instanceof PDFDict) {
            const style = entryOf(be, 'S');
            if (style instanceof PDFName && style.decodeText() === 'C') {
              const intensity = entryOf(be, 'I');
              cloudy = intensity instanceof PDFNumber ? intensity.asNumber() : 1;
            }
          }
          let dashArray: ReadonlyArray<number> | undefined;
          const d = entryOf(bs, 'D');
          if (d instanceof PDFArray) {
            const nums = d
              .asArray()
              .map((v) => (v instanceof PDFNumber ? v.asNumber() : Number.NaN));
            if (nums.length > 0 && !nums.some((n) => Number.isNaN(n))) dashArray = nums;
          }
          // `/Measure` and the dimension entries beside it (M33, ADR 0018). PDFium has a getter
          // for none of them, and a measurement that reopened without its scale would show a
          // different number from the one it was saved with.
          const measure = readMeasure(entryOf(dict, 'Measure'), (v) => ctx.lookup(v));
          const cap = entryOf(dict, 'Cap');
          const captionPosition = entryOf(dict, 'CP');
          out.push({
            ...optional('color', read('C')),
            ...optional('interiorColor', read('IC')),
            ...optional('borderWidth', borderWidth),
            ...optional('callout', numbers('CL')),
            ...optional('padding', numbers('RD')),
            ...optional('align', number('Q')),
            ...optional('rotate', number('Rotate')),
            ...optional('lineEndings', lineEndings),
            ...optional('cloudy', cloudy),
            ...optional('dashArray', dashArray),
            ...optional('measure', measure),
            ...optional('leaderLength', number('LL')),
            ...optional('leaderExtend', number('LLE')),
            ...optional('leaderOffset', number('LLO')),
            ...optional('caption', cap instanceof PDFBool ? cap.asBoolean() : undefined),
            ...optional(
              'captionPosition',
              captionPosition instanceof PDFName ? captionPosition.decodeText() : undefined,
            ),
            ...optional('captionOffset', numbers('CO')),
          });
        }
      }
    } catch {
      // Malformed page tree: no fallback colours for this page.
    }
    colorCache.set(page, out);
    return out;
  };

  // ---- embedded files (name tree walk, in order) ---------------------------------------------
  const embeddedFiles: Array<{
    description?: string;
    mimeType?: string;
    treeKey?: string;
    folderId?: number;
  }> = [];
  const walkNames = (node: PDFDict | undefined, depth: number): void => {
    if (!node || depth > 32) return;
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) {
      for (const kid of kids.asArray()) walkNames(ctx.lookupMaybe(kid, PDFDict), depth + 1);
      return;
    }
    const names = node.lookupMaybe(PDFName.of('Names'), PDFArray)?.asArray() ?? [];
    for (let i = 1; i < names.length; i += 2) {
      const spec = ctx.lookupMaybe(names[i], PDFDict);
      const key = textOf(names[i - 1]);
      const description = textOf(spec?.lookup(PDFName.of('Desc')));
      const ef = spec?.lookupMaybe(PDFName.of('EF'), PDFDict);
      const file = ef ? ctx.lookup(ef.get(PDFName.of('F')) ?? ef.get(PDFName.of('UF'))) : undefined;
      const subtype =
        file instanceof PDFRawStream
          ? file.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)
          : undefined;
      const ci = spec?.lookupMaybe(PDFName.of('CI'), PDFDict);
      const fields: Record<string, string> = {};
      if (ci) {
        for (const [key, value] of ci.entries()) {
          const resolved = ctx.lookup(value);
          const text =
            textOf(resolved) ??
            (resolved instanceof PDFNumber
              ? String(resolved.asNumber())
              : resolved instanceof PDFName
                ? resolved.decodeText()
                : undefined);
          // A date column's value is a PDF date; hand it over as ISO like every other date here,
          // so the model treats it as one and the writer can put it back in the same form.
          if (text !== undefined) {
            fields[key.decodeText()] = /^D:\d{8}/.test(text) ? (pdfDate(text) ?? text) : text;
          }
        }
      }
      embeddedFiles.push({
        ...optional('treeKey', key),
        ...optional('folderId', key === undefined ? undefined : parseTreeKey(key).folderId),
        ...optional('description', description),
        ...optional('mimeType', subtype?.decodeText()),
        ...optional(
          'collectionFields',
          Object.keys(fields).length > 0 ? (fields as Readonly<Record<string, string>>) : undefined,
        ),
      });
    }
  };
  try {
    const namesDict = catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
    walkNames(namesDict?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict), 0);
  } catch {
    embeddedFiles.length = 0;
  }

  return {
    layers,
    layerIdByName,
    ...optional('xmp', xmp),
    annotationColors,
    embeddedFiles,
    collection: readCollection(ctx, catalog),
    fonts: readFonts(doc),
    initialView: readInitialView(doc),
    documentInfo: readDocumentInfo(doc),
  };
}

/** `/View` values a viewer understands; anything else is a custom navigator. */
const COLLECTION_VIEWS: Readonly<Record<string, PdfCollection['view']>> = {
  D: 'details',
  T: 'tile',
  H: 'hidden',
  C: 'custom',
};

/** Field `/Subtype` values, standard first (PDF 12.3.5). */
const FIELD_KINDS = new Set<CollectionField['kind']>([
  'F',
  'Desc',
  'ModDate',
  'CreationDate',
  'Size',
  'CompressedSize',
  'S',
  'D',
  'N',
]);

/**
 * The catalogue's `/Collection` dictionary — a PDF Portfolio (PDF 12.3.5, ADR 0011).
 *
 * Returns `null` for an ordinary file, and a collection with no fields for a portfolio that
 * defines no schema of its own: the presence of the dictionary is what makes a portfolio, not
 * the schema, and a viewer still has to show the embedded files.
 */
function readCollection(
  ctx: PDFDocument['context'],
  catalog: PDFDocument['catalog'],
): PdfCollection | null {
  let dict: PDFDict | undefined;
  try {
    dict = catalog.lookupMaybe(PDFName.of('Collection'), PDFDict);
  } catch {
    return null;
  }
  if (!dict) return null;
  const fields: CollectionField[] = [];
  try {
    const schema = dict.lookupMaybe(PDFName.of('Schema'), PDFDict);
    if (schema) {
      for (const [key, value] of schema.entries()) {
        const field = ctx.lookupMaybe(value, PDFDict);
        if (!field) continue;
        const subtype = field.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() ?? 'S';
        const kind = (
          FIELD_KINDS.has(subtype as CollectionField['kind']) ? subtype : 'S'
        ) as CollectionField['kind'];
        const name = key.decodeText();
        fields.push({
          key: name,
          label: textOf(field.lookup(PDFName.of('N'))) ?? name,
          kind,
          order: field.lookupMaybe(PDFName.of('O'), PDFNumber)?.asNumber() ?? fields.length,
          visible: field.lookup(PDFName.of('V')) !== undefined ? isTrue(field, 'V') : true,
        });
      }
    }
  } catch {
    fields.length = 0;
  }
  fields.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  let folders: CollectionFolder[] = [];
  let initialFile: string | undefined;
  try {
    const root = dict.lookupMaybe(PDFName.of('Folders'), PDFDict);
    if (root) folders = readFolders(root, null, 0);
    initialFile = textOf(dict.lookup(PDFName.of('D')));
  } catch {
    folders = [];
  }
  const view = dict.lookupMaybe(PDFName.of('View'), PDFName)?.decodeText() ?? 'D';
  return {
    view: COLLECTION_VIEWS[view] ?? 'custom',
    fields,
    ...optional('initialFile', initialFile),
    folderCount: folders.length,
    ...optional('folders', folders.length > 0 ? folders : undefined),
    ...optional('sort', readSort(dict)),
    ...optional('reorderKey', dict.lookupMaybe(PDFName.of('Reorder'), PDFName)?.decodeText()),
  };
}

/**
 * `/Sort` (PDF 12.3.5): `/S` is the schema key, or an array of them when a viewer sorts on
 * several — we take the first, because one column is what a grid header can show. `/A` is the
 * direction and may be an array too; the first entry governs the first key.
 */
function readSort(dict: PDFDict): { key: string; ascending: boolean } | undefined {
  const sort = dict.lookupMaybe(PDFName.of('Sort'), PDFDict);
  if (!sort) return undefined;
  const s = sort.lookup(PDFName.of('S'));
  const key =
    s instanceof PDFName
      ? s.decodeText()
      : s instanceof PDFArray
        ? nameOf(s.asArray()[0])
        : undefined;
  if (key === undefined) return undefined;
  const a = sort.lookup(PDFName.of('A'));
  const first = a instanceof PDFArray ? a.asArray()[0] : a;
  // `/A` absent means ascending (PDF 12.3.5 table 78).
  return { key, ascending: first === undefined || String(first) !== 'false' };
}

function nameOf(value: unknown): string | undefined {
  return value instanceof PDFName ? value.decodeText() : undefined;
}

/**
 * `/Folders` is a linked tree: `/Child` is a node's first subfolder and `/Next` its next
 * sibling. This flattens it, root first, so a caller never has to walk links again (M42,
 * ADR 0014). A malformed file that links back on itself stops at the depth limit.
 */
function readFolders(node: PDFDict, parentId: number | null, depth: number): CollectionFolder[] {
  if (depth > 32) return [];
  const out: CollectionFolder[] = [];
  let current: PDFDict | undefined = node;
  const seen = new Set<PDFDict>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const id = current.lookupMaybe(PDFName.of('ID'), PDFNumber)?.asNumber() ?? out.length;
    out.push({
      id,
      name: textOf(current.lookup(PDFName.of('Name'))) ?? '',
      parentId,
      ...optional('description', textOf(current.lookup(PDFName.of('Desc')))),
      ...optional('created', pdfDate(textOf(current.lookup(PDFName.of('CreationDate'))))),
      ...optional('modified', pdfDate(textOf(current.lookup(PDFName.of('ModDate'))))),
    });
    const child = current.lookupMaybe(PDFName.of('Child'), PDFDict);
    if (child) out.push(...readFolders(child, id, depth + 1));
    current = current.lookupMaybe(PDFName.of('Next'), PDFDict);
  }
  return out;
}

/**
 * A PDF date string (`D:YYYYMMDDHHmmSSOHH'mm`) as ISO 8601, or the input when it is not one.
 * Kept here rather than imported from the adapter so this file stays parser-only.
 */
function pdfDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const m =
    /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})?)?/.exec(
      value,
    );
  if (!m) return value;
  const [
    ,
    year,
    month = '01',
    day = '01',
    hour = '00',
    minute = '00',
    second = '00',
    z,
    sign,
    oh,
    om = '00',
  ] = m;
  const zone = z === 'Z' ? 'Z' : sign === undefined ? '' : `${sign}${oh ?? '00'}:${om}`;
  return `${year ?? '0000'}-${month}-${day}T${hour}:${minute}:${second}${zone}`;
}

/** A boolean entry that may be a direct `PDFBool` or a reference to one. */
function isTrue(dict: PDFDict, key: string): boolean {
  const value = dict.lookup(PDFName.of(key));
  return String(value) === 'true';
}

/** Helper for `exactOptionalPropertyTypes`: include a key only when defined. */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

// ---- fonts (M72, ADR 0017) -------------------------------------------------------------------

/** `/Subtype` values that name a font; anything else is reported as `Unknown`. */
const FONT_TYPES = new Set<FontUsage['type']>([
  'Type1',
  'MMType1',
  'TrueType',
  'Type3',
  'Type0',
  'CIDFontType0',
  'CIDFontType2',
]);

/** ISO 32000-1 §9.6.4: a subset's `/BaseFont` is six uppercase letters, a plus, then the name. */
const SUBSET_PREFIX = /^[A-Z]{6}\+/;

/**
 * Every font the page resources name, in the order the pages name them (M72, ADR 0017).
 *
 * Resources nest: a page's `/XObject` form has its own `/Resources`, and so does a Type3 font's
 * glyph procedure, so the walk follows both to a depth limit. A font *object* seen twice — the
 * same reference from two pages, or an inherited resource dictionary — is one row; two different
 * objects with the same `/BaseFont` are two, because they are two fonts in the file whatever they
 * are called.
 */
function readFonts(doc: PDFDocument): ReadonlyArray<FontUsage> {
  const ctx = doc.context;
  const out: FontUsage[] = [];
  const seenFont = new Set<string>();
  const seenResources = new Set<string>();

  const walk = (resources: PDFDict | undefined, page: number, depth: number): void => {
    if (!resources || depth > 8) return;
    const fonts = resources.lookupMaybe(PDFName.of('Font'), PDFDict);
    if (fonts) {
      for (const [, value] of fonts.entries()) {
        const dict = ctx.lookupMaybe(value, PDFDict);
        if (!dict) continue;
        const key =
          value instanceof PDFRef ? value.toString() : `inline:${String(page)}:${dict.toString()}`;
        if (seenFont.has(key)) continue;
        seenFont.add(key);
        out.push(describeFont(ctx, dict, page));
        // A Type3 font draws its glyphs with content streams of its own, which may name fonts.
        walk(dict.lookupMaybe(PDFName.of('Resources'), PDFDict), page, depth + 1);
      }
    }
    const xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xobjects) return;
    for (const [, value] of xobjects.entries()) {
      const stream = ctx.lookup(value);
      const dict = stream instanceof PDFRawStream ? stream.dict : undefined;
      if (!dict) continue;
      const key = value instanceof PDFRef ? value.toString() : dict.toString();
      if (seenResources.has(key)) continue;
      seenResources.add(key);
      walk(dict.lookupMaybe(PDFName.of('Resources'), PDFDict), page, depth + 1);
    }
  };

  try {
    doc.getPages().forEach((page, index) => {
      walk(page.node.Resources(), index, 0);
    });
  } catch {
    // A malformed page tree gives whatever was read before it broke, which beats reporting none.
  }
  return out;
}

function describeFont(ctx: PDFDocument['context'], dict: PDFDict, page: number): FontUsage {
  const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() ?? '';
  const type = FONT_TYPES.has(subtype as FontUsage['type'])
    ? (subtype as FontUsage['type'])
    : 'Unknown';
  // `/BaseFont` names every font but a Type 3, which carries `/Name` instead — as a name in
  // some files and as a string in others, so both forms are read.
  const named = dict.lookup(PDFName.of('Name'));
  const name =
    dict.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.decodeText() ??
    nameOf(named) ??
    textOf(named) ??
    'Unnamed';

  // A Type0 font's embedding and descriptor live on its descendant, not on itself.
  let descriptorOwner: PDFDict | undefined = dict;
  let descendantType: 'CIDFontType0' | 'CIDFontType2' | undefined;
  if (type === 'Type0') {
    const descendants = dict.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray);
    const first = descendants ? ctx.lookupMaybe(descendants.get(0), PDFDict) : undefined;
    if (first) {
      descriptorOwner = first;
      const sub = first.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
      if (sub === 'CIDFontType0' || sub === 'CIDFontType2') descendantType = sub;
    }
  }
  const descriptor = descriptorOwner?.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
  const embedded =
    descriptor !== undefined &&
    ['FontFile', 'FontFile2', 'FontFile3'].some((k) => descriptor.get(PDFName.of(k)) !== undefined);

  let encoding: string | undefined;
  const enc = ctx.lookup(dict.get(PDFName.of('Encoding')));
  if (enc instanceof PDFName) encoding = enc.decodeText();
  else if (enc instanceof PDFRawStream) encoding = 'Embedded CMap';
  else if (enc instanceof PDFDict) {
    encoding = enc.lookupMaybe(PDFName.of('BaseEncoding'), PDFName)?.decodeText() ?? 'Custom';
  }

  return {
    name,
    type,
    ...optional('descendantType', descendantType),
    // A Type3 font has no descriptor and no font file: its glyphs *are* the content streams it
    // carries, so it is embedded by construction.
    embedded: embedded || type === 'Type3',
    subset: SUBSET_PREFIX.test(name),
    ...optional('encoding', encoding),
    toUnicode: dict.get(PDFName.of('ToUnicode')) !== undefined,
    firstPage: page,
  };
}

// ---- initial view and the rest of the information dictionary (M72, ADR 0017) -----------------

const PAGE_MODES: Readonly<Record<string, InitialView['pageMode']>> = {
  UseNone: 'none',
  UseOutlines: 'outlines',
  UseThumbs: 'thumbnails',
  FullScreen: 'fullscreen',
  UseAttachments: 'attachments',
  UseOC: 'ocg',
};

const PAGE_LAYOUTS: Readonly<Record<string, InitialView['pageLayout']>> = {
  SinglePage: 'single',
  OneColumn: 'one-column',
  TwoColumnLeft: 'two-column-left',
  TwoColumnRight: 'two-column-right',
  TwoPageLeft: 'two-page-left',
  TwoPageRight: 'two-page-right',
};

/** `/PageMode`, `/PageLayout`, `/OpenAction` and `/ViewerPreferences`. Never throws. */
function readInitialView(doc: PDFDocument): InitialView {
  try {
    const catalog = doc.catalog;
    const prefs = catalog.lookupMaybe(PDFName.of('ViewerPreferences'), PDFDict);
    const flag = (key: string): boolean => (prefs ? isTrue(prefs, key) : false);
    const scaling = prefs?.lookupMaybe(PDFName.of('PrintScaling'), PDFName)?.decodeText();
    const direction = prefs?.lookupMaybe(PDFName.of('Direction'), PDFName)?.decodeText();
    return {
      pageMode:
        PAGE_MODES[catalog.lookupMaybe(PDFName.of('PageMode'), PDFName)?.decodeText() ?? ''] ??
        'none',
      pageLayout:
        PAGE_LAYOUTS[catalog.lookupMaybe(PDFName.of('PageLayout'), PDFName)?.decodeText() ?? ''] ??
        'default',
      ...optional('openAction', readOpenAction(doc)),
      hideToolbar: flag('HideToolbar'),
      hideMenubar: flag('HideMenubar'),
      hideWindowUi: flag('HideWindowUI'),
      fitWindow: flag('FitWindow'),
      centreWindow: flag('CenterWindow'),
      displayDocTitle: flag('DisplayDocTitle'),
      printScaling: scaling === 'None' ? 'none' : 'app-default',
      direction: direction === 'R2L' ? 'r2l' : 'l2r',
    };
  } catch {
    return DEFAULT_INITIAL_VIEW;
  }
}

/**
 * `/OpenAction` as a destination.
 *
 * It may be the destination array itself, a `/GoTo` action holding one, or a name that has to be
 * looked up in `/Dests`. Anything else — a JavaScript action, a `/Named` action — is not a place
 * in the document, so there is nothing to report and the entry is left out.
 */
function readOpenAction(doc: PDFDocument): Destination | undefined {
  const ctx = doc.context;
  const value = ctx.lookup(doc.catalog.get(PDFName.of('OpenAction')));
  let dest: unknown = value;
  if (value instanceof PDFDict) {
    const action = value.lookupMaybe(PDFName.of('S'), PDFName)?.decodeText();
    if (action !== 'GoTo') return undefined;
    dest = ctx.lookup(value.get(PDFName.of('D')));
  }
  if (dest instanceof PDFString || dest instanceof PDFHexString || dest instanceof PDFName) {
    dest = lookupNamedDestination(doc, textOf(dest) ?? nameOf(dest) ?? '');
  }
  return dest instanceof PDFArray ? destinationFromArray(doc, dest) : undefined;
}

/** Finds a named destination in `/Names /Dests` or the older `/Dests` dictionary. */
function lookupNamedDestination(doc: PDFDocument, name: string): PDFArray | undefined {
  if (!name) return undefined;
  const ctx = doc.context;
  const asArray = (value: PDFObject | undefined): PDFArray | undefined => {
    const resolved: unknown = ctx.lookup(value);
    // A destination may be wrapped in `<< /D [...] >>`.
    if (resolved instanceof PDFDict) {
      const inner: unknown = ctx.lookup(resolved.get(PDFName.of('D')));
      return inner instanceof PDFArray ? inner : undefined;
    }
    return resolved instanceof PDFArray ? resolved : undefined;
  };
  const legacy = doc.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict);
  if (legacy) {
    const hit = legacy.get(PDFName.of(name));
    if (hit !== undefined) return asArray(hit);
  }
  const root = doc.catalog
    .lookupMaybe(PDFName.of('Names'), PDFDict)
    ?.lookupMaybe(PDFName.of('Dests'), PDFDict);
  const walk = (node: PDFDict | undefined, depth: number): PDFArray | undefined => {
    if (!node || depth > 32) return undefined;
    const names = node.lookupMaybe(PDFName.of('Names'), PDFArray)?.asArray() ?? [];
    for (let i = 1; i < names.length; i += 2) {
      if (textOf(names[i - 1]) === name) return asArray(names[i]);
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (!kids) return undefined;
    for (const kid of kids.asArray()) {
      const hit = walk(ctx.lookupMaybe(kid, PDFDict), depth + 1);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(root, 0);
}

/** `[page /XYZ left top zoom]` to a {@link Destination}. A null entry means "leave as it was". */
function destinationFromArray(doc: PDFDocument, array: PDFArray): Destination | undefined {
  const items = array.asArray();
  const target = items[0];
  let page = -1;
  if (target instanceof PDFNumber) page = target.asNumber();
  else if (target instanceof PDFRef) {
    page = doc.getPages().findIndex((p) => p.ref.toString() === target.toString());
  }
  if (page < 0) return undefined;
  const fit = nameOf(items[1]) ?? 'XYZ';
  const n = (index: number): number | undefined => {
    const value = items[index];
    return value instanceof PDFNumber ? value.asNumber() : undefined;
  };
  switch (fit) {
    case 'Fit':
      return { page, fit: 'fit' };
    case 'FitB':
      return { page, fit: 'fitB' };
    case 'FitH':
      return { page, fit: 'fitH', ...optional('top', n(2)) };
    case 'FitBH':
      return { page, fit: 'fitBH', ...optional('top', n(2)) };
    case 'FitV':
      return { page, fit: 'fitV', ...optional('left', n(2)) };
    case 'FitBV':
      return { page, fit: 'fitBV', ...optional('left', n(2)) };
    case 'FitR': {
      const [x0, y0, x1, y1] = [n(2), n(3), n(4), n(5)];
      if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) {
        return { page, fit: 'fitR' };
      }
      return {
        page,
        fit: 'fitR',
        rect: {
          x0: Math.min(x0, x1),
          y0: Math.min(y0, y1),
          x1: Math.max(x0, x1),
          y1: Math.max(y0, y1),
        },
      };
    }
    default: {
      const zoom = n(4);
      return {
        page,
        fit: 'xyz',
        ...optional('left', n(2)),
        ...optional('top', n(3)),
        // A zoom of 0 is the PDF way of saying "keep the current one", same as null.
        ...optional('zoom', zoom === 0 ? undefined : zoom),
      };
    }
  }
}

/** Information-dictionary keys read elsewhere; everything else is a custom property. */
const STANDARD_INFO_KEYS = new Set([
  'Title',
  'Author',
  'Subject',
  'Keywords',
  'Creator',
  'Producer',
  'CreationDate',
  'ModDate',
  'Trapped',
]);

/** Custom Info entries, `/Trapped`, `/Lang` and the base URL (M72, ADR 0017). Never throws. */
function readDocumentInfo(doc: PDFDocument): RawInfo['documentInfo'] {
  const ctx = doc.context;
  const custom: Record<string, string> = {};
  let trapped: 'True' | 'False' | 'Unknown' | undefined;
  try {
    const info = ctx.lookupMaybe(ctx.trailerInfo.Info, PDFDict);
    if (info) {
      for (const [key, value] of info.entries()) {
        const name = key.decodeText();
        const resolved = ctx.lookup(value);
        if (name === 'Trapped') {
          const word = nameOf(resolved) ?? textOf(resolved);
          if (word === 'True' || word === 'False' || word === 'Unknown') trapped = word;
          continue;
        }
        if (STANDARD_INFO_KEYS.has(name)) continue;
        const text =
          textOf(resolved) ??
          (resolved instanceof PDFNumber
            ? String(resolved.asNumber())
            : resolved instanceof PDFName
              ? resolved.decodeText()
              : undefined);
        if (text !== undefined) custom[name] = text;
      }
    }
  } catch {
    // A damaged Info dictionary reports nothing rather than failing the whole read.
  }
  let lang: string | undefined;
  let baseUrl: string | undefined;
  try {
    lang = textOf(doc.catalog.lookup(PDFName.of('Lang')));
    const uri = doc.catalog.lookupMaybe(PDFName.of('URI'), PDFDict);
    baseUrl = uri ? textOf(uri.lookup(PDFName.of('Base'))) : undefined;
  } catch {
    lang = undefined;
  }
  return {
    ...optional(
      'custom',
      Object.keys(custom).length > 0 ? (custom as Readonly<Record<string, string>>) : undefined,
    ),
    ...optional('trapped', trapped),
    ...optional('lang', lang),
    ...optional('baseUrl', baseUrl),
  };
}
