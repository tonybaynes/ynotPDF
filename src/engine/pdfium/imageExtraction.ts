/** Intrinsic image extraction (M92), with PDFium doing colour conversion and masking.
 *
 * GetBitmap ignores masks; GetRenderedBitmap includes placement and clipping. A small,
 * isolated image page retains the image dictionary (including SMask/Mask/Matte/Decode)
 * and its colour resources, without page graphics state or mutations of live objects.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObjectCopier,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib';
import type { PdfMatrix } from '@shared/pdf';
import { EngineError, type EmbeddedImage, type PageImagesOptions } from '../PdfEngine';
import { applyToRect, IDENTITY, multiply } from '../content/matrix';
import { scanObjects } from '../content/objects';
import { parse, type ContentValue, type InlineImage } from '../content/parser';
import { pageContentOf } from '../content/pdf';

type DecodeImage = (pdf: Uint8Array, width: number, height: number) => Uint8Array;
const MAX_OBJECTS = 100_000;
const MAX_DEPTH = 256;
const MAX_RGBA_BYTES = 512 * 1024 * 1024;
const name = PDFName.of;

function numeric(dict: PDFDict, key: string): number {
  const value = dict.lookup(name(key));
  return value instanceof PDFNumber ? value.asNumber() : 0;
}

function streamBytes(stream: PDFStream): Uint8Array {
  return stream instanceof PDFRawStream
    ? decodePDFRawStream(stream).decode()
    : stream.getContents();
}

function resolvedColour(
  value: PDFObject,
  resources: PDFDict,
  active = new Set<PDFObject>(),
): PDFObject {
  if (active.has(value)) throw new EngineError('corrupt', 'Cyclic image colour resources');
  if (active.size >= 64)
    throw new EngineError('unsupported', 'Image colour nesting exceeds the extraction limit');
  active.add(value);
  try {
    if (value instanceof PDFName) {
      const defaultName =
        value === name('DeviceRGB')
          ? 'DefaultRGB'
          : value === name('DeviceGray')
            ? 'DefaultGray'
            : value === name('DeviceCMYK')
              ? 'DefaultCMYK'
              : undefined;
      const next = defaultName ? resources.lookup(name(defaultName)) : resources.lookup(value);
      return next ? resolvedColour(next, resources, active) : value;
    }
    if (!(value instanceof PDFArray))
      throw new EngineError('corrupt', 'Invalid image colour space');
    const kind = value.lookup(0);
    if (!(kind instanceof PDFName))
      throw new EngineError('corrupt', 'Invalid image colour-space array');
    // Only base/alternate positions are colour-space references. Colorant names,
    // profile streams, lookup tables and tint functions retain their original roles/refs.
    const colourAt =
      kind === name('Indexed') || kind === name('Pattern')
        ? 1
        : kind === name('Separation') || kind === name('DeviceN')
          ? 2
          : -1;
    const array = PDFArray.withContext(resources.context);
    for (const [index, item] of value.asArray().entries()) {
      if (index !== colourAt) array.push(item);
      else {
        const base = resources.context.lookup(item);
        if (!base) throw new EngineError('corrupt', 'Missing image base colour space');
        array.push(resolvedColour(base, resources, active));
      }
    }
    return array;
  } finally {
    active.delete(value);
  }
}
function checkDecodeSize(image: PDFStream, active = new Set<PDFStream>()): void {
  if (active.has(image)) throw new EngineError('corrupt', 'Cyclic image masks');
  if (active.size >= 32)
    throw new EngineError('unsupported', 'Image mask nesting exceeds the extraction limit');
  const width = numeric(image.dict, 'Width');
  const height = numeric(image.dict, 'Height');
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height * 4 > MAX_RGBA_BYTES
  ) {
    throw new EngineError('unsupported', 'Image dimensions exceed the extraction limit');
  }
  active.add(image);
  for (const key of ['SMask', 'Mask']) {
    const mask = image.dict.lookup(name(key));
    if (mask instanceof PDFStream) checkDecodeSize(mask, active);
  }
  active.delete(image);
}

function filtersOf(stream: PDFStream): string[] {
  const filters = stream.dict.lookup(name('Filter'));
  if (filters instanceof PDFName) return [filters.decodeText()];
  if (!(filters instanceof PDFArray)) return [];
  return filters.asArray().map((value) => {
    const resolved = stream.dict.context.lookup(value);
    if (!(resolved instanceof PDFName)) throw new EngineError('corrupt', 'Invalid image filter');
    return resolved.decodeText();
  });
}

function formMatrix(form: PDFStream): PdfMatrix {
  const matrix = form.dict.lookup(name('Matrix'));
  if (!(matrix instanceof PDFArray)) return IDENTITY;
  const values = matrix.asArray().map((v) => form.dict.context.lookup(v));
  if (values.length !== 6 || !values.every((v) => v instanceof PDFNumber)) {
    throw new EngineError('corrupt', 'Invalid form matrix');
  }
  return values.map((v) => v.asNumber()) as unknown as PdfMatrix;
}

const INLINE_NAMES: Readonly<Record<string, string>> = {
  W: 'Width',
  H: 'Height',
  BPC: 'BitsPerComponent',
  CS: 'ColorSpace',
  D: 'Decode',
  DP: 'DecodeParms',
  F: 'Filter',
  IM: 'ImageMask',
  I: 'Interpolate',
  G: 'DeviceGray',
  RGB: 'DeviceRGB',
  CMYK: 'DeviceCMYK',
  AHx: 'ASCIIHexDecode',
  A85: 'ASCII85Decode',
  LZW: 'LZWDecode',
  Fl: 'FlateDecode',
  RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode',
  DCT: 'DCTDecode',
};
const INLINE_COLOURS: Readonly<Record<string, string>> = {
  G: 'DeviceGray',
  RGB: 'DeviceRGB',
  CMYK: 'DeviceCMYK',
  I: 'Indexed',
};

function inlineValue(
  value: ContentValue,
  context: PDFContext,
  role: 'colour' | 'filter' | 'other',
): PDFObject {
  switch (value.kind) {
    case 'number':
      return PDFNumber.of(value.value);
    case 'name':
      return name(
        role === 'colour'
          ? (INLINE_COLOURS[value.value] ?? value.value)
          : role === 'filter'
            ? (INLINE_NAMES[value.value] ?? value.value)
            : value.value,
      );
    case 'bool':
      return value.value ? PDFBool.True : PDFBool.False;
    case 'null':
      return PDFNull;
    case 'string':
      return PDFHexString.of(
        Array.from(value.value, (v) => v.toString(16).padStart(2, '0')).join(''),
      );
    case 'array': {
      const array = PDFArray.withContext(context);
      const first = value.items[0];
      const kind = first?.kind === 'name' ? first.value : '';
      const baseAt =
        kind === 'I' || kind === 'Indexed' || kind === 'Pattern'
          ? 1
          : kind === 'Separation' || kind === 'DeviceN'
            ? 2
            : -1;
      for (const [index, item] of value.items.entries()) {
        const itemRole =
          role === 'filter'
            ? 'filter'
            : role === 'colour' && (index === 0 || index === baseAt)
              ? 'colour'
              : 'other';
        array.push(inlineValue(item, context, itemRole));
      }
      return array;
    }
    case 'dict': {
      const dict = PDFDict.withContext(context);
      for (const [key, item] of value.entries)
        dict.set(name(key), inlineValue(item, context, 'other'));
      return dict;
    }
  }
}

function inlineStream(image: InlineImage, context: PDFContext): PDFRawStream {
  const dict = PDFDict.withContext(context);
  for (const [key, value] of image.dict) {
    const expanded = INLINE_NAMES[key] ?? key;
    // Inline /I means Indexed in a colour-space value, Interpolate as a dictionary key.
    const converted = inlineValue(
      value,
      context,
      expanded === 'ColorSpace' ? 'colour' : expanded === 'Filter' ? 'filter' : 'other',
    );
    dict.set(name(expanded), converted);
  }
  dict.set(name('Type'), name('XObject'));
  dict.set(name('Subtype'), name('Image'));
  return PDFRawStream.of(dict, image.data);
}

async function isolatedImage(
  source: PDFDocument,
  image: PDFStream,
  resources: PDFDict | undefined,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const target = await PDFDocument.create();
  const copier = PDFObjectCopier.for(source.context, target.context);
  const page = target.addPage([width, height]);
  const copiedImage = copier.copy(image);
  const imageColour = image.dict.lookup(name('ColorSpace'));
  const resourceColours = resources?.lookup(name('ColorSpace'));
  if (imageColour) {
    copiedImage.dict.set(
      name('ColorSpace'),
      copier.copy(
        resolvedColour(
          imageColour,
          resourceColours instanceof PDFDict
            ? resourceColours
            : PDFDict.withContext(source.context),
        ),
      ),
    );
  }
  const imageRef = target.context.register(copiedImage);
  const isolatedResources = target.context.obj({ XObject: { Image: imageRef } });
  const colours = resources?.lookup(name('ColorSpace'));
  if (colours instanceof PDFDict) isolatedResources.set(name('ColorSpace'), copier.copy(colours));
  page.node.set(name('Resources'), isolatedResources);
  page.node.set(
    name('Contents'),
    target.context.register(
      target.context.flateStream(`q ${String(width)} 0 0 ${String(height)} 0 0 cm /Image Do Q`),
    ),
  );
  return target.save({ useObjectStreams: false, updateFieldAppearances: false });
}

/** Extract drawn image occurrences, retaining the root page-object index for nested images.
 * Cyclic forms and work/depth limits fail explicitly rather than silently losing pictures.
 */
