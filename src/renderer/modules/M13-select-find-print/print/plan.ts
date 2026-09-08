/**
 * From the print dialog's settings to a list of sheets (M13). Pure, so the preview, the paper
 * and "Print to PDF" all read the same plan and the acceptance test can check the imposition
 * without a printer.
 */

import type { PrintSettings } from '../settings';
import {
  imposePages,
  orientPaper,
  type ImpositionOptions,
  type Paper,
  type Sheet,
  type SourcePage,
} from './imposition';
import { resolvePages } from './pageRange';
import { paperOrDefault } from './paper';

export interface PrintPlanInput {
  readonly settings: PrintSettings;
  /** Displayed page sizes in points, one per page of the document. */
  readonly pageSizes: ReadonlyArray<{ readonly width: number; readonly height: number }>;
  readonly currentPage: number;
  /** Pages the reader has selected text or thumbnails on, for "Selection". */
  readonly selectedPages: ReadonlyArray<number>;
}

export interface PrintPlan {
  /** Source pages, in print order. */
  readonly pages: ReadonlyArray<number>;
  readonly sheets: ReadonlyArray<Sheet>;
  readonly paper: Paper;
  readonly imposition: ImpositionOptions;
  readonly error: string | null;
}

/** Chooses the paper's orientation when the reader asked for "automatic". */
export function autoOrientation(
  pages: ReadonlyArray<{ readonly width: number; readonly height: number }>,
): 'portrait' | 'landscape' {
  let landscape = 0;
  for (const page of pages) if (page.width > page.height) landscape++;
  return landscape * 2 > pages.length ? 'landscape' : 'portrait';
}

export function buildPrintPlan(input: PrintPlanInput): PrintPlan {
  const { settings } = input;
  const range = resolvePages({
    mode: settings.rangeMode,
    text: settings.rangeText,
    pageCount: input.pageSizes.length,
    currentPage: input.currentPage,
    selectedPages: input.selectedPages,
    subset: settings.subset,
    reverse: settings.reverse,
  });
  const sizes = range.pages
    .map((index) => {
      const size = input.pageSizes[index];
      return size ? ({ index, width: size.width, height: size.height } satisfies SourcePage) : null;
    })
    .filter((p): p is SourcePage => p !== null);

  const named = paperOrDefault(settings.paperId);
  const orientation =
    settings.orientation === 'auto' ? autoOrientation(sizes) : settings.orientation;
  // A booklet folds two pages on to one sheet, so its sheet is the long way round whatever the
  // reader picked — that is what makes the fold down the middle work.
  const paper = orientPaper(named, settings.mode === 'booklet' ? 'landscape' : orientation);

  const imposition: ImpositionOptions = {
    paper,
    margins: {
      top: settings.marginTop,
      right: settings.marginRight,
      bottom: settings.marginBottom,
      left: settings.marginLeft,
    },
    scaling: settings.scaling,
    customScale: settings.customScale,
    autoRotate: settings.autoRotate,
    autoCentre: settings.autoCentre,
    nUp:
      settings.mode === 'nup'
        ? {
            columns: settings.nUpColumns,
            rows: settings.nUpRows,
            order: settings.nUpOrder,
            border: settings.nUpBorder,
          }
        : null,
    booklet:
      settings.mode === 'booklet'
        ? { subset: settings.bookletSubset, binding: settings.bookletBinding }
        : null,
    tile:
      settings.mode === 'tile'
        ? { scale: settings.tileScale, overlap: settings.tileOverlap, marks: settings.tileMarks }
        : null,
  };

  if (range.error) {
    return { pages: [], sheets: [], paper, imposition, error: range.error };
  }
  return {
    pages: sizes.map((p) => p.index),
    sheets: imposePages(sizes, imposition),
    paper,
    imposition,
    error: sizes.length === 0 ? 'No pages to print' : null,
  };
}

/** A one-line description of what will happen, for the dialog's summary. */
export function describePlan(plan: PrintPlan): string {
  if (plan.error) return plan.error;
  const sheets = plan.sheets.length;
  const pages = plan.pages.length;
  const pagePlural = pages === 1 ? 'page' : 'pages';
  const sheetPlural = sheets === 1 ? 'sheet' : 'sheets';
  return `${pages} ${pagePlural} on ${sheets} ${sheetPlural}`;
}
