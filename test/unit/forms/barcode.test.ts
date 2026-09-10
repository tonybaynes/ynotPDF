/**
 * The barcode field: the symbol bwip-js produces, the geometry we turn it into, and — the point
 * of the exercise — that a **second library can read the value back out of the picture we drew**.
 *
 * The decoder is ZXing (Apache-2.0), a dev dependency only: it never ships. Decoding our own
 * polygons rather than bwip-js's own bitmap is deliberate, because the polygons are what reaches
 * the appearance stream, and a mistake in the SVG-path parser or in the y-flip would be invisible
 * to a test that decoded the encoder's own output.
 */

import { describe, expect, it } from 'vitest';
import {
  BinaryBitmap,
  DataMatrixReader,
  DecodeHintType,
  HybridBinarizer,
  PDF417Reader,
  QRCodeReader,
  RGBLuminanceSource,
  type Reader,
} from '@zxing/library';
import {
  BarcodeError,
  barcodeSymbol,
  errorCorrectionRange,
  fitBarcode,
} from '@engine/forms/barcode';
import { DEFAULT_BARCODE, type BarcodeSpec, type BarcodeSymbology } from '@engine/forms/model';

/** The scale each symbology needs to decode reliably in a synthetic bitmap. */
const SCALE: Readonly<Record<BarcodeSymbology, number>> = {
  pdf417: 4,
  qrcode: 6,
  datamatrix: 8,
};

/**
 * Rasterises the symbol the way the appearance stream draws it: **one path, non-zero winding**.
 *
 * That is not a detail. A QR finder pattern is a filled square with a white ring inside it, and
 * the ring is a sub-path wound the other way — fill each sub-path on its own and every finder
 * comes out solid, which no decoder will look at twice. The content stream emits every sub-path
 * and one `f`, so this does the same.
 */
function decode(spec: BarcodeSpec, text: string): string | null {
  const symbol = barcodeSymbol(spec, text);
  if (!symbol) return null;
  const scale = SCALE[spec.symbology];
  const quiet = 4 * scale;
  const width = Math.ceil(symbol.width * scale) + quiet * 2;
  const height = Math.ceil(symbol.height * scale) + quiet * 2;
  // One luminance byte per pixel: `RGBLuminanceSource` takes either that or packed ARGB
  // `Int32Array`s, and a four-byte-per-pixel array is read as four pixels' worth of grey.
  const luminance = new Uint8ClampedArray(width * height).fill(255);

  const rows = Math.ceil(symbol.height * scale);
  for (let y = 0; y < rows; y++) {
    const centre = y + 0.5;
    const crossings: Array<{ x: number; direction: number }> = [];
    for (const polygon of symbol.polygons) {
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        if (!a || !b) continue;
        const ay = a.y * scale;
        const by = b.y * scale;
        if (ay === by) continue;
        if (centre < Math.min(ay, by) || centre >= Math.max(ay, by)) continue;
        const t = (centre - ay) / (by - ay);
        crossings.push({
          x: a.x * scale + t * (b.x * scale - a.x * scale),
          direction: by > ay ? 1 : -1,
        });
      }
    }
    crossings.sort((p, q) => p.x - q.x);
    let winding = 0;
    for (let i = 0; i < crossings.length; i++) {
      winding += crossings[i]?.direction ?? 0;
      if (winding === 0) continue;
      const from = Math.round(crossings[i]?.x ?? 0);
      const to = Math.round(crossings[i + 1]?.x ?? from);
      for (let x = from; x < to; x++) {
        const px = x + quiet;
        const py = y + quiet;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        luminance[py * width + px] = 0;
      }
    }
  }

  const source = new RGBLuminanceSource(luminance, width, height);
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));
  const reader: Reader =
    spec.symbology === 'qrcode'
      ? new QRCodeReader()
      : spec.symbology === 'datamatrix'
        ? new DataMatrixReader()
        : new PDF417Reader();
  const hints = new Map<DecodeHintType, unknown>([[DecodeHintType.TRY_HARDER, true]]);
  return reader.decode(bitmap, hints).getText();
}

describe('the barcode encoder', () => {
  it('has nothing to draw for an empty value', () => {
    expect(barcodeSymbol(DEFAULT_BARCODE, '')).toBeNull();
  });

  it('produces polygons inside its own view box', () => {
    const symbol = barcodeSymbol(DEFAULT_BARCODE, 'HELLO');
    expect(symbol).not.toBeNull();
    expect(symbol?.polygons.length).toBeGreaterThan(0);
    for (const polygon of symbol?.polygons ?? []) {
      for (const p of polygon) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(symbol?.width ?? 0);
        expect(p.y).toBeLessThanOrEqual(symbol?.height ?? 0);
      }
    }
  });

  it('says which symbologies offer an error-correction setting', () => {
    const pdf417 = errorCorrectionRange('pdf417');
    expect(pdf417?.min).toBe(0);
    expect(pdf417?.max).toBe(8);
    expect(pdf417?.label).toContain('0');
    expect(errorCorrectionRange('qrcode')?.max).toBe(4);
    // Data Matrix fixes its own (ECC 200), so there is nothing to offer.
    expect(errorCorrectionRange('datamatrix')).toBeNull();
  });

  it('keeps the symbol shape when it fits it into a box', () => {
    const symbol = barcodeSymbol(DEFAULT_BARCODE, 'HELLO');
    expect(symbol).not.toBeNull();
    if (!symbol) return;
    const fitted = fitBarcode(
      symbol,
      { ...DEFAULT_BARCODE, cellSize: 4 },
      {
        width: 100,
        height: 40,
      },
    );
    expect(fitted.width).toBeLessThanOrEqual(100.001);
    expect(fitted.height).toBeLessThanOrEqual(40.001);
    expect(fitted.width / fitted.height).toBeCloseTo(symbol.width / symbol.height, 5);
  });

  it('refuses a value a symbology cannot carry, in words', () => {
    // Data Matrix has a hard capacity; a value far past it is an error rather than a wrong symbol.
    expect(() =>
      barcodeSymbol({ ...DEFAULT_BARCODE, symbology: 'datamatrix' }, 'x'.repeat(5000)),
    ).toThrow(BarcodeError);
  });
});

describe('a second library reads back what we drew', () => {
  it('decodes a PDF417 symbol', () => {
    expect(decode({ symbology: 'pdf417', errorCorrection: 5, cellSize: 1 }, 'ORDER-4711')).toBe(
      'ORDER-4711',
    );
  });

  it('decodes a QR symbol', () => {
    expect(decode({ symbology: 'qrcode', errorCorrection: 2, cellSize: 1 }, 'ynotPDF M60')).toBe(
      'ynotPDF M60',
    );
  });

  it('decodes a Data Matrix symbol', () => {
    expect(decode({ symbology: 'datamatrix', errorCorrection: 0, cellSize: 1 }, 'DM-2026')).toBe(
      'DM-2026',
    );
  });
});
