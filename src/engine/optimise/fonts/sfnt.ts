/**
 * TrueType surgery (M100): read a font's table directory, find out which glyphs can be reached,
 * and write it back out with the ones nothing uses emptied.
 *
 * **Why blanking rather than renumbering.** Every subsetting library renumbers glyphs — glyph 900
 * becomes glyph 7 — and inside a PDF that is a trap. A simple font finds its glyphs through
 * `/Encoding`, `/Differences` and the font's own `cmap`; a CID font finds them through
 * `/CIDToGIDMap`; and a renumbered font needs *all* of those rewritten in step, in a document
 * whose text is already written. Get one wrong and letters swap places in a file that still opens
 * and still looks plausible, which is the worst failure this module could have.
 *
 * So the glyph count never changes here. `loca` keeps all its entries, unused glyphs get a length
 * of zero, and every mapping in the font and in the PDF keeps pointing exactly where it did. The
 * saving is the same one a renumbering subsetter gets, because it is `glyf` that is large:
 * emptying the unused outlines of a 15 MB CJK font leaves about 40 KB.
 *
 * Only `glyf`-flavoured fonts are handled. A CFF font (`FontFile3`) keeps its charstrings in a
 * structure with its own index and its own subroutine sharing, and cutting it down safely is a
 * second implementation of a different format — those are left alone and named in the report.
 */

/** Tables a PDF-embedded TrueType font needs, and nothing else (ISO 32000-1 §9.9.2). */
const KEEP = new Set([
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'cvt ',
  'fpgm',
  'prep',
  'glyf',
  'loca',
  'cmap',
  'gasp',
  // Vertical metrics: needed by a vertical CJK writing mode, tiny, and nothing else reads them.
  'vhea',
  'vmtx',
]);

export interface SfntTable {
  readonly tag: string;
  readonly data: Uint8Array;
}

export interface Sfnt {
  /** `0x00010000` for TrueType outlines, `'ttcf'`/`'OTTO'` for the two we refuse. */
  readonly version: number;
  readonly tables: ReadonlyArray<SfntTable>;
}

/** True when this is a TrueType font with `glyf` outlines — the only kind {@link subsetFont} cuts. */
export function isTrueTypeOutlines(font: Sfnt): boolean {
  return font.tables.some((t) => t.tag === 'glyf') && font.tables.some((t) => t.tag === 'loca');
}

/** Reads the table directory. Returns `null` for anything that is not a single sfnt font. */
export function readSfnt(bytes: Uint8Array): Sfnt | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(0);
  // `ttcf` is a collection, `wOFF` is compressed: neither is a font program a PDF may embed.
  if (version === 0x74746366 || version === 0x774f4646) return null;
  const count = view.getUint16(4);
  if (count === 0 || count > 512 || 12 + count * 16 > bytes.length) return null;

  const tables: SfntTable[] = [];
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(
      bytes[at] ?? 0,
      bytes[at + 1] ?? 0,
      bytes[at + 2] ?? 0,
      bytes[at + 3] ?? 0,
    );
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    if (offset + length > bytes.length) return null;
    tables.push({ tag, data: bytes.subarray(offset, offset + length) });
  }
  return { version, tables };
}

export function tableOf(font: Sfnt, tag: string): Uint8Array | null {
  return font.tables.find((t) => t.tag === tag)?.data ?? null;
}

/** `indexToLocFormat` from `head`: 0 means `loca` holds 16-bit halves of offsets, 1 means 32-bit. */
function locaFormat(font: Sfnt): 0 | 1 | null {
  const head = tableOf(font, 'head');
  if (!head || head.length < 52) return null;
  const value = new DataView(head.buffer, head.byteOffset, head.byteLength).getInt16(50);
  return value === 0 || value === 1 ? value : null;
}

function glyphCount(font: Sfnt): number {
  const maxp = tableOf(font, 'maxp');
  if (!maxp || maxp.length < 6) return 0;
  return new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).getUint16(4);
}

/** `loca` as absolute offsets into `glyf`, one more entry than there are glyphs. */
function readLoca(font: Sfnt): Uint32Array | null {
  const loca = tableOf(font, 'loca');
  const format = locaFormat(font);
  const glyphs = glyphCount(font);
  if (!loca || format === null || glyphs === 0) return null;
  const needed = format === 0 ? (glyphs + 1) * 2 : (glyphs + 1) * 4;
  if (loca.length < needed) return null;
  const view = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
  const out = new Uint32Array(glyphs + 1);
  for (let i = 0; i <= glyphs; i++) {
    out[i] = format === 0 ? view.getUint16(i * 2) * 2 : view.getUint32(i * 4);
  }
  return out;
}

/**
 * Every glyph a set of glyphs depends on: a composite glyph draws other glyphs, and dropping one
 * of its components leaves a letter with its accent missing.
 */
