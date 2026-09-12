import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const tag = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, crc]);
}

/** Minimal PNG fixture encoder using Node, independent of the product's image codecs. */
function png(
  pixels: Uint8Array,
  width: number,
  height: number,
  dpi: { x: number; y: number },
): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const resolution = Buffer.alloc(9);
  resolution.writeUInt32BE(Math.round(dpi.x / 0.0254));
  resolution.writeUInt32BE(Math.round(dpi.y / 0.0254), 4);
  resolution[8] = 1;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    rows.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('pHYs', resolution),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** Deterministic scanner pixels, rotated clockwise independently of the deskew implementation. */
export function scanImage(angle: number | null, dpi = { x: 150, y: 150 }): Uint8Array {
  const width = 700,
    height = 900;
  const pixels = new Uint8Array(width * height * 4);
  const radians = ((angle ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians),
    sin = Math.sin(radians);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = cos * (x - width / 2) + sin * (y - height / 2) + width / 2;
      const sy = -sin * (x - width / 2) + cos * (y - height / 2) + height / 2;
      const line = Math.floor((sy - 65) / 22);
      const ink =
        angle !== null &&
        sx >= 65 &&
        sx < width - 65 &&
        sy >= 65 &&
        sy < height - 65 &&
        sy - 65 - line * 22 < 6 &&
        Math.floor((sx + line * 37) / 23) % 5 !== 0;
      const at = (y * width + x) * 4;
      pixels[at] = pixels[at + 1] = pixels[at + 2] = ink ? 25 : 255;
      pixels[at + 3] = 255;
    }
  }
  return png(pixels, width, height, dpi);
}
