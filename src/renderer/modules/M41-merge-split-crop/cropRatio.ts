import type { PdfRect, Rotation } from '@shared/pdf';
import presets from '../../../../resources/crop-ratios.json';

export const CROP_RATIOS = presets;
export interface CropRatioChoice {
  readonly mode: string;
  readonly width: string;
  readonly height: string;
}
export const FREE_CROP_RATIO: CropRatioChoice = { mode: 'free', width: '4', height: '3' };
export const RATIO_ERROR =
  'Enter width and height from 0.01 to 1000, with a ratio from 1:100 to 100:1.';

/** null is free; undefined is invalid, and must never silently become free. */
export function readCropRatio(choice: CropRatioChoice): number | null | undefined {
  if (choice.mode === 'free') return null;
  const preset = CROP_RATIOS.find((p) => p.value === choice.mode);
  if (preset) return preset.width / preset.height;
  if (choice.mode !== 'custom') return undefined;
  const w = Number(choice.width);
  const h = Number(choice.height);
  if (![w, h].every((n) => Number.isFinite(n) && n >= 0.01 && n <= 1000)) return undefined;
  const ratio = w / h;
  return ratio >= 0.01 && ratio <= 100 ? ratio : undefined;
}

/** Ratios describe the displayed page; saved boxes stay in unrotated PDF coordinates. */
export function pageCropRatio(ratio: number | null, rotation: Rotation): number | null {
  return ratio === null ? null : rotation === 90 || rotation === 270 ? 1 / ratio : ratio;
}

/** Centre-fit inside both rectangles, without a minimum-size clamp that would break the ratio. */
export function fitCropRatio(rect: PdfRect, bounds: PdfRect, ratio: number | null): PdfRect {
  const x0 = Math.max(bounds.x0, Math.min(bounds.x1, rect.x0));
  const y0 = Math.max(bounds.y0, Math.min(bounds.y1, rect.y0));
  const x1 = Math.max(x0, Math.min(bounds.x1, rect.x1));
  const y1 = Math.max(y0, Math.min(bounds.y1, rect.y1));
  if (ratio === null) return { x0, y0, x1, y1 };
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error(RATIO_ERROR);
  const w = Math.min(x1 - x0, (y1 - y0) * ratio);
  const h = w / ratio;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 };
}

export function usableCrop(rect: PdfRect): boolean {
  return (
    Object.values(rect).every(Number.isFinite) && rect.x1 - rect.x0 >= 1 && rect.y1 - rect.y0 >= 1
  );
}
