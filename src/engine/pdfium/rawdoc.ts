/**
 * Reads the few catalogue facts PDFium's public API does not expose (M10): optional-content
 * groups (layers) and the raw XMP packet. Uses pdf-lib's object parser, read-only. For
 * encrypted files the caller passes bytes already decrypted by PDFium (`FPDF_SaveAsCopy` with
 * `FPDF_REMOVE_SECURITY`), because pdf-lib does not decrypt strings.
 */

import {
  PDFArray,
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
import type { CollectionField, Layer, PdfCollection } from '../PdfEngine';

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
  }>;
  /** The catalogue's `/Collection`: the file is a PDF Portfolio (ADR 0011). */
  readonly collection: PdfCollection | null;
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

  // ---- XMP -----------------------------------------------------------------------------------
  let xmp = scanXmp(bytes);
  if (xmp === undefined) {
    try {
      const meta = catalog.lookup(PDFName.of('Metadata'));
      if (meta instanceof PDFRawStream) {
        xmp = new TextDecoder('utf-8').decode(decodePDFRawStream(meta).decode());
      }
    } catch {
      xmp = undefined;
    }
  }

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
  const embeddedFiles: Array<{ description?: string; mimeType?: string }> = [];
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
          if (text !== undefined) fields[key.decodeText()] = text;
        }
      }
      embeddedFiles.push({
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
  let folderCount: number;
  let initialFile: string | undefined;
  try {
    const folders = dict.lookupMaybe(PDFName.of('Folders'), PDFDict);
    folderCount = folders ? 1 + countFolders(ctx, folders, 0) : 0;
    initialFile = textOf(dict.lookup(PDFName.of('D')));
  } catch {
    folderCount = 0;
  }
  const view = dict.lookupMaybe(PDFName.of('View'), PDFName)?.decodeText() ?? 'D';
  return {
    view: COLLECTION_VIEWS[view] ?? 'custom',
    fields,
    ...optional('initialFile', initialFile),
    folderCount,
  };
}

/** `/Folders` is a linked tree of `/Child` and `/Next` nodes; we only need how many there are. */
function countFolders(ctx: PDFDocument['context'], node: PDFDict, depth: number): number {
  if (depth > 32) return 0;
  let n = 0;
  for (const key of ['Child', 'Next'] as const) {
    const next = node.lookupMaybe(PDFName.of(key), PDFDict);
    if (next) n += 1 + countFolders(ctx, next, depth + 1);
  }
  return n;
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