export function withComponents(font: Sfnt, wanted: ReadonlySet<number>): Set<number> {
  const glyf = tableOf(font, 'glyf');
  const loca = readLoca(font);
  const out = new Set(wanted);
  if (!glyf || !loca) return out;
  const view = new DataView(glyf.buffer, glyf.byteOffset, glyf.byteLength);
  const stack = [...wanted];
  let steps = 0;

  while (stack.length > 0 && steps++ < 200_000) {
    const gid = stack.pop();
    if (gid === undefined) continue;
    const start = loca[gid];
    const end = loca[gid + 1];
    if (start === undefined || end === undefined || end <= start || end > glyf.length) continue;
    if (end - start < 10) continue;
    // A negative contour count means a composite glyph (Apple's TrueType reference, `glyf`).
    if (view.getInt16(start) >= 0) continue;

    let at = start + 10;
    for (;;) {
      if (at + 4 > end) break;
      const flags = view.getUint16(at);
      const component = view.getUint16(at + 2);
      if (!out.has(component)) {
        out.add(component);
        stack.push(component);
      }
      at += 4;
      at += (flags & 1) !== 0 ? 4 : 2; // ARG_1_AND_2_ARE_WORDS
      if ((flags & 8) !== 0)
        at += 2; // WE_HAVE_A_SCALE
      else if ((flags & 0x40) !== 0)
        at += 4; // WE_HAVE_AN_X_AND_Y_SCALE
      else if ((flags & 0x80) !== 0) at += 8; // WE_HAVE_A_TWO_BY_TWO
      if ((flags & 0x20) === 0) break; // MORE_COMPONENTS
    }
  }
  return out;
}

/**
 * Every glyph any character code can reach through the font's `cmap`.
 *
 * This is what makes a **simple** font safe to cut without knowing which characters the document
 * uses: a simple font addresses at most 256 codes, so whatever the encoding does to them, the
 * glyphs it can land on are a subset of what the `cmap` can produce — and everything else in the
 * font is unreachable by any string in any content stream. `codes` is the set of character codes
 * to follow, which for a simple font is 0–255.
 */
export function glyphsReachableByCmap(font: Sfnt, codes: Iterable<number>): Set<number> {
  const out = new Set<number>([0]);
  const cmap = tableOf(font, 'cmap');
  if (!cmap || cmap.length < 4) return out;
  const view = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
  const tables = view.getUint16(2);
  const wanted = [...codes];

  for (let i = 0; i < tables; i++) {
    const at = 4 + i * 8;
    if (at + 8 > cmap.length) break;
    const offset = view.getUint32(at + 4);
    if (offset + 4 > cmap.length) continue;
    const format = view.getUint16(offset);
    for (const code of wanted) {
      const gid = lookup(view, cmap.length, offset, format, code);
      if (gid > 0) out.add(gid);
    }
  }
  return out;
}

/** One `cmap` subtable lookup. Formats 0, 4, 6 and 12 — the four a PDF font actually uses. */
function lookup(
  view: DataView,
  length: number,
  offset: number,
  format: number,
  code: number,
): number {
  try {
    if (format === 0) {
      if (code > 255) return 0;
      return view.getUint8(offset + 6 + code);
    }
    if (format === 4) {
      const segX2 = view.getUint16(offset + 6);
      const endAt = offset + 14;
      const startAt = endAt + segX2 + 2;
      const deltaAt = startAt + segX2;
      const rangeAt = deltaAt + segX2;
      for (let s = 0; s < segX2; s += 2) {
        if (code > view.getUint16(endAt + s)) continue;
        const start = view.getUint16(startAt + s);
        if (code < start) return 0;
        const delta = view.getInt16(deltaAt + s);
        const rangeOffset = view.getUint16(rangeAt + s);
        if (rangeOffset === 0) return (code + delta) & 0xffff;
        const at = rangeAt + s + rangeOffset + (code - start) * 2;
        if (at + 2 > length) return 0;
        const gid = view.getUint16(at);
        return gid === 0 ? 0 : (gid + delta) & 0xffff;
      }
      return 0;
    }
    if (format === 6) {
      const first = view.getUint16(offset + 6);
      const count = view.getUint16(offset + 8);
      if (code < first || code >= first + count) return 0;
      return view.getUint16(offset + 10 + (code - first) * 2);
    }
    if (format === 12) {
      const groups = view.getUint32(offset + 12);
      for (let g = 0; g < groups; g++) {
        const at = offset + 16 + g * 12;
        if (at + 12 > length) return 0;
        if (code < view.getUint32(at)) return 0;
        if (code > view.getUint32(at + 4)) continue;
        return view.getUint32(at + 8) + (code - view.getUint32(at));
      }
      return 0;
    }
  } catch {
    return 0;
  }
  return 0;
}

/**
 * Writes the font out again with only `keep`'s glyph outlines in it.
 *
 * Returns `null` when the font is not one this file can cut — a CFF font, a collection, a `loca`
 * that does not match `maxp` — which the caller turns into "left as it was" rather than an error.
 */
