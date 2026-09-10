/**
 * CCITT Group 4 encoding for one-bit images (M100) — ITU-T T.6, as PDF's `CCITTFaxDecode` with
 * `/K -1` reads it (ISO 32000-1 §7.4.6).
 *
 * Written here rather than pulled in as a dependency: it is a hundred lines of table and forty of
 * state machine, it has no other user, and the alternative encoders on npm are wrappers round C.
 * The two encodings the brief parks — JBIG2 and JPEG 2000 — are the ones that would have needed
 * a real library; G4 is the one that does not, and on scanned text it is worth two to four times
 * flate.
 *
 * **How G4 works, in one paragraph**, because the variable names below are the spec's and mean
 * nothing without it. Each row is coded against the row above it. `a0` is where we have got to on
 * the row being coded; `a1` is the next place its colour changes; `b1` is the next colour change
 * on the row above that would start a run of the opposite colour to `a0`'s, and `b2` the one
 * after that. If `b2` is still left of `a1` the two rows have diverged and we emit *pass* and
 * skip to `b2`; if `a1` is within three pixels of `b1` we emit *vertical* and say how far off it
 * is; otherwise the rows have nothing to do with each other here and we fall back to *horizontal*,
 * which spells out two run lengths in the Group 3 tables. An imaginary all-white row sits above
 * the first one.
 */

import type { Samples } from './codecs';

/** Bit strings exactly as ITU-T T.4 tables 1–3 and T.6 print them. Parsed once, below. */
// prettier-ignore
const WHITE_TERMINATING = [
  '00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111',
  '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101',
  '101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100',
  '0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010',
  '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000',
  '00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010',
  '00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000',
  '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100',
];

// prettier-ignore
const WHITE_MAKEUP = [
  '11011', '10010', '010111', '0110111', '00110110', '00110111', '01100100', '01100101',
  '01101000', '01100111', '011001100', '011001101', '011010010', '011010011', '011010100',
  '011010101', '011010110', '011010111', '011011000', '011011001', '011011010', '011011011',
  '010011000', '010011001', '010011010', '011000', '010011011',
];

// prettier-ignore
const BLACK_TERMINATING = [
  '0000110111', '010', '11', '10', '011', '0011', '0010', '00011',
  '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111', '000011000',
  '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100',
  '00000110111', '00000101000', '00000010111', '00000011000', '000011001010', '000011001011',
  '000011001100', '000011001101', '000001101000', '000001101001', '000001101010', '000001101011',
  '000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111',
  '000001101100', '000001101101', '000011011010', '000011011011', '000001010100', '000001010101',
  '000001010110', '000001010111', '000001100100', '000001100101', '000001010010', '000001010011',
  '000000100100', '000000110111', '000000111000', '000000100111', '000000101000', '000001011000',
  '000001011001', '000000101011', '000000101100', '000001011010', '000001100110', '000001100111',
];

// prettier-ignore
const BLACK_MAKEUP = [
  '0000001111', '000011001000', '000011001001', '000001011011', '000000110011', '000000110100',
  '000000110101', '0000001101100', '0000001101101', '0000001001010', '0000001001011',
  '0000001001100', '0000001001101', '0000001110010', '0000001110011', '0000001110100',
  '0000001110101', '0000001110110', '0000001110111', '0000001010010', '0000001010011',
  '0000001010100', '0000001010101', '0000001011010', '0000001011011', '0000001100100',
  '0000001100101',
];

/** Makeup codes above 1728, shared by both colours (T.4 table 3). */
// prettier-ignore
const EXTENDED_MAKEUP = [
  '00000001000', '00000001100', '00000001101', '000000010010', '000000010011', '000000010100',
  '000000010101', '000000010110', '000000010111', '000000011100', '000000011101', '000000011110',
  '000000011111',
];

const PASS = '0001';
const HORIZONTAL = '001';
/** Vertical codes for a1 − b1 of −3, −2, −1, 0, +1, +2, +3. */
const VERTICAL = ['0000010', '000010', '010', '1', '011', '000011', '0000011'];
/** Two consecutive EOLs: what `/EndOfBlock true` — the default — looks for. */
const EOFB = '000000000001000000000001';

/** Accumulates a bit string into bytes, most significant bit first, zero-padded at the end. */
class BitWriter {
  private readonly bytes: number[] = [];
  private current = 0;
  private filled = 0;

  write(bits: string): void {
    for (let i = 0; i < bits.length; i++) {
      this.current = (this.current << 1) | (bits.charCodeAt(i) === 49 ? 1 : 0);
      if (++this.filled === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.filled = 0;
      }
    }
  }

