/**
 * Page-size presets (M91). The data is `resources/page-sizes.json`; this file only turns a
 * choice into points and applies orientation. Everything here is pure.
 */

import type { MarginsMm, Orientation, PageSizeChoice } from './create';
import { mmToPt } from './pdf';
import presetsJson from '../../resources/page-sizes.json';

export interface PageSizePreset {
  readonly id: string;
  readonly label: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly group: string;
}

interface PresetFile {
  readonly version: number;
  readonly sizes: ReadonlyArray<PageSizePreset>;
}

const FILE = presetsJson as PresetFile;

/** Every preset, in file order. */
export const PAGE_SIZE_PRESETS: ReadonlyArray<PageSizePreset> = FILE.sizes;

export const DEFAULT_PAGE_SIZE_ID = 'A4';

export function findPreset(id: string): PageSizePreset | undefined {
  return PAGE_SIZE_PRESETS.find((p) => p.id === id);
}

/** Width and height in points. */
export interface SizePt {
  readonly width: number;
  readonly height: number;
}

/** A choice as portrait points, before orientation. Unknown presets fall back to A4. */
export function choiceToPortraitPoints(choice: PageSizeChoice): SizePt {
  if (choice.kind === 'custom') {
    const w = Math.max(1, choice.widthMm);
    const h = Math.max(1, choice.heightMm);
    return { width: mmToPt(Math.min(w, h)), height: mmToPt(Math.max(w, h)) };
  }
  const preset = findPreset(choice.id) ?? findPreset(DEFAULT_PAGE_SIZE_ID);
  if (!preset) return { width: mmToPt(210), height: mmToPt(297) };
  return { width: mmToPt(preset.widthMm), height: mmToPt(preset.heightMm) };
}

/**
 * Applies an orientation to a portrait size. `auto` needs a hint — the content's aspect — and
 * is portrait when there is none.
 */
export function orient(size: SizePt, orientation: Orientation, contentAspect?: number): SizePt {
  const landscape =
    orientation === 'landscape' ||
    (orientation === 'auto' && contentAspect !== undefined && contentAspect > 1);
  const portrait: SizePt = {
    width: Math.min(size.width, size.height),
    height: Math.max(size.width, size.height),
  };
  return landscape ? { width: portrait.height, height: portrait.width } : portrait;
}

/** Margins in points, clamped so they can never swallow the page. */
export function marginsToPoints(margins: MarginsMm, page: SizePt): MarginsMm {
  const maxX = page.width / 2 - 1;
  const maxY = page.height / 2 - 1;
  const clamp = (mm: number, max: number): number => Math.min(Math.max(0, mmToPt(mm)), max);
  return {
    top: clamp(margins.top, maxY),
    right: clamp(margins.right, maxX),
    bottom: clamp(margins.bottom, maxY),
    left: clamp(margins.left, maxX),
  };
}

/** The page size in points for a choice + orientation, with an optional content aspect for auto. */
export function resolvePageSize(
  choice: PageSizeChoice,
  orientation: Orientation,
  contentAspect?: number,
): SizePt {
  return orient(choiceToPortraitPoints(choice), orientation, contentAspect);
}

/** Chromium's `printToPDF` wants a size in inches. */
export function sizeInInches(size: SizePt): { readonly width: number; readonly height: number } {
  return { width: size.width / 72, height: size.height / 72 };
}
