import { describe, expect, it, vi } from 'vitest';
import * as UTIF from 'utif';
import { PDFDocument, PDFName } from 'pdf-lib';
import { engine } from '../engine/helpers';
import { encodeTiff, type TiffFrame } from '@engine/export/codecs/tiff';
import { encodeRaster, exportImages } from '@engine/export/images';
import { greyToRgba, toMono, type GreyRaster } from '@engine/export/pixels';
import {
  memorySettingsStorage,
  readExportSettings,
  writeExportSettings,
} from '@modules/M92-export/settings';

function picture(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number,
): GreyRaster {
  return {
    width,
    height,
    data: Uint8Array.from({ length: width * height }, (_, i) =>
      pixel(i % width, Math.floor(i / width)),
    ),
  };
}

function frame(grey: GreyRaster, dirtyPadding = false): TiffFrame {
  const mono = toMono(grey, { threshold: 128, dither: 'none' });
  if (dirtyPadding && grey.width % 8) {
    for (let y = 0; y < grey.height; y++) {
      const at = (y + 1) * mono.stride - 1;
      mono.data[at] = (mono.data[at] ?? 0) | ((1 << (8 - (grey.width % 8))) - 1);
    }
  }
  return { kind: 'mono', mono };
}

function decode(bytes: Uint8Array): UTIF.IFD[] {
  const buffer = Uint8Array.from(bytes).buffer;
  const ifds = UTIF.decode(buffer);
  for (const ifd of ifds) {
    UTIF.decodeImage(buffer, ifd);
    // utif 3.1's TIFF dispatcher wrongly copies compressed bytes as raw whenever the
    // strip happens to equal the decoded length (e.g. a 17x2 black G4 image). Call its
    // independent T.6 decoder directly in that case; do not change the file or pixels.
    if ((ifd.t259 as number[])[0] === 4 && (ifd.t279 as number[])[0] === ifd.data?.length) {
      const decoder = UTIF.decode as typeof UTIF.decode & {
        _decodeG4(
          data: Uint8Array,
          offset: number,
          length: number,
          target: Uint8Array,
          targetOffset: number,
          width: number,
          fillOrder: number,
        ): void;
      };
      const target = must(ifd.data);
      target.fill(0);
      decoder._decodeG4(
        new Uint8Array(buffer),
        must((ifd.t273 as number[])[0]),
        must((ifd.t279 as number[])[0]),
        target,
        0,
        must(ifd.width),
        1,
      );
    }
  }
  return ifds;
}