  finish(): Uint8Array {
    if (this.filled > 0) {
      this.bytes.push((this.current << (8 - this.filled)) & 0xff);
      this.current = 0;
      this.filled = 0;
    }
    return Uint8Array.from(this.bytes);
  }
}

/** A run length as makeup codes plus one terminating code. */
function runLength(length: number, white: boolean): string {
  const terminating = white ? WHITE_TERMINATING : BLACK_TERMINATING;
  const makeup = white ? WHITE_MAKEUP : BLACK_MAKEUP;
  let remaining = length;
  let out = '';
  // Above 2560 the spec repeats the largest makeup code as often as needed.
  while (remaining >= 2624) {
    out += EXTENDED_MAKEUP[EXTENDED_MAKEUP.length - 1] ?? '';
    remaining -= 2560;
  }
  if (remaining >= 1792) {
    const index = Math.floor((remaining - 1792) / 64);
    out += EXTENDED_MAKEUP[index] ?? '';
    remaining -= 1792 + index * 64;
  } else if (remaining >= 64) {
    const index = Math.floor(remaining / 64) - 1;
    out += makeup[index] ?? '';
    remaining -= (index + 1) * 64;
  }
  return out + (terminating[remaining] ?? '');
}

/**
 * Encodes a one-bit image as Group 4.
 *
 * `samples` must be single-component; anything at or above mid-grey is white, which is the same
 * threshold {@link packMono} uses, so a mono image takes the same decision whichever way out it
 * goes. The returned bytes go straight into a stream with `/Filter /CCITTFaxDecode` and
 * `/DecodeParms << /K -1 /Columns w /Rows h /BlackIs1 false >>`.
 */
export function encodeGroup4(samples: Samples): Uint8Array {
  const { width, height } = samples;
  const writer = new BitWriter();
  // The changing elements of each row, as positions where the colour differs from the pixel to
  // its left. Row −1 is imaginary and all white, so it has none.
  let reference: number[] = [];

  for (let y = 0; y < height; y++) {
    const row = changingElements(samples, y, width);
    let a0 = -1;
    // The colour at a0. The row notionally starts white, whatever the first pixel is.
    let white = true;

    while (a0 < width) {
      const a1 = nextChange(row, a0, width);
      const b1 = firstB1(reference, a0, white, width);
      const b2 = b1 >= width ? width : nextAfter(reference, b1, width);

      if (b2 < a1) {
        writer.write(PASS);
        a0 = b2;
        continue;
      }
      const delta = a1 - b1;
      if (delta >= -3 && delta <= 3) {
        writer.write(VERTICAL[delta + 3] ?? VERTICAL[3] ?? '1');
        a0 = a1;
        white = !white;
        continue;
      }
      const a2 = nextChange(row, a1, width);
      writer.write(HORIZONTAL);
      writer.write(runLength(a1 - Math.max(a0, 0), white));
      writer.write(runLength(a2 - a1, !white));
      a0 = a2;
    }
    reference = row;
  }

  writer.write(EOFB);
  return writer.finish();
}

/** Positions where row `y` changes colour, left to right. Position 0 counts when it is black. */
function changingElements(samples: Samples, y: number, width: number): number[] {
  const out: number[] = [];
  const base = y * width;
  let previous = 1; // the imaginary white pixel left of the row
  for (let x = 0; x < width; x++) {
    const value = (samples.data[base + x] ?? 0) >= 128 ? 1 : 0;
    if (value !== previous) out.push(x);
    previous = value;
  }
  return out;
}

/** The first changing element strictly right of `a0`. */
function nextChange(row: ReadonlyArray<number>, a0: number, width: number): number {
  for (const x of row) if (x > a0) return x;
  return width;
}

function nextAfter(row: ReadonlyArray<number>, b1: number, width: number): number {
  for (const x of row) if (x > b1) return x;
  return width;
}

/**
 * `b1`: the first changing element on the reference line strictly right of `a0` **and of the
 * opposite colour to `a0`**.
 *
 * A changing element at an even index in the list starts a black run (the row starts white), so
 * "opposite colour to a0" is a parity test: when a0 is white, b1 must start a black run.
 */
function firstB1(
  reference: ReadonlyArray<number>,
  a0: number,
  white: boolean,
  width: number,
): number {
  for (let i = 0; i < reference.length; i++) {
    const x = reference[i] ?? width;
    if (x <= a0) continue;
    const startsBlack = i % 2 === 0;
    if (startsBlack === white) return x;
  }
  return width;
}