export async function extractPageImages(
  bytes: Uint8Array,
  pageIndex: number,
  decode: DecodeImage,
  options: PageImagesOptions = {},
): Promise<ReadonlyArray<EmbeddedImage>> {
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = source.getPages()[pageIndex];
  if (!page) throw new EngineError('invalid-page', `No page ${String(pageIndex)}`);
  const out: EmbeddedImage[] = [];
  const activeForms = new Set<PDFStream>();
  const decoded = new Map<PDFStream, Map<PDFDict | undefined, Uint8Array>>();
  let remaining = MAX_OBJECTS;

  const walk = async (
    content: Uint8Array,
    resources: PDFDict | undefined,
    parent: PdfMatrix,
    depth: number,
    rootIndex?: number,
  ): Promise<void> => {
    if (depth > MAX_DEPTH)
      throw new EngineError('unsupported', 'Image form nesting exceeds the extraction limit');
    const parsed = parse(content);
    if (parsed.issues.length) throw new EngineError('corrupt', 'Cannot safely parse image content');
    for (const object of scanObjects(parsed.ops).objects) {
      if (--remaining < 0)
        throw new EngineError('unsupported', 'Too many image/form objects to extract');
      const index = rootIndex ?? object.index;
      const matrix = multiply(object.ctm, parent);
      let image: PDFStream | undefined;
      if (object.kind === 'image') {
        const inline = parsed.ops[object.opStart]?.image;
        if (inline) image = inlineStream(inline, source.context);
      } else if (object.kind === 'xobject' && object.name !== undefined) {
        const objects = resources?.lookup(name('XObject'));
        const candidate =
          objects instanceof PDFDict ? objects.lookup(name(object.name)) : undefined;
        if (!(candidate instanceof PDFStream))
          throw new EngineError('corrupt', 'Missing image/form resource');
        const subtype = candidate.dict.lookup(name('Subtype'));
        if (subtype === name('Form')) {
          if (activeForms.has(candidate))
            throw new EngineError('corrupt', 'Cyclic image form resources');
          activeForms.add(candidate);
          try {
            const ownResources = candidate.dict.lookup(name('Resources'));
            await walk(
              streamBytes(candidate),
              ownResources instanceof PDFDict ? ownResources : resources,
              multiply(formMatrix(candidate), matrix),
              depth + 1,
              index,
            );
          } finally {
            activeForms.delete(candidate);
          }
        } else if (subtype === name('Image')) image = candidate;
      }
      if (!image) continue;
      const width = numeric(image.dict, 'Width');
      const height = numeric(image.dict, 'Height');
      if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width <= 0 ||
        height <= 0
      ) {
        throw new EngineError('unsupported', 'Image dimensions exceed the extraction limit');
      }
      const filters = filtersOf(image);
      const encoding =
        options.output === 'png'
          ? 'rgba'
          : filters.length === 1 && filters[0] === 'DCTDecode'
            ? 'jpeg'
            : filters.length === 1 && filters[0] === 'JPXDecode'
              ? 'jp2'
              : 'rgba';
      let data: Uint8Array;
      if (encoding === 'rgba') {
        const contexts = decoded.get(image) ?? new Map<PDFDict | undefined, Uint8Array>();
        const cached = contexts.get(resources);
        // Every returned occurrence owns its buffer: the existing RPC transfers each view.
        if (cached) data = Uint8Array.from(cached);
        else {
          checkDecodeSize(image);
          data = decode(
            await isolatedImage(source, image, resources, width, height),
            width,
            height,
          );
          contexts.set(resources, data);
          decoded.set(image, contexts);
        }
      } else data = Uint8Array.from(image.getContents());
      const xLength = Math.hypot(matrix[0], matrix[1]);
      const yLength = Math.hypot(matrix[2], matrix[3]);
      out.push({
        page: pageIndex,
        index,
        width,
        height,
        rect: applyToRect(matrix, { x0: 0, y0: 0, x1: 1, y1: 1 }),
        dpiX: xLength > 0 ? (width * 72) / xLength : 72,
        dpiY: yLength > 0 ? (height * 72) / yLength : 72,
        filters,
        encoding,
        data,
      });
      if ((out.length & 7) === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };
  await walk(pageContentOf(source, page), page.node.Resources(), IDENTITY, 0);
  return out;
}
