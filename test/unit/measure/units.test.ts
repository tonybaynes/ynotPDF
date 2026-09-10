/**
 * M33: the scale, the numbers a measurement shows, and the `/Measure` dictionary they become.
 *
 * These are the arithmetic the whole module rests on — a wrong conversion factor is a wrong
 * number on every page — so the cases are stated in the units a reader would use.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEASURE_SCALE,
  FRACTION_DENOMINATORS,
  MEASURE_UNITS,
  POINTS_PER_UNIT,
  areaFactor,
  formatFraction,
  formatMeasureNumber,
  formatMeasurement,
  isMeasureUnit,
  linearFactor,
  measureArea,
  measureDictValue,
  measureLength,
  normaliseScale,
  parseMeasureScale,
  scaleFromNumberFormat,
  scaleRatioText,
  unitLabel,
  type MeasureScale,
} from '@engine/appearance';
import type { DictValue } from '@engine/appearance/dict';

/** 100 mm in PDF points. */
const HUNDRED_MM = (100 * 72) / 25.4;

const scale = (patch: Partial<MeasureScale> = {}): MeasureScale =>
  normaliseScale({ ...DEFAULT_MEASURE_SCALE, ...patch });

describe('units', () => {
  it('knows how many points each unit is', () => {
    expect(POINTS_PER_UNIT.pt).toBe(1);
    expect(POINTS_PER_UNIT.in).toBe(72);
    expect(POINTS_PER_UNIT.pc).toBe(12);
    expect(POINTS_PER_UNIT.mm).toBeCloseTo(2.834645669, 6);
    expect(POINTS_PER_UNIT.cm).toBeCloseTo(28.34645669, 6);
    expect(POINTS_PER_UNIT.m).toBeCloseTo(2834.645669, 5);
    expect(POINTS_PER_UNIT.ft).toBe(864);
    expect(POINTS_PER_UNIT.yd).toBe(2592);
    expect(POINTS_PER_UNIT.mi).toBe(63360 * 72);
    expect(POINTS_PER_UNIT.km).toBeCloseTo(POINTS_PER_UNIT.m * 1000, 3);
  });

  it('recognises its own units and nothing else', () => {
    for (const unit of MEASURE_UNITS) expect(isMeasureUnit(unit)).toBe(true);
    expect(isMeasureUnit('furlong')).toBe(false);
    expect(isMeasureUnit(72)).toBe(false);
    expect(isMeasureUnit(null)).toBe(false);
  });

  it('labels an area with a squared unit and an angle with a degree sign', () => {
    expect(unitLabel('mm', 'length')).toBe('mm');
    expect(unitLabel('mm', 'area')).toBe('mm²');
    expect(unitLabel('ft', 'angle')).toBe('°');
  });
});

describe('the scale', () => {
  it('measures true size in millimetres by default', () => {
    expect(measureLength(HUNDRED_MM, DEFAULT_MEASURE_SCALE)).toBeCloseTo(100, 9);
  });

  it('converts a length through any pair of units', () => {
    // 1 inch of page is 1 inch: 72 points is one inch.
    expect(measureLength(72, scale({ fromUnit: 'in', toUnit: 'in' }))).toBeCloseTo(1, 9);
    // A site plan at 1 cm = 5 m: one centimetre of page is five metres.
    const plan = scale({ fromValue: 1, fromUnit: 'cm', toValue: 5, toUnit: 'm' });
    expect(measureLength(POINTS_PER_UNIT.cm, plan)).toBeCloseTo(5, 9);
    expect(measureLength(POINTS_PER_UNIT.cm * 3, plan)).toBeCloseTo(15, 9);
  });

  it('squares the factor for an area', () => {
    const plan = scale({ fromValue: 1, fromUnit: 'cm', toValue: 5, toUnit: 'm' });
    expect(areaFactor(plan)).toBeCloseTo(linearFactor(plan) ** 2, 12);
    // One square centimetre of page is 25 square metres.
    const cm2 = POINTS_PER_UNIT.cm ** 2;
    expect(measureArea(cm2, plan)).toBeCloseTo(25, 6);
  });

  it('measures a 50 x 20 mm rectangle as 1000 mm²', () => {
    const points = ((50 * 72) / 25.4) * ((20 * 72) / 25.4);
    expect(measureArea(points, DEFAULT_MEASURE_SCALE)).toBeCloseTo(1000, 6);
  });

  it('states the ratio in words', () => {
    expect(scaleRatioText(DEFAULT_MEASURE_SCALE)).toBe('1 mm = 1 mm');
    expect(scaleRatioText(scale({ fromUnit: 'cm', toValue: 5, toUnit: 'm' }))).toBe('1 cm = 5 m');
  });

  it('refuses zero, negative and nonsense, without throwing', () => {
    const bad = normaliseScale({
      fromValue: 0,
      fromUnit: 'nope' as never,
      toValue: -3,
      toUnit: 'mm',
      precision: 99,
      denominator: 7,
    });
    expect(bad.fromValue).toBe(1);
    expect(bad.fromUnit).toBe('mm');
    expect(bad.toValue).toBe(3);
    expect(bad.precision).toBe(6);
    expect(bad.denominator).toBe(0);
  });

  it('parses a stored object, and rejects one with no units', () => {
    expect(parseMeasureScale({ ...DEFAULT_MEASURE_SCALE })).toEqual(DEFAULT_MEASURE_SCALE);
    expect(parseMeasureScale({ fromValue: 1, toValue: 1 })).toBeNull();
    expect(parseMeasureScale(null)).toBeNull();
    expect(parseMeasureScale('1 mm = 1 mm')).toBeNull();
  });
});

