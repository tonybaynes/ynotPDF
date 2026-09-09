/**
 * The system font list (M30, ADR 0013): the sfnt `name`-table reader in `src/main/fonts.ts`.
 *
 * It is tested against fonts that are actually on the machine — the bundled Liberation faces when
 * `npm run fetch-binaries` has put them there — plus synthetic buffers for the cases that matter
 * and cannot be relied on to exist: a truncated file, a collection header, a `name` table that
 * claims an absurd size, and something that is not a font at all. A broken font on a reader's
 * machine must cost them nothing.
 *
 * The walk of the whole machine is timed as well as checked. It runs in the **main process**, so a
 * slow one is a frozen window rather than a slow test — which is exactly how the first version was
 * caught, timing out at thirty seconds on a Windows CI runner because it read every font whole.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bufferReader,
  familiesIn,
  familiesInFontFile,
  forgetSystemFonts,
  systemFontFamilies,
} from '../../../src/main/fonts';
import { FONTS_DIR } from '../engine/helpers';

/** A .ttf from the bundled substitution fonts, when they have been fetched. */
function bundledFontPath(): string | null {
  if (!existsSync(FONTS_DIR)) return null;
  const name = readdirSync(FONTS_DIR).find((f) => f.endsWith('.ttf'));
  return name === undefined ? null : join(FONTS_DIR, name);
}

const families = (bytes: Buffer): string[] => familiesIn(bufferReader(bytes));

describe('reading a font’s family name', () => {
  it('reads the family out of a real font file', () => {
    const path = bundledFontPath();
    // The bundled fonts are git-ignored and fetched by a script, so this is a skip, not a failure.
    if (!path) return;
    const found = familiesInFontFile(path);
    expect(found.length).toBe(1);
    expect(found[0]).toMatch(/liberation|dejavu/i);
    // The same answer from bytes in memory, so the two readers cannot drift apart.
    expect(families(readFileSync(path))).toEqual(found);
  });

  it('reads only a few hundred bytes, not the whole font', () => {
    const path = bundledFontPath();
    if (!path) return;
    const size = readFileSync(path).byteLength;
    let read = 0;
    const counting = (at: number, length: number): Buffer => {
      read += length;
      return readFileSync(path).subarray(at, at + length);
    };
    expect(familiesIn(counting).length).toBe(1);
    // Four reads: the header, the table directory, then the `name` table. Nowhere near the file.
    expect(read).toBeLessThan(size / 4);
    expect(read).toBeLessThan(64 * 1024);
  });

  it('a file that is not a font contributes nothing', () => {
    expect(families(Buffer.from('not a font at all, just some bytes'))).toEqual([]);
    expect(families(Buffer.alloc(0))).toEqual([]);
    expect(families(Buffer.alloc(4))).toEqual([]);
  });

  it('a path that cannot be opened is skipped rather than thrown', () => {
    expect(familiesInFontFile(join(FONTS_DIR, 'no-such-font.ttf'))).toEqual([]);
  });

  it('a truncated font is skipped rather than half-read', () => {
    const path = bundledFontPath();
    if (!path) return;
    // Enough for the header and the table directory, and nothing else.
    expect(families(readFileSync(path).subarray(0, 200))).toEqual([]);
  });

  it('a collection header with no fonts behind it yields nothing', () => {
    const ttc = Buffer.alloc(20);
    ttc.write('ttcf', 0, 'latin1');
    ttc.writeUInt32BE(2, 8);
    expect(families(ttc)).toEqual([]);
  });

  it('a table directory that claims thousands of tables is refused', () => {
    const header = Buffer.alloc(12);
    header.writeUInt32BE(0x00010000, 0);
    header.writeUInt16BE(9999, 4);
    expect(families(header)).toEqual([]);
  });

  it('a `name` table that claims an absurd size is refused, not read', () => {
    // A header, one table directory entry for `name`, and a length no name table ever has.
    const bytes = Buffer.alloc(28);
    bytes.writeUInt32BE(0x00010000, 0);
    bytes.writeUInt16BE(1, 4);
    bytes.write('name', 12, 'latin1');
    bytes.writeUInt32BE(28, 20); // offset
    bytes.writeUInt32BE(50_000_000, 24); // length
    let asked = 0;
    familiesIn((at, length) => {
      asked = Math.max(asked, length);
      return bytes.subarray(at, at + length);
    });
    expect(asked).toBeLessThan(1_000_000);
  });
});

describe('the machine’s font list', () => {
  it('is sorted, unique, free of empty names, and quick enough for the main process', () => {
    forgetSystemFonts();
    const started = Date.now();
    const list = systemFontFamilies();
    const elapsed = Date.now() - started;
    expect(list).toEqual([...list].sort((a, b) => a.localeCompare(b)));
    expect(new Set(list.map((f) => f.toLowerCase())).size).toBe(list.length);
    for (const family of list) expect(family.trim()).not.toBe('');
    // The walk has its own four-second budget; this is the check that the budget is honoured.
    expect(elapsed).toBeLessThan(15_000);
  });

  it('is cached, so a font picker opening twice reads no files the second time', () => {
    const first = systemFontFamilies();
    const started = Date.now();
    expect(systemFontFamilies()).toBe(first);
    expect(Date.now() - started).toBeLessThan(50);
  });
});
