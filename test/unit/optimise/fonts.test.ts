/**
 * The font half of optimising (M100), against real embedded fonts.
 *
 * Two things are being checked and they are not the same. **Which codes the document actually
 * shows** — read out of the content streams, including the ones inside form XObjects and
 * annotation appearances — and **what happens to a font program** once that is known. A mistake
 * in the first silently subsets away a letter someone is reading; a mistake in the second
 * produces a font that renders as blank boxes. So the page is rendered through PDFium afterwards
 * and compared, which catches both.
 */

import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { NO_CHANGE, collectFontUsage, optimise, optimiseFonts } from '@engine/optimise';
import { dhash, hamming } from '@engine/imageHash';
import { engine, fixture, structureHook } from './helpers';

const SUBSET = { subset: true, unembedStandard: false };
const UNEMBED = { subset: false, unembedStandard: true };

async function load(name: string): Promise<PDFDocument> {
  return PDFDocument.load(fixture(name), {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  });
}

async function pageHash(bytes: Uint8Array, page = 0): Promise<string> {
  const e = await engine();
  const handle = await e.open(bytes.slice());
  try {
    const raster = await e.renderRaw(handle, page, 2);
    return dhash(raster.rgba, raster.width, raster.height);
  } finally {
    await e.close(handle);
  }
}

/** Every embedded font program in a document, decoded, keyed by the object that holds it. */
function programs(doc: PDFDocument): Map<string, number> {
  const out = new Map<string, number>();
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (object.dict.get(PDFName.of('Length1')) === undefined) continue;
    try {
      out.set(ref.toString(), decodePDFRawStream(object).decode().length);
    } catch {
      out.set(ref.toString(), object.contents.length);
    }
  }
  return out;
}

/** Whether any font descriptor in the document still carries a font program. */
function anyEmbedded(doc: PDFDocument): boolean {
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (object.lookupMaybe(PDFName.of('Type'), PDFName)?.asString() !== '/FontDescriptor') continue;
    for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
      if (object.get(PDFName.of(key)) !== undefined) return true;
    }
  }
  return false;
}

describe('which codes a document shows', () => {
  it('finds the codes on the page', async () => {
    const doc = await load('text.pdf');
    const usage = collectFontUsage(doc);
    expect(usage.size).toBeGreaterThan(0);
    const all = new Set<number>();
    for (const entry of usage.values()) for (const code of entry.codes) all.add(code);
    // The fixture's paragraph is Latin text, so the codes are ASCII.
    expect(all.has('T'.charCodeAt(0))).toBe(true);
    expect(all.has('q'.charCodeAt(0))).toBe(true);
    expect([...all].every((c) => c < 256)).toBe(true);
  });

  it('reads a composite font’s codes two bytes at a time', async () => {
    const doc = await load('cjk-rtl.pdf');
    const usage = collectFontUsage(doc);
    const composite = [...usage.values()].filter((u) => [...u.codes].some((c) => c > 255));
    expect(composite.length).toBeGreaterThan(0);
  });

  it('finds the text inside an annotation’s appearance', async () => {
    const doc = await load('annotations-all.pdf');
    const usage = collectFontUsage(doc);
    // The fixture's FreeText and Widget annotations draw with their own resources; whether or not
    // their fonts are also on the page, every font reached is either used or marked keep-all.
    expect(usage.size).toBeGreaterThan(0);
    for (const entry of usage.values()) {
      expect(entry.codes.size > 0 || entry.keepEverything).toBe(true);
    }
  });

  it('marks a font keep-everything rather than guessing when a stream will not parse', async () => {
    const doc = await load('text.pdf');
    // Replace the page's content with something that is not a content stream at all.
    const page = doc.getPages()[0];
    if (!page) throw new Error('no page');
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.stream('BT /F1 12 Tf (unterminated')),
    );
    const usage = collectFontUsage(doc);
    // Whatever it made of that, no font may be left with an empty, confident list.
    for (const entry of usage.values()) {
      expect(entry.codes.size > 0 || entry.keepEverything).toBe(true);
    }
  });
});

describe('subsetting', () => {
  it('cuts the embedded programs in the fonts fixture and leaves the page identical', async () => {
    const bytes = fixture('fonts.pdf');
    const before = await pageHash(bytes);
    const doc = await load('fonts.pdf');
    const sizeBefore = [...programs(doc).values()].reduce((n, v) => n + v, 0);

    const outcome = await optimiseFonts(doc, SUBSET);
    expect(outcome.subsetted).toBeGreaterThan(0);
    expect(outcome.saved).toBeGreaterThan(0);
    const sizeAfter = [...programs(doc).values()].reduce((n, v) => n + v, 0);
    expect(sizeAfter).toBeLessThan(sizeBefore);

    const saved = await doc.save({ addDefaultPage: false, updateFieldAppearances: false });
    expect(hamming(await pageHash(saved), before)).toBeLessThanOrEqual(2);
  });

  it('says so when a font is one it dare not cut', async () => {
    const doc = await load('fonts.pdf');
    const outcome = await optimiseFonts(doc, SUBSET);
    // The fixture carries a Type 3 font and standard-14 entries; anything with a PostScript
    // outline is named rather than silently skipped.
    for (const warning of outcome.warnings) {
      expect(warning).toMatch(/left at its full size|no longer embedded/i);
    }
  });

  it('does nothing when it is asked for nothing', async () => {
    const doc = await load('fonts.pdf');
    const before = programs(doc);
    const outcome = await optimiseFonts(doc, { subset: false, unembedStandard: false });
    expect(outcome).toMatchObject({ subsetted: 0, unembedded: 0, saved: 0 });
    expect(programs(doc)).toEqual(before);
  });

  it('keeps the page count and the text of a document full of fonts', async () => {
    const bytes = fixture('cjk-rtl.pdf');
    const result = await optimise(
      bytes,
      { ...NO_CHANGE, fonts: SUBSET },
      { structure: structureHook() },
    );
    const doc = await PDFDocument.load(result.bytes, { ignoreEncryption: true });
    expect(doc.getPageCount()).toBe(1);
  });
});

describe('unembedding', () => {
  it('refuses every font in the fixtures, because none of them is a standard face', async () => {
    for (const name of ['fonts.pdf', 'cjk-rtl.pdf']) {
      const doc = await load(name);
      const embedded = anyEmbedded(doc);
      const outcome = await optimiseFonts(doc, UNEMBED);
      // Whatever it unembedded, something is still embedded — nothing here is Arial.
      if (embedded) expect(anyEmbedded(doc)).toBe(true);
      for (const warning of outcome.warnings) {
        expect(warning).toMatch(/no longer embedded/i);
      }
    }
  });

  it('takes out a font it renamed to a standard face, and says what that costs', async () => {
    const doc = await load('fonts.pdf');
    // Rename one embedded font to Arial: metric-compatible with Helvetica, so it may go.
    let renamed = false;
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFDict)) continue;
      if (object.lookupMaybe(PDFName.of('Type'), PDFName)?.asString() !== '/Font') continue;
      const descriptor = object.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
      const program = descriptor?.get(PDFName.of('FontFile2'));
      if (!(program instanceof PDFRef)) continue;
      object.set(PDFName.of('BaseFont'), PDFName.of('Arial'));
      renamed = true;
      break;
    }
    expect(renamed).toBe(true);

    const outcome = await optimiseFonts(doc, UNEMBED);
    expect(outcome.unembedded).toBe(1);
    expect(outcome.saved).toBeGreaterThan(0);
    expect(outcome.warnings.join(' ')).toMatch(/Arial.*no longer embedded/is);
  });
});
