/**
 * The image half of optimising (M100): downsample, recompress, and know when to leave well alone.
 *
 * One pass over every image XObject in the document. For each, the questions are always the same
 * — what class is it, how big is it drawn, can we read its samples at all, and does re-encoding it
 * actually make it smaller — and an image that fails any of them keeps exactly the bytes it had.
 * That last rule is the important one: an optimiser that silently damages a picture is worse than
 * one that saves nothing, so every bail-out here is a `continue`, not a throw.
 *
 * Soft masks (`/SMask`) are optimised in step with the image they belong to: an 8-bit alpha
 * channel at 1200 dpi behind a 150 dpi photograph is a surprisingly common way to waste a
 * megabyte, and downsampling one without the other would leave the mask and the image
 * disagreeing about where the edges are.
 */

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFHexString,
  decodePDFRawStream,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
} from 'pdf-lib';
import { pick } from '../../ops/pdfdoc';
import { checkCancelled, type ImageClass, type ImageOptions, type OptimiseContext } from '../types';
import {
  deflate,
  decodeJpeg,
  encodeJpeg,
  packMono,
  undoPredictor,
  unpack,
  type Samples,
} from './codecs';
import { encodeGroup4 } from './ccitt';
import { resample, targetSize } from './resample';
import { findPlacements, type Placements } from './placement';

export interface ImageOutcome {
  /** How many images were rewritten. */
  readonly changed: number;
  /** How many were downsampled (a subset of `changed`). */
  readonly downsampled: number;
  /** How many were re-encoded without a size change (also a subset). */
  readonly recompressed: number;
  readonly saved: number;
  readonly warnings: ReadonlyArray<string>;
}

/** Filters whose samples we can get at. Anything else is left as it is. */
const READABLE = new Set([
  'FlateDecode',
  'LZWDecode',
  'ASCII85Decode',
  'ASCIIHexDecode',
  'RunLengthDecode',
]);

export async function optimiseImages(
  doc: PDFDocument,
  options: ImageOptions,
  ctx: OptimiseContext = {},
): Promise<ImageOutcome> {
  const placements = findPlacements(doc);
  const warnings = new Set<string>();
  let changed = 0;
  let downsampled = 0;
  let recompressed = 0;
  let saved = 0;

  const images = [...doc.context.enumerateIndirectObjects()].filter(([, object]) =>
    isImage(doc.context, object),
  );
  // Soft masks are dealt with by the image that owns them, so they must not also be visited on
  // their own — the second visit would downsample an already-downsampled mask.
  const masks = new Set<string>();
  for (const [, object] of images) {
    const stream = object as PDFStream;
    for (const key of ['SMask', 'Mask']) {
      const entry = stream.dict.get(PDFName.of(key));
      if (entry instanceof PDFRef) masks.add(entry.toString());
    }
  }

  let done = 0;
  for (const [ref, object] of images) {
    checkCancelled(ctx.signal);
    ctx.progress?.(images.length > 0 ? done / images.length : null, 'Optimising images');
    done++;
    if (masks.has(ref.toString())) continue;

    const result = optimiseOne(doc, ref, object as PDFStream, options, placements, warnings);
    if (!result) continue;
    changed += result.changed;
    downsampled += result.downsampled;
    recompressed += result.recompressed;
    saved += result.saved;
    // A yield per image keeps a worker answering `cancel` on a document full of photographs.
    if (done % 8 === 0) await Promise.resolve();
  }

  return { changed, downsampled, recompressed, saved, warnings: [...warnings] };
}

interface OneOutcome {
  changed: number;
  downsampled: number;
  recompressed: number;
  saved: number;
}

