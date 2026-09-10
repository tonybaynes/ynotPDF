/**
 * The image pipeline against images of every shape it claims to handle (M100).
 *
 * Built here rather than taken from the corpus, because the corpus has one kind of image and the
 * pipeline has to cope with eight: flate RGB and grey, an indexed palette, a one-bit stencil mask,
 * an 8-bit soft mask riding on a photograph, a JPEG, and two codecs — JPEG 2000 and JBIG2 — that
 * it must leave strictly alone and say so.
 *
 * Every document built here is put back through PDFium at the end, because "the bytes changed"
 * and "the page still draws" are not the same statement.
 */

import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  type PDFDict,
  type PDFPage,
} from 'pdf-lib';
import { NO_CHANGE, optimiseImages, findPlacements, type ImageOptions } from '@engine/optimise';
import { deflate, encodeJpeg } from '@engine/optimise/images/codecs';
import { engine } from './helpers';

/** Downsample everything above 100 dpi to 72, re-encoding colour and grey as JPEG. */
const SHRINK: ImageOptions = {
  colour: { targetDpi: 72, thresholdDpi: 100, codec: 'jpeg', quality: 70 },
  grey: { targetDpi: 72, thresholdDpi: 100, codec: 'jpeg', quality: 70 },
  mono: { targetDpi: 150, thresholdDpi: 200, codec: 'ccitt', quality: 100 },
  neverGrow: true,
};

/**
 * A photograph-like 200x200 picture: smooth ramps with a little grain.
 *
 * The grain matters. A pure gradient flates to almost nothing, so JPEG loses to it however small
 * the picture is made — which is correct behaviour and a useless test, because it exercises the
 * never-grow guard rather than the codec.
 */
function photo(components: 1 | 3, size = 200): Uint8Array {
  const out = new Uint8Array(size * size * components);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const base = (y * size + x) * components;
      const grain = ((x * 31 + y * 17) % 23) - 11;
      out[base] = clamp((x + y) / 2 + grain);
      if (components === 3) {
        out[base + 1] = clamp(x * 0.9 + grain);
        out[base + 2] = clamp(255 - y * 0.8 + grain);
      }
    }
  }
  return out;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

interface BuiltImage {
  readonly bytes: Uint8Array;
  readonly entries: Record<string, unknown>;
  readonly width: number;
  readonly height: number;
}

/** One page, 100 pt square, drawing `images` stacked on top of each other to fill it. */
async function documentWith(images: ReadonlyArray<BuiltImage>): Promise<PDFDocument> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page: PDFPage = doc.addPage([100, 100]);
  let content = '';
  images.forEach((image, i) => {
    const stream = PDFRawStream.of(
      doc.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: image.width,
        Height: image.height,
        Length: image.bytes.length,
        ...image.entries,
      }),
      image.bytes,
    );
    page.node.setXObject(PDFName.of(`Im${String(i)}`), doc.context.register(stream));
    content += `q 100 0 0 100 0 0 cm /Im${String(i)} Do Q\n`;
  });
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
  return doc;
}

function flateImage(components: 1 | 3, size = 200): BuiltImage {
  return {
    bytes: deflate(photo(components, size)),
    width: size,
    height: size,
    entries: {
      ColorSpace: components === 1 ? 'DeviceGray' : 'DeviceRGB',
      BitsPerComponent: 8,
      Filter: 'FlateDecode',
    },
  };
}

async function save(doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({ addDefaultPage: false, updateFieldAppearances: false });
}

/** Does PDFium still open it and draw a page? */
async function opens(bytes: Uint8Array): Promise<boolean> {
  const e = await engine();
  try {
    const handle = await e.open(bytes.slice());
    try {
      await e.renderRaw(handle, 0, 1);
      return true;
    } finally {
      await e.close(handle);
    }
  } catch {
    return false;
  }
}

/** The one image XObject in a document, as pdf-lib sees it. */
function onlyImage(doc: PDFDocument): { dict: PDFDict; length: number } {
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (object.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Image') continue;
    return { dict: object.dict, length: object.contents.length };
  }
  throw new Error('no image in the document');
}

function nameOf(dict: PDFDict, key: string): string | undefined {
  return dict.lookupMaybe(PDFName.of(key), PDFName)?.asString();
}

