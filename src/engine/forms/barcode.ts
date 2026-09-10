/**
 * Barcode symbols for a barcode field (M60) — PDF417, QR Code and Data Matrix.
 *
 * bwip-js (MIT) does the encoding. Its `generic` build is used deliberately: it has no canvas,
 * no DOM and no Node dependency, so the same import works in the renderer, in the engine worker
 * and in a plain vitest process. It returns SVG, and the only path commands it emits are `M`,
 * `L` and `Z` — axis-aligned polygons around runs of dark modules — which turns into PDF path
 * operators with no curve maths at all.
 *
 * The symbol is described here as *geometry in a unit box*, so one computation serves both the
 * appearance stream the file gets and the picture the widget layer draws on screen.
 */

import { toSVG } from 'bwip-js/generic';
import type { BarcodeSpec, BarcodeSymbology } from './model';

/** One closed sub-path of the symbol, in the symbol's own coordinates (origin top-left, y down). */
export type BarcodePolygon = ReadonlyArray<{ readonly x: number; readonly y: number }>;

/**
 * A rendered barcode: its natural size and the sub-paths that make it up.
 *
 * **They are sub-paths of one path, not separate shapes.** A QR finder pattern is a filled square
 * with a white ring inside it, and the ring is a sub-path wound the other way: fill each one on
 * its own and every finder comes out solid, which no decoder will look at twice. Both drawers —
 * the content stream and the widget layer's `<path>` — emit all of them and fill once, under the
 * non-zero winding rule that PDF's `f` and SVG's default `fill-rule` both use.
 */
export interface BarcodeSymbol {
  readonly width: number;
  readonly height: number;
  readonly polygons: ReadonlyArray<BarcodePolygon>;
}

/** Why a value could not be encoded, in words for the reader. */
export class BarcodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BarcodeError';
  }
}

/**
 * The bwip-js request shape. Its own `RenderOptions` names only the options every symbology
 * shares; `eclevel` and friends are per-symbology and are typed as an open bag, which is what
 * the library's own documentation describes.
 */
type BarcodeRequest = Parameters<typeof toSVG>[0] & Record<string, unknown>;

/** bwip-js options for one symbology and error-correction setting. */
function optionsFor(spec: BarcodeSpec, text: string): BarcodeRequest {
  const base: BarcodeRequest = {
    bcid: spec.symbology,
    text,
    scale: 1,
    includetext: false,
    backgroundcolor: '',
  };
  switch (spec.symbology) {
    case 'pdf417':
      // `eclevel` 0..8; columns left to bwip-js so the symbol stays close to square.
      return { ...base, eclevel: clampInt(spec.errorCorrection, 0, 8) };
    case 'qrcode': {
      const levels = ['L', 'M', 'Q', 'H'];
      return { ...base, eclevel: levels[clampInt(spec.errorCorrection, 1, 4) - 1] ?? 'M' };
    }
    default:
      // Data Matrix fixes its own error correction (ECC 200); there is nothing to choose.
      return base;
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** The error-correction range a symbology offers, or null when it has none to offer. */
export function errorCorrectionRange(
  symbology: BarcodeSymbology,
): { readonly min: number; readonly max: number; readonly label: string } | null {
  switch (symbology) {
    case 'pdf417':
      return { min: 0, max: 8, label: 'Error correction level (0–8)' };
    case 'qrcode':
      return { min: 1, max: 4, label: 'Error correction (1 = L, 4 = H)' };
    default:
      return null;
  }
}

const VIEWBOX_RE = /viewBox="0 0 ([\d.]+) ([\d.]+)"/;
const PATH_RE = /<path d="([^"]+)"/g;

/**
 * Encodes `text` and returns the symbol's geometry.
 *
 * An empty value has no symbol — a barcode of nothing is a picture of noise — and says so by
 * returning null rather than throwing, because an unfilled barcode field is a normal state.
 */
export function barcodeSymbol(spec: BarcodeSpec, text: string): BarcodeSymbol | null {
  if (text === '') return null;
  let svg: string;
  try {
    svg = toSVG(optionsFor(spec, text));
  } catch (error) {
    throw new BarcodeError(
      error instanceof Error ? error.message : 'the value could not be encoded',
    );
  }
  const box = VIEWBOX_RE.exec(svg);
  const width = Number(box?.[1] ?? 0);
  const height = Number(box?.[2] ?? 0);
  if (!(width > 0) || !(height > 0)) {
    throw new BarcodeError('the encoder produced an empty symbol');
  }
  const polygons: BarcodePolygon[] = [];
  PATH_RE.lastIndex = 0;
  for (let m = PATH_RE.exec(svg); m; m = PATH_RE.exec(svg)) {
    polygons.push(...parsePath(m[1] ?? ''));
  }
  return { width, height, polygons };
}

/**
 * Parses the `M x y L x y … Z` paths bwip-js emits. Only those three commands appear; anything
 * else is ignored rather than guessed at, which would draw a wrong barcode instead of none.
 */
function parsePath(d: string): BarcodePolygon[] {
  const out: BarcodePolygon[] = [];
  let current: Array<{ x: number; y: number }> = [];
  const tokens = d.match(/[MLZmlz]|-?[\d.]+/g) ?? [];
  let i = 0;
  let command = '';
  while (i < tokens.length) {
    const token = tokens[i] ?? '';
    if (/[MLZmlz]/.test(token)) {
      command = token.toUpperCase();
      i++;
      if (command === 'Z') {
        if (current.length >= 3) out.push(current);
        current = [];
      }
      continue;
    }
    const x = Number(tokens[i]);
    const y = Number(tokens[i + 1]);
    i += 2;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (command === 'M' && current.length >= 3) {
      out.push(current);
      current = [];
    }
    current.push({ x, y });
  }
  if (current.length >= 3) out.push(current);
  return out;
}

/**
 * The size the symbol wants at `cellSize` points per module, and the scale that fits it into
 * `box` without distorting it. A symbol always keeps its aspect ratio: a stretched barcode is an
 * unreadable barcode.
 */
export function fitBarcode(
  symbol: BarcodeSymbol,
  spec: BarcodeSpec,
  box: { readonly width: number; readonly height: number },
): { readonly scale: number; readonly width: number; readonly height: number } {
  const wanted = Math.max(0.1, spec.cellSize);
  const natural = { width: symbol.width * wanted, height: symbol.height * wanted };
  const scale = Math.min(
    1,
    box.width / Math.max(natural.width, 1e-6),
    box.height / Math.max(natural.height, 1e-6),
  );
  const factor = wanted * scale;
  return { scale: factor, width: symbol.width * factor, height: symbol.height * factor };
}
