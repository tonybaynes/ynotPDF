/**
 * Helpers for M13's unit tests: synthetic `TextRun`s (so the pure text-layer tests state exactly
 * what they mean, without a PDF in the way) and a page-text builder over them.
 */

import type { TextRun } from '@engine/PdfEngine';
import { buildPageText, type PageText } from '@view/TextLayer';
import type { PdfMatrix } from '@shared/pdf';

const IDENTITY: PdfMatrix = [1, 0, 0, 1, 0, 0];

export interface RunSpec {
  readonly text: string;
  /** Baseline start, in points. */
  readonly x: number;
  readonly y: number;
  readonly size?: number;
  readonly font?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly color?: number;
  /** Width of one character, so a test can put a gap exactly where it wants one. */
  readonly advance?: number;
  readonly angle?: number;
}

/** A run whose characters are evenly spaced — enough for every rule the text layer applies. */
export function run(spec: RunSpec, index: number): TextRun {
  const size = spec.size ?? 10;
  const advance = spec.advance ?? size * 0.5;
  const chars = Array.from(spec.text).map((_, i) => ({
    x0: spec.x + i * advance,
    y0: spec.y,
    x1: spec.x + (i + 1) * advance,
    y1: spec.y + size,
  }));
  const width = Array.from(spec.text).length * advance;
  return {
    text: spec.text,
    rect: { x0: spec.x, y0: spec.y, x1: spec.x + width, y1: spec.y + size },
    chars,
    origin: { x: spec.x, y: spec.y },
    matrix: IDENTITY,
    fontName: spec.font ?? 'Helvetica',
    fontSize: size,
    color: spec.color ?? 0,
    objectIndex: index,
    ...(spec.bold === undefined ? {} : { bold: spec.bold }),
    ...(spec.italic === undefined ? {} : { italic: spec.italic }),
    ...(spec.angle === undefined ? {} : { angle: spec.angle }),
  };
}

/** Builds a page model from run specs. */
export function pageOf(specs: ReadonlyArray<RunSpec>, page = 0): PageText {
  return buildPageText(
    page,
    specs.map((spec, i) => run(spec, i)),
  );
}

/** Two lines of body text, the shape most tests want. */
export const TWO_LINES: ReadonlyArray<RunSpec> = [
  { text: 'The quick brown fox', x: 72, y: 700 },
  { text: 'jumps over the dog', x: 72, y: 688 },
];

/**
 * Narrows away an `undefined` a test knows cannot happen, loudly. The project forbids `!` — an
 * assertion that is wrong should fail with a sentence, not a `TypeError` five lines later.
 */
export function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`expected a ${what}, got nothing`);
  return value;
}
