/**
 * Measurements (M33): the scale, the `/Measure` dictionary, the numbers a measurement shows, and
 * what a dimension line draws.
 *
 * A measurement is an ordinary shape annotation — a `Line`, a `PolyLine` or a `Polygon` — with
 * two extra things: an `/IT` saying it is a dimension, and a `/Measure` dictionary saying what a
 * point on the page is worth in the real world. Everything about that pair lives here, so the
 * tools, the properties panel, the results list, the overlay and the writer all read the same
 * arithmetic and the same wording.
 *
 * `/Measure`, `/NumberFormat`, the `RL` subtype and the `/LL`, `/LLE`, `/LLO`, `/Cap`, `/CP` and
 * `/CO` entries are ISO 32000-1 §12.9 and tables 172, 266 and 267 (PDF 2.0 numbers them the
 * same). Nothing here is specific to any product.
 *
 * Geometry is PDF page space, points, origin bottom-left, as everywhere else in this folder.
 */

import type { PdfPoint, PdfRect } from '@shared/pdf';
import { ContentBuilder, type PathOp } from './content';
import type { DictValue } from './dict';
import { textWidth } from './metrics';
import { lineEndingDrawing, lineEndingsOf, opsBounds, type ShapeDrawing } from './shapes';
import type {
  AppearanceGenerator,
  AppearanceInput,
  AppearanceStream,
  StandardFontName,
} from './types';

// ---- units --------------------------------------------------------------------------------------

/** The units a scale may be stated in, and a measurement shown in. */
export const MEASURE_UNITS = ['pt', 'pc', 'in', 'ft', 'yd', 'mi', 'mm', 'cm', 'm', 'km'] as const;

export type MeasureUnit = (typeof MEASURE_UNITS)[number];

/** How many PDF points one of each unit is. `pt` is the default user-space unit. */
export const POINTS_PER_UNIT: Readonly<Record<MeasureUnit, number>> = {
  pt: 1,
  pc: 12,
  in: 72,
  ft: 864,
  yd: 2592,
  mi: 4_561_920,
  mm: 72 / 25.4,
  cm: 720 / 25.4,
  m: 72_000 / 25.4,
  km: 72_000_000 / 25.4,
};

/** The words a menu shows. Never just the abbreviation: "pc" is not a word anyone reads. */
export const UNIT_NAMES: Readonly<Record<MeasureUnit, string>> = {
  pt: 'Points',
  pc: 'Picas',
  in: 'Inches',
  ft: 'Feet',
  yd: 'Yards',
  mi: 'Miles',
  mm: 'Millimetres',
  cm: 'Centimetres',
  m: 'Metres',
  km: 'Kilometres',
};

export function isMeasureUnit(value: unknown): value is MeasureUnit {
  return typeof value === 'string' && (MEASURE_UNITS as ReadonlyArray<string>).includes(value);
}

/** What a measurement is: a length, an area, or an angle. */
export type MeasureKind = 'length' | 'area' | 'angle';

/** The label written into `/U` and shown beside a number: `mm`, `mm²`, `°`. */
export function unitLabel(unit: MeasureUnit, kind: MeasureKind): string {
  if (kind === 'angle') return '°';
  return kind === 'area' ? `${unit}²` : unit;
}

// ---- the scale ----------------------------------------------------------------------------------

/**
 * A scale: *fromValue* of a page unit is *toValue* of a real-world unit — "1 mm = 1 mm" at true
 * size, "1 cm = 5 m" on a site plan. `precision` is decimal places; `denominator`, when it is 2,
 * 4, 8 or 16, shows the fraction to that denominator instead.
 */
export interface MeasureScale {
  readonly fromValue: number;
  readonly fromUnit: MeasureUnit;
  readonly toValue: number;
  readonly toUnit: MeasureUnit;
  /** Decimal places, 0–6. Ignored when `denominator` is not 0. */
  readonly precision: number;
  /** 0 for decimals; 2, 4, 8 or 16 to show halves, quarters, eighths or sixteenths. */
  readonly denominator: number;
}

/**
 * True size, shown in millimetres to one decimal place. The operator's locale is en-GB, so metric
 * is the sensible starting point; the settings and the calibration dialog change it.
 */
