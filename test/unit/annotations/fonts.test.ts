/**
 * The system font list (M30, ADR 0013): the sfnt `name`-table reader in `src/main/fonts.ts`.
 *
 * It is tested against fonts that are actually on the machine — the bundled Liberation faces when
 * `npm run fetch-binaries` has put them there, and the OS's own font directories otherwise — plus
 * synthetic buffers for the cases that matter and cannot be relied on to exist: a truncated file,
 * a collection header, and something that is not a font at all. A broken font on a reader's
 * machine must cost them nothing.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { familiesInFont, systemFontFamilies } from '../../../src/main/fonts';
import { FONTS_DIR } from '../engine/helpers';

/** A .ttf from the bundled substitution fonts, when they have been fetched. */
function bundledFont(): Buffer | null {
  if (!existsSync(FONTS_DIR)) return null;
  const name = readdirSync(FONTS_DIR).find((f) => f.endsWith('.ttf'));
  return name === undefined ? null : readFileSync(join(FONTS_DIR, name));
}

describe('reading a font’s family name', () => {
  it('reads the family out of a real font file', () => {
    const bytes = bundledFont();
    // The bundled fonts are git-ignored and fetched by a script, so this is a skip, not a failure.
    if (!bytes) return;
    const families = familiesInFont(bytes);
    expect(families.length).toBe(1);
    expect(families[0]).toMatch(/liberation|dejavu/i);
  });

  it('a file that is not a font contributes nothing', () => {
    expect(familiesInFont(Buffer.from('not a font at all, just some bytes'))).toEqual([]);
    expect(familiesInFont(Buffer.alloc(0))).toEqual([]);
    expect(familiesInFont(Buffer.alloc(4))).toEqual([]);
  });

  it('a truncated font is skipped rather than half-read', () => {
    const bytes = bundledFont();
    if (!bytes) return;
    // Enough for the header and the table directory, and nothing else.
    expect(familiesInFont(bytes.subarray(0, 200))).toEqual([]);
  });

  it('a collection header with no fonts behind it yields nothing', () => {
    const ttc = Buffer.alloc(20);
    ttc.write('ttcf', 0, 'latin1');
    ttc.writeUInt32BE(2, 8);
    expect(familiesInFont(ttc)).toEqual([]);
  });
});

describe('the machine’s font list', () => {
  it('is sorted, unique, and free of empty names', () => {
    const families = systemFontFamilies();
    expect(families).toEqual([...families].sort((a, b) => a.localeCompare(b)));
    expect(new Set(families.map((f) => f.toLowerCase())).size).toBe(families.length);
    for (const family of families) expect(family.trim()).not.toBe('');
  });

  it('is cached, so a font picker opening twice reads no files the second time', () => {
    expect(systemFontFamilies()).toBe(systemFontFamilies());
  });
});