export function subsetFont(bytes: Uint8Array, keep: ReadonlySet<number>): Uint8Array | null {
  const font = readSfnt(bytes);
  if (!font || !isTrueTypeOutlines(font)) return null;
  const glyf = tableOf(font, 'glyf');
  const loca = readLoca(font);
  const format = locaFormat(font);
  if (!glyf || !loca || format === null) return null;
  const glyphs = loca.length - 1;

  const wanted = withComponents(font, keep);
  // Glyph 0 is `.notdef` and is drawn for anything the encoding cannot resolve; a font without it
  // is invalid.
  wanted.add(0);

  const pieces: Uint8Array[] = [];
  const offsets = new Uint32Array(glyphs + 1);
  let at = 0;
  for (let gid = 0; gid < glyphs; gid++) {
    offsets[gid] = at;
    if (!wanted.has(gid)) continue;
    const start = loca[gid] ?? 0;
    const end = loca[gid + 1] ?? 0;
    if (end <= start || end > glyf.length) continue;
    // Glyph data is padded to a 2-byte boundary; a 32-bit `loca` allows odd offsets but every
    // reader is happier without them.
    const piece = glyf.subarray(start, end);
    const padded = piece.length % 2 === 0 ? piece : join([piece, new Uint8Array(1)]);
    pieces.push(padded);
    at += padded.length;
  }
  offsets[glyphs] = at;

  const newGlyf = join(pieces);
  // A short `loca` stores offset/2, so it can only be used while everything fits in 16 bits.
  const shortLoca = format === 0 && at < 0x20000 && every(offsets, (v) => v % 2 === 0);
  const newLoca = shortLoca ? writeLocaShort(offsets) : writeLocaLong(offsets);
  const newHead = withLocaFormat(tableOf(font, 'head'), shortLoca ? 0 : 1);

  const tables: SfntTable[] = [];
  for (const table of font.tables) {
    if (!KEEP.has(table.tag)) continue;
    if (table.tag === 'glyf') tables.push({ tag: 'glyf', data: newGlyf });
    else if (table.tag === 'loca') tables.push({ tag: 'loca', data: newLoca });
    else if (table.tag === 'head' && newHead) tables.push({ tag: 'head', data: newHead });
    else tables.push(table);
  }
  if (!tables.some((t) => t.tag === 'head')) return null;
  return writeSfnt(font.version, tables);
}

/** `head` with `indexToLocFormat` set, and `checkSumAdjustment` zeroed because it is now wrong. */
function withLocaFormat(head: Uint8Array | null, format: 0 | 1): Uint8Array | null {
  if (!head || head.length < 54) return null;
  const out = Uint8Array.from(head);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setInt16(50, format);
  // Nothing in a PDF verifies the font's checksums, and a stale one is more misleading than none.
  view.setUint32(8, 0);
  return out;
}

function writeLocaShort(offsets: Uint32Array): Uint8Array {
  const out = new Uint8Array(offsets.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < offsets.length; i++) view.setUint16(i * 2, (offsets[i] ?? 0) / 2);
  return out;
}

function writeLocaLong(offsets: Uint32Array): Uint8Array {
  const out = new Uint8Array(offsets.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < offsets.length; i++) view.setUint32(i * 4, offsets[i] ?? 0);
  return out;
}

/** Assembles a table directory and its tables, each padded to four bytes as the format requires. */
export function writeSfnt(version: number, tables: ReadonlyArray<SfntTable>): Uint8Array {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const count = sorted.length;
  const directory = 12 + count * 16;
  let total = directory;
  for (const t of sorted) total += pad4(t.data.length);

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, version);
  view.setUint16(4, count);
  // searchRange, entrySelector, rangeShift: the binary-search hints, which every reader recomputes
  // but a validator will check.
  const power = Math.floor(Math.log2(Math.max(1, count)));
  const searchRange = 16 * 2 ** power;
  view.setUint16(6, searchRange);
  view.setUint16(8, power);
  view.setUint16(10, count * 16 - searchRange);

  let at = directory;
  sorted.forEach((table, i) => {
    const entry = 12 + i * 16;
    for (let c = 0; c < 4; c++) out[entry + c] = table.tag.charCodeAt(c);
    view.setUint32(entry + 4, checksum(table.data));
    view.setUint32(entry + 8, at);
    view.setUint32(entry + 12, table.data.length);
    out.set(table.data, at);
    at += pad4(table.data.length);
  });
  return out;
}

function checksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum =
      (sum +
        (((data[i] ?? 0) << 24) |
          ((data[i + 1] ?? 0) << 16) |
          ((data[i + 2] ?? 0) << 8) |
          (data[i + 3] ?? 0))) >>>
      0;
  }
  return sum >>> 0;
}

function pad4(n: number): number {
  return n + ((4 - (n % 4)) % 4);
}

function join(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function every(values: Uint32Array, predicate: (v: number) => boolean): boolean {
  for (const v of values) if (!predicate(v)) return false;
  return true;
}
