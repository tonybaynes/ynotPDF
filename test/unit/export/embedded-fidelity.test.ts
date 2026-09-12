import { describe, expect, it } from 'vitest';
import UPNG from '@pdf-lib/upng';
import jpeg from 'jpeg-js';
import { deflate } from 'pako';
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFArray,
  type PDFRawStream,
  type PDFObject,
} from 'pdf-lib';
import { extractPageImages } from '@engine/pdfium/imageExtraction';
import { engine } from '../engine/helpers';
import { collectTransferables } from '@engine/rpc';
import { ALL_ALLOWED } from '@engine/security/types';
import { security } from '../security/helpers';
import {
  memorySettingsStorage,
  readExportSettings,
  writeExportSettings,
} from '@modules/M92-export/settings';
import { exportEmbeddedImages, contentKey, type EmbeddedImageLike } from '@engine/export/embedded';
import {
  ALPHA,
  OTHER_ALPHA,
  JP2,
  RGB,
  SRGB_PROFILE,
  embeddedFixture,
  rgbaOf,
} from './embedded-fixtures';

function decodePng(bytes: Uint8Array): { width: number; height: number; data: Uint8Array } {
  const png = UPNG.decode(Uint8Array.from(bytes).buffer);
  return { width: png.width, height: png.height, data: new Uint8Array(must(UPNG.toRGBA8(png)[0])) };
}

async function extractSingle(
  build: (pdf: PDFDocument) => PDFRawStream,
): Promise<EmbeddedImageLike> {
  const pdf = await PDFDocument.create();
  const image = build(pdf);
  const width = image.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber();
  const height = image.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber();
  const page = pdf.addPage([100, 100]);
  page.node.set(
    PDFName.of('Resources'),
    pdf.context.obj({ XObject: { Picture: pdf.context.register(image) } }),
  );
  page.node.set(
    PDFName.of('Contents'),
    pdf.context.register(pdf.context.flateStream('q 40 7 3 19 10 20 cm /Picture Do Q')),
  );
  const e = await engine();
  const doc = await e.open(await pdf.save());
  try {
    const images = await e.pageImages(doc, 0, { output: 'png' });
    expect(images).toHaveLength(1);
    expect([must(images[0]).width, must(images[0]).height]).toEqual([width, height]);
    return must(images[0]);
  } finally {
    await e.close(doc);
  }
}

/** Fully transparent RGB is undefined after compositing; visible channels must stay straight. */
function expectPixels(actual: Uint8Array, rgb: Uint8Array, alpha: Uint8Array, tolerance = 0): void {
  expect(actual).toHaveLength(alpha.length * 4);
  for (let i = 0; i < alpha.length; i++) {
    expect(actual[i * 4 + 3], `alpha pixel ${i}`).toBe(alpha[i]);
    if (alpha[i] === 0) continue;
    for (let c = 0; c < 3; c++)
      expect(
        Math.abs((actual[i * 4 + c] ?? -999) - (rgb[i * 3 + c] ?? 999)),
        `colour pixel ${i} channel ${c}`,
      ).toBeLessThanOrEqual(tolerance);
  }
}