describe('CCITT Group 4 TIFF interoperability', () => {
  it('PDFium independently decodes the short G4 strip that utif dispatches incorrectly', async () => {
    const source = picture(17, 2, () => 0);
    const bytes = encodeTiff([frame(source)], { compression: 'group4' });
    const ifd = must(UTIF.decode(Uint8Array.from(bytes).buffer)[0]);
    const offset = must((ifd.t273 as number[])[0]);
    const length = must((ifd.t279 as number[])[0]);
    expect(length).toBe(6);
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([17, 2]);
    const image = pdf.context.stream(bytes.slice(offset, offset + length), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 17,
      Height: 2,
      BitsPerComponent: 1,
      ColorSpace: 'DeviceGray',
      Filter: 'CCITTFaxDecode',
      DecodeParms: { K: -1, Columns: 17, Rows: 2, BlackIs1: false },
    });
    page.node.setXObject(PDFName.of('Im0'), pdf.context.register(image));
    page.node.set(
      PDFName.of('Contents'),
      pdf.context.register(pdf.context.stream('q 17 0 0 2 0 0 cm /Im0 Do Q')),
    );
    const e = await engine();
    const handle = await e.open(await pdf.save());
    try {
      const pixels = await e.renderRaw(handle, 0, 1);
      expect([pixels.width, pixels.height]).toEqual([17, 2]);
      expect(new Uint8Array(pixels.rgba)).toEqual(greyToRgba(source));
    } finally {
      await e.close(handle);
    }
  });
  for (const width of [1, 7, 8, 9, 17, 63, 64, 65, 1728, 2560, 2625, 5201]) {
    it(`independently decodes every pixel at width ${String(width)}, ignoring row padding`, () => {
      const sources = [
        picture(width, 1, () => 255),
        picture(width, 2, () => 0),
        picture(width, 9, (x, y) => ((x + y) % 2 ? 255 : 0)),
        picture(width, 11, (x, y) => ((x * 17 + y * 43) % 29 < 13 ? 255 : 0)),
        picture(width, 7, (x, y) => (x < width / 2 + y - 3 ? 255 : 0)),
      ];
      const frames = sources.map((source) => frame(source, true));
      const before = frames.map((f) => (f.kind === 'mono' ? f.mono.data.slice() : null));
      const bytes = encodeTiff(frames, { compression: 'group4', dpi: { x: 150, y: 300 } });
      const decoded = decode(bytes);
      expect(decoded).toHaveLength(sources.length);
      for (const [i, ifd] of decoded.entries()) {
        const source = must(sources[i]);
        expect([ifd.width, ifd.height]).toEqual([source.width, source.height]);
        expect(UTIF.toRGBA8(ifd)).toEqual(greyToRgba(source));
        expect(ifd.t258).toEqual([1]);
        expect(ifd.t259).toEqual([4]);
        expect(ifd.t262).toEqual([0]);
        expect(ifd.t266).toEqual([1]);
        expect(ifd.t277).toEqual([1]);
        expect(ifd.t278).toEqual([source.height]);
        expect(ifd.t282).toEqual([150]);
        expect(ifd.t283).toEqual([300]);
        expect(ifd.t293).toEqual([0]);
        expect(ifd.t296).toEqual([2]);
        const start = must((ifd.t273 as number[])[0]);
        const length = must((ifd.t279 as number[])[0]);
        expect(start).toBeGreaterThanOrEqual(8);
        expect(length).toBeGreaterThan(0);
        expect(start + length).toBeLessThan(bytes.length);
        if (i > 0) {
          const previous = must(decoded[i - 1]);
          expect(start).toBeGreaterThanOrEqual(
            must((previous.t273 as number[])[0]) + must((previous.t279 as number[])[0]),
          );
        }
      }
      expect(frames.map((f) => (f.kind === 'mono' ? f.mono.data : null))).toEqual(before);
      // The final IFD really terminates; a decoder's cycle guard must not hide a malformed chain.
      const view = new DataView(bytes.buffer);
      let at = view.getUint32(4, true);
      const seen = new Set<number>();
      for (const _source of sources) {
        expect(_source.width).toBeGreaterThan(0);
        expect(at % 2).toBe(0);
        expect(at).toBeGreaterThan(0);
        expect(seen.has(at)).toBe(false);
        seen.add(at);
        at = view.getUint32(at + 2 + 12 * view.getUint16(at, true), true);
      }
      expect(at).toBe(0);
    });
  }

  it('compresses repeated text-like rows and starts each frame with a fresh reference row', () => {
    const source = picture(1729, 100, (x, y) => (y % 16 < 8 || x % 24 < 8 ? 255 : 0));
    const frames = [frame(source), frame(picture(13, 5, () => 0)), frame(source)];
    const bytes = encodeTiff(frames, { compression: 'group4' });
    expect(bytes.length).toBeLessThan(encodeTiff(frames, { compression: 'none' }).length / 4);
    const decoded = decode(bytes);
    expect(UTIF.toRGBA8(must(decoded[0]))).toEqual(greyToRgba(source));
    expect(UTIF.toRGBA8(must(decoded[2]))).toEqual(greyToRgba(source));
  });

  it('rejects grey, RGB and mixed-frame Group 4 files', () => {
    const grey = picture(9, 3, () => 128);
    for (const invalid of [
      { kind: 'grey', grey },
      { kind: 'rgb', rgba: greyToRgba(grey), width: 9, height: 3 },
    ] as const) {
      expect(() => encodeTiff([frame(grey), invalid], { compression: 'group4' })).toThrow(
        /requires black and white/,
      );
    }
  });

  for (const multiPage of [false, true]) {
    it(`passes compression through the image export (multi-page ${String(multiPage)})`, async () => {
      const sources = [picture(17, 9, (x, y) => (x > y ? 255 : 0)), picture(7, 2, () => 255)];
      const render = vi.fn((page: number) =>
        Promise.resolve({ ...must(sources[page]), data: greyToRgba(must(sources[page])) }),
      );
      for (const [compression, code] of [
        ['none', 1],
        ['packbits', 32773],
        ['deflate', 8],
        ['group4', 4],
      ] as const) {
        const result = await exportImages(render, {
          format: 'tiff',
          dpi: 150,
          colour: 'mono',
          mono: { threshold: 128, dither: 'none' },
          tiffCompression: compression,
          pages: [1, 0],
          pageCount: 2,
          documentName: 'scan',
          multiPage,
        });
        expect(result.files).toHaveLength(multiPage ? 1 : 2);
        const decoded = result.files.flatMap((file) => decode(file.bytes));
        expect(decoded.map((ifd) => ifd.t259)).toEqual([[code], [code]]);
        expect(decoded.map((ifd) => UTIF.toRGBA8(ifd))).toEqual([
          greyToRgba(must(sources[1])),
          greyToRgba(must(sources[0])),
        ]);
      }
      for (const colour of ['colour', 'grey'] as const) {
        render.mockClear();
        await expect(
          exportImages(render, {
            format: 'tiff',
            dpi: 150,
            colour,
            tiffCompression: 'group4',
            pages: [0],
            pageCount: 2,
            documentName: 'scan',
            multiPage,
          }),
        ).rejects.toThrow(/requires black and white/);
        expect(render).not.toHaveBeenCalled();
      }
    });
  }

  it('supports direct raster export and persists the compression setting', async () => {
    const storage = memorySettingsStorage();
    await writeExportSettings(storage, { tiffCompression: 'group4', imageColour: 'mono' });
    const settings = await readExportSettings(storage);
    expect(settings.tiffCompression).toBe('group4');
    const source = picture(9, 2, (x) => (x % 3 ? 255 : 0));
    const bytes = encodeRaster(
      { mode: 'mono', mono: toMono(source, { threshold: 128, dither: 'none' }) },
      { format: 'tiff', dpi: 96, tiffCompression: settings.tiffCompression },
    );
    expect(UTIF.toRGBA8(must(decode(bytes)[0]))).toEqual(greyToRgba(source));
  });
});

function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Missing test value');
  return value;
}
