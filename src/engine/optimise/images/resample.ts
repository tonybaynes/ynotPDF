/**
 * Downsampling (M100).
 *
 * A box filter — every output pixel is the mean of the input pixels it covers — because for
 * *reduction* it is what an area-average should be, and the fancier kernels (Lanczos, bicubic)
 * buy sharpness at the cost of ringing round the hard edges that scanned text is made of. Foxit
 * and Acrobat both offer "average downsampling" as their safe default for the same reason
 * (public docs); their "bicubic" option is the one that makes a scan look worse.
 *
 * Fractional coverage is handled properly rather than by nearest-neighbour on the box edges: the
 * first and last input pixel of each box are weighted by how much of them the box actually
 * covers. Without it, a 1.3× reduction — which is most of them, once a threshold is in play —
 * drops rows and columns outright and the result shimmers.
 */

import type { Samples } from './codecs';

/**
 * Scales `samples` to `width` × `height`. Enlarging is refused: the caller is reducing, and an
 * optimiser that made an image bigger would be doing the opposite of its job.
 */
export function resample(samples: Samples, width: number, height: number): Samples {
  const w = Math.max(1, Math.min(Math.round(width), samples.width));
  const h = Math.max(1, Math.min(Math.round(height), samples.height));
  if (w === samples.width && h === samples.height) return samples;

  const n = samples.components;
  const out = new Uint8Array(w * h * n);
  const xScale = samples.width / w;
  const yScale = samples.height / h;
  const accumulator = new Float64Array(n);

  for (let y = 0; y < h; y++) {
    const y0 = y * yScale;
    const y1 = (y + 1) * yScale;
    for (let x = 0; x < w; x++) {
      const x0 = x * xScale;
      const x1 = (x + 1) * xScale;
      accumulator.fill(0);
      let weightSum = 0;

      for (let sy = Math.floor(y0); sy < Math.min(Math.ceil(y1), samples.height); sy++) {
        const wy = overlap(y0, y1, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.min(Math.ceil(x1), samples.width); sx++) {
          const wx = overlap(x0, x1, sx);
          if (wx <= 0) continue;
          const weight = wy * wx;
          const base = (sy * samples.width + sx) * n;
          for (let c = 0; c < n; c++) {
            accumulator[c] = (accumulator[c] ?? 0) + (samples.data[base + c] ?? 0) * weight;
          }
          weightSum += weight;
        }
      }

      const base = (y * w + x) * n;
      if (weightSum > 0) {
        for (let c = 0; c < n; c++) out[base + c] = Math.round((accumulator[c] ?? 0) / weightSum);
      }
    }
  }
  return { data: out, width: w, height: h, components: n };
}

/** How much of input pixel `i` (which spans `[i, i+1)`) lies inside `[lo, hi)`. */
function overlap(lo: number, hi: number, i: number): number {
  return Math.min(hi, i + 1) - Math.max(lo, i);
}

/**
 * The size an image should be reduced to, or `null` when it should be left alone.
 *
 * `drawnPoints` is how wide and tall the image is *on the page*, in PDF points, which is where
 * the effective resolution comes from: a 2000-pixel image drawn 2 inches wide is 1000 dpi
 * whatever it says about itself. An image nothing draws has no resolution at all and is never
 * downsampled — resizing something we cannot see the size of would be guesswork.
 */
export function targetSize(
  pixels: { readonly width: number; readonly height: number },
  drawnPoints: { readonly width: number; readonly height: number } | null,
  policy: { readonly targetDpi: number; readonly thresholdDpi: number },
): { width: number; height: number } | null {
  if (!drawnPoints || policy.targetDpi <= 0) return null;
  const inchesWide = drawnPoints.width / 72;
  const inchesTall = drawnPoints.height / 72;
  if (!(inchesWide > 0) || !(inchesTall > 0)) return null;
  const dpiX = pixels.width / inchesWide;
  const dpiY = pixels.height / inchesTall;
  // The higher of the two axes decides: an image squashed on one axis is still oversampled on
  // the other, and reducing to the lower figure would blur it.
  const dpi = Math.max(dpiX, dpiY);
  const threshold = Math.max(policy.targetDpi, policy.thresholdDpi);
  if (!(dpi > threshold)) return null;
  const factor = policy.targetDpi / dpi;
  const width = Math.max(1, Math.round(pixels.width * factor));
  const height = Math.max(1, Math.round(pixels.height * factor));
  if (width >= pixels.width && height >= pixels.height) return null;
  return { width, height };
}
