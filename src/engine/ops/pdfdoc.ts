/**
 * The pdf-lib odd jobs every op in this folder needs (M41): loading with the same options and
 * the same worded failures, finding page leaves, reading and writing the five page boxes, and
 * reading a document's outline as a flat list.
 *
 * Kept here rather than repeated per op because "what does `/CropBox` fall back to" has to have
 * exactly one answer across combine, split, crop and deskew, and because a document that fails
 * to load should say the same sentence whichever op was asked for.
 */

import type { PDFPageLeaf } from 'pdf-lib';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  ParseSpeeds,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib';
import type { PageBoxName, PdfRect } from '@shared/pdf';
import { normalizeRect } from '@shared/pdf';
import { OpFailed, type BoxPatch } from './types';

/** `/MediaBox` and friends, by the name the model uses. */
export const BOX_KEYS: Readonly<Record<PageBoxName, string>> = {
  media: 'MediaBox',
  crop: 'CropBox',
  bleed: 'BleedBox',
  trim: 'TrimBox',
  art: 'ArtBox',
};

/** US Letter, which is what a PDF reader falls back to when a page has no usable MediaBox. */
export const FALLBACK_BOX: PdfRect = { x0: 0, y0: 0, x1: 612, y1: 792 };

/**
 * Loads bytes with the options every op wants, turning pdf-lib's exceptions into one worded
 * {@link OpFailed}.
 *
 * `ignoreEncryption` is false on purpose: rewriting an encrypted document would produce a file
 * whose strings are plaintext under a trailer that still claims encryption. The caller decrypts
 * first (the engine's `save({ removeSecurity: true })` does it) or gets told why not.
 */
export async function loadPdf(bytes: Uint8Array, what: string): Promise<PDFDocument> {
  try {
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
      throwOnInvalidObject: false,
      parseSpeed: ParseSpeeds.Fastest,
    });
    // pdf-lib is lazy about the catalogue, so a file damaged past its page tree loads happily
    // and only falls over later, deep inside whichever op asked first. Walking the tree here
    // means "could not be read" is said once, in words, by the thing that did the reading.
    doc.getPageCount();
    return doc;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/encrypt/i.test(message)) {
      throw new OpFailed(`${what} is password-protected, so it cannot be read here`);
    }
    throw new OpFailed(`${what} could not be read: ${message}`);
  }
}

/** A new, empty document with the app's producer strings already on it. */
export async function createPdf(): Promise<PDFDocument> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setProducer('ynotPDF');
  doc.setCreator('ynotPDF');
  return doc;
}

/** Serialises without pdf-lib's helpful extras — no default page, no field-appearance rebuild. */
export function savePdf(doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({ addDefaultPage: false, updateFieldAppearances: false });
}

/** The page leaves of a document in page order, with their refs. */
export function pageLeaves(doc: PDFDocument): Array<{ leaf: PDFPageLeaf; ref: PDFRef }> {
  return doc.getPages().map((page) => ({ leaf: page.node, ref: page.ref }));
}

/** Reads a rectangle-valued entry, following the page tree's inheritance for the two that have it. */
export function readBox(leaf: PDFPageLeaf, box: PageBoxName): PdfRect | null {
  const key = PDFName.of(BOX_KEYS[box]);
  // MediaBox and CropBox are inheritable (PDF 7.7.3.4); the other three are not.
  const raw = box === 'media' || box === 'crop' ? leaf.getInheritableAttribute(key) : leaf.get(key);
  const array = leaf.context.lookupMaybe(raw, PDFArray);
  if (!array || array.size() < 4) return null;
  const at = (i: number): number => {
    const value = leaf.context.lookupMaybe(array.get(i), PDFNumber);
    return value ? value.asNumber() : Number.NaN;
  };
  const rect = normalizeRect({ x0: at(0), y0: at(1), x1: at(2), y1: at(3) });
  if (![rect.x0, rect.y0, rect.x1, rect.y1].every((n) => Number.isFinite(n))) return null;
  return rect.x1 - rect.x0 > 0 && rect.y1 - rect.y0 > 0 ? rect : null;
}

/** The box a name means with the spec's fallbacks applied: Trim/Bleed/Art fall back to Crop. */
export function effectiveBox(leaf: PDFPageLeaf, box: PageBoxName): PdfRect {
  const media = readBox(leaf, 'media') ?? FALLBACK_BOX;
  if (box === 'media') return media;
  const crop = readBox(leaf, 'crop') ?? media;
  if (box === 'crop') return crop;
  return readBox(leaf, box) ?? crop;
}

