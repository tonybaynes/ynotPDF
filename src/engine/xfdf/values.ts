/**
 * The small value conversions FDF and XFDF share (M32): dates, colours, points, flags.
 *
 * Self-contained on purpose. The engine has date helpers of its own, but they live beside the
 * PDFium adapter and the pdf-lib writer, and this layer has to stay importable by a unit test —
 * and by M120's batch runner — without dragging a WASM module in behind them.
 */

import type { AnnotationFlags } from '@engine/PdfEngine';
import type { PdfPoint, PdfRect } from '@shared/pdf';
import { DEFAULT_XFDF_FLAGS, XFDF_FLAG_NAMES } from './types';

// ---- numbers ------------------------------------------------------------------------------------

/** A finite number, or null. Accepts the `1.0e2` and `.5` forms a file may use. */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A comma- or space-separated list of numbers; anything unparsable makes the whole list empty. */
export function numberList(value: unknown): number[] {
  if (typeof value !== 'string') return [];
  const parts = value
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const out: number[] = [];
  for (const part of parts) {
    const n = num(part);
    if (n === null) return [];
    out.push(n);
  }
  return out;
}

/** Formats a number the way an exchange file wants it: no exponent, no trailing zeros. */
export function fmt(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 1e4) / 1e4;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

export function fmtList(values: ReadonlyArray<number>): string {
  return values.map(fmt).join(',');
}

// ---- rectangles and points ----------------------------------------------------------------------

/** `"x0,y0,x1,y1"` → a normalised rect, or null. */
export function parseRect(value: unknown): PdfRect | null {
  const n = numberList(value);
  if (n.length < 4) return null;
  const [a = 0, b = 0, c = 0, d = 0] = n;
  return { x0: Math.min(a, c), y0: Math.min(b, d), x1: Math.max(a, c), y1: Math.max(b, d) };
}

export function formatRect(rect: PdfRect): string {
  return fmtList([rect.x0, rect.y0, rect.x1, rect.y1]);
}

/** `"x,y;x,y;…"` (an ink gesture, a vertex list) → points. */
export function parsePoints(value: unknown): PdfPoint[] {
  if (typeof value !== 'string') return [];
  const out: PdfPoint[] = [];
  // Both separators appear in the wild: `;` between points is the spec, but exports that use
  // only commas are common, so a flat even-length list of numbers is taken pairwise.
  if (!value.includes(';')) {
    const flat = numberList(value);
    if (flat.length >= 2 && flat.length % 2 === 0) {
      for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i] ?? 0, y: flat[i + 1] ?? 0 });
    }
    return out;
  }
  for (const pair of value.split(';')) {
    const n = numberList(pair);
    if (n.length < 2) continue;
    out.push({ x: n[0] ?? 0, y: n[1] ?? 0 });
  }
  return out;
}

export function formatPoints(points: ReadonlyArray<PdfPoint>): string {
  return points.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(';');
}

/** Points as one flat number list — how `/QuadPoints` and `/CL` are written. */
export function flatten(points: ReadonlyArray<PdfPoint>): number[] {
  return points.flatMap((p) => [p.x, p.y]);
}

// ---- colour -------------------------------------------------------------------------------------

/** `"#RRGGBB"` → `0xRRGGBB`. Also takes the 3-digit form and a bare hex triplet. */
export function parseColor(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(hex)) return Number.parseInt(hex, 16);
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    const [r = '0', g = '0', b = '0'] = hex.split('');
    return Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
  }
  return null;
}

export function formatColor(value: number): string {
  return `#${(value & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`;
}

/** `[r, g, b]` in 0..1 (PDF's `/C`) → `0xRRGGBB`. An empty array is "no colour". */
export function packColorComponents(components: ReadonlyArray<number>): number | null {
  const to8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  if (components.length === 3) {
    return (to8(components[0] ?? 0) << 16) | (to8(components[1] ?? 0) << 8) | to8(components[2] ?? 0);
  }
  if (components.length === 1) {
    const g = to8(components[0] ?? 0);
    return (g << 16) | (g << 8) | g;
  }
  if (components.length === 4) {
    // CMYK, as a few producers write it.
    const [c = 0, m = 0, y = 0, k = 0] = components;
    return (
      (to8((1 - Math.min(1, c + k)) as number) << 16) |
      (to8((1 - Math.min(1, m + k)) as number) << 8) |
      to8((1 - Math.min(1, y + k)) as number)
    );
  }
  return null;
}

/** `0xRRGGBB` → the `[r, g, b]` 0..1 triple a PDF `/C` array wants. */
export function colorComponents(value: number): [number, number, number] {
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

// ---- dates --------------------------------------------------------------------------------------

/** `D:YYYYMMDDHHmmSSOHH'mm'` → ISO 8601, or null. */
export function pdfDateToIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const m =
    /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz+-])(\d{2})?'?(\d{2})?'?)?/.exec(
      value.trim(),
    );
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', tz, tzh = '00', tzm = '00'] = m;
  const stamp = `${y ?? '1970'}-${mo}-${d}T${h}:${mi}:${s}`;
  const iso = !tz || tz === 'Z' || tz === 'z' ? `${stamp}Z` : `${stamp}${tz}${tzh}:${tzm}`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

/** ISO 8601 → `D:YYYYMMDDHHmmSSZ00'00'`, or null when the input is not a date. */
export function isoToPdfDate(iso: unknown): string | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const p = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, '0');
  return (
    `D:${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z00'00'`
  );
}

// ---- flags --------------------------------------------------------------------------------------

/** `"print,nozoom"` → the flags the model keeps. Unknown words are ignored. */
export function parseFlagWords(value: unknown): AnnotationFlags {
  if (typeof value !== 'string') return DEFAULT_XFDF_FLAGS;
  const words = new Set(
    value
      .split(/[,\s]+/)
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w !== ''),
  );
  // A `flags` attribute that is present replaces the default set outright, so an export saying
  // only "hidden" means print is off — which is what the file says and what the reader gets.
  return {
    hidden: words.has('hidden'),
    print: words.has('print'),
    noView: words.has('noview'),
    readOnly: words.has('readonly'),
    locked: words.has('locked'),
  };
}

export function formatFlagWords(flags: AnnotationFlags): string {
  const words: string[] = [];
  if (flags.hidden) words.push('hidden');
  if (flags.print) words.push('print');
  if (flags.noView) words.push('noview');
  if (flags.readOnly) words.push('readonly');
  if (flags.locked) words.push('locked');
  return words.join(',');
}

/** `/F` as a bit field → the flags the model keeps (PDF 12.5.3). */
export function unpackFlagBits(bits: number): AnnotationFlags {
  return {
    hidden: (bits & 2) !== 0,
    print: (bits & 4) !== 0,
    noView: (bits & 32) !== 0,
    readOnly: (bits & 64) !== 0,
    locked: (bits & 128) !== 0,
  };
}

export function packFlagBits(flags: AnnotationFlags): number {
  return (
    (flags.hidden ? 2 : 0) |
    (flags.print ? 4 : 0) |
    (flags.noView ? 32 : 0) |
    (flags.readOnly ? 64 : 0) |
    (flags.locked ? 128 : 0)
  );
}

/** The flag words in the order the format lists them, for a writer that wants them all. */
export function flagWordList(): ReadonlyArray<string> {
  return XFDF_FLAG_NAMES;
}
