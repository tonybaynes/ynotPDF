/**
 * `ContentBuilder` — a small PDF content-stream emitter (M21).
 *
 * Enough of the operator set to draw the shapes an annotation needs: paths, strokes, fills,
 * dashes, alpha through an `/ExtGState`, and single-line text in a standard font. It formats
 * numbers the way a PDF wants them (no exponents, no trailing zeros, at most four decimals) and
 * escapes strings, which is the part that is easy to get subtly wrong.
 *
 * It knows nothing about annotations; the generators in `generators.ts` do.
 */

import type { PdfPoint, PdfRect } from '@shared/pdf';
import type { AppearanceResources, ExtGStateSpec, StandardFontName } from './types';

/** Kappa: the circle-to-Bézier constant, `4/3 * (sqrt(2) - 1)`. */
const KAPPA = 0.5522847498307936;

/**
 * The largest magnitude a coordinate may have. PDF 1.7 Annex C puts the limit on a real at
 * ±3.403e38, but a page is 200 inches across at most and anything beyond this is corrupt input,
 * not geometry — clamping keeps the number printable rather than letting it reach the exponent
 * notation a PDF cannot read.
 */
const MAX_COORDINATE = 1e15;

/**
 * Formats a number for a content stream. PDF has no exponent notation, so neither `1e-7` nor
 * `1e+21` may reach the file; anything below the fourth decimal is noise at any sane zoom.
 */
export function num(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const clamped = Math.max(-MAX_COORDINATE, Math.min(MAX_COORDINATE, value));
  const rounded = Math.round(clamped * 10_000) / 10_000;
  if (Object.is(rounded, -0) || rounded === 0) return '0';
  // `toFixed` never uses an exponent below 1e21, and the clamp keeps us well under that.
  return rounded.toFixed(4).replace(/\.?0+$/, '');
}

/** A PDF literal string: `(...)` with `\`, `(` and `)` escaped and non-Latin-1 dropped. */
export function pdfString(value: string): string {
  let out = '(';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code >= 32 && code <= 255) out += ch;
    else out += '?';
  }
  return `${out})`;
}

/** `0xRRGGBB` → the three components a PDF colour operator wants. */
export function rgbComponents(color: number): [number, number, number] {
  return [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255];
}

export class ContentBuilder {
  private readonly ops: string[] = [];
  private readonly gsStates = new Map<string, ExtGStateSpec>();
  private readonly fontNames = new Map<string, StandardFontName>();
  private gsSeq = 0;
  private painted = false;

  /** Raw operator line. Prefer the named helpers; this is the escape hatch. */
  push(line: string): this {
    this.ops.push(line);
    return this;
  }

  save(): this {
    return this.push('q');
  }

  restore(): this {
    return this.push('Q');
  }

  /** `cm` — concatenate a matrix onto the CTM. */
  transform(a: number, b: number, c: number, d: number, e: number, f: number): this {
    return this.push(`${num(a)} ${num(b)} ${num(c)} ${num(d)} ${num(e)} ${num(f)} cm`);
  }

  strokeColor(color: number): this {
    const [r, g, b] = rgbComponents(color);
    return this.push(`${num(r)} ${num(g)} ${num(b)} RG`);
  }

  fillColor(color: number): this {
    const [r, g, b] = rgbComponents(color);
    return this.push(`${num(r)} ${num(g)} ${num(b)} rg`);
  }

  lineWidth(width: number): this {
    return this.push(`${num(width)} w`);
  }

  /** 0 butt · 1 round · 2 square. */
  lineCap(cap: 0 | 1 | 2): this {
    return this.push(`${cap} J`);
  }

  /** 0 miter · 1 round · 2 bevel. */
  lineJoin(join: 0 | 1 | 2): this {
    return this.push(`${join} j`);
  }

  /** `d` — dash pattern. An empty array is a solid line. */
  dash(pattern: ReadonlyArray<number>, phase = 0): this {
    const array = pattern
      .filter((n) => n > 0)
      .map(num)
      .join(' ');
    return this.push(`[${array}] ${num(phase)} d`);
  }

  moveTo(x: number, y: number): this {
    return this.push(`${num(x)} ${num(y)} m`);
  }

  lineTo(x: number, y: number): this {
    return this.push(`${num(x)} ${num(y)} l`);
  }

  curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): this {
    return this.push(`${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)} ${num(x3)} ${num(y3)} c`);
  }

  closePath(): this {
    return this.push('h');
  }

  /** `re` — a rectangle as a complete subpath. */
  rect(r: PdfRect): this {
    return this.push(`${num(r.x0)} ${num(r.y0)} ${num(r.x1 - r.x0)} ${num(r.y1 - r.y0)} re`);
  }

  /** An ellipse inscribed in `r`, as four Béziers. */
  ellipse(r: PdfRect): this {
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    const rx = (r.x1 - r.x0) / 2;
    const ry = (r.y1 - r.y0) / 2;
    const ox = rx * KAPPA;
    const oy = ry * KAPPA;
    this.moveTo(cx - rx, cy);
    this.curveTo(cx - rx, cy + oy, cx - ox, cy + ry, cx, cy + ry);
    this.curveTo(cx + ox, cy + ry, cx + rx, cy + oy, cx + rx, cy);
    this.curveTo(cx + rx, cy - oy, cx + ox, cy - ry, cx, cy - ry);
    this.curveTo(cx - ox, cy - ry, cx - rx, cy - oy, cx - rx, cy);
    return this.closePath();
  }

  /** An open polyline through `points`. No-op for fewer than two. */
  polyline(points: ReadonlyArray<PdfPoint>): this {
    const [first, ...rest] = points;
    if (!first || rest.length === 0) return this;
    this.moveTo(first.x, first.y);
    for (const p of rest) this.lineTo(p.x, p.y);
    return this;
  }

  stroke(): this {
    this.painted = true;
    return this.push('S');
  }

  /** `f` — non-zero winding fill. */
  fill(): this {
    this.painted = true;
    return this.push('f');
  }

  fillAndStroke(): this {
    this.painted = true;
    return this.push('B');
  }

  /** Ends the path without painting (used to clear a path we decided not to draw). */
  endPath(): this {
    return this.push('n');
  }

  /**
   * Declares an `/ExtGState` and emits its `gs`. Identical states share one name, so a stream
   * that draws twenty highlight quads carries one Multiply state rather than twenty.
   */
  graphicsState(spec: ExtGStateSpec): this {
    const key = JSON.stringify([spec.fillAlpha, spec.strokeAlpha, spec.blendMode]);
    let name = [...this.gsStates.entries()].find(
      ([, s]) => JSON.stringify([s.fillAlpha, s.strokeAlpha, s.blendMode]) === key,
    )?.[0];
    if (name === undefined) {
      name = `GS${++this.gsSeq}`;
      this.gsStates.set(name, spec);
    }
    return this.push(`/${name} gs`);
  }

  /** One line of text at a baseline point, in a standard font. */
  text(
    value: string,
    options: { font: StandardFontName; size: number; x: number; y: number },
  ): this {
    const name = this.fontName(options.font);
    this.painted = true;
    this.push('BT');
    this.push(`/${name} ${num(options.size)} Tf`);
    this.push(`1 0 0 1 ${num(options.x)} ${num(options.y)} Tm`);
    this.push(`${pdfString(value)} Tj`);
    return this.push('ET');
  }

  /** Several lines, top-down from `y`, each `leading` apart. */
  textLines(
    lines: ReadonlyArray<string>,
    options: { font: StandardFontName; size: number; x: number; y: number; leading: number },
  ): this {
    if (lines.length === 0) return this;
    const name = this.fontName(options.font);
    this.painted = true;
    this.push('BT');
    this.push(`/${name} ${num(options.size)} Tf`);
    this.push(`${num(options.leading)} TL`);
    this.push(`1 0 0 1 ${num(options.x)} ${num(options.y)} Tm`);
    lines.forEach((line, i) => {
      if (i > 0) this.push('T*');
      this.push(`${pdfString(line)} Tj`);
    });
    return this.push('ET');
  }

  /** Registers a font resource and returns the name the stream refers to it by. */
  fontName(font: StandardFontName): string {
    for (const [name, f] of this.fontNames) if (f === font) return name;
    const name = `F${this.fontNames.size + 1}`;
    this.fontNames.set(name, font);
    return name;
  }

  /**
   * True when the stream would put no ink on the page — nothing emitted at all, or only state
   * changes and paths that were never painted. An appearance like that is worse than none: a
   * viewer honours the empty `/AP` and draws nothing where it would otherwise have guessed.
   */
  get isEmpty(): boolean {
    return this.ops.length === 0 || !this.painted;
  }

  get resources(): AppearanceResources {
    return {
      extGState: Object.fromEntries(this.gsStates),
      fonts: Object.fromEntries(this.fontNames),
    };
  }

  build(): string {
    return this.ops.join('\n');
  }
}
