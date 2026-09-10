/**
 * The font half of optimising (M100): cut embedded fonts down to what the document draws, and
 * take out the ones the reader is certain to have already.
 *
 * Two operations, and both of them are conservative by construction:
 *
 * - **Subsetting** empties the outlines of glyphs nothing can reach. What "can reach" means
 *   depends on the kind of font: a composite font is asked which CIDs the content streams
 *   actually show, and a simple font — which can address only 256 codes at all — is asked which
 *   glyphs its own `cmap` can produce for those. Glyph numbering never changes (`sfnt.ts` says
 *   why), so no encoding, no `/Widths` and no `/CIDToGIDMap` needs touching.
 * - **Unembedding** removes the font program of a Standard-14 font or one metrically identical
 *   to it (`standard.ts`), and nothing else.
 *
 * A font this file cannot cut — CFF, Type 1, Type 3, a `loca` that disagrees with `maxp` — is
 * left exactly as it was and named in the report.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFContext,
  type PDFDocument,
} from 'pdf-lib';
import { pick } from '../../ops/pdfdoc';
import { checkCancelled, type FontOptions, type OptimiseContext } from '../types';
import { collectFontUsage, type UsageMap } from './usage';
import { glyphsReachableByCmap, isTrueTypeOutlines, readSfnt, subsetFont } from './sfnt';
import { isSafeToUnembed, stripSubsetPrefix } from './standard';

export interface FontOutcome {
  readonly subsetted: number;
  readonly unembedded: number;
  readonly saved: number;
  readonly warnings: ReadonlyArray<string>;
}

/** The three descriptor keys a font program can hang off (ISO 32000-1 table 122). */
const PROGRAM_KEYS = ['FontFile', 'FontFile2', 'FontFile3'] as const;

export async function optimiseFonts(
  doc: PDFDocument,
  options: FontOptions,
  ctx: OptimiseContext = {},
): Promise<FontOutcome> {
  if (!options.subset && !options.unembedStandard) {
    return { subsetted: 0, unembedded: 0, saved: 0, warnings: [] };
  }
  const usage = options.subset ? collectFontUsage(doc) : new Map();
  const warnings = new Set<string>();
  let subsetted = 0;
  let unembedded = 0;
  let saved = 0;

  const fonts = [...doc.context.enumerateIndirectObjects()].filter(([, object]) =>
    isFontDict(doc.context, object),
  );
  let done = 0;
  for (const [ref, object] of fonts) {
    checkCancelled(ctx.signal);
    ctx.progress?.(fonts.length > 0 ? done / fonts.length : null, 'Optimising fonts');
    done++;
    const dict = object as PDFDict;

    if (options.unembedStandard) {
      const removed = tryUnembed(doc, dict, warnings);
      if (removed > 0) {
        unembedded++;
        saved += removed;
        continue;
      }
    }
    if (options.subset) {
      const cut = trySubset(doc, ref, dict, usage, warnings);
      if (cut > 0) {
        subsetted++;
        saved += cut;
      }
    }
    if (done % 8 === 0) await Promise.resolve();
  }
  return { subsetted, unembedded, saved, warnings: [...warnings] };
}

// ---- unembedding ---------------------------------------------------------------------------------

/** Bytes freed, or 0 when this font kept its program. */
function tryUnembed(doc: PDFDocument, dict: PDFDict, warnings: Set<string>): number {
  const baseFont = pick(doc.context, dict.get(PDFName.of('BaseFont')), PDFName)?.asString();
  if (baseFont === undefined) return 0;
  const name = stripSubsetPrefix(baseFont);
  const descriptor = descriptorOf(doc.context, dict);
  if (!descriptor) return 0;
  if (!hasProgram(doc.context, descriptor)) return 0;

  if (!isSafeToUnembed(name)) return 0;
  // A subset carries only some of the family's glyphs, and the substitute carries all of them —
  // so unembedding a *subset* of a standard face is still safe, and unembedding a subset of
  // anything else is exactly the case `isSafeToUnembed` refuses.
  const freed = removeProgram(doc, descriptor);
  if (freed > 0) {
    warnings.add(
      `“${name}” is no longer embedded: it is one of the fonts every PDF reader is required to have, ` +
        'so the text will look the same, but a reader with an unusual font setup may space it differently.',
    );
  }
  return freed;
}

function hasProgram(ctx: PDFContext, descriptor: PDFDict): boolean {
  return PROGRAM_KEYS.some((key) => descriptor.get(PDFName.of(key)) !== undefined);
}

function removeProgram(doc: PDFDocument, descriptor: PDFDict): number {
  let freed = 0;
  for (const key of PROGRAM_KEYS) {
    const entry = descriptor.get(PDFName.of(key));
    if (entry === undefined) continue;
    const stream = pick(doc.context, entry, PDFStream);
    if (stream) freed += stream.getContentsSize();
    descriptor.delete(PDFName.of(key));
    // The object itself is left for qpdf's `--remove-unreferenced-resources` to sweep up; deleting
    // it here would break any other descriptor that shares it, and shared programs do happen.
  }
  return freed;
}

// ---- subsetting ----------------------------------------------------------------------------------