function optimiseOne(
  doc: PDFDocument,
  ref: PDFRef,
  stream: PDFStream,
  options: ImageOptions,
  placements: Placements,
  warnings: Set<string>,
): OneOutcome | null {
  const info = readImage(doc.context, stream);
  if (!info) return null;
  const policy = options[info.imageClass];
  const drawn = placements.get(ref.toString()) ?? null;

  const samples = decodeSamples(doc.context, stream, info, warnings);
  if (!samples) return null;

  const target = targetSize({ width: info.width, height: info.height }, drawn, policy);
  const scaled = target ? resample(samples, target.width, target.height) : samples;
  const wantsRecompression = policy.codec !== 'keep';
  if (!target && !wantsRecompression) return null;

  const before = stream.getContentsSize();
  let written = writeImage(doc, ref, stream, scaled, info, policy.codec, policy.quality);
  if (!written) return null;

  /*
   * When the chosen codec made it bigger, try flate at the new size before giving up.
   *
   * This matters more than it sounds. A picture that flates well — a screenshot, a chart, an
   * indexed palette — can be *smaller* as 200 px of flate than as 100 px of JPEG, and the naive
   * rule ("it grew, put it back") then throws away a downsample that would have helped, because
   * one of the two changes lost. Trying the lossless codec at the reduced size costs one deflate
   * and recovers exactly that case.
   */
  if (options.neverGrow && written.length >= before && policy.codec === 'jpeg') {
    const lossless = writeImage(doc, ref, stream, scaled, info, 'flate', 100);
    if (lossless) written = lossless;
  }

  if (options.neverGrow && written.length >= before) {
    // Put it back exactly as it was. Nothing is said about it: "this image did not get smaller"
    // is not something a reader can act on.
    doc.context.assign(ref, stream);
    return null;
  }

  const outcome: OneOutcome = {
    changed: 1,
    downsampled: target ? 1 : 0,
    recompressed: target ? 0 : 1,
    saved: Math.max(0, before - written.length),
  };

  // The mask travels with its image, at the same scale, whatever the reader asked for its class.
  if (target) {
    for (const key of ['SMask', 'Mask']) {
      const entry = stream.dict.get(PDFName.of(key));
      if (!(entry instanceof PDFRef)) continue;
      const maskStream = pick(doc.context, entry, PDFStream);
      if (!maskStream) continue;
      const maskSaved = scaleMask(doc, entry, maskStream, target, warnings);
      outcome.saved += maskSaved;
    }
  }
  return outcome;
}

/** What a mask is worth scaling to: exactly the pixel grid of the image it masks. */
function scaleMask(
  doc: PDFDocument,
  ref: PDFRef,
  stream: PDFStream,
  target: { width: number; height: number },
  warnings: Set<string>,
): number {
  const info = readImage(doc.context, stream);
  if (!info) return 0;
  if (info.width <= target.width && info.height <= target.height) return 0;
  const samples = decodeSamples(doc.context, stream, info, warnings);
  if (!samples) return 0;
  const scaled = resample(samples, target.width, target.height);
  const before = stream.getContentsSize();
  // A mask is always lossless: JPEG artefacts on an alpha channel show up as haloes.
  const written = writeImage(
    doc,
    ref,
    stream,
    scaled,
    info,
    info.imageClass === 'mono' ? 'ccitt' : 'flate',
    100,
  );
  if (!written) return 0;
  if (written.length >= before) {
    doc.context.assign(ref, stream);
    return 0;
  }
  return before - written.length;
}

// ---- reading -----------------------------------------------------------------------------------

interface ImageInfo {
  readonly width: number;
  readonly height: number;
  readonly bits: number;
  readonly components: 1 | 3;
  readonly imageClass: ImageClass;
  readonly isMask: boolean;
  readonly filters: ReadonlyArray<string>;
  readonly indexed: { readonly base: number; readonly palette: Uint8Array } | null;
}

function isImage(ctx: PDFContext, object: unknown): boolean {
  if (!(object instanceof PDFStream)) return false;
  return pick(ctx, object.dict.get(PDFName.of('Subtype')), PDFName)?.asString() === '/Image';
}

