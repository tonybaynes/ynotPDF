/**
 * Measurement units and ruler ticks (M11). Pure.
 *
 * PDF points are the internal unit everywhere (`@shared/pdf`); this file converts to whatever
 * the operator picked in `viewer.rulers.units` and works out where the tick marks go so the
 * ruler always shows a readable number of labels whatever the zoom.
 */

import { PT_PER_INCH } from '@shared/pdf';

export type Unit = 'pt' | 'mm' | 'cm' | 'in';

export const UNITS: ReadonlyArray<{ id: Unit; label: string }> = [
  { id: 'pt', label: 'Points' },
  { id: 'mm', label: 'Millimetres' },
  { id: 'cm', label: 'Centimetres' },
  { id: 'in', label: 'Inches' },
];

/** Points in one of each unit. */
export const PT_PER_UNIT: Readonly<Record<Unit, number>> = {
  pt: 1,
  mm: PT_PER_INCH / 25.4,
  cm: PT_PER_INCH / 2.54,
  in: PT_PER_INCH,
};

export function fromPoints(points: number, unit: Unit): number {
  return points / PT_PER_UNIT[unit];
}

export function toPoints(value: number, unit: Unit): number {
  return value * PT_PER_UNIT[unit];
}

/** Decimal places worth showing for a unit (points are whole; inches want two). */
const PLACES: Readonly<Record<Unit, number>> = { pt: 0, mm: 0, cm: 1, in: 2 };

/** Formats a length in points for display, e.g. `formatLength(72, 'in')` → `"1.00 in"`. */
export function formatLength(points: number, unit: Unit, withUnit = true): string {
  const value = fromPoints(points, unit);
  const text = value.toFixed(PLACES[unit]);
  // `-0.00` is noise.
  const clean = /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
  return withUnit ? `${clean} ${unit}` : clean;
}

/** Candidate tick spacings per unit, in that unit, smallest first. */
const STEPS: Readonly<Record<Unit, ReadonlyArray<number>>> = {
  pt: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
  mm: [1, 2, 5, 10, 20, 50, 100, 200, 500],
  cm: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50],
  in: [0.0625, 0.125, 0.25, 0.5, 1, 2, 5, 10],
};

/**
 * The tick spacing (in points) whose on-screen distance is at least `minPx`, so labels never
 * collide however far out you zoom.
 */
export function tickStep(unit: Unit, zoom: number, minPx = 56): number {
  const steps = STEPS[unit];
  for (const step of steps) {
    if (toPoints(step, unit) * zoom >= minPx) return toPoints(step, unit);
  }
  const last = steps[steps.length - 1] ?? 1;
  // Beyond the table, keep doubling rather than giving up.
  let step = toPoints(last, unit);
  while (step * zoom < minPx && step < 1e7) step *= 2;
  return step;
}

export interface Tick {
  /** Position in points from the ruler's origin. */
  readonly points: number;
  /** Position in CSS px from the ruler's origin. */
  readonly px: number;
  /** Major ticks carry a label. */
  readonly major: boolean;
  readonly label: string;
}

/**
 * Ticks covering `[fromPt, toPt)`. Minor ticks subdivide the major step into `subdivisions`.
 * Positions are relative to the ruler origin, which the caller places at the page's top-left.
 */
export function rulerTicks(
  fromPt: number,
  toPt: number,
  unit: Unit,
  zoom: number,
  options: { readonly minPx?: number; readonly subdivisions?: number } = {},
): Tick[] {
  const major = tickStep(unit, zoom, options.minPx ?? 56);
  const subdivisions = Math.max(1, Math.round(options.subdivisions ?? (unit === 'in' ? 4 : 5)));
  const minor = major / subdivisions;
  if (!(minor > 0) || !Number.isFinite(minor)) return [];
  const ticks: Tick[] = [];
  const start = Math.floor(fromPt / minor) * minor;
  const limit = 4000; // a guard: a ruler never legitimately needs more marks than this
  for (let i = 0; i < limit; i++) {
    const points = start + i * minor;
    if (points >= toPt) break;
    if (points < fromPt - minor / 2) continue;
    const steps = Math.round(points / major);
    const isMajor = Math.abs(points - steps * major) < minor / 100;
    ticks.push({
      points,
      px: points * zoom,
      major: isMajor,
      label: isMajor ? formatLength(points, unit, false) : '',
    });
  }
  return ticks;
}

/** Snaps a length in points to the nearest grid line. */
export function snapToGrid(points: number, spacingPt: number): number {
  if (!(spacingPt > 0)) return points;
  return Math.round(points / spacingPt) * spacingPt;
}