function trySubset(
  doc: PDFDocument,
  ref: PDFRef,
  dict: PDFDict,
  usage: UsageMap,
  warnings: Set<string>,
): number {
  const subtype = pick(doc.context, dict.get(PDFName.of('Subtype')), PDFName)?.asString();
  if (subtype === '/Type3') return 0;

  const descriptor = descriptorOf(doc.context, dict);
  if (!descriptor) return 0;
  const programRef = descriptor.get(PDFName.of('FontFile2'));
  if (!(programRef instanceof PDFRef)) {
    if (hasProgram(doc.context, descriptor)) {
      const name =
        pick(doc.context, dict.get(PDFName.of('BaseFont')), PDFName)?.asString() ?? 'A font';
      warnings.add(
        `${stripSubsetPrefix(name)} was left at its full size: it is a PostScript-outline font, and ` +
          'cutting one down safely needs a different kind of surgery than ynotPDF performs.',
      );
    }
    return 0;
  }
  const program = pick(doc.context, programRef, PDFStream);
  if (!program) return 0;

  const bytes = contentsOf(program);
  if (!bytes) return 0;
  const font = readSfnt(bytes);
  if (!font || !isTrueTypeOutlines(font)) return 0;

  const keep = glyphsToKeep(doc, ref, dict, subtype, font, usage);
  if (!keep) return 0;

  const cut = subsetFont(bytes, keep);
  if (!cut || cut.length >= bytes.length) return 0;

  const newDict = program.dict.clone(doc.context);
  newDict.set(PDFName.of('Length'), PDFNumber.of(cut.length));
  newDict.set(PDFName.of('Length1'), PDFNumber.of(cut.length));
  newDict.delete(PDFName.of('Filter'));
  newDict.delete(PDFName.of('DecodeParms'));
  doc.context.assign(programRef, PDFRawStream.of(newDict, cut));
  return bytes.length - cut.length;
}

/**
 * The glyphs this font must keep, or `null` when we cannot say and it must keep all of them.
 *
 * The two kinds are genuinely different questions:
 *
 * - **Composite** (`/Type0`): a code in the content stream is a CID, and a CID becomes a glyph
 *   through `/CIDToGIDMap` — the identity for almost every file, or a stream of 16-bit entries.
 *   So the used CIDs map straight onto used glyphs.
 * - **Simple**: a code is one byte, so the font can be asked for at most 256 glyphs however the
 *   encoding is arranged. Rather than untangle `/Encoding`, `/Differences`, a symbolic `(3,0)`
 *   `cmap` and the `F0xx` convention — where a mistake silently swaps letters — every glyph any
 *   of the 256 codes can reach through any of the font's `cmap` subtables is kept. That is a
 *   superset of what the document uses and a tiny fraction of a large font.
 */
function glyphsToKeep(
  doc: PDFDocument,
  ref: PDFRef,
  dict: PDFDict,
  subtype: string | undefined,
  font: ReturnType<typeof readSfnt>,
  usage: UsageMap,
): Set<number> | null {
  if (!font) return null;
  if (subtype !== '/Type0') {
    const codes: number[] = [];
    for (let c = 0; c < 256; c++) codes.push(c);
    // The high plane the "symbolic" convention uses: a (3,0) cmap maps 0xF000 + code.
    for (let c = 0; c < 256; c++) codes.push(0xf000 + c);
    return glyphsReachableByCmap(font, codes);
  }

  const used = usage.get(ref.toString());
  if (!used || used.keepEverything) return null;
  // A composite font showing nothing at all is either unused or drawn by something we could not
  // read; either way, leave it alone rather than empty it.
  if (used.codes.size === 0) return null;

  const descendant = descendantOf(doc.context, dict);
  const map = descendant ? cidToGid(doc.context, descendant) : null;
  const keep = new Set<number>([0]);
  for (const cid of used.codes) keep.add(map ? (map[cid] ?? 0) : cid);
  return keep;
}

/** `/CIDToGIDMap` as a lookup table, or `null` for the identity (`/Identity` or absent). */
function cidToGid(ctx: PDFContext, descendant: PDFDict): Uint16Array | null {
  const entry = descendant.get(PDFName.of('CIDToGIDMap'));
  if (entry === undefined) return null;
  // A name there is `/Identity` in every file anyone writes, and any other name is undefined by
  // the spec — both mean "CID is the glyph", which is what a null table stands for.
  if (pick(ctx, entry, PDFName) !== null) return null;
  const stream = pick(ctx, entry, PDFStream);
  if (!stream) return null;
  const bytes = contentsOf(stream);
  if (!bytes) return null;
  const out = new Uint16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = ((bytes[i * 2] ?? 0) << 8) | (bytes[i * 2 + 1] ?? 0);
  }
  return out;
}

// ---- odds and ends ---------------------------------------------------------------------------------

function isFontDict(ctx: PDFContext, object: unknown): boolean {
  if (!(object instanceof PDFDict)) return false;
  return pick(ctx, object.get(PDFName.of('Type')), PDFName)?.asString() === '/Font';
}

/** A font's descriptor, following the `/DescendantFonts` hop that a composite font makes. */
function descriptorOf(ctx: PDFContext, dict: PDFDict): PDFDict | null {
  const own = pick(ctx, dict.get(PDFName.of('FontDescriptor')), PDFDict);
  if (own) return own;
  const descendant = descendantOf(ctx, dict);
  return descendant ? pick(ctx, descendant.get(PDFName.of('FontDescriptor')), PDFDict) : null;
}

function descendantOf(ctx: PDFContext, dict: PDFDict): PDFDict | null {
  const array = pick(ctx, dict.get(PDFName.of('DescendantFonts')), PDFArray);
  if (!array || array.size() === 0) return null;
  return pick(ctx, array.get(0), PDFDict);
}

function contentsOf(stream: PDFStream): Uint8Array | null {
  try {
    return stream instanceof PDFRawStream
      ? decodePDFRawStream(stream).decode()
      : stream.getContents();
  } catch {
    return null;
  }
}
