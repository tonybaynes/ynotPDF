/**
 * Where a document's working scale lives (M33).
 *
 * `Document.custom['M33.measure']` holds one record: the document's own scale, and a scale per
 * page id for the pages that have been calibrated separately. It is written by a
 * `SetCustomCommand`, so calibrating is undoable, journalled and in the recovery file like every
 * other change — a calibration lost on a crash would mean every measurement after it was wrong.
 *
 * Pure: this file reads and builds the record, and never touches the document itself.
 */

import type { ModelId } from '@core/Ids';
import { DEFAULT_MEASURE_SCALE, parseMeasureScale, type MeasureScale } from '@engine/appearance';

/** The namespace inside `Document.custom`. One per module, as M20 requires. */
export const MEASURE_NAMESPACE = 'M33.measure';

/** The two keys the namespace holds. */
export const SCALE_KEY = 'scale';
export const PAGE_SCALES_KEY = 'pageScales';

/** A document's calibration: one scale for the document, and any per-page overrides. */
export interface ScaleRecord {
  readonly document: MeasureScale | null;
  readonly pages: Readonly<Record<string, MeasureScale>>;
}

export const EMPTY_SCALE_RECORD: ScaleRecord = { document: null, pages: {} };

/** The record a `Document.custom` namespace holds, defaulted and validated. */
export function readScaleRecord(bag: Readonly<Record<string, unknown>>): ScaleRecord {
  const pages: Record<string, MeasureScale> = {};
  const raw = bag[PAGE_SCALES_KEY];
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const scale = parseMeasureScale(value);
      if (scale) pages[key] = scale;
    }
  }
  return { document: parseMeasureScale(bag[SCALE_KEY]), pages };
}

/**
 * The scale a page measures with: its own if it has been calibrated, else the document's, else
 * the one the settings say a new document starts with.
 *
 * Per-page beats per-document deliberately: a drawing set often has one sheet at 1:50 and the
 * next at 1:100, and calibrating the second must not silently re-measure the first.
 */
export function scaleFor(
  record: ScaleRecord,
  pageId: ModelId | null,
  fallback: MeasureScale = DEFAULT_MEASURE_SCALE,
): MeasureScale {
  const page = pageId === null ? undefined : record.pages[pageId];
  return page ?? record.document ?? fallback;
}

/** Whether a page has a calibration of its own. */
export function hasPageScale(record: ScaleRecord, pageId: ModelId | null): boolean {
  return pageId !== null && record.pages[pageId] !== undefined;
}

/** The values a `SetCustomCommand` writes to set the document's scale. */
export function documentScalePatch(scale: MeasureScale): Record<string, unknown> {
  return { [SCALE_KEY]: scale };
}

/**
 * The values a `SetCustomCommand` writes to set (or clear) one page's scale. The whole map is
 * written each time: `SetCustomCommand` merges at the key level, so a nested object has to be
 * replaced whole or a removed page would survive.
 */
export function pageScalePatch(
  record: ScaleRecord,
  pageId: ModelId,
  scale: MeasureScale | null,
): Record<string, unknown> {
  const pages: Record<string, MeasureScale> = {};
  for (const [key, value] of Object.entries(record.pages)) {
    if (key !== pageId) pages[key] = value;
  }
  if (scale !== null) pages[pageId] = scale;
  return { [PAGE_SCALES_KEY]: pages };
}

/**
 * The scale that makes a drawn length mean a stated one: the calibration.
 *
 * `pagePoints` is what was drawn, `realValue` and `unit` what the reader says it is. The scale is
 * stated as "1 <unit> of page = *n* <unit>", which is the form the `/Measure` number format takes
 * anyway, so nothing is lost turning it into one.
 */
export function calibrationScale(input: {
  readonly pagePoints: number;
  readonly realValue: number;
  readonly unit: MeasureScale['toUnit'];
  readonly precision: number;
  readonly denominator?: number;
  readonly pointsPerUnit: number;
}): MeasureScale | null {
  if (!(input.pagePoints > 1e-6) || !(input.realValue > 0)) return null;
  const pageInUnits = input.pagePoints / input.pointsPerUnit;
  return {
    fromValue: 1,
    fromUnit: input.unit,
    toValue: input.realValue / pageInUnits,
    toUnit: input.unit,
    precision: input.precision,
    denominator: input.denominator ?? 0,
  };
}