function readImage(ctx: PDFContext, stream: PDFStream): ImageInfo | null {
  const dict = stream.dict;
  const width = numberOf(ctx, dict, 'Width');
  const height = numberOf(ctx, dict, 'Height');
  if (!(width > 0) || !(height > 0)) return null;
  // 100 megapixels is well past anything a page carries and is where a runaway file starts
  // costing gigabytes of heap for no benefit.
  if (width * height > 100_000_000) return null;

  const isMask = pick(ctx, dict.get(PDFName.of('ImageMask')), PDFBool)?.asBoolean() === true;
  const bits = isMask ? 1 : numberOf(ctx, dict, 'BitsPerComponent') || 8;
  const filters = filterNames(ctx, dict);
  const space = colourSpace(ctx, dict);

  if (isMask || bits === 1) {
    return {
      width,
      height,
      bits: 1,
      components: 1,
      imageClass: 'mono',
      isMask,
      filters,
      indexed: null,
    };
  }
  if (space.kind === 'grey') {
    return {
      width,
      height,
      bits,
      components: 1,
      imageClass: 'grey',
      isMask,
      filters,
      indexed: null,
    };
  }
  if (space.kind === 'rgb') {
    return {
      width,
      height,
      bits,
      components: 3,
      imageClass: 'colour',
      isMask,
      filters,
      indexed: null,
    };
  }
  if (space.kind === 'indexed') {
    return {
      width,
      height,
      bits,
      components: 3,
      imageClass: 'colour',
      isMask,
      filters,
      indexed: space.indexed,
    };
  }
  // CMYK, Lab, Separation, ICCBased with four components, a pattern colour space: readable in
  // principle, wrong in practice without colour management we do not have.
  return null;
}

type Space =
  | { kind: 'grey' }
  | { kind: 'rgb' }
  | { kind: 'other' }
  | { kind: 'indexed'; indexed: { base: number; palette: Uint8Array } };

/** What the `/ColorSpace` entry means, as far as this file needs to care. */
function colourSpace(ctx: PDFContext, dict: PDFDict): Space {
  const raw = dict.get(PDFName.of('ColorSpace'));
  const name = pick(ctx, raw, PDFName)?.asString();
  if (name === '/DeviceGray' || name === '/CalGray' || name === '/G') return { kind: 'grey' };
  if (name === '/DeviceRGB' || name === '/CalRGB' || name === '/RGB') return { kind: 'rgb' };
  const array = pick(ctx, raw, PDFArray);
  if (!array || array.size() === 0) return { kind: 'other' };
  const family = pick(ctx, array.get(0), PDFName)?.asString();
  if (family === '/CalGray') return { kind: 'grey' };
  if (family === '/CalRGB') return { kind: 'rgb' };
  if (family === '/ICCBased') {
    const profile = pick(ctx, array.get(1), PDFStream);
    const n = profile ? numberOf(ctx, profile.dict, 'N') : 0;
    if (n === 1) return { kind: 'grey' };
    if (n === 3) return { kind: 'rgb' };
    return { kind: 'other' };
  }
  if (family === '/Indexed' || family === '/I') {
    const base = pick(ctx, array.get(1), PDFName)?.asString();
    const baseComponents = base === '/DeviceGray' ? 1 : base === '/DeviceRGB' ? 3 : 0;
    if (baseComponents === 0) return { kind: 'other' };
    const palette = paletteBytes(ctx, array.get(3));
    if (!palette) return { kind: 'other' };
    return { kind: 'indexed', indexed: { base: baseComponents, palette } };
  }
  return { kind: 'other' };
}

/** An indexed palette is either a stream or a string; both spellings are legal (ISO 32000 §8.6.6.3). */
function paletteBytes(ctx: PDFContext, raw: PDFObject | undefined): Uint8Array | null {
  const stream = pick(ctx, raw, PDFStream);
  if (stream) {
    try {
      return stream instanceof PDFRawStream
        ? decodePDFRawStream(stream).decode()
        : stream.getContents();
    } catch {
      return null;
    }
  }
  const resolved = raw === undefined ? undefined : ctx.lookupMaybe(raw, PDFString);
  if (resolved) return resolved.asBytes();
  const hex = raw === undefined ? undefined : ctx.lookupMaybe(raw, PDFHexString);
  return hex ? hex.asBytes() : null;
}

function filterNames(ctx: PDFContext, dict: PDFDict): string[] {
  const raw = dict.get(PDFName.of('Filter'));
  const one = pick(ctx, raw, PDFName);
  if (one) return [one.asString().slice(1)];
  const array = pick(ctx, raw, PDFArray);
  if (!array) return [];
  const out: string[] = [];
  for (const item of array.asArray()) {
    const name = pick(ctx, item, PDFName);
    if (name) out.push(name.asString().slice(1));
  }
  return out;
}

function numberOf(ctx: PDFContext, dict: PDFDict, key: string): number {
  const n = pick(ctx, dict.get(PDFName.of(key)), PDFNumber);
  return n ? n.asNumber() : 0;
}

