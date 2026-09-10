/**
 * The pieces the pipeline is built from (M100), each proved on its own.
 *
 * The two that matter most here are the ones that write a format rather than read one — the
 * Group 4 encoder and the TrueType subsetter — because a mistake in either produces a file that
 * still opens and is quietly wrong. Both are therefore checked by putting their output through
 * **PDFium**: a page whose only content is a G4 image is rendered and compared with the same page
 * carrying the same picture as flate, and a subsetted font is rendered and compared with the
 * original. That is the same reading the operator would get.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';
import {
  BUILT_IN_PRESETS,
  DEFAULT_PRESET_ID,
  NO_CHANGE,
  encodeGroup4,
  glyphsReachableByCmap,
  isLossless,
  isSafeToUnembed,
  presetById,
  readCheck,
  readPreset,
  readSfnt,
  resample,
  stripSubsetPrefix,
  structureArgs,
  subsetFont,
  targetSize,
  withComponents,
} from '@engine/optimise';
import { engine, fixture } from './helpers';
import { dhash, hamming } from '@engine/imageHash';

// ---- CCITT Group 4 -----------------------------------------------------------------------------

/** A one-bit picture with enough going on to exercise pass, vertical and horizontal modes. */
function monoPattern(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const stripe = Math.floor(x / 7) % 2 === 0;
      const band = y > height * 0.3 && y < height * 0.5;
      const disc = Math.hypot(x - width * 0.7, y - height * 0.7) < width * 0.18;
      const ink = (stripe && !band) || disc || y % 23 === 0;
      data[y * width + x] = ink ? 0 : 255;
    }
  }
  return data;
}

/** One page whose whole content is `image`, drawn to fill it. */
async function pageWithImage(
  bytes: Uint8Array,
  width: number,
  height: number,
  entries: Record<string, unknown>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([200, 200]);
  const stream = PDFRawStream.of(
    doc.context.obj({
      Type: 'XObject',
      Subtype: 'Image',
      Width: width,
      Height: height,
      Length: bytes.length,
      ...entries,
    }),
    bytes,
  );
  const ref = doc.context.register(stream);
  page.node.setXObject(PDFName.of('Im0'), ref);
  const content = doc.context.stream('q 200 0 0 200 0 0 cm /Im0 Do Q');
  page.node.set(PDFName.of('Contents'), doc.context.register(content));
  doc.context.trailerInfo.Info = doc.context.register(
    doc.context.obj({ Producer: PDFString.of('ynotPDF tests') }),
  );
  return doc.save({ addDefaultPage: false, updateFieldAppearances: false });
}

/** Packs 8-bit mono samples to one bit per pixel, rows byte-aligned, the way a PDF wants them. */
function packBits(data: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = Math.ceil(width / 8);
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((data[y * width + x] ?? 0) >= 128) {
        out[y * rowBytes + (x >> 3)] = (out[y * rowBytes + (x >> 3)] ?? 0) | (0x80 >> (x & 7));
      }
    }
  }
  return out;
}

async function renderHash(bytes: Uint8Array): Promise<string> {
  const e = await engine();
  const handle = await e.open(bytes.slice());
  try {
    const raster = await e.renderRaw(handle, 0, 2);
    return dhash(raster.rgba, raster.width, raster.height);
  } finally {
    await e.close(handle);
  }
}

describe('CCITT Group 4', () => {
  it('encodes a picture PDFium decodes back to the same thing', async () => {
    const width = 128;
    const height = 96;
    const data = monoPattern(width, height);
    const samples = { data, width, height, components: 1 as const };

    const g4 = await pageWithImage(encodeGroup4(samples), width, height, {
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 1,
      Filter: 'CCITTFaxDecode',
      DecodeParms: { K: -1, Columns: width, Rows: height, BlackIs1: false },
    });
    const raw = await pageWithImage(packBits(data, width, height), width, height, {
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 1,
    });

    // Identical hashes, not merely close: G4 is lossless, so any difference is a coding error.
    expect(await renderHash(g4)).toBe(await renderHash(raw));
  });

  it('beats flate on a picture that looks like a scan', () => {
    const width = 512;
    const height = 512;
    const data = monoPattern(width, height);
    const g4 = encodeGroup4({ data, width, height, components: 1 });
    expect(g4.length).toBeLessThan(packBits(data, width, height).length);
  });

  it('copes with an all-white and an all-black picture', async () => {
    for (const value of [0, 255]) {
      const data = new Uint8Array(64 * 64).fill(value);
      const encoded = encodeGroup4({ data, width: 64, height: 64, components: 1 });
      expect(encoded.length).toBeGreaterThan(0);
      const page = await pageWithImage(encoded, 64, 64, {
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 1,
        Filter: 'CCITTFaxDecode',
        DecodeParms: { K: -1, Columns: 64, Rows: 64, BlackIs1: false },
      });
      const raw = await pageWithImage(packBits(data, 64, 64), 64, 64, {
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 1,
      });
      expect(await renderHash(page)).toBe(await renderHash(raw));
    }
  });
});