describe('intrinsic embedded images through the real PDFium adapter', () => {
  for (const kind of ['Separation', 'DeviceN'] as const) {
    it(`resolves ${kind} alternate spaces without substituting colliding colorant resource names`, async () => {
      const pdf = await PDFDocument.create();
      const tint =
        kind === 'Separation'
          ? pdf.context.register(
              pdf.context.obj({
                FunctionType: 2,
                Domain: [0, 1],
                C0: [1, 1, 1],
                C1: [1, 0, 0],
                N: 1,
              }),
            )
          : pdf.context.register(
              pdf.context.flateStream('{ pop 1 exch dup }', {
                FunctionType: 4,
                Domain: [0, 1, 0, 1],
                Range: [0, 1, 0, 1, 0, 1],
              }),
            );
      const cs =
        kind === 'Separation'
          ? ['Separation', 'Spot', 'Alternate', tint]
          : ['DeviceN', ['Spot', 'Shade'], 'Alternate', tint];
      const samples = kind === 'Separation' ? [0, 127, 255] : [0, 0, 127, 255, 255, 0];
      const image = pdf.context.register(
        pdf.context.flateStream(Uint8Array.from(samples), {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 3,
          Height: 1,
          BitsPerComponent: 8,
          ColorSpace: cs,
        }),
      );
      const page = pdf.addPage([30, 10]);
      page.node.set(
        PDFName.of('Resources'),
        pdf.context.obj({
          XObject: { Image: image },
          ColorSpace: { Spot: 'DeviceCMYK', Shade: 'DeviceGray', Alternate: 'DeviceRGB' },
        }),
      );
      page.node.set(
        PDFName.of('Contents'),
        pdf.context.register(pdf.context.flateStream('q 30 0 0 10 0 0 cm /Image Do Q')),
      );
      const e = await engine();
      const doc = await e.open(await pdf.save());
      try {
        const images = await e.pageImages(doc, 0);
        expect(images).toHaveLength(1);
        const rgb =
          kind === 'Separation'
            ? [255, 255, 255, 255, 128, 128, 255, 0, 0]
            : [255, 0, 0, 255, 127, 127, 255, 255, 255];
        expectPixels(must(images[0]).data, Uint8Array.from(rgb), new Uint8Array(3).fill(255), 1);
      } finally {
        await e.close(doc);
      }
    });
  }

  it('rejects cyclic indirect colour-space arrays before invoking the decoder', async () => {
    const pdf = await PDFDocument.create();
    const colour = PDFArray.withContext(pdf.context);
    const ref = pdf.context.register(colour);
    for (const item of [
      PDFName.of('Indexed'),
      ref,
      PDFNumber.of(1),
      pdf.context.register(pdf.context.stream(new Uint8Array(6))),
    ])
      colour.push(item);
    const image = pdf.context.register(
      pdf.context.flateStream(new Uint8Array(1), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 1,
        Height: 1,
        BitsPerComponent: 8,
        ColorSpace: ref,
      }),
    );
    const page = pdf.addPage([10, 10]);
    page.node.set(PDFName.of('Resources'), pdf.context.obj({ XObject: { Image: image } }));
    page.node.set(
      PDFName.of('Contents'),
      pdf.context.register(pdf.context.flateStream('q 10 0 0 10 0 0 cm /Image Do Q')),
    );
    let decodes = 0;
    await expect(
      extractPageImages(await pdf.save(), 0, () => {
        decodes++;
        return new Uint8Array(4);
      }),
    ).rejects.toThrow('Cyclic image colour');
    expect(decodes).toBe(0);
  });
  it('keeps one shared image distinct when Form resources give its named colour space different meanings', async () => {
    const pdf = await PDFDocument.create();
    const palette = Uint8Array.from({ length: 256 * 3 }, (_, i) =>
      i % 3 === 0 ? Math.floor(i / 3) : 0,
    );
    const image = pdf.context.register(
      pdf.context.flateStream(Uint8Array.from([0, 127, 255]), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 3,
        Height: 1,
        BitsPerComponent: 8,
        ColorSpace: 'Tone',
      }),
    );
    const form = (colour: PDFObject) =>
      pdf.context.register(
        pdf.context.flateStream('q 3 0 0 1 0 0 cm /Shared Do Q', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 3, 1],
          Resources: { XObject: { Shared: image }, ColorSpace: { Tone: colour } },
        }),
      );
    const gray = form(pdf.context.obj('DeviceGray'));
    const indexed = form(
      pdf.context.obj([
        'Indexed',
        'DeviceRGB',
        255,
        pdf.context.register(pdf.context.stream(palette)),
      ]),
    );
    const page = pdf.addPage([100, 100]);
    page.node.set(
      PDFName.of('Resources'),
      pdf.context.obj({ XObject: { Gray: gray, Red: indexed } }),
    );
    page.node.set(
      PDFName.of('Contents'),
      pdf.context.register(pdf.context.flateStream('/Gray Do /Red Do')),
    );
    const e = await engine();
    const doc = await e.open(await pdf.save());
    try {
      const images = await e.pageImages(doc, 0);
      expect(images).toHaveLength(2);
      expectPixels(
        must(images[0]).data,
        Uint8Array.from([0, 0, 0, 127, 127, 127, 255, 255, 255]),
        new Uint8Array(3).fill(255),
      );
      expectPixels(
        must(images[1]).data,
        Uint8Array.from([0, 0, 0, 127, 0, 0, 255, 0, 0]),
        new Uint8Array(3).fill(255),
      );
      expect(
        exportEmbeddedImages(images, { documentName: 'contexts', pageCount: 1, minPixels: 1 })
          .files,
      ).toHaveLength(2);
    } finally {
      await e.close(doc);
    }
  });

  it('decodes a Flate-wrapped JPEG filter chain instead of writing compressed bytes as a JPEG', async () => {
    const { jpegBytes } = await embeddedFixture();
    const image = await extractSingle((pdf) =>
      pdf.context.stream(deflate(jpegBytes), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 3,
        Height: 2,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceRGB',
        Filter: ['FlateDecode', 'DCTDecode'],
      }),
    );
    const decoded = jpeg.decode(jpegBytes, { useTArray: true }).data;
    const rgb = Uint8Array.from(
      { length: 18 },
      (_, i) => decoded[Math.floor(i / 3) * 4 + (i % 3)] ?? 0,
    );
    expect(image.encoding).toBe('rgba');
    expectPixels(image.data, rgb, new Uint8Array(6).fill(255), 2);
  });
  it('keeps repeated decoded buffers separately transferable through the existing RPC', async () => {
    const { bytes } = await embeddedFixture();
    const e = await engine();
    const doc = await e.open(bytes);
    try {
      const images = await e.pageImages(doc, 0, { output: 'png' });
      const transfer = collectTransferables(images);
      expect(new Set(transfer).size).toBe(transfer.length);
      const received = structuredClone(images, { transfer });
      expectPixels(must(received[0]).data, RGB, ALPHA);
      expectPixels(must(received[1]).data, RGB, ALPHA);
    } finally {
      await e.close(doc);
    }
  });

  it('extracts an opened encrypted document without altering its protection', async () => {
    const { bytes } = await embeddedFixture();
    const protectedFile = await security().protect(
      bytes,
      {
        kind: 'password',
        algorithm: 'aes-256',
        scope: 'all',
        permissions: ALL_ALLOWED,
        hasUserPassword: true,
        hasOwnerPassword: true,
      },
      { user: 'synthetic-user', owner: 'synthetic-owner' },
    );
    const e = await engine();
    const doc = await e.open(protectedFile.bytes, { password: 'synthetic-user' });
    try {
      const decoded = await e.pageImages(doc, 0, { output: 'png' });
      expectPixels(must(decoded[0]).data, RGB, ALPHA);
      expect((await security().inspect(await e.save(doc))).encrypted).toBe(true);
    } finally {
      await e.close(doc);
    }
  });
  it('keeps soft masks, stored dimensions and nested occurrences, independent of placement clipping/opacity', async () => {
    const { bytes } = await embeddedFixture();
    const e = await engine();
    const doc = await e.open(bytes);
    try {
      const before = await e.save(doc);
      const images = await e.pageImages(doc, 0);
      expect(images).toHaveLength(7);
      expect(images.map((i) => [i.width, i.height])).toEqual(
        Array.from({ length: 7 }, () => [3, 2]),
      );
      expect(images.map((i) => i.index)).toEqual([0, 1, 2, 3, 4, 5, 5]);
      expectPixels(must(images[0]).data, RGB, ALPHA);
      expect(must(images[1]).data).toEqual(must(images[0]).data);
      expectPixels(must(images[2]).data, RGB, OTHER_ALPHA);
      expectPixels(must(images[5]).data, RGB, ALPHA);
      expectPixels(must(images[6]).data, RGB, OTHER_ALPHA);
      expect([must(images[0]).dpiX, must(images[0]).dpiY]).toEqual([36, 36]);
      expect([must(images[1]).dpiX, must(images[1]).dpiY]).toEqual([18, 24]);
      expect([must(images[5]).dpiX, must(images[5]).dpiY]).toEqual([3.6, 3.6]);
      expect(await e.save(doc)).toEqual(before);
      const other = await e.pageImages(doc, 1);
      expect(must(other[0]).data).toEqual(must(images[0]).data);
      const output = exportEmbeddedImages([...images, ...other], {
        documentName: 'synthetic',
        pageCount: 2,
        minPixels: 1,
      });
      expect(output.files).toHaveLength(4); // two mask variants + original JPEG + original JP2
      expect(output.files.map((f) => f.name.split('.').at(-1))).toEqual([
        'png',
        'png',
        'jpg',
        'jp2',
      ]);
      const png = decodePng(must(output.files[0]).bytes);
      expect([png.width, png.height]).toEqual([3, 2]);
      expectPixels(png.data, RGB, ALPHA);
      const everyPlacement = exportEmbeddedImages([...images, ...other], {
        documentName: 'synthetic',
        pageCount: 2,
        minPixels: 1,
        keepDuplicates: true,
      });
      expect(everyPlacement.files).toHaveLength(8);
    } finally {
      await e.close(doc);
    }
  });

  it('preserves original JPEG/JP2 bytes by default, and applies their external masks in PNG mode', async () => {
    const { bytes, jpegBytes } = await embeddedFixture();
    const e = await engine();
    const doc = await e.open(bytes);
    try {
      const original = await e.pageImages(doc, 0, { output: 'original' });
      expect(must(original[3]).encoding).toBe('jpeg');
      expect(must(original[3]).data).toEqual(jpegBytes);
      expect(must(original[4]).encoding).toBe('jp2');
      expect(must(original[4]).data).toEqual(JP2);
      const decoded = await e.pageImages(doc, 0, { output: 'png' });
      expect(decoded.every((image) => image.encoding === 'rgba')).toBe(true);
      expectPixels(must(decoded[4]).data, RGB, ALPHA);
      // jpeg-js is an independent JPEG decoder, not the exporter or PDFium.
      const jpegPixels = jpeg.decode(jpegBytes, { useTArray: true }).data;
      const rgb = Uint8Array.from(
        { length: 18 },
        (_, i) => jpegPixels[Math.floor(i / 3) * 4 + (i % 3)] ?? 0,
      );
      expectPixels(must(decoded[3]).data, rgb, ALPHA, 2);
    } finally {
      await e.close(doc);
    }
  });

  it('reflects current edited page objects and stays read-only', async () => {
    const { bytes } = await embeddedFixture();
    const e = await engine();
    const doc = await e.open(bytes);
    try {
      await e.setObjectMatrix(doc, 0, 0, [12, 0, 0, 8, 1, 2]);
      const before = await e.save(doc);
      const images = await e.pageImages(doc, 0, { output: 'png' });
      expect([must(images[0]).dpiX, must(images[0]).dpiY]).toEqual([18, 18]);
      expectPixels(must(images[0]).data, RGB, ALPHA);
      expect(await e.save(doc)).toEqual(before);
    } finally {
      await e.close(doc);
    }
  });

  it('reports cyclic form resources instead of hanging or silently dropping images', async () => {
    const pdf = await PDFDocument.create();
    const form = pdf.context.flateStream('/Self Do', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 10, 10],
    });
    const ref = pdf.context.register(form);
    form.dict.set(PDFName.of('Resources'), pdf.context.obj({ XObject: { Self: ref } }));
    const page = pdf.addPage([20, 20]);
    page.node.set(PDFName.of('Resources'), pdf.context.obj({ XObject: { Form: ref } }));
    page.node.set(
      PDFName.of('Contents'),
      pdf.context.register(pdf.context.flateStream('/Form Do')),
    );
    const e = await engine();
    const doc = await e.open(await pdf.save());
    try {
      await expect(e.pageImages(doc, 0)).rejects.toThrow('Cyclic');
    } finally {
      await e.close(doc);
    }
  });

  it('honours grayscale Decode arrays instead of treating filtered samples as final colours', async () => {
    const image = await extractSingle((pdf) =>
      pdf.context.flateStream(Uint8Array.from([0, 64, 128, 192, 255, 16]), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 3,
        Height: 2,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceGray',
        Decode: [1, 0],
      }),
    );
    expectPixels(
      image.data,
      Uint8Array.from([255, 191, 127, 63, 0, 239].flatMap((v) => [v, v, v])),
      new Uint8Array(6).fill(255),
    );
  });

  it('decodes odd-width bilevel rows without reading padding pixels', async () => {
    const image = await extractSingle((pdf) =>
      pdf.context.flateStream(Uint8Array.from([0x80, 0x7f, 0x7f, 0xff]), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 9,
        Height: 2,
        BitsPerComponent: 1,
        ColorSpace: 'DeviceGray',
      }),
    );
    const gray = [255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255];
    expectPixels(
      image.data,
      Uint8Array.from(gray.flatMap((v) => [v, v, v])),
      new Uint8Array(18).fill(255),
    );
  });

  it('keeps Indexed palette colours and intrinsic size instead of placement raster dimensions', async () => {
    const image = await extractSingle((pdf) =>
      pdf.context.flateStream(Uint8Array.from([0, 1, 2, 3, 4, 5]), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 3,
        Height: 2,
        BitsPerComponent: 8,
        ColorSpace: pdf.context.obj([
          PDFName.of('Indexed'),
          PDFName.of('DeviceRGB'),
          5,
          pdf.context.register(pdf.context.stream(RGB)),
        ]),
      }),
    );
    expectPixels(image.data, RGB, new Uint8Array(6).fill(255));
  });

  it('decodes DeviceCMYK at stored size with a real colour conversion', async () => {
    const image = await extractSingle((pdf) =>
      pdf.context.flateStream(Uint8Array.from([0, 0, 0, 0, 255, 255, 255, 255]), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 2,
        Height: 1,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceCMYK',
      }),
    );
    expect([...image.data.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    expect(image.data[7]).toBe(255);
    for (const channel of image.data.subarray(4, 7)) expect(channel).toBeLessThan(16);
  });

  it('retains ICCBased colour conversion and soft-mask alpha at intrinsic dimensions', async () => {
    const image = await extractSingle((pdf) => {
      const profile = pdf.context.register(
        pdf.context.flateStream(SRGB_PROFILE, { N: 3, Alternate: 'DeviceRGB' }),
      );
      const mask = pdf.context.register(
        pdf.context.flateStream(ALPHA, {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 3,
          Height: 2,
          BitsPerComponent: 8,
          ColorSpace: 'DeviceGray',
        }),
      );
      return pdf.context.flateStream(RGB, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 3,
        Height: 2,
        BitsPerComponent: 8,
        ColorSpace: ['ICCBased', profile],
        SMask: mask,
      });
    });
    expectPixels(image.data, RGB, ALPHA, 1);
  });

  it('scales an image-level mask to the base image dimensions, not the page placement', async () => {
    const rgb = Uint8Array.from({ length: 4 * 4 * 3 }, (_, i) => (i % 3 === 0 ? 255 : 0));
    const image = await extractSingle((pdf) => {
      const mask = pdf.context.register(
        pdf.context.flateStream(Uint8Array.from([0, 85, 170, 255]), {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 2,
          Height: 2,
          BitsPerComponent: 8,
          ColorSpace: 'DeviceGray',
          Interpolate: false,
        }),
      );
      return pdf.context.flateStream(rgb, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 4,
        Height: 4,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceRGB',
        SMask: mask,
      });
    });
    // PDFium uses bilinear quality resampling for this upsampled soft mask. Compute
    // the expected plane independently at target pixel centres, with clamped edges.
    const expectedAlpha = Uint8Array.from({ length: 16 }, (_, i) => {
      const x = Math.max(0, Math.min(1, ((i % 4) + 0.5) / 2 - 0.5));
      const y = Math.max(0, Math.min(1, (Math.floor(i / 4) + 0.5) / 2 - 0.5));
      // The separable byte passes round down after each axis.
      return Math.floor(85 * x) + Math.floor(170 * y);
    });
    expectPixels(image.data, rgb, expectedAlpha);
  });

  it('applies a colour-key image Mask', async () => {
    const image = await extractSingle((pdf) =>
      pdf.context.flateStream(RGB, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 3,
        Height: 2,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceRGB',
        Mask: [255, 255, 0, 0, 0, 0],
      }),
    );
    expectPixels(image.data, RGB, Uint8Array.from([0, 255, 255, 255, 255, 255]));
  });

  it('applies a stencil Mask stream and undoes Matte preblending in a soft mask', async () => {
    const hard = await extractSingle((pdf) => {
      const mask = pdf.context.register(
        pdf.context.flateStream(Uint8Array.from([0x40]), {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 3,
          Height: 1,
          ImageMask: true,
          BitsPerComponent: 1,
        }),
      );
      return pdf.context.flateStream(RGB.subarray(0, 9), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 3,
        Height: 1,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceRGB',
        Mask: mask,
      });
    });
    expectPixels(hard.data, RGB.subarray(0, 9), Uint8Array.from([255, 0, 255]));
    const matte = await extractSingle((pdf) => {
      const mask = pdf.context.register(
        pdf.context.flateStream(Uint8Array.from([85]), {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 1,
          Height: 1,
          BitsPerComponent: 8,
          ColorSpace: 'DeviceGray',
          Matte: [1, 1, 1],
        }),
      );
      return pdf.context.flateStream(Uint8Array.from([255, 170, 170]), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 1,
        Height: 1,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceRGB',
        SMask: mask,
      });
    });
    expectPixels(matte.data, Uint8Array.from([255, 0, 0]), Uint8Array.from([85]), 1);
  });

  it.each(['RGB', 'W'])(
    'reads inline images with colour %s without rewriting resource names as dictionary keys',
    async (colour) => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([100, 100]);
      page.node.set(PDFName.of('Resources'), pdf.context.obj({ ColorSpace: { W: 'DeviceRGB' } }));
      const prefix = new TextEncoder().encode(
        `q 40 0 0 20 0 0 cm BI /W 3 /H 2 /BPC 8 /CS /${colour} ID `,
      );
      const suffix = new TextEncoder().encode(' EI Q');
      const stream = new Uint8Array(prefix.length + RGB.length + suffix.length);
      stream.set(prefix);
      stream.set(RGB, prefix.length);
      stream.set(suffix, prefix.length + RGB.length);
      page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.flateStream(stream)));
      const e = await engine();
      const doc = await e.open(await pdf.save());
      try {
        const images = await e.pageImages(doc, 0);
        expect(images).toHaveLength(1);
        expectPixels(must(images[0]).data, RGB, new Uint8Array(6).fill(255));
      } finally {
        await e.close(doc);
      }
    },
  );
});

