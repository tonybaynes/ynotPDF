/**
 * Paper sizes (M13). The list is data (`resources/print/paper-sizes.json`) so a size can be
 * added without a code change, per PLAN.md §4.4; this file is the typed reader plus the
 * "custom" entry the dialog needs.
 */

import catalogue from '../../../../../resources/print/paper-sizes.json';
import type { Paper } from './imposition';

export interface PaperSize extends Paper {
  readonly id: string;
  readonly label: string;
}

interface Catalogue {
  readonly sizes: ReadonlyArray<PaperSize>;
}

/** Every named size, portrait dimensions, in points. */
export const PAPER_SIZES: ReadonlyArray<PaperSize> = (catalogue as unknown as Catalogue).sizes;

export const DEFAULT_PAPER_ID = 'a4';

export function paperById(id: string): PaperSize | null {
  return PAPER_SIZES.find((s) => s.id === id) ?? null;
}

/** The default when the id is unknown — never `undefined`, so the dialog always has a sheet. */
export function paperOrDefault(id: string): PaperSize {
  return paperById(id) ?? paperById(DEFAULT_PAPER_ID) ?? { ...FALLBACK };
}

const FALLBACK: PaperSize = { id: 'a4', label: 'A4', width: 595.28, height: 841.89 };

/** The closest named size to an arbitrary page, within a point — how "Same as page" resolves. */
export function nearestPaper(width: number, height: number): PaperSize | null {
  const w = Math.min(width, height);
  const h = Math.max(width, height);
  return PAPER_SIZES.find((s) => Math.abs(s.width - w) < 1 && Math.abs(s.height - h) < 1) ?? null;
}
