/**
 * The results list (M33). Pure: rows, totals and the CSV, over model annotations.
 *
 * The panel that shows them is `ResultsPanel.ts`; everything about *what* it shows is here, so a
 * test can check the arithmetic and the file without a DOM.
 */

import type { ModelAnnotation } from '@core/model';
import {
  formatMeasureNumber,
  formatMeasurement,
  scaleRatioText,
  unitLabel,
  type MeasureKind,
  type MeasureScale,
} from '@engine/appearance';
import { measurementFor } from './overlay';

/** One measurement, as the list shows it. */
export interface ResultRow {
  readonly id: string;
  /** 0-based page index; the panel adds one. */
  readonly page: number;
  readonly pageLabel: string;
  /** "Distance", "Perimeter", "Area". */
  readonly kindLabel: string;
  readonly kind: MeasureKind;
  /** In the scale's unit. */
  readonly value: number;
  /** The value with its unit. */
  readonly text: string;
  readonly scale: MeasureScale;
  readonly ratio: string;
  /** `/Contents`, which the reader may have replaced with a note of their own. */
  readonly label: string;
  readonly author: string;
  readonly created: string;
}

const KIND_LABELS = {
  LineDimension: 'Distance',
  PolyLineDimension: 'Perimeter',
  PolygonDimension: 'Area',
} as const;

/**
 * Every measurement in the document, page by page, in the order the pages are in.
 *
 * `pages` is the model's page list; `annotationsOf` reads the annotations of one page, which is
 * what keeps this pure — the caller decides whether that means the loaded ones or all of them.
 */
export function resultRows(
  pages: ReadonlyArray<{ readonly id: string; readonly label: string }>,
  annotationsOf: (pageId: string) => ReadonlyArray<ModelAnnotation>,
): ResultRow[] {
  const out: ResultRow[] = [];
  pages.forEach((page, index) => {
    for (const a of annotationsOf(page.id)) {
      const measurement = measurementFor(a);
      if (!measurement) continue;
      out.push({
        id: a.id,
        page: index,
        pageLabel: page.label,
        kind: measurement.kind,
        kindLabel: KIND_LABELS[measurement.intent],
        value: measurement.value,
        text: measurement.text,
        scale: measurement.scale,
        ratio: scaleRatioText(measurement.scale),
        label: a.contents ?? '',
        author: a.author ?? '',
        created: a.created ?? '',
      });
    }
  });
  return out;
}

/** A running total per unit label, so two scales in one document do not get added together. */
export interface ResultTotal {
  readonly kind: MeasureKind;
  readonly unit: string;
  readonly count: number;
  readonly value: number;
  readonly text: string;
}

/**
 * The cumulative totals: one per (kind, unit) pair, lengths first.
 *
 * Deliberately **not** one grand total. A document can hold measurements made at two scales, or
 * in two units, and adding those would produce a number that means nothing; keeping them apart
 * says so without a warning nobody reads.
 */
export function resultTotals(rows: ReadonlyArray<ResultRow>): ResultTotal[] {
  const buckets = new Map<
    string,
    { kind: MeasureKind; scale: MeasureScale; sum: number; n: number }
  >();
  for (const row of rows) {
    const unit = unitLabel(row.scale.toUnit, row.kind);
    const key = `${row.kind}|${unit}`;
    const bucket = buckets.get(key) ?? { kind: row.kind, scale: row.scale, sum: 0, n: 0 };
    bucket.sum += row.value;
    bucket.n += 1;
    buckets.set(key, bucket);
  }
  const out: ResultTotal[] = [];
  for (const [key, bucket] of buckets) {
    out.push({
      kind: bucket.kind,
      unit: key.split('|')[1] ?? '',
      count: bucket.n,
      value: bucket.sum,
      text: formatMeasurement(bucket.sum, bucket.scale, bucket.kind),
    });
  }
  return out.sort((a, b) =>
    a.kind === b.kind ? a.unit.localeCompare(b.unit) : a.kind === 'length' ? -1 : 1,
  );
}

// ---- export ------------------------------------------------------------------------------------

/** UTF-8 byte-order mark, written as an escape so it is visible in review. */
export const BOM = '\uFEFF';

const CRLF = '\r\n';

const HEADER = ['Page', 'Type', 'Value', 'Unit', 'Scale', 'Comment', 'Author', 'Created'] as const;

function quote(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

/**
 * The rows as CSV: RFC 4180 quoting, CRLF endings and a UTF-8 BOM so a spreadsheet opens it as
 * Unicode rather than guessing at a code page — the same shape M13's search export uses.
 *
 * The value and its unit are separate columns, because a spreadsheet cannot add up "100.0 mm".
 */
export function rowsToCsv(rows: ReadonlyArray<ResultRow>): string {
  const lines = [HEADER.map(quote).join(',')];
  for (const row of rows) {
    lines.push(
      [
        quote(row.pageLabel),
        quote(row.kindLabel),
        quote(formatMeasureNumber(row.value, row.scale)),
        quote(unitLabel(row.scale.toUnit, row.kind)),
        quote(row.ratio),
        quote(row.label),
        quote(row.author),
        quote(row.created),
      ].join(','),
    );
  }
  return BOM + lines.join(CRLF) + CRLF;
}

/** The CSV as bytes, ready for `file:write`. */
export function csvBytes(rows: ReadonlyArray<ResultRow>): Uint8Array {
  return new TextEncoder().encode(rowsToCsv(rows));
}

/** The rows as tab-separated text, which is what a spreadsheet wants off the clipboard. */
export function rowsToText(rows: ReadonlyArray<ResultRow>): string {
  const lines = [HEADER.join('\t')];
  for (const row of rows) {
    lines.push(
      [
        row.pageLabel,
        row.kindLabel,
        formatMeasureNumber(row.value, row.scale),
        unitLabel(row.scale.toUnit, row.kind),
        row.ratio,
        row.label,
        row.author,
        row.created,
      ].join('\t'),
    );
  }
  return lines.join('\n');
}