/** The `/DecodeParms` that belongs to the last filter — the one whose predictor is in force. */
function lastDecodeParms(ctx: PDFContext, dict: PDFDict): PDFDict | null {
  const raw = dict.get(PDFName.of('DecodeParms')) ?? dict.get(PDFName.of('DP'));
  const one = pick(ctx, raw, PDFDict);
  if (one) return one;
  const array = pick(ctx, raw, PDFArray);
  if (!array || array.size() === 0) return null;
  for (let i = array.size() - 1; i >= 0; i--) {
    const entry = pick(ctx, array.get(i), PDFDict);
    if (entry) return entry;
  }
  return null;
}

/** Samples, filters undone and predictors reversed, or `null` when we cannot get at them. */
function decodeSamples(
  ctx: PDFContext,
  stream: PDFStream,
  info: ImageInfo,
  warnings: Set<string>,
): Samples | null {
  if (info.filters.includes('DCTDecode')) {
    if (info.filters.length > 1) return null;
    const raw = stream instanceof PDFRawStream ? stream.contents : stream.getContents();
    const decoded = decodeJpeg(raw);
    if (!decoded) {
      warnings.add(
        'One JPEG image could not be read — most likely a CMYK or progressive one — so it was left as it was.',
      );
      return null;
    }
    return info.imageClass === 'grey' ? toGrey(decoded) : decoded;
  }
  if (info.filters.includes('JPXDecode')) {
    warnings.add(
      'A JPEG 2000 image was left as it was: ynotPDF does not write JPEG 2000, so it could not be re-encoded.',
    );
    return null;
  }
  if (info.filters.includes('JBIG2Decode')) {
    warnings.add(
      'A JBIG2 image was left as it was: ynotPDF does not write JBIG2, so it could not be re-encoded.',
    );
    return null;
  }
  if (info.filters.includes('CCITTFaxDecode')) {
    // Already the best we could do for it, and decoding it would need a G4 *decoder* we have no
    // other use for.
    return null;
  }
  if (!info.filters.every((f) => READABLE.has(f))) return null;

  let raw: Uint8Array;
  try {
    raw =
      stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
  } catch {
    return null;
  }
  const parms = lastDecodeParms(ctx, stream.dict);
  const storedComponents = info.indexed ? 1 : info.components;
  if (parms) {
    raw = undoPredictor(raw, {
      predictor: numberOf(ctx, parms, 'Predictor') || 1,
      colors: numberOf(ctx, parms, 'Colors') || storedComponents,
      bitsPerComponent: numberOf(ctx, parms, 'BitsPerComponent') || info.bits,
      columns: numberOf(ctx, parms, 'Columns') || info.width,
    });
  }

  const needed = Math.ceil((info.width * storedComponents * info.bits) / 8) * info.height;
  if (raw.length < needed) return null;

  if (info.indexed) return expandIndexed(raw, info);
  const data = unpack(raw, info.width, info.height, storedComponents, info.bits);
  return { data, width: info.width, height: info.height, components: info.components };
}

function toGrey(samples: Samples): Samples {
  if (samples.components === 1) return samples;
  const out = new Uint8Array(samples.width * samples.height);
  for (let i = 0; i < out.length; i++) {
    // Rec. 601 luma, the same weighting `imageHash.ts` uses, so grey means one thing here.
    out[i] =
      Math.round(
        0.299 * (samples.data[i * 3] ?? 0) +
          0.587 * (samples.data[i * 3 + 1] ?? 0) +
          0.114 * (samples.data[i * 3 + 2] ?? 0),
      ) & 0xff;
  }
  return { data: out, width: samples.width, height: samples.height, components: 1 };
}

