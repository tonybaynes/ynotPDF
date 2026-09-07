/**
 * Font substitution for PDFium (M10). Non-embedded fonts are resolved against the bundled
 * Liberation + DejaVu faces through `FPDF_SetSystemFontInfo`, so a document renders the same on
 * every OS. The mapping is data: `resources/fonts/substitutions.json`. Anything we do not map
 * falls back to PDFium's built-in Foxit fonts (also deterministic).
 *
 * `resolveSubstitute` is pure and unit-tested; `FontRegistry` wires it to PDFium's
 * `FPDF_SYSFONTINFO` callback struct (10 × i32 on wasm32: version + 9 function pointers).
 */

import { addFunction, removeFunction } from './wasm';
import type { Ffi } from './ffi';

/** One entry of `substitutions.json`. */
export interface SubstitutionFamily {
  /** Display name reported back to PDFium as the face name. */
  readonly name: string;
  /** Normalised aliases (lowercase, no spaces/hyphens) that map to this family. */
  readonly aliases: ReadonlyArray<string>;
  readonly generic: 'sans' | 'serif' | 'mono';
  readonly files: {
    readonly regular?: string;
    readonly bold?: string;
    readonly italic?: string;
    readonly boldItalic?: string;
  };
}

export interface SubstitutionTable {
  readonly version: 1;
  readonly families: ReadonlyArray<SubstitutionFamily>;
  /** PDFium charset id (FX_Charset) → family name used when the face itself is unknown. */
  readonly charsetFallback: Readonly<Record<string, string>>;
  /** What to do with unknown faces of an unmapped charset: `builtin` = leave it to PDFium. */
  readonly unknown: 'builtin';
}

/** A loaded font file. */
export interface FontFile {
  readonly file: string;
  readonly bytes: Uint8Array;
}

export interface ResolvedFace {
  readonly family: SubstitutionFamily;
  readonly file: string;
  readonly bold: boolean;
  readonly italic: boolean;
  /** True when the face name itself matched (not a charset / generic fallback). */
  readonly exact: boolean;
}

/** FX_Charset values PDFium passes to `MapFont`. */
export const CHARSET = {
  ansi: 0,
  default: 1,
  symbol: 2,
  shiftJis: 128,
  hangul: 129,
  gb2312: 134,
  big5: 136,
  greek: 161,
  turkish: 162,
  vietnamese: 163,
  hebrew: 177,
  arabic: 178,
  baltic: 186,
  cyrillic: 204,
  thai: 222,
  eastEurope: 238,
} as const;

/** FXFONT_FF_* pitch/family bits PDFium passes to `MapFont`. */
export const PITCH_FAMILY = { fixedPitch: 1 << 0, roman: 1 << 4, script: 4 << 4 } as const;

const STYLE_SUFFIXES = [
  'bolditalic',
  'boldoblique',
  'semibold',
  'demibold',
  'bold',
  'italic',
  'oblique',
  'regular',
  'roman',
  'medium',
  'light',
  'psmt',
  'mt',
];

/**
 * Lowercases, drops the subset tag and separators, and reads style words from the tokens after
 * the family name (`Arial-BoldMT`, `Courier New,Bold`). Style suffixes glued to the family
 * (`ArialBold`) are only stripped while `isKnown` rejects the key, so `TimesNewRoman` keeps
 * its `roman`.
 */
