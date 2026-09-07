/**
 * Shared helpers for the engine test suite (M10): a lazily created `PdfiumEngine` fed from disk
 * (wasm from node_modules, fonts from resources/fonts when fetched), fixture loading, and a
 * 64-bit difference hash for render regression tests.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dhash as hashPixels, luma } from '@engine/imageHash';
import { PdfiumEngine, type RawRender } from '@engine/pdfium/PdfiumEngine';
import type { SubstitutionTable } from '@engine/pdfium/fonts';

export const ROOT = process.cwd();
export const FIXTURES = join(ROOT, 'test', 'fixtures');
export const EXTERNAL_FIXTURES = join(FIXTURES, 'external');
export const WASM_PATH = join(ROOT, 'node_modules', '@hyzyla', 'pdfium', 'dist', 'pdfium.wasm');
export const FONTS_DIR = join(ROOT, 'resources', 'fonts');

export function loadWasm(): Uint8Array {
  return new Uint8Array(readFileSync(WASM_PATH));
}

export function loadFonts(): Map<string, Uint8Array> {
  const fonts = new Map<string, Uint8Array>();
  if (!existsSync(FONTS_DIR)) return fonts;
  for (const f of readdirSync(FONTS_DIR)) {
    if (f.endsWith('.ttf')) fonts.set(f, new Uint8Array(readFileSync(join(FONTS_DIR, f))));
  }
  return fonts;
}

export function loadSubstitutions(): SubstitutionTable {
  return JSON.parse(
    readFileSync(join(FONTS_DIR, 'substitutions.json'), 'utf8'),
  ) as SubstitutionTable;
}

let shared: Promise<PdfiumEngine> | null = null;

/** One engine per test process (PDFium init is ~15 ms, fonts add a few more). */
export function engine(): Promise<PdfiumEngine> {
  shared ??= PdfiumEngine.create({
    wasm: loadWasm(),
    fonts: loadFonts(),
    substitutions: loadSubstitutions(),
    renderSlice: 20,
  });
  return shared;
}

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

export function hasFixture(name: string): boolean {
  return existsSync(join(FIXTURES, name));
}

export { hamming } from '@engine/imageHash';

/** 64-bit difference hash of a render (see `src/engine/imageHash.ts`). */
export function dhash(render: RawRender): string {
  return hashPixels(render.rgba, render.width, render.height);
}

/** Fraction of pixels darker than `threshold` luminance inside a device rect. */
export function inkCoverage(
  render: RawRender,
  rect: { x: number; y: number; width: number; height: number },
  threshold = 160,
): number {
  let dark = 0;
  let n = 0;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(render.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(render.height, Math.ceil(rect.y + rect.height));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      n++;
      if (luma(render.rgba, (y * render.width + x) * 4) < threshold) dark++;
    }
  }
  return n === 0 ? 0 : dark / n;
}

/** Whether any pixel in the render is not the background colour. */
export function hasInk(render: RawRender, threshold = 200): boolean {
  for (let i = 0; i < render.rgba.length; i += 4) {
    if (luma(render.rgba, i) < threshold) return true;
  }
  return false;
}