export const DEFAULT_MEASURE_SCALE: MeasureScale = {
  fromValue: 1,
  fromUnit: 'mm',
  toValue: 1,
  toUnit: 'mm',
  precision: 1,
  denominator: 0,
};

/** The fraction denominators the panel offers, beside plain decimals. */
export const FRACTION_DENOMINATORS: ReadonlyArray<number> = [2, 4, 8, 16];

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamps a scale into the range everything downstream assumes: no zeroes, no negatives. */
export function normaliseScale(scale: MeasureScale): MeasureScale {
  const from = Math.abs(finite(scale.fromValue, 1));
  const to = Math.abs(finite(scale.toValue, 1));
  const denominator = FRACTION_DENOMINATORS.includes(scale.denominator) ? scale.denominator : 0;
  return {
    fromValue: from > 1e-9 ? from : 1,
    fromUnit: isMeasureUnit(scale.fromUnit) ? scale.fromUnit : 'mm',
    toValue: to > 1e-9 ? to : 1,
    toUnit: isMeasureUnit(scale.toUnit) ? scale.toUnit : 'mm',
    precision: Math.max(0, Math.min(6, Math.round(finite(scale.precision, 1)))),
    denominator,
  };
}

/** A scale out of a plain object — the settings store, `Document.custom`, or a command's args. */
export function parseMeasureScale(raw: unknown): MeasureScale | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isMeasureUnit(r['fromUnit']) || !isMeasureUnit(r['toUnit'])) return null;
  return normaliseScale({
    fromValue: finite(r['fromValue'], 1),
    fromUnit: r['fromUnit'],
    toValue: finite(r['toValue'], 1),
    toUnit: r['toUnit'],
    precision: finite(r['precision'], 1),
    denominator: finite(r['denominator'], 0),
  });
}

/** The scale an annotation's `extra` carries, or null when it has none. */
export function measureScaleOf(extra: Readonly<Record<string, unknown>>): MeasureScale | null {
  return parseMeasureScale(extra['measure']);
}

/**
 * The same physical scale, stated in another unit.
 *
 * Only the *display* changes: a length that measured 100 mm still measures 10 cm. The ratio is
 * restated rather than recomputed, so nothing is lost to rounding on the way through.
 */
export function convertScaleTo(scale: MeasureScale, unit: MeasureUnit): MeasureScale {
  const s = normaliseScale(scale);
  if (s.toUnit === unit) return s;
  return normaliseScale({
    ...s,
    toValue: (s.toValue * POINTS_PER_UNIT[s.toUnit]) / POINTS_PER_UNIT[unit],
    toUnit: unit,
  });
}

/** Points → the scale's real-world unit. This is `/C` of the `/X` and `/D` number formats. */
export function linearFactor(scale: MeasureScale): number {
  const s = normaliseScale(scale);
  return s.toValue / (s.fromValue * POINTS_PER_UNIT[s.fromUnit]);
}

/** Square points → the square of the scale's unit. `/C` of the `/A` number format. */
export function areaFactor(scale: MeasureScale): number {
  const linear = linearFactor(scale);
  return linear * linear;
}