export function normalizeFaceName(
  face: string,
  isKnown: (key: string) => boolean = () => true,
): { key: string; bold: boolean; italic: boolean } {
  let s = face.trim();
  const plus = s.indexOf('+');
  if (plus === 6) s = s.slice(7); // ABCDEF+Name subset prefix
  // Family and style separate at the first hyphen or comma ("Arial-BoldMT", "Courier New,Bold");
  // trailing style words inside the family part ("Arial Bold") count as style too.
  const [familyPart = '', ...styleParts] = s.split(/[-,]/);
  const words = familyPart
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const styleWords: string[] = [];
  while (
    words.length > 1 &&
    /^(bold|italic|oblique|regular|black|heavy|light|medium|semibold|demibold)$/i.test(
      words[words.length - 1] ?? '',
    )
  ) {
    styleWords.unshift(words.pop() ?? '');
  }
  const family = words.join('');
  const style = [...styleParts, ...styleWords].join('').toLowerCase();
  let bold = /bold|black|heavy|semibold|demibold/.test(style);
  let italic = /italic|oblique/.test(style);
  let key = family.toLowerCase();
  if (!isKnown(key)) {
    let changed = true;
    while (changed && !isKnown(key)) {
      changed = false;
      for (const suffix of STYLE_SUFFIXES) {
        if (key.length > suffix.length && key.endsWith(suffix)) {
          if (suffix.includes('bold')) bold = true;
          if (suffix.includes('italic') || suffix.includes('oblique')) italic = true;
          key = key.slice(0, -suffix.length);
          changed = true;
          break;
        }
      }
    }
  }
  return { key, bold, italic };
}

function pickFile(
  family: SubstitutionFamily,
  bold: boolean,
  italic: boolean,
): { file: string; bold: boolean; italic: boolean } | null {
  const f = family.files;
  const candidates: Array<[string | undefined, boolean, boolean]> = [];
  if (bold && italic) candidates.push([f.boldItalic, true, true]);
  if (bold) candidates.push([f.bold, true, false]);
  if (italic) candidates.push([f.italic, false, true]);
  candidates.push([f.regular, false, false], [f.bold, true, false], [f.italic, false, true]);
  for (const [file, b, i] of candidates) if (file) return { file, bold: b, italic: i };
  return null;
}

/**
 * Chooses a bundled face for a PDFium `MapFont` request. Returns `null` to let PDFium use its
 * built-in fonts. Pure.
 */
export function resolveSubstitute(
  table: SubstitutionTable,
  face: string,
  weight: number,
  italic: boolean,
  charset: number,
  pitchFamily: number,
): ResolvedFace | null {
  const known = (key: string): boolean => table.families.some((fam) => fam.aliases.includes(key));
  const norm = normalizeFaceName(face, known);
  const bold = weight >= 600 || norm.bold;
  const wantItalic = italic || norm.italic;
  let family = table.families.find((fam) => fam.aliases.includes(norm.key));
  let exact = family !== undefined;
  if (!family) {
    const fallbackName = table.charsetFallback[String(charset)];
    if (fallbackName === undefined) return null;
    // Keep the generic class the PDF asked for (serif / mono / sans) within the fallback family set.
    const generic: SubstitutionFamily['generic'] =
      (pitchFamily & PITCH_FAMILY.fixedPitch) !== 0
        ? 'mono'
        : (pitchFamily & PITCH_FAMILY.roman) !== 0
          ? 'serif'
          : 'sans';
    const base = table.families.find((fam) => fam.name === fallbackName);
    if (!base) return null;
    const prefix = base.name.split(' ')[0] ?? base.name;
    family =
      table.families.find((fam) => fam.name.startsWith(prefix) && fam.generic === generic) ?? base;
    exact = false;
  }
  const picked = pickFile(family, bold, wantItalic);
  if (!picked) return null;
  return { family, file: picked.file, bold: picked.bold, italic: picked.italic, exact };
}

/** Installs the substitution table into PDFium. Keep the instance alive while PDFium runs. */
export class FontRegistry {
  private readonly faces: ResolvedFace[] = [];
  private readonly handles = new Map<string, number>();
  private readonly callbacks: number[] = [];
  private struct = 0;
  private readonly ffi: Ffi;
  readonly table: SubstitutionTable;
  private readonly files: ReadonlyMap<string, Uint8Array>;

  constructor(ffi: Ffi, table: SubstitutionTable, files: ReadonlyMap<string, Uint8Array>) {
    this.ffi = ffi;
    this.table = table;
    this.files = files;
  }

  /** Number of font files available to the registry. */
  get fileCount(): number {
    return this.files.size;
  }