/** Writes some of a page's boxes. `null` removes the entry; `undefined` leaves it alone. */
export function writeBoxes(leaf: PDFPageLeaf, patch: BoxPatch): void {
  for (const name of Object.keys(BOX_KEYS) as PageBoxName[]) {
    const value = patch[name];
    if (value === undefined) continue;
    const key = PDFName.of(BOX_KEYS[name]);
    if (value === null) leaf.delete(key);
    else leaf.set(key, rectArray(leaf.context, value));
  }
}

export function rectArray(ctx: PDFContext, r: PdfRect): PDFArray {
  return ctx.obj([r.x0, r.y0, r.x1, r.y1]);
}

/** `/Rotate`, normalised to 0/90/180/270 clockwise. */
export function readRotation(leaf: PDFPageLeaf): number {
  const raw = leaf.context.lookupMaybe(
    leaf.getInheritableAttribute(PDFName.of('Rotate')),
    PDFNumber,
  );
  const degrees = raw ? raw.asNumber() : 0;
  return (((Math.round(degrees / 90) % 4) + 4) % 4) * 90;
}

/** One bookmark of a document, flattened. `parent` indexes this same list; `null` at the top. */
export interface FlatBookmark {
  readonly title: string;
  /** 0-based page in the document it came from, or `null` when it points nowhere we can follow. */
  readonly page: number | null;
  readonly parent: number | null;
  readonly bold: boolean;
  readonly italic: boolean;
  /** `0xRRGGBB`, or `null`. */
  readonly color: number | null;
  /** Whether the item was stored open (`/Count` positive). */
  readonly open: boolean;
}

/**
 * Reads `/Outlines` as a flat list, depth-first, resolving each item's destination to a page
 * index of *this* document.
 *
 * Both spellings are followed: `/Dest` (an array, a name or a string into `/Dests`) and
 * `/A` with `/S /GoTo`. An item whose destination is a named one we cannot resolve keeps its
 * title with `page: null` — a heading with no destination is still a heading, and dropping it
 * would silently lose everything nested under it.
 */
export function readOutline(doc: PDFDocument): FlatBookmark[] {
  const ctx = doc.context;
  const root = ctx.lookupMaybe(doc.catalog.get(PDFName.of('Outlines')), PDFDict);
  if (!root) return [];
  const pageIndexOf = new Map<string, number>();
  doc.getPages().forEach((page, i) => pageIndexOf.set(page.ref.toString(), i));
  const named = readNameTreeDests(doc);

  const out: FlatBookmark[] = [];
  const seen = new Set<PDFDict>();

  const destPage = (item: PDFDict): number | null => {
    const direct = item.get(PDFName.of('Dest'));
    const resolved = resolveDest(ctx, direct, named);
    if (resolved !== null) return pageOf(resolved);
    const action = ctx.lookupMaybe(item.get(PDFName.of('A')), PDFDict);
    if (!action) return null;
    if (ctx.lookupMaybe(action.get(PDFName.of('S')), PDFName)?.asString() !== '/GoTo') {
      return null;
    }
    const viaAction = resolveDest(ctx, action.get(PDFName.of('D')), named);
    return viaAction === null ? null : pageOf(viaAction);
  };

  const pageOf = (dest: PDFArray): number | null => {
    const first = dest.get(0);
    if (first instanceof PDFRef) return pageIndexOf.get(first.toString()) ?? null;
    const number = ctx.lookupMaybe(first, PDFNumber);
    return number ? number.asNumber() : null;
  };

  const walk = (firstRaw: PDFObject | undefined, parent: number | null, depth: number): void => {
    if (depth > 32) return;
    let node = ctx.lookupMaybe(firstRaw, PDFDict);
    let guard = 0;
    while (node && guard++ < 8192) {
      if (seen.has(node)) break;
      seen.add(node);
      const title = readText(ctx, node.get(PDFName.of('Title')));
      const flags = ctx.lookupMaybe(node.get(PDFName.of('F')), PDFNumber);
      const bits = flags ? flags.asNumber() : 0;
      const count = ctx.lookupMaybe(node.get(PDFName.of('Count')), PDFNumber);
      const index = out.length;
      out.push({
        title,
        page: destPage(node),
        parent,
        italic: (bits & 1) !== 0,
        bold: (bits & 2) !== 0,
        color: readColor(ctx, node.get(PDFName.of('C'))),
        open: count ? count.asNumber() > 0 : false,
      });
      walk(node.get(PDFName.of('First')), index, depth + 1);
      node = ctx.lookupMaybe(node.get(PDFName.of('Next')), PDFDict);
    }
  };

  walk(root.get(PDFName.of('First')), null, 0);
  return out;
}