describe('lossless alpha and exact duplicate identity', () => {
  it('defaults to original formats and persists the explicit PNG choice', async () => {
    const storage = memorySettingsStorage();
    expect((await readExportSettings(storage)).embeddedOutput).toBe('original');
    await writeExportSettings(storage, { embeddedOutput: 'png' });
    expect((await readExportSettings(storage)).embeddedOutput).toBe('png');
  });
  const image = (data: Uint8Array, width: number, height: number): EmbeddedImageLike => ({
    page: 0,
    index: 0,
    width,
    height,
    dpiX: 150,
    dpiY: 300,
    encoding: 'rgba',
    data,
  });
  it('retains every RGBA channel in an independently decoded PNG, including RGB beneath zero alpha', () => {
    const rgba = rgbaOf(RGB, ALPHA);
    const out = exportEmbeddedImages([image(rgba, 3, 2)], {
      documentName: 'alpha',
      pageCount: 1,
      minPixels: 1,
    });
    const png = decodePng(must(out.files[0]).bytes);
    expect(Uint8Array.from(png.data)).toEqual(rgba);
    expect(must(out.files[0]).bytes[25]).toBe(6); // truecolour + alpha
  });
  it('does not collapse identical byte arrays with different dimensions or encoding', () => {
    const rgba = rgbaOf(RGB, ALPHA);
    const out = exportEmbeddedImages(
      [image(rgba, 3, 2), image(rgba, 2, 3), { ...image(rgba, 3, 2), encoding: 'jpeg' }],
      { documentName: 'shape', pageCount: 1, minPixels: 1 },
    );
    expect(out.files).toHaveLength(3);
  });
  it('uses a hash only to select a bucket, never as proof that image bytes match', () => {
    // Deterministic genuine FNV-1a collision, not a mocked hash function.
    const a = Uint8Array.from([192, 128, 79, 7, 14, 138, 175, 195]);
    const b = Uint8Array.from([153, 149, 45, 176, 38, 187, 129, 51]);
    expect(contentKey(a)).toBe(contentKey(b));
    const out = exportEmbeddedImages([image(a, 2, 1), image(b, 2, 1), image(a, 2, 1)], {
      documentName: 'bytes',
      pageCount: 1,
      minPixels: 1,
    });
    expect(out.files).toHaveLength(2);
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing expected test value');
  return value;
}
