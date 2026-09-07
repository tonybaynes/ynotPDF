/**
 * Perceptual hashing of rendered pages (M10). Used by the render-regression tests
 * (`test/fixtures/hashes/`) and by the `dev.engineOpen` probe command.
 *
 * Difference hash: downsample to a 9×8 grid of mean luminance (box filter) and emit one bit
 * per horizontal neighbour comparison → 64 bits as 16 hex digits. Anti-aliasing differences
 * flip at most a few bits; layout or content changes flip many.
 */

/** Luminance of the RGBA pixel starting at byte `i` (0..255). */
export function luma(rgba: ArrayLike<number>, i: number): number {
  return 0.299 * (rgba[i] ?? 0) + 0.587 * (rgba[i + 1] ?? 0) + 0.114 * (rgba[i + 2] ?? 0);
}

export function dhash(rgba: ArrayLike<number>, width: number, height: number): string {
  const cols = 9;
  const rows = 8;
  const cells = new Float64Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    const y0 = Math.floor((cy * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * height) / rows));
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx * width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / cols));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          sum += luma(rgba, (y * width + x) * 4);
          n++;
        }
      }
      cells[cy * cols + cx] = n > 0 ? sum / n : 0;
    }
  }
  let bits = '';
  for (let cy = 0; cy < rows; cy++) {
    let byte = 0;
    for (let cx = 0; cx < cols - 1; cx++) {
      const a = cells[cy * cols + cx] ?? 0;
      const b = cells[cy * cols + cx + 1] ?? 0;
      byte = (byte << 1) | (a > b ? 1 : 0);
    }
    bits += byte.toString(16).padStart(2, '0');
  }
  return bits;
}

/** Number of differing bits between two hex hashes of equal length. */
export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = parseInt(a[i] ?? '0', 16) ^ parseInt(b[i] ?? '0', 16);
    d += ((x >> 3) & 1) + ((x >> 2) & 1) + ((x >> 1) & 1) + (x & 1);
  }
  return d;
}