/** A number with no trailing zeroes, for the ratio text. */
function trimNumber(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

/** The ratio in words, for `/R` and for the panel: `1 cm = 5 m`. */
export function scaleRatioText(scale: MeasureScale): string {
  const s = normaliseScale(scale);
  return `${trimNumber(s.fromValue)} ${s.fromUnit} = ${trimNumber(s.toValue)} ${s.toUnit}`;
}

/** A length in points as the scale's unit. */
export function measureLength(points: number, scale: MeasureScale): number {
  return points * linearFactor(scale);
}

/** An area in square points as the square of the scale's unit. */
export function measureArea(squarePoints: number, scale: MeasureScale): number {
  return squarePoints * areaFactor(scale);
}

// ---- formatting ---------------------------------------------------------------------------------

const FORMATTERS = new Map<number, Intl.NumberFormat>();

/** en-GB, as PLAN.md §9 requires: grouped thousands, a full stop for the decimal point. */
function formatter(places: number): Intl.NumberFormat {
  let f = FORMATTERS.get(places);
  if (!f) {
    f = new Intl.NumberFormat('en-GB', {
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    });
    FORMATTERS.set(places, f);
  }
  return f;
}

/** `3 1/2`, `1/4`, `5` — a value rounded to `denominator`ths and written as a mixed number. */
export function formatFraction(value: number, denominator: number): string {
  const sign = value < 0 ? '-' : '';
  const total = Math.round(Math.abs(value) * denominator);
  const whole = Math.floor(total / denominator);
  let numerator = total - whole * denominator;
  let d = denominator;
  while (numerator > 0 && numerator % 2 === 0 && d % 2 === 0) {
    numerator /= 2;
    d /= 2;
  }
  const zero = formatter(0);
  if (numerator === 0) return `${sign}${zero.format(whole)}`;
  const fraction = `${String(numerator)}/${String(d)}`;
  return whole === 0 ? `${sign}${fraction}` : `${sign}${zero.format(whole)} ${fraction}`;
}

/** The number alone, without its unit. */
export function formatMeasureNumber(value: number, scale: MeasureScale): string {
  const s = normaliseScale(scale);
  if (s.denominator > 0) return formatFraction(value, s.denominator);
  // A tiny negative rounds to `-0.0`, which reads as a mistake rather than as zero.
  const rounded = Math.abs(value) < 0.5 * 10 ** -s.precision ? 0 : value;
  return formatter(s.precision).format(rounded);
}

/** The number and its unit, as the caption and the results list show it: `100.0 mm`. */
export function formatMeasurement(value: number, scale: MeasureScale, kind: MeasureKind): string {
  return `${formatMeasureNumber(value, scale)} ${unitLabel(normaliseScale(scale).toUnit, kind)}`;
}

// ---- the `/Measure` dictionary -------------------------------------------------------------------

/** One `/Type /NumberFormat` dictionary (table 267), written in full so nothing relies on defaults. */
function numberFormat(scale: MeasureScale, kind: MeasureKind): DictValue {
  const s = normaliseScale(scale);
  const conversion = kind === 'area' ? areaFactor(s) : kind === 'angle' ? 1 : linearFactor(s);
  const fractional = s.denominator > 0;
  return {
    kind: 'dict',
    value: {
      Type: { kind: 'name', value: 'NumberFormat' },
      U: { kind: 'string', value: unitLabel(s.toUnit, kind) },
      C: { kind: 'number', value: conversion },
      F: { kind: 'name', value: fractional ? 'F' : 'D' },
      D: { kind: 'number', value: fractional ? s.denominator : Math.max(1, 10 ** s.precision) },
      FD: { kind: 'bool', value: false },
      RD: { kind: 'string', value: '.' },
      RT: { kind: 'string', value: ',' },
      PS: { kind: 'string', value: ' ' },
      SS: { kind: 'string', value: '' },
      O: { kind: 'name', value: 'S' },
    },
  };
}

/** The whole `/Measure` dictionary for a scale: a RectilinearMeasure with all five axes. */
export function measureDictValue(scale: MeasureScale): DictValue {
  const s = normaliseScale(scale);
  const linear = numberFormat(s, 'length');
  return {
    kind: 'dict',
    value: {
      Type: { kind: 'name', value: 'Measure' },
      Subtype: { kind: 'name', value: 'RL' },
      R: { kind: 'string', value: scaleRatioText(s) },
      X: { kind: 'array', value: [linear] },
      Y: { kind: 'array', value: [linear] },
      D: { kind: 'array', value: [linear] },
      A: { kind: 'array', value: [numberFormat(s, 'area')] },
      T: { kind: 'array', value: [numberFormat(s, 'angle')] },
      // The y/x scale ratio. Ours is always square: one scale, both axes.
      CYX: { kind: 'number', value: 1 },
    },
  };
}

/** The parts of a `/Measure` a raw reader can pull out, whoever wrote the file. */
export interface RawNumberFormat {
  readonly unit: string;
  readonly conversion: number;
  /** `/F`: `D` decimal, `F` fraction, `R` round to a fraction, `T` truncate. */
  readonly fractionStyle?: string;
  /** `/D`: the denominator, or the power of ten a decimal is rounded to. */
  readonly denominator?: number;
}

/**
 * A scale read back out of a file's `/Measure`.
 *
 * The file states a conversion factor and a unit, not the ratio the reader typed, so the scale is
 * rebuilt as "1 <unit> of page = *n* <unit>": the same arithmetic, stated the way the file states
 * it. `/R` is only words — Acrobat writes "1in = 0.1m", with no space — so it is never parsed.
 */
export function scaleFromNumberFormat(input: RawNumberFormat): MeasureScale | null {
  const unit = input.unit.replace(/²|\^2/gu, '').trim();
  if (!isMeasureUnit(unit)) return null;
  if (!Number.isFinite(input.conversion) || input.conversion <= 0) return null;
  const fractional = input.fractionStyle === 'F' || input.fractionStyle === 'R';
  const d = input.denominator ?? (fractional ? 2 : 100);
  const denominator = fractional ? (FRACTION_DENOMINATORS.includes(d) ? d : 2) : 0;
  const precision = fractional ? 1 : Math.max(0, Math.min(6, Math.round(Math.log10(d || 100))));
  // One page unit of `unit` is `conversion × POINTS_PER_UNIT[unit]` of the real unit.
  return normaliseScale({
    fromValue: 1,
    fromUnit: unit,
    toValue: input.conversion * POINTS_PER_UNIT[unit],
    toUnit: unit,
    precision,
    denominator,
  });
}

// ---- the dimension's own entries ------------------------------------------------------------------

/** `/IT` values that make a shape a measurement, by the subtype each belongs on. */
export const MEASURE_INTENTS = {
  Line: 'LineDimension',
  PolyLine: 'PolyLineDimension',
  Polygon: 'PolygonDimension',
} as const;

export type MeasureIntent = (typeof MEASURE_INTENTS)[keyof typeof MEASURE_INTENTS];

const INTENT_KIND: Readonly<Record<MeasureIntent, MeasureKind>> = {
  LineDimension: 'length',
  PolyLineDimension: 'length',
  PolygonDimension: 'area',
};

export function isMeasureIntent(value: unknown): value is MeasureIntent {
  return value === 'LineDimension' || value === 'PolyLineDimension' || value === 'PolygonDimension';
}

/** The dimension intent an annotation carries, or null when it is an ordinary shape. */
export function measureIntentOf(extra: Readonly<Record<string, unknown>>): MeasureIntent | null {
  const intent = extra['intent'];
  return isMeasureIntent(intent) ? intent : null;
}

/** What the intent measures: an area for a polygon, a length for the other two. */
export function kindOfIntent(intent: MeasureIntent): MeasureKind {
  return INTENT_KIND[intent];
}

/** Whether a subtype and an `extra` bag together describe a measurement. */
export function isMeasurement(subtype: string, extra: Readonly<Record<string, unknown>>): boolean {
  const intent = measureIntentOf(extra);
  if (!intent) return false;
  return (
    (intent === 'LineDimension' && subtype === 'Line') ||
    (intent === 'PolyLineDimension' && subtype === 'PolyLine') ||
    (intent === 'PolygonDimension' && subtype === 'Polygon')
  );
}

/** Where the caption sits on a dimension line: `/CP`. */
export type CaptionPosition = 'Inline' | 'Top';

/** The look of a dimension: its leader lines and its caption. */
export interface MeasureStyle {
  /** `/LL` — how far the line proper is offset from the points it measures. */
  readonly leaderLength: number;
  /** `/LLE` — how far the leaders run past the line proper. Never negative. */
  readonly leaderExtend: number;
  /** `/LLO` — the gap between a measured point and the start of its leader. */
  readonly leaderOffset: number;
  /** `/Cap` — draw the value on the line. */
  readonly caption: boolean;
  readonly captionPosition: CaptionPosition;
  /** `/CO` — nudge, along the line and across it. */
  readonly captionOffset: readonly [number, number];
  /** Caption size in points. Not a PDF entry: ours, kept in `extra.fontSize` like a free text. */
  readonly fontSize: number;
}

export const DEFAULT_MEASURE_STYLE: MeasureStyle = {
  leaderLength: 0,
  leaderExtend: 0,
  leaderOffset: 0,
  caption: true,
  captionPosition: 'Top',
  captionOffset: [0, 0],
  fontSize: 9,
};

/** The style an annotation's `extra` carries, defaulted field by field. */
export function measureStyleOf(extra: Readonly<Record<string, unknown>>): MeasureStyle {
  const offset = extra['captionOffset'];
  const numbers: ReadonlyArray<number> = Array.isArray(offset)
    ? offset.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : [];
  const pair: readonly [number, number] =
    numbers.length === 2 ? [numbers[0] ?? 0, numbers[1] ?? 0] : DEFAULT_MEASURE_STYLE.captionOffset;
  return {
    leaderLength: finite(extra['leaderLength'], DEFAULT_MEASURE_STYLE.leaderLength),
    leaderExtend: Math.max(0, finite(extra['leaderExtend'], DEFAULT_MEASURE_STYLE.leaderExtend)),
    leaderOffset: Math.max(0, finite(extra['leaderOffset'], DEFAULT_MEASURE_STYLE.leaderOffset)),
    caption: typeof extra['caption'] === 'boolean' ? extra['caption'] : true,
    captionPosition: extra['captionPosition'] === 'Inline' ? 'Inline' : 'Top',
    captionOffset: pair,
    fontSize: Math.max(4, Math.min(72, finite(extra['fontSize'], DEFAULT_MEASURE_STYLE.fontSize))),
  };
}

// ---- what a measurement measures -------------------------------------------------------------------

/** The length of a polyline through `points`, in points. */
export function pathLength(points: ReadonlyArray<PdfPoint>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** Twice the signed area of a closed polygon (shoelace); the sign follows the winding. */
export function shoelace(points: ReadonlyArray<PdfPoint>): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a && b) sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** The unsigned area of a closed polygon, in square points. */
export function polygonArea(points: ReadonlyArray<PdfPoint>): number {
  return points.length < 3 ? 0 : Math.abs(shoelace(points));
}

/** What one measurement annotation says. `raw` is points (or square points for an area). */
export interface Measurement {
  readonly intent: MeasureIntent;
  readonly kind: MeasureKind;
  readonly scale: MeasureScale;
  /** Points, or square points for an area. */
  readonly raw: number;
  /** `raw` in the scale's unit. */
  readonly value: number;
  /** The value with its unit, as the caption reads. */
  readonly text: string;
}

/** The measurement an annotation makes, or null when it is not one. */
export function measurementOf(input: {
  readonly subtype: string;
  readonly vertices: ReadonlyArray<PdfPoint>;
  readonly extra: Readonly<Record<string, unknown>>;
}): Measurement | null {
  const intent = measureIntentOf(input.extra);
  if (!intent || !isMeasurement(input.subtype, input.extra)) return null;
  const scale = measureScaleOf(input.extra) ?? DEFAULT_MEASURE_SCALE;
  const kind = kindOfIntent(intent);
  const raw = kind === 'area' ? polygonArea(input.vertices) : pathLength(input.vertices);
  const value = kind === 'area' ? measureArea(raw, scale) : measureLength(raw, scale);
  return { intent, kind, scale, raw, value, text: formatMeasurement(value, scale, kind) };
}

// ---- what a dimension draws -------------------------------------------------------------------------

/** The caption of a measurement, placed and ready to paint. */
export interface MeasureCaption {
  readonly text: string;
  /** Baseline origin, page space. */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly color: number;
  /** Degrees anticlockwise, so a distance's caption lies along its line. */
  readonly rotate: number;
  /** The text's width at `size`, which is also the gap an inline caption leaves in the line. */
  readonly width: number;
}

/** The paths and the caption a measurement adds to (or draws instead of) the plain shape. */
export interface MeasureDrawings {
  readonly paths: ShapeDrawing[];
  readonly caption: MeasureCaption | null;
}

/** The font a caption is laid out and drawn in. */
export const CAPTION_FONT: StandardFontName = 'Helvetica';

/** Black, the fallback every viewer makes for an annotation with no `/C`. */
const DEFAULT_COLOR = 0x000000;

function unitVector(a: PdfPoint, b: PdfPoint): { ux: number; uy: number; length: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return { ux: 1, uy: 0, length: 0 };
  return { ux: dx / length, uy: dy / length, length };
}

/**
 * The two ends of a distance's line proper: the measured points, moved across by `/LL`.
 *
 * A positive `/LL` puts the line on the side that is clockwise when walking from the start to the
 * end (ISO 32000-1, `/LL`), which in page space — y upwards — is the normal `(uy, -ux)`.
 */
export function dimensionLine(
  from: PdfPoint,
  to: PdfPoint,
  leaderLength: number,
): { readonly from: PdfPoint; readonly to: PdfPoint } {
  const { ux, uy } = unitVector(from, to);
  const nx = uy;
  const ny = -ux;
  return {
    from: { x: from.x + nx * leaderLength, y: from.y + ny * leaderLength },
    to: { x: to.x + nx * leaderLength, y: to.y + ny * leaderLength },
  };
}

/** One leader: from a measured point, past the line proper, by `/LLO`, `/LL` and `/LLE`. */
function leaderOps(at: PdfPoint, nx: number, ny: number, style: MeasureStyle): PathOp[] {
  const sign = style.leaderLength < 0 ? -1 : 1;
  const start = style.leaderOffset * sign;
  const end = style.leaderLength + style.leaderExtend * sign;
  if (Math.abs(end - start) < 1e-6) return [];
  return [
    { op: 'M', x: at.x + nx * start, y: at.y + ny * start },
    { op: 'L', x: at.x + nx * end, y: at.y + ny * end },
  ];
}

/** The angle a caption is drawn at so it never reads upside down. */
export function readableAngle(ux: number, uy: number): number {
  let degrees = (Math.atan2(uy, ux) * 180) / Math.PI;
  if (degrees > 90) degrees -= 180;
  if (degrees <= -90) degrees += 180;
  return degrees;
}

/** The point half way along a polyline by arc length. */
export function midpointAlong(points: ReadonlyArray<PdfPoint>): PdfPoint | null {
  const first = points[0];
  if (!first) return null;
  const total = pathLength(points);
  if (total < 1e-9) return first;
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (walked + length >= total / 2) {
      const t = length < 1e-9 ? 0 : (total / 2 - walked) / length;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    walked += length;
  }
  return points[points.length - 1] ?? first;
}

/** The average of some points — where a polygon's caption goes. */
export function centroid(points: ReadonlyArray<PdfPoint>): PdfPoint | null {
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/**
 * Everything a measurement draws: its leaders, the line proper (broken for an inline caption)
 * and the caption itself. A polyline or a polygon has no leaders — `/LL` is a `Line` entry — so
 * only its caption is added, and the plain shape drawing still draws the outline.
 */
export function measureDrawings(input: AppearanceInput): MeasureDrawings | null {
  const measurement = measurementOf({
    subtype: input.subtype,
    vertices: input.vertices,
    extra: input.extra,
  });
  if (!measurement) return null;
  const style = measureStyleOf(input.extra);
  const colour = input.color ?? DEFAULT_COLOR;
  const width = input.borderWidth === null || input.borderWidth <= 0 ? 1 : input.borderWidth;
  const size = style.fontSize;
  const text = measurement.text;
  const textLength = textWidth(text, CAPTION_FONT, size);
  const paths: ShapeDrawing[] = [];
  let caption: MeasureCaption | null = null;

  if (measurement.intent === 'LineDimension') {
    const from = input.vertices[0];
    const to = input.vertices[1];
    if (!from || !to) return null;
    const { ux, uy, length } = unitVector(from, to);
    const nx = uy;
    const ny = -ux;
    const line = dimensionLine(from, to, style.leaderLength);
    for (const ops of [leaderOps(from, nx, ny, style), leaderOps(to, nx, ny, style)]) {
      if (ops.length > 0) paths.push({ ops, stroke: colour, fill: null, width });
    }
    /*
     * `/LE` on the *line proper*, not on the measured points: the ends the reader sees are the
     * ends of the dimension line, which `/LL` has moved. Drawn with the same arithmetic M31's
     * arrows use, so an arrow on a measurement and an arrow on a plain line are the same head.
     */
    const [startKind, endKind] = lineEndingsOf(input.extra);
    const startHead = lineEndingDrawing(startKind, line.from, line.to, width);
    const endHead = lineEndingDrawing(endKind, line.to, line.from, width);
    // The line stops short of a closed head so the stroke does not poke through the fill.
    const startTrim = startHead?.trim ?? 0;
    const endTrim = endHead?.trim ?? 0;
    const drawnFrom = { x: line.from.x + ux * startTrim, y: line.from.y + uy * startTrim };
    const drawnTo = { x: line.to.x - ux * endTrim, y: line.to.y - uy * endTrim };
    const mid = {
      x: (line.from.x + line.to.x) / 2 + ux * style.captionOffset[0] + nx * style.captionOffset[1],
      y: (line.from.y + line.to.y) / 2 + uy * style.captionOffset[0] + ny * style.captionOffset[1],
    };
    const inline = style.caption && style.captionPosition === 'Inline' && length > textLength + 8;
    if (inline) {
      const gap = textLength / 2 + 3;
      paths.push({
        ops: [
          { op: 'M', x: drawnFrom.x, y: drawnFrom.y },
          { op: 'L', x: mid.x - ux * gap, y: mid.y - uy * gap },
        ],
        stroke: colour,
        fill: null,
        width,
      });
      paths.push({
        ops: [
          { op: 'M', x: mid.x + ux * gap, y: mid.y + uy * gap },
          { op: 'L', x: drawnTo.x, y: drawnTo.y },
        ],
        stroke: colour,
        fill: null,
        width,
      });
    } else {
      paths.push({
        ops: [
          { op: 'M', x: drawnFrom.x, y: drawnFrom.y },
          { op: 'L', x: drawnTo.x, y: drawnTo.y },
        ],
        stroke: colour,
        fill: null,
        width,
      });
    }
    for (const head of [startHead, endHead]) {
      if (!head) continue;
      paths.push({
        ops: head.ops,
        stroke: colour,
        fill: head.closed ? (input.interiorColor ?? colour) : null,
        width,
      });
    }
    if (style.caption) {
      const rotate = readableAngle(ux, uy);
      const radians = (rotate * Math.PI) / 180;
      // Along the drawn text, and across it: the caption is placed from its own centre.
      const ax = Math.cos(radians);
      const ay = Math.sin(radians);
      const cx = -ay;
      const cy = ax;
      const across = inline ? -size * 0.34 : size * 0.45;
      caption = {
        text,
        x: mid.x - ax * (textLength / 2) + cx * across,
        y: mid.y - ay * (textLength / 2) + cy * across,
        size,
        color: colour,
        rotate,
        width: textLength,
      };
    }
  } else if (style.caption) {
    const at =
      measurement.intent === 'PolygonDimension'
        ? centroid(input.vertices)
        : midpointAlong(input.vertices);
    if (at) {
      caption = {
        text,
        x: at.x - textLength / 2 + style.captionOffset[0],
        y: at.y - size * 0.35 + style.captionOffset[1],
        size,
        color: colour,
        rotate: 0,
        width: textLength,
      };
    }
  }
  return { paths, caption };
}

// ---- generators ---------------------------------------------------------------------------------------

/** The box a caption's glyphs occupy, turned by its own angle. */
export function captionBounds(caption: MeasureCaption): PdfRect {
  const radians = (caption.rotate * Math.PI) / 180;
  const ax = Math.cos(radians);
  const ay = Math.sin(radians);
  const cx = -ay;
  const cy = ax;
  const up = caption.size;
  const down = caption.size * 0.3;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const along of [0, caption.width]) {
    for (const across of [-down, up]) {
      xs.push(caption.x + ax * along + cx * across);
      ys.push(caption.y + ay * along + cy * across);
    }
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function union(a: PdfRect, b: PdfRect): PdfRect {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/**
 * The box a measurement occupies: everything it draws, grown by half its widest stroke.
 *
 * Deliberately **not** unioned with the annotation's own `/Rect`, the way an ordinary shape's
 * bbox is. A viewer maps an appearance's `/BBox` on to the annotation's `/Rect` (PDF 12.5.5), so
 * the two disagreeing by even a point *scales* the drawing — which for a plain outline is
 * invisible and for a caption is a number that has moved. `measureRectFor` computes this same
 * box, so the rect the model stores and the bbox the stream carries are the same rectangle and
 * the mapping is the identity.
 */
export function measureBounds(
  drawings: ReadonlyArray<ShapeDrawing>,
  caption: MeasureCaption | null,
  points: ReadonlyArray<PdfPoint> = [],
): PdfRect | null {
  // The measured points themselves, which `/LLO` can leave just outside everything drawn: a
  // reader expects `/Rect` to contain what `/L` or `/Vertices` names.
  let box: PdfRect | null = null;
  for (const p of points) {
    box = box
      ? union(box, { x0: p.x, y0: p.y, x1: p.x, y1: p.y })
      : { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  }
  let pad = 0.5;
  for (const d of drawings) {
    pad = Math.max(pad, d.width / 2 + 0.5);
    const bounds = opsBounds(d.ops);
    if (bounds) box = box ? union(box, bounds) : bounds;
  }
  if (caption) {
    const bounds = captionBounds(caption);
    box = box ? union(box, bounds) : bounds;
  }
  return box === null
    ? null
    : { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad };
}

/** Paints drawings and a caption into one stream. Shared by the three measurement generators. */
export function paintMeasurement(
  input: AppearanceInput,
  drawings: ReadonlyArray<ShapeDrawing>,
  caption: MeasureCaption | null,
): AppearanceStream | null {
  const b = new ContentBuilder();
  b.save();
  const alpha = input.opacity;
  if (alpha !== null && alpha < 1) b.graphicsState({ fillAlpha: alpha, strokeAlpha: alpha });
  for (const d of drawings) {
    const stroked = d.stroke !== null && d.width > 0;
    const filled = d.fill !== null;
    if (!stroked && !filled) continue;
    b.save();
    if (stroked && d.stroke !== null) {
      b.strokeColor(d.stroke).lineWidth(d.width).lineCap(1).lineJoin(1);
      if (d.dash && d.dash.length > 0) b.dash(d.dash);
    }
    if (filled && d.fill !== null) b.fillColor(d.fill);
    b.path(d.ops);
    if (stroked && filled) b.fillAndStroke();
    else if (filled) b.fill();
    else b.stroke();
    b.restore();
  }
  if (caption && caption.text !== '') {
    b.save();
    b.fillColor(caption.color);
    if (caption.rotate === 0) {
      b.text(caption.text, { font: CAPTION_FONT, size: caption.size, x: caption.x, y: caption.y });
    } else {
      const radians = (caption.rotate * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      b.transform(cos, sin, -sin, cos, caption.x, caption.y);
      b.text(caption.text, { font: CAPTION_FONT, size: caption.size, x: 0, y: 0 });
    }
    b.restore();
  }
  b.restore();
  if (b.isEmpty) return null;
  return {
    bbox: measureBounds(drawings, caption, input.vertices) ?? input.rect,
    content: b.build(),
    resources: b.resources,
  };
}

/**
 * Wraps a shape generator so a measurement draws its leaders and its caption, and anything else
 * is drawn exactly as it was before.
 *
 * Registered over `Line`, `PolyLine` and `Polygon` by `createAppearanceService`, so a file's
 * measurement is drawn correctly whether or not M33 is in the build — a document opened in a
 * cut-down build must not lose its captions on the next save.
 */
export function measureAware(
  base: AppearanceGenerator,
  outline: (input: AppearanceInput) => ReadonlyArray<ShapeDrawing>,
): AppearanceGenerator {
  return (input) => {
    const drawn = measureDrawings(input);
    if (!drawn) return base(input);
    // A distance draws its own line (offset, and broken for an inline caption); a polyline or a
    // polygon keeps the outline the shape generator makes and only gains a caption.
    const paths = input.subtype === 'Line' ? drawn.paths : [...outline(input), ...drawn.paths];
    return paintMeasurement(input, paths, drawn.caption);
  };
}

/**
 * The `/Rect` a measurement needs: exactly the box its appearance stream will declare as its
 * `/BBox`, so a viewer's BBox → Rect mapping neither scales nor shifts anything (see
 * {@link measureBounds}). The tools and the provider call it whenever the geometry, the style or
 * the scale changes.
 *
 * `outline` is how the caller draws a polygon's or a polyline's own outline — the same
 * `shapeDrawings` the generator uses — so the two lists are identical by construction.
 */
export function measureRectFor(
  input: AppearanceInput,
  base: PdfRect,
  outline: (input: AppearanceInput) => ReadonlyArray<ShapeDrawing> = () => [],
): PdfRect {
  const drawn = measureDrawings(input);
  if (!drawn) return base;
  const paths =
    input.subtype === 'Line' ? drawn.paths : [...outline({ ...input, rect: base }), ...drawn.paths];
  return measureBounds(paths, drawn.caption, input.vertices) ?? base;
}