/** Indexed samples become plain RGB: the palette is tiny and the arithmetic above is one path. */
function expandIndexed(raw: Uint8Array, info: ImageInfo): Samples | null {
  const indexed = info.indexed;
  if (!indexed) return null;
  const indices = unpack(raw, info.width, info.height, 1, info.bits);
  const out = new Uint8Array(info.width * info.height * 3);
  for (let i = 0; i < indices.length; i++) {
    // `unpack` scales to 0–255; the palette index is the raw value, so scale back.
    const max = (1 << info.bits) - 1;
    const index = Math.round(((indices[i] ?? 0) * max) / 255);
    const at = index * indexed.base;
    if (indexed.base === 1) {
      const v = indexed.palette[at] ?? 0;
      out[i * 3] = v;
      out[i * 3 + 1] = v;
      out[i * 3 + 2] = v;
    } else {
      out[i * 3] = indexed.palette[at] ?? 0;
      out[i * 3 + 1] = indexed.palette[at + 1] ?? 0;
      out[i * 3 + 2] = indexed.palette[at + 2] ?? 0;
    }
  }
  return { data: out, width: info.width, height: info.height, components: 3 };
}

// ---- writing -----------------------------------------------------------------------------------

/**
 * Encodes `samples` and puts them back in the document, rewriting the dictionary to match.
 *
 * Every entry that described the *old* encoding goes: `/Filter`, `/DecodeParms`, `/Decode` (whose
 * meaning depends on the colour space we may just have changed), and the indexed palette. What
 * describes the *picture* — `/SMask`, `/Mask`, `/Intent`, `/Alternates` — stays.
 */
function writeImage(
  doc: PDFDocument,
  ref: PDFRef,
  stream: PDFStream,
  samples: Samples,
  info: ImageInfo,
  codec: 'keep' | 'jpeg' | 'flate' | 'ccitt',
  quality: number,
): Uint8Array | null {
  // A clone, so that a caller who decides the result is not smaller can put the original stream
  // back and get its original dictionary with it.
  const dict = stream.dict.clone(doc.context);
  const chosen = codec === 'keep' ? (info.imageClass === 'mono' ? 'ccitt' : 'flate') : codec;

  let bytes: Uint8Array;
  let filter: string;
  let bitsPerComponent: number;
  let colourSpaceName: string;
  let parms: PDFDict | null = null;

  if (chosen === 'jpeg' && info.imageClass !== 'mono') {
    bytes = encodeJpeg(samples, quality);
    filter = 'DCTDecode';
    bitsPerComponent = 8;
    // jpeg-js writes three components whatever it was handed (see `codecs.ts`), so the colour
    // space has to say three as well or every reader will show noise.
    colourSpaceName = 'DeviceRGB';
  } else if (chosen === 'ccitt' && info.imageClass === 'mono') {
    const mono = samples.components === 1 ? samples : toGrey(samples);
    bytes = encodeGroup4(mono);
    filter = 'CCITTFaxDecode';
    bitsPerComponent = 1;
    colourSpaceName = 'DeviceGray';
    parms = doc.context.obj({
      K: -1,
      Columns: samples.width,
      Rows: samples.height,
      BlackIs1: false,
    });
  } else if (info.imageClass === 'mono') {
    const mono = samples.components === 1 ? samples : toGrey(samples);
    bytes = deflate(packMono(mono));
    filter = 'FlateDecode';
    bitsPerComponent = 1;
    colourSpaceName = 'DeviceGray';
  } else {
    bytes = deflate(samples.data);
    filter = 'FlateDecode';
    bitsPerComponent = 8;
    colourSpaceName = samples.components === 1 ? 'DeviceGray' : 'DeviceRGB';
  }

  dict.set(PDFName.of('Width'), PDFNumber.of(samples.width));
  dict.set(PDFName.of('Height'), PDFNumber.of(samples.height));
  dict.set(PDFName.of('Length'), PDFNumber.of(bytes.length));
  dict.set(PDFName.of('Filter'), PDFName.of(filter));
  dict.delete(PDFName.of('DecodeParms'));
  dict.delete(PDFName.of('DP'));
  dict.delete(PDFName.of('Decode'));
  if (parms) dict.set(PDFName.of('DecodeParms'), parms);

  if (info.isMask) {
    // A stencil mask has no colour space and no bit depth of its own; saying otherwise makes it
    // invalid rather than merely odd.
    dict.delete(PDFName.of('ColorSpace'));
    dict.delete(PDFName.of('BitsPerComponent'));
    dict.set(PDFName.of('ImageMask'), PDFBool.True);
  } else {
    dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(bitsPerComponent));
    dict.set(PDFName.of('ColorSpace'), PDFName.of(colourSpaceName));
  }

  doc.context.assign(ref, PDFRawStream.of(dict, bytes));
  return bytes;
}