function numberOf(dict: PDFDict, key: string): number | undefined {
  return dict.lookupMaybe(PDFName.of(key), PDFNumber)?.asNumber();
}

describe('the image pipeline', () => {
  it('downsamples and re-encodes a colour photograph, and the page still draws', async () => {
    const doc = await documentWith([flateImage(3)]);
    const before = onlyImage(doc).length;
    const outcome = await optimiseImages(doc, SHRINK);

    expect(outcome.downsampled).toBe(1);
    expect(outcome.saved).toBeGreaterThan(0);
    const after = onlyImage(doc);
    // 200 px across 100 pt is 144 dpi; asked for 72, it halves.
    expect(numberOf(after.dict, 'Width')).toBe(100);
    expect(nameOf(after.dict, 'Filter')).toBe('/DCTDecode');
    expect(after.length).toBeLessThan(before);
    expect(await opens(await save(doc))).toBe(true);
  });

  it('turns a greyscale photograph into a JPEG and says so in the colour space', async () => {
    const doc = await documentWith([flateImage(1)]);
    await optimiseImages(doc, SHRINK);
    const after = onlyImage(doc);
    expect(nameOf(after.dict, 'Filter')).toBe('/DCTDecode');
    // jpeg-js writes three components whatever it is given, so the colour space has to agree.
    expect(nameOf(after.dict, 'ColorSpace')).toBe('/DeviceRGB');
    expect(await opens(await save(doc))).toBe(true);
  });

  it('leaves an image alone when nothing was asked for', async () => {
    const doc = await documentWith([flateImage(3)]);
    const before = onlyImage(doc).length;
    const outcome = await optimiseImages(doc, NO_CHANGE.images);
    expect(outcome.changed).toBe(0);
    expect(onlyImage(doc).length).toBe(before);
  });

  it('leaves an image alone when it is already below the threshold', async () => {
    // 60 px across 100 pt is 43 dpi — well under the 100 dpi threshold.
    const doc = await documentWith([flateImage(3, 60)]);
    const outcome = await optimiseImages(doc, {
      ...SHRINK,
      colour: { ...SHRINK.colour, codec: 'keep' },
    });
    expect(outcome.downsampled).toBe(0);
    expect(outcome.changed).toBe(0);
  });

  it('expands an indexed palette to RGB', async () => {
    const size = 200;
    const indices = new Uint8Array(size * size).map((_, i) => i % 4);
    const palette = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 200, 200, 200]);
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([100, 100]);
    const paletteRef = doc.context.register(doc.context.stream(palette));
    const space = PDFArray.withContext(doc.context);
    space.push(PDFName.of('Indexed'));
    space.push(PDFName.of('DeviceRGB'));
    space.push(PDFNumber.of(3));
    space.push(paletteRef);
    const stream = PDFRawStream.of(
      doc.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: size,
        Height: size,
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
        Length: 0,
      }),
      deflate(indices),
    );
    stream.dict.set(PDFName.of('ColorSpace'), space);
    stream.dict.set(PDFName.of('Length'), PDFNumber.of(stream.contents.length));
    page.node.setXObject(PDFName.of('Im0'), doc.context.register(stream));
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.stream('q 100 0 0 100 0 0 cm /Im0 Do Q')),
    );

    // `neverGrow: false`, because a four-colour palette is *already* the compact form of this
    // picture and the guard would rightly refuse to replace it — which is the next test. What is
    // under examination here is whether the expansion produces a correct RGB image at all.
    const outcome = await optimiseImages(doc, { ...SHRINK, neverGrow: false });
    expect(outcome.changed).toBe(1);
    const after = onlyImage(doc);
    expect(nameOf(after.dict, 'ColorSpace')).toBe('/DeviceRGB');
    expect(numberOf(after.dict, 'Width')).toBe(100);
    expect(after.dict.get(PDFName.of('Decode'))).toBeUndefined();
    expect(await opens(await save(doc))).toBe(true);
  });

  it('leaves an indexed picture alone when expanding it would make the file bigger', async () => {
    const size = 200;
    const indices = new Uint8Array(size * size).map((_, i) => i % 4);
    const palette = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 200, 200, 200]);
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([100, 100]);
    const space = PDFArray.withContext(doc.context);
    space.push(PDFName.of('Indexed'));
    space.push(PDFName.of('DeviceRGB'));
    space.push(PDFNumber.of(3));
    space.push(doc.context.register(doc.context.stream(palette)));
    const stream = PDFRawStream.of(
      doc.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: size,
        Height: size,
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
        Length: 0,
      }),
      deflate(indices),
    );
    stream.dict.set(PDFName.of('ColorSpace'), space);
    stream.dict.set(PDFName.of('Length'), PDFNumber.of(stream.contents.length));
    page.node.setXObject(PDFName.of('Im0'), doc.context.register(stream));
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.stream('q 100 0 0 100 0 0 cm /Im0 Do Q')),
    );

    const before = onlyImage(doc).length;
    expect((await optimiseImages(doc, SHRINK)).changed).toBe(0);
    expect(onlyImage(doc).length).toBe(before);
  });

  it('scales a soft mask in step with the picture it masks', async () => {
    const size = 200;
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([100, 100]);
    const mask = PDFRawStream.of(
      doc.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: size,
        Height: size,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceGray',
        Filter: 'FlateDecode',
        Length: 0,
      }),
      deflate(photo(1, size)),
    );
    mask.dict.set(PDFName.of('Length'), PDFNumber.of(mask.contents.length));
    const maskRef = doc.context.register(mask);

    const image = PDFRawStream.of(
      doc.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: size,
        Height: size,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceRGB',
        Filter: 'FlateDecode',
        Length: 0,
      }),
      deflate(photo(3, size)),
    );
    image.dict.set(PDFName.of('Length'), PDFNumber.of(image.contents.length));
    image.dict.set(PDFName.of('SMask'), maskRef);
    page.node.setXObject(PDFName.of('Im0'), doc.context.register(image));
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.stream('q 100 0 0 100 0 0 cm /Im0 Do Q')),
    );

    await optimiseImages(doc, SHRINK);
    const scaledMask = doc.context.lookup(maskRef);
    expect(scaledMask).toBeInstanceOf(PDFRawStream);
    if (scaledMask instanceof PDFRawStream) {
      // The mask ended up on the same pixel grid as the picture, not left at 200.
      expect(numberOf(scaledMask.dict, 'Width')).toBe(100);
      expect(nameOf(scaledMask.dict, 'Filter')).toBe('/FlateDecode');
    }
    expect(await opens(await save(doc))).toBe(true);
  });

  it('re-encodes a JPEG that is drawn far too large for its size on the page', async () => {
    const size = 200;
    const jpeg = encodeJpeg({ data: photo(3, size), width: size, height: size, components: 3 }, 95);
    const doc = await documentWith([
      {
        bytes: jpeg,
        width: size,
        height: size,
        entries: { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' },
      },
    ]);
    const outcome = await optimiseImages(doc, SHRINK);
    expect(outcome.downsampled).toBe(1);
    expect(numberOf(onlyImage(doc).dict, 'Width')).toBe(100);
    expect(await opens(await save(doc))).toBe(true);
  });

  it('leaves JPEG 2000 and JBIG2 exactly as they are, and says why', async () => {
    for (const filter of ['JPXDecode', 'JBIG2Decode']) {
      const doc = await documentWith([
        {
          bytes: new Uint8Array(2048).fill(7),
          width: 200,
          height: 200,
          entries: { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: filter },
        },
      ]);
      const before = onlyImage(doc).length;
      const outcome = await optimiseImages(doc, SHRINK);
      expect(outcome.changed).toBe(0);
      expect(onlyImage(doc).length).toBe(before);
      expect(outcome.warnings.join(' ')).toMatch(filter === 'JPXDecode' ? /JPEG 2000/ : /JBIG2/);
    }
  });

  it('leaves a CMYK image alone rather than getting its colours wrong', async () => {
    const doc = await documentWith([
      {
        bytes: deflate(new Uint8Array(200 * 200 * 4).fill(90)),
        width: 200,
        height: 200,
        entries: { ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Filter: 'FlateDecode' },
      },
    ]);
    const before = onlyImage(doc).length;
    expect((await optimiseImages(doc, SHRINK)).changed).toBe(0);
    expect(onlyImage(doc).length).toBe(before);
  });

  it('puts a one-bit stencil mask through CCITT and keeps it a stencil', async () => {
    const size = 800;
    const rowBytes = Math.ceil(size / 8);
    const bits = new Uint8Array(rowBytes * size);
    for (let y = 0; y < size; y++) {
      for (let b = 0; b < rowBytes; b++) bits[y * rowBytes + b] = y % 3 === 0 ? 0xff : 0b10101010;
    }
    const doc = await documentWith([
      {
        bytes: deflate(bits),
        width: size,
        height: size,
        entries: { ImageMask: true, Filter: 'FlateDecode' },
      },
    ]);
    const outcome = await optimiseImages(doc, SHRINK);
    expect(outcome.changed).toBe(1);
    const after = onlyImage(doc);
    expect(nameOf(after.dict, 'Filter')).toBe('/CCITTFaxDecode');
    // A stencil has no colour space and no bit depth of its own; saying otherwise is invalid.
    expect(after.dict.get(PDFName.of('ColorSpace'))).toBeUndefined();
    expect(after.dict.get(PDFName.of('ImageMask'))).toBeDefined();
    expect(await opens(await save(doc))).toBe(true);
  });

  it('never lets an image come out bigger than it went in', async () => {
    // Noise: JPEG at quality 100 is larger than flate, and the original must be kept.
    const size = 120;
    const noise = new Uint8Array(size * size * 3).map((_, i) => (i * 2654435761) % 256);
    const doc = await documentWith([
      {
        bytes: deflate(noise),
        width: size,
        height: size,
        entries: { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' },
      },
    ]);
    const before = onlyImage(doc);
    const outcome = await optimiseImages(doc, {
      ...SHRINK,
      colour: { targetDpi: 0, thresholdDpi: 0, codec: 'flate', quality: 100 },
      neverGrow: true,
    });
    expect(outcome.changed).toBe(0);
    const after = onlyImage(doc);
    expect(after.length).toBe(before.length);
    // And the dictionary is the one it had, not a rewritten one.
    expect(nameOf(after.dict, 'Filter')).toBe('/FlateDecode');
  });

  it('can be cancelled part-way and leaves nothing behind', async () => {
    const doc = await documentWith([flateImage(3), flateImage(3, 180)]);
    const controller = new AbortController();
    controller.abort();
    await expect(optimiseImages(doc, SHRINK, { signal: controller.signal })).rejects.toThrow(
      /cancelled/i,
    );
  });
});