describe('formatting', () => {
  it('shows a value to the precision the scale asks for', () => {
    expect(formatMeasureNumber(100, scale({ precision: 0 }))).toBe('100');
    expect(formatMeasureNumber(100, scale({ precision: 1 }))).toBe('100.0');
    expect(formatMeasureNumber(100.456, scale({ precision: 2 }))).toBe('100.46');
    expect(formatMeasurement(100, DEFAULT_MEASURE_SCALE, 'length')).toBe('100.0 mm');
    expect(formatMeasurement(1000, DEFAULT_MEASURE_SCALE, 'area')).toBe('1,000.0 mm²');
  });

  it('never shows a rounded-away value as minus zero', () => {
    expect(formatMeasureNumber(-0.0001, scale({ precision: 1 }))).toBe('0.0');
    expect(formatMeasureNumber(0, scale({ precision: 2 }))).toBe('0.00');
  });

  it('writes fractions as mixed numbers, reduced', () => {
    expect(formatFraction(3.5, 16)).toBe('3 1/2');
    expect(formatFraction(0.25, 16)).toBe('1/4');
    expect(formatFraction(5, 8)).toBe('5');
    expect(formatFraction(-1.75, 4)).toBe('-1 3/4');
    expect(formatFraction(2.0625, 16)).toBe('2 1/16');
    expect(formatMeasurement(3.5, scale({ toUnit: 'in', denominator: 16 }), 'length')).toBe(
      '3 1/2 in',
    );
  });

  it('offers the fraction denominators a ruler has', () => {
    expect([...FRACTION_DENOMINATORS]).toEqual([2, 4, 8, 16]);
  });
});

// ---- the `/Measure` dictionary --------------------------------------------------------------

/** A typed entry out of a planned dictionary, so the assertions read as PDF rather than as TS. */
function entry(value: DictValue, ...keys: string[]): DictValue | null {
  let current: DictValue | null = value;
  for (const key of keys) {
    if (current?.kind !== 'dict') return null;
    current = current.value[key] ?? null;
  }
  return current;
}