  /** Calls `FPDF_SetSystemFontInfo`. Must run after `FPDF_InitLibrary*` and before any load. */
  install(): void {
    if (this.files.size === 0) return; // nothing to offer: PDFium keeps its built-ins
    const ffi = this.ffi;
    const m = ffi.m;
    const add = (fn: (...args: number[]) => number | void, sig: string): number => {
      const idx = addFunction(m, fn, sig);
      this.callbacks.push(idx);
      return idx;
    };
    const release = add(() => undefined, 'vi');
    const enumFonts = add((_self: number, mapper: number) => {
      // Tell PDFium which faces exist so exact-name lookups succeed.
      ffi.scope((s) => {
        for (const fam of this.table.families) {
          if (this.familyHasFile(fam)) {
            ffi.call('FPDF_AddInstalledFont', mapper, s.utf8(fam.name), CHARSET.ansi);
          }
        }
      });
    }, 'vii');
    const mapFont = add(
      (
        _self: number,
        weight: number,
        italic: number,
        charset: number,
        pitchFamily: number,
        facePtr: number,
        exactPtr: number,
      ) => {
        const face = ffi.readUtf8(facePtr);
        const resolved = resolveSubstitute(
          this.table,
          face,
          weight,
          italic !== 0,
          charset,
          pitchFamily,
        );
        if (!resolved || !this.files.has(resolved.file)) return 0;
        if (exactPtr !== 0) ffi.setI32(exactPtr, resolved.exact ? 1 : 0);
        return this.handleFor(resolved);
      },
      'iiiiiiii',
    );
    const getFont = add((_self: number, facePtr: number) => {
      const face = ffi.readUtf8(facePtr);
      const resolved = resolveSubstitute(this.table, face, 400, false, CHARSET.ansi, 0);
      return resolved && resolved.exact && this.files.has(resolved.file)
        ? this.handleFor(resolved)
        : 0;
    }, 'iii');
    const getFontData = add(
      (_self: number, hFont: number, tableTag: number, buffer: number, size: number) => {
        if (tableTag !== 0) return 0; // whole-file requests only (no TTC, no per-table access)
        const face = this.faces[hFont - 1];
        const bytes = face ? this.files.get(face.file) : undefined;
        if (!bytes) return 0;
        if (buffer !== 0 && size >= bytes.byteLength) m.HEAPU8.set(bytes, buffer);
        return bytes.byteLength;
      },
      'iiiiii',
    );
    const getFaceName = add((_self: number, hFont: number, buffer: number, size: number) => {
      const face = this.faces[hFont - 1];
      if (!face) return 0;
      const name = new TextEncoder().encode(face.family.name);
      if (buffer !== 0 && size >= name.length + 1) {
        m.HEAPU8.set(name, buffer);
        m.HEAPU8[buffer + name.length] = 0;
      }
      return name.length + 1;
    }, 'iiiii');
    const getFontCharset = add(() => CHARSET.ansi, 'iii');
    const deleteFont = add(() => undefined, 'vii');

    // struct FPDF_SYSFONTINFO { int version; 9 function pointers } — 40 bytes on wasm32.
    this.struct = ffi.malloc(40);
    const fields = [
      1,
      release,
      enumFonts,
      mapFont,
      getFont,
      getFontData,
      getFaceName,
      getFontCharset,
      deleteFont,
      0,
    ];
    fields.forEach((v, i) => {
      ffi.setI32(this.struct, v, i);
    });
    ffi.call('FPDF_SetSystemFontInfo', this.struct);
  }

  /** Detaches from PDFium and frees the callback slots. Call before `FPDF_DestroyLibrary`. */
  dispose(): void {
    if (this.struct !== 0) {
      this.ffi.call('FPDF_SetSystemFontInfo', 0);
      this.ffi.free(this.struct);
      this.struct = 0;
    }
    for (const idx of this.callbacks) removeFunction(this.ffi.m, idx);
    this.callbacks.length = 0;
  }

  private familyHasFile(fam: SubstitutionFamily): boolean {
    return Object.values(fam.files).some((f) => f !== undefined && this.files.has(f));
  }

  private handleFor(face: ResolvedFace): number {
    const key = `${face.family.name}|${face.file}`;
    let h = this.handles.get(key);
    if (h === undefined) {
      this.faces.push(face);
      h = this.faces.length;
      this.handles.set(key, h);
    }
    return h;
  }
}