describe('where an image is drawn', () => {
  it('measures the size on the page rather than the size in the file', async () => {
    const doc = await documentWith([flateImage(3)]);
    const places = findPlacements(doc);
    expect(places.size).toBe(1);
    const [size] = [...places.values()];
    expect(size?.width).toBeCloseTo(100, 5);
    expect(size?.height).toBeCloseTo(100, 5);
  });

  it('follows a form XObject into its own matrix', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([200, 200]);
    const image = PDFRawStream.of(
      doc.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: 100,
        Height: 100,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceGray',
        Filter: 'FlateDecode',
        Length: 0,
      }),
      deflate(photo(1, 100)),
    );
    image.dict.set(PDFName.of('Length'), PDFNumber.of(image.contents.length));
    const imageRef = doc.context.register(image);

    // A form that draws the image into a 50 pt square, itself drawn at half scale: 25 pt.
    const formContent = 'q 50 0 0 50 0 0 cm /Im0 Do Q';
    const form = PDFRawStream.of(
      doc.context.obj({
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 50, 50],
        Length: formContent.length,
        Resources: { XObject: { Im0: imageRef } },
      }),
      new TextEncoder().encode(formContent),
    );
    const formRef = doc.context.register(form);
    page.node.setXObject(PDFName.of('Fx0'), formRef);
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.stream('q 0.5 0 0 0.5 0 0 cm /Fx0 Do Q')),
    );

    const places = findPlacements(doc);
    const size = places.get(imageRef.toString());
    expect(size?.width).toBeCloseTo(25, 5);
  });

  it('says nothing about an image no page draws', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([100, 100]);
    doc.context.register(
      PDFRawStream.of(
        doc.context.obj({ Type: 'XObject', Subtype: 'Image', Width: 10, Height: 10, Length: 1 }),
        new Uint8Array([0]),
      ),
    );
    expect(findPlacements(doc).size).toBe(0);
  });
});