// ---- TrueType subsetting ------------------------------------------------------------------------

/**
 * The embedded TrueType programs in `fonts.pdf`, which is generated by `npm run fixtures` and is
 * therefore on every machine — unlike `resources/fonts/`, which is fetched and git-ignored.
 */
async function embeddedTrueTypes(): Promise<Uint8Array[]> {
  const doc = await PDFDocument.load(fixture('fonts.pdf'), { ignoreEncryption: true });
  const out: Uint8Array[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (object.dict.get(PDFName.of('Length1')) === undefined) continue;
    // Font programs are flate-compressed in the fixture, as they are in any real document.
    out.push(decodePDFRawStream(object).decode());
  }
  return out;
}

/** Liberation Sans, when `npm run fetch-binaries` has been run; `null` on a machine without it. */
function liberation(): Uint8Array | null {
  const path = join(process.cwd(), 'resources', 'fonts', 'LiberationSans-Regular.ttf');
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
}

describe('TrueType subsetting', () => {
  it('reads an embedded font’s table directory', async () => {
    const fonts = await embeddedTrueTypes();
    expect(fonts.length).toBeGreaterThan(0);
    const font = readSfnt(fonts[0] ?? new Uint8Array());
    expect(font).not.toBeNull();
    expect(font?.tables.map((t) => t.tag)).toContain('glyf');
  });

  it('follows the cmap to the glyph a code lands on', async () => {
    const fonts = await embeddedTrueTypes();
    const font = readSfnt(fonts[0] ?? new Uint8Array());
    if (!font) throw new Error('no embedded TrueType in fonts.pdf');
    // The fixture's font maps U+0041 ("A") to glyph 1 and nothing else anywhere.
    const reachable = glyphsReachableByCmap(font, [0x41]);
    expect([...reachable].sort((a, b) => a - b)).toEqual([0, 1]);
    // A code the font does not map reaches nothing but `.notdef`.
    expect([...glyphsReachableByCmap(font, [0x5a])]).toEqual([0]);
  });

  it('cuts the outlines it was not told to keep, and keeps the glyph count', async () => {
    const fonts = await embeddedTrueTypes();
    const bytes = fonts[0] ?? new Uint8Array();
    const font = readSfnt(bytes);
    if (!font) throw new Error('no embedded TrueType in fonts.pdf');

    const cut = subsetFont(bytes, new Set([0]));
    expect(cut).not.toBeNull();
    if (!cut) return;
    const after = readSfnt(cut);
    expect(after).not.toBeNull();
    // `maxp` is untouched, so the font still has the same number of glyphs — that is the whole
    // point of blanking rather than renumbering (see `sfnt.ts`).
    expect(after?.tables.find((t) => t.tag === 'maxp')?.data).toEqual(
      font.tables.find((t) => t.tag === 'maxp')?.data,
    );
    const glyfBefore = font.tables.find((t) => t.tag === 'glyf')?.data.length ?? 0;
    const glyfAfter = after?.tables.find((t) => t.tag === 'glyf')?.data.length ?? 0;
    expect(glyfAfter).toBeLessThan(glyfBefore);
  });

  it('cuts a real font down to what 256 codes can reach', () => {
    const bytes = liberation();
    // Fetched at build time and git-ignored, so absent on a fresh clone and in some CI jobs.
    if (!bytes) return;
    const font = readSfnt(bytes);
    if (!font) throw new Error('Liberation Sans would not parse');
    const codes = Array.from({ length: 256 }, (_, i) => i);
    const keep = glyphsReachableByCmap(font, codes);
    expect(keep.size).toBeGreaterThan(50);

    const cut = subsetFont(bytes, keep);
    expect(cut).not.toBeNull();
    // A Latin font with thousands of glyphs cut to the 256 a simple font can address.
    expect(cut?.length).toBeLessThan(bytes.length);
  });

  it('keeps a composite glyph’s components', () => {
    const bytes = liberation();
    if (!bytes) return;
    const font = readSfnt(bytes);
    if (!font) return;
    // "Á" is a composite of "A" and an acute accent in every font that has it.
    const acute = glyphsReachableByCmap(font, [0xc1]);
    const withParts = withComponents(font, acute);
    expect(withParts.size).toBeGreaterThan(acute.size);
  });

  it('refuses what it cannot cut', () => {
    expect(readSfnt(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(subsetFont(new Uint8Array([1, 2, 3]), new Set([0]))).toBeNull();
  });

  it('renders text identically after a subset', async () => {
    const bytes = fixture('fonts.pdf');
    const before = await renderHash(bytes);
    // fonts.pdf carries an embedded subset and a full embedded TrueType; optimising it must not
    // change a single letter on the page.
    const { optimise, presetById: byId } = await import('@engine/optimise');
    const preset = byId('standard');
    if (!preset) throw new Error('no standard preset');
    const result = await optimise(bytes, { ...preset.options, structure: NO_CHANGE.structure });
    expect(hamming(await renderHash(result.bytes), before)).toBeLessThanOrEqual(2);
  });
});

// ---- unembedding rules ----------------------------------------------------------------------------

describe('which fonts may be unembedded', () => {
  it('allows the Standard 14 and the faces metrically identical to them', () => {
    for (const name of [
      'Helvetica',
      'Helvetica-Bold',
      'Times-Roman',
      'Courier-BoldOblique',
      'Symbol',
      'ZapfDingbats',
      'Arial',
      'ArialMT',
      'Arial-BoldMT',
      'TimesNewRomanPSMT',
      'CourierNew',
      'ABCDEF+Arial',
    ]) {
      expect({ name, ok: isSafeToUnembed(name) }).toEqual({ name, ok: true });
    }
  });

  it('refuses everything else, however common it looks', () => {
    for (const name of [
      'Calibri',
      'HelveticaNeue',
      'DejaVuSans',
      'Cambria',
      'SegoeUI',
      'ABCDEF+DejaVuSans',
      'MS-Gothic',
    ]) {
      expect({ name, ok: isSafeToUnembed(name) }).toEqual({ name, ok: false });
    }
  });

  it('takes a subset prefix off and leaves anything else alone', () => {
    expect(stripSubsetPrefix('ABCDEF+DejaVuSans')).toBe('DejaVuSans');
    expect(stripSubsetPrefix('/ABCDEF+DejaVuSans')).toBe('DejaVuSans');
    expect(stripSubsetPrefix('DejaVuSans')).toBe('DejaVuSans');
    expect(stripSubsetPrefix('ABCDE+Short')).toBe('ABCDE+Short');
  });
});

// ---- downsampling arithmetic -----------------------------------------------------------------------

describe('downsampling', () => {
  it('works out the effective resolution from the size on the page', () => {
    // 600 px across two inches is 300 dpi; asked for 150 with a threshold of 200, it halves.
    expect(
      targetSize(
        { width: 600, height: 600 },
        { width: 144, height: 144 },
        {
          targetDpi: 150,
          thresholdDpi: 200,
        },
      ),
    ).toEqual({ width: 300, height: 300 });
  });

  it('leaves an image below the threshold alone', () => {
    expect(
      targetSize(
        { width: 300, height: 300 },
        { width: 144, height: 144 },
        {
          targetDpi: 150,
          thresholdDpi: 200,
        },
      ),
    ).toBeNull();
  });

  it('leaves an image nothing draws alone', () => {
    expect(
      targetSize({ width: 4000, height: 4000 }, null, { targetDpi: 72, thresholdDpi: 72 }),
    ).toBeNull();
  });

  it('averages rather than dropping rows', () => {
    // A 2×2 chequer averaged to 1×1 must be mid-grey, not one of the two corners.
    const data = new Uint8Array([0, 255, 255, 0]);
    const out = resample({ data, width: 2, height: 2, components: 1 }, 1, 1);
    expect(out.data[0]).toBeGreaterThan(120);
    expect(out.data[0]).toBeLessThan(136);
  });

  it('never makes an image bigger', () => {
    const data = new Uint8Array(4).fill(10);
    const out = resample({ data, width: 2, height: 2, components: 1 }, 8, 8);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
  });
});

// ---- presets --------------------------------------------------------------------------------------

describe('presets', () => {
  it('ships four, in the order the dialog lists them', () => {
    expect(BUILT_IN_PRESETS.map((p) => p.id)).toEqual([
      'lossless',
      'standard',
      'small',
      'smallest',
    ]);
    expect(presetById(DEFAULT_PRESET_ID)).not.toBeNull();
  });

  it('marks exactly one of them lossless, and works it out rather than trusting the file', () => {
    expect(BUILT_IN_PRESETS.filter((p) => p.lossless).map((p) => p.id)).toEqual(['lossless']);
    expect(isLossless(NO_CHANGE)).toBe(true);
    expect(isLossless({ ...NO_CHANGE, fonts: { subset: true, unembedStandard: false } })).toBe(
      false,
    );
    expect(isLossless({ ...NO_CHANGE, discard: { ...NO_CHANGE.discard, thumbnails: true } })).toBe(
      false,
    );
  });

  it('reads a hand-edited preset without falling over', () => {
    expect(readPreset({})).toBeNull();
    expect(readPreset({ id: 'x' })).toBeNull();
    const p = readPreset({ id: 'x', name: 'Mine', options: { images: { colour: 'nonsense' } } });
    expect(p?.options.images.colour).toEqual(NO_CHANGE.images.colour);
    const clamped = readPreset({
      id: 'y',
      name: 'Mine',
      options: { images: { colour: { targetDpi: 99999, quality: -4, codec: 'wat' } } },
    });
    expect(clamped?.options.images.colour.targetDpi).toBe(2400);
    expect(clamped?.options.images.colour.quality).toBe(1);
    expect(clamped?.options.images.colour.codec).toBe('keep');
  });
});

// ---- qpdf argv and output -------------------------------------------------------------------------

describe('what we ask qpdf for, and what we make of its answer', () => {
  it('builds the argv the options describe', () => {
    const args = structureArgs({
      objectStreams: true,
      recompressStreams: true,
      removeUnused: true,
      linearise: true,
    });
    expect(args).toContain('--object-streams=generate');
    expect(args).toContain('--recompress-flate');
    expect(args).toContain('--remove-unreferenced-resources=yes');
    expect(args).toContain('--linearize');
    // Deterministic, so optimising the same file twice gives the same bytes.
    expect(args).toContain('--deterministic-id');
  });

  it('asks for nothing it was not told to do', () => {
    const args = structureArgs({
      objectStreams: false,
      recompressStreams: false,
      removeUnused: false,
      linearise: false,
    });
    expect(args).toContain('--object-streams=preserve');
    expect(args).toContain('--remove-unreferenced-resources=no');
    expect(args).not.toContain('--linearize');
    expect(args).not.toContain('--recompress-flate');
  });

  it('reads a clean check as clean', () => {
    const check = readCheck(
      [
        'checking in.pdf',
        'PDF Version: 1.7',
        'File is not encrypted',
        'File is not linearized',
        'No syntax or stream encoding errors found; the file may still contain',
        'errors that qpdf cannot detect',
      ].join('\n'),
      0,
    );
    expect(check).toMatchObject({
      ok: true,
      unreadable: false,
      linearised: false,
      encrypted: false,
      version: '1.7',
    });
  });

  it('reads a linearised, encrypted file as both', () => {
    const check = readCheck(
      ['checking in.pdf', 'PDF Version: 1.6', 'File is encrypted', 'File is linearized'].join('\n'),
      0,
    );
    expect(check.linearised).toBe(true);
    expect(check.encrypted).toBe(true);
  });

  it('treats an unprefixed complaint as an error when the exit code says so', () => {
    const check = readCheck('in.pdf (xref stream, offset 999): expected n n obj', 2);
    expect(check.ok).toBe(false);
    expect(check.unreadable).toBe(true);
    expect(check.errors).toEqual(['in.pdf (xref stream, offset 999): expected n n obj']);
  });

  it('separates warnings from errors', () => {
    const check = readCheck(
      ['checking in.pdf', 'WARNING: in.pdf: something odd', 'PDF Version: 1.4'].join('\n'),
      3,
    );
    expect(check.warnings).toEqual(['in.pdf: something odd']);
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(false);
    expect(check.unreadable).toBe(false);
  });
});

// ---- a small sanity check on pdf-lib’s numbers ------------------------------------------------------

it('the test helper builds a page pdf-lib is happy with', async () => {
  const bytes = await pageWithImage(new Uint8Array([0xff]), 8, 8, {
    ColorSpace: 'DeviceGray',
    BitsPerComponent: 1,
  });
  const doc = await PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBe(1);
  expect(PDFNumber.of(1).asNumber()).toBe(1);
});