/** Named destinations from `/Names /Dests` and the older `/Dests` dictionary, as arrays. */
function readNameTreeDests(doc: PDFDocument): Map<string, PDFArray> {
  const ctx = doc.context;
  const out = new Map<string, PDFArray>();
  const put = (name: string, value: PDFObject | undefined): void => {
    const array = destArray(ctx, value);
    if (array && !out.has(name)) out.set(name, array);
  };

  const legacy = ctx.lookupMaybe(doc.catalog.get(PDFName.of('Dests')), PDFDict);
  if (legacy) {
    for (const [key, value] of legacy.entries()) put(key.asString().replace(/^\//, ''), value);
  }

  const names = ctx.lookupMaybe(doc.catalog.get(PDFName.of('Names')), PDFDict);
  const dests = names ? ctx.lookupMaybe(names.get(PDFName.of('Dests')), PDFDict) : undefined;
  if (!dests) return out;

  const visit = (node: PDFDict, depth: number): void => {
    if (depth > 32) return;
    const pairs = ctx.lookupMaybe(node.get(PDFName.of('Names')), PDFArray);
    if (pairs) {
      for (let i = 0; i + 1 < pairs.size(); i += 2) {
        const key = pairs.get(i);
        const name =
          key instanceof PDFString || key instanceof PDFHexString ? key.decodeText() : null;
        if (name !== null) put(name, pairs.get(i + 1));
      }
    }
    const kids = ctx.lookupMaybe(node.get(PDFName.of('Kids')), PDFArray);
    if (!kids) return;
    for (let i = 0; i < kids.size(); i++) {
      const kid = ctx.lookupMaybe(kids.get(i), PDFDict);
      if (kid) visit(kid, depth + 1);
    }
  };
  visit(dests, 0);
  return out;
}

/** A destination value that may be the array itself or a `/D` wrapper around it. */
function destArray(ctx: PDFContext, value: PDFObject | undefined): PDFArray | null {
  const array = ctx.lookupMaybe(value, PDFArray);
  if (array) return array;
  const dict = ctx.lookupMaybe(value, PDFDict);
  if (!dict) return null;
  return ctx.lookupMaybe(dict.get(PDFName.of('D')), PDFArray) ?? null;
}

/** Resolves `/Dest` in any of its three spellings to the destination array. */
function resolveDest(
  ctx: PDFContext,
  value: PDFObject | undefined,
  named: ReadonlyMap<string, PDFArray>,
): PDFArray | null {
  if (value === undefined) return null;
  const direct = destArray(ctx, value);
  if (direct) return direct;
  const asName = ctx.lookupMaybe(value, PDFName);
  if (asName) return named.get(asName.asString().replace(/^\//, '')) ?? null;
  const raw = value instanceof PDFRef ? ctx.lookup(value) : value;
  if (raw instanceof PDFString || raw instanceof PDFHexString) {
    return named.get(raw.decodeText()) ?? null;
  }
  return null;
}

/** A `/Title`-style text string, whichever encoding it used. */
export function readText(ctx: PDFContext, value: PDFObject | undefined): string {
  const raw = value instanceof PDFRef ? ctx.lookup(value) : value;
  if (raw instanceof PDFString || raw instanceof PDFHexString) return raw.decodeText();
  return '';
}

/** A three-number colour array as `0xRRGGBB`. */
function readColor(ctx: PDFContext, value: PDFObject | undefined): number | null {
  const array = ctx.lookupMaybe(value, PDFArray);
  if (!array || array.size() < 3) return null;
  const channel = (i: number): number => {
    const n = ctx.lookupMaybe(array.get(i), PDFNumber);
    const v = n ? n.asNumber() : 0;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  return (channel(0) << 16) | (channel(1) << 8) | channel(2);
}