describe('the /Measure dictionary', () => {
  const plan = scale({ fromValue: 1, fromUnit: 'cm', toValue: 5, toUnit: 'm', precision: 2 });
  const dict = measureDictValue(plan);

  it('is a RectilinearMeasure with the ratio in words', () => {
    expect(entry(dict, 'Type')).toEqual({ kind: 'name', value: 'Measure' });
    expect(entry(dict, 'Subtype')).toEqual({ kind: 'name', value: 'RL' });
    expect(entry(dict, 'R')).toEqual({ kind: 'string', value: '1 cm = 5 m' });
    expect(entry(dict, 'CYX')).toEqual({ kind: 'number', value: 1 });
  });

  it('carries all five axes as arrays of number formats', () => {
    for (const axis of ['X', 'Y', 'D', 'A', 'T']) {
      const array = entry(dict, axis);
      expect(array?.kind, axis).toBe('array');
      if (array?.kind !== 'array') continue;
      expect(array.value).toHaveLength(1);
      const format = array.value[0];
      expect(format?.kind).toBe('dict');
      if (format?.kind !== 'dict') continue;
      expect(format.value['Type']).toEqual({ kind: 'name', value: 'NumberFormat' });
      // Written in full: nothing relies on a reader's defaults.
      for (const key of ['U', 'C', 'F', 'D', 'FD', 'RD', 'RT', 'PS', 'SS', 'O']) {
        expect(format.value[key], `${axis}.${key}`).toBeDefined();
      }
    }
  });

  it('converts default user space to the unit, and squares it for an area', () => {
    const distance = entry(dict, 'D');
    const area = entry(dict, 'A');
    const factor = (value: DictValue | null): number => {
      if (value?.kind !== 'array') return Number.NaN;
      const format = value.value[0];
      if (format?.kind !== 'dict') return Number.NaN;
      const c = format.value['C'];
      return c?.kind === 'number' ? c.value : Number.NaN;
    };
    expect(factor(distance)).toBeCloseTo(linearFactor(plan), 12);
    expect(factor(area)).toBeCloseTo(linearFactor(plan) ** 2, 12);
  });

  it('labels an area with the squared unit and an angle in degrees', () => {
    const label = (value: DictValue | null): string => {
      if (value?.kind !== 'array') return '';
      const format = value.value[0];
      if (format?.kind !== 'dict') return '';
      const u = format.value['U'];
      return u?.kind === 'string' ? u.value : '';
    };
    expect(label(entry(dict, 'D'))).toBe('m');
    expect(label(entry(dict, 'A'))).toBe('m²');
    expect(label(entry(dict, 'T'))).toBe('°');
  });

  it('says decimals with a power-of-ten denominator, and fractions with the real one', () => {
    const style = (value: DictValue, ...keys: string[]): unknown => {
      const array = entry(value, ...keys);
      if (array?.kind !== 'array') return null;
      const format = array.value[0];
      if (format?.kind !== 'dict') return null;
      return [format.value['F'], format.value['D']];
    };
    expect(style(dict, 'D')).toEqual([
      { kind: 'name', value: 'D' },
      { kind: 'number', value: 100 },
    ]);
    const fractional = measureDictValue(scale({ toUnit: 'in', denominator: 8 }));
    expect(style(fractional, 'D')).toEqual([
      { kind: 'name', value: 'F' },
      { kind: 'number', value: 8 },
    ]);
  });
});

describe('reading a /Measure back', () => {
  it('rebuilds the same arithmetic from a number format', () => {
    const plan = scale({ fromValue: 1, fromUnit: 'cm', toValue: 5, toUnit: 'm' });
    const back = scaleFromNumberFormat({ unit: 'm', conversion: linearFactor(plan) });
    expect(back).not.toBeNull();
    if (back === null) return;
    // Stated differently — "1 m of page = n m" — but the same factor, which is what matters.
    expect(linearFactor(back)).toBeCloseTo(linearFactor(plan), 12);
    expect(measureLength(POINTS_PER_UNIT.cm, back)).toBeCloseTo(5, 9);
  });

  it('takes the squared label off an area format', () => {
    const back = scaleFromNumberFormat({ unit: 'mm²', conversion: 1 });
    expect(back?.toUnit).toBe('mm');
  });

  it('reads the precision out of a decimal denominator, and a fraction out of /F /F', () => {
    expect(scaleFromNumberFormat({ unit: 'mm', conversion: 1, denominator: 1000 })?.precision).toBe(
      3,
    );
    const fraction = scaleFromNumberFormat({
      unit: 'in',
      conversion: 1,
      fractionStyle: 'F',
      denominator: 16,
    });
    expect(fraction?.denominator).toBe(16);
  });

  it('refuses a unit it does not know and a factor that makes no sense', () => {
    expect(scaleFromNumberFormat({ unit: 'furlong', conversion: 1 })).toBeNull();
    expect(scaleFromNumberFormat({ unit: 'mm', conversion: 0 })).toBeNull();
    expect(scaleFromNumberFormat({ unit: 'mm', conversion: Number.NaN })).toBeNull();
  });
});
