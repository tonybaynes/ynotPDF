/**
 * Checks the app icon (`resources/build/icon.png`) — the operator's real logo, cropped from
 * `resources/brand/ynotPDF-logo-source.jpg` (2026-09-08). electron-builder derives `.ico`
 * and `.icns` from this PNG; WiX refuses an MSI without one.
 *
 * This script no longer generates anything: the placeholder generator it replaced would
 * overwrite the real logo. It verifies the PNG is square, at least 512 px and RGBA, so a
 * damaged or accidentally replaced icon fails `npm run icon` (and CI, which calls it) with a
 * worded message. To change the icon, replace the PNG (1024×1024 recommended) and re-run.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const file = join(process.cwd(), 'resources', 'build', 'icon.png');
const png = readFileSync(file);

const isPng = png
  .subarray(0, 8)
  .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
if (!isPng || png.subarray(12, 16).toString('ascii') !== 'IHDR') {
  throw new Error(`make-icon: ${file} is not a PNG`);
}
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
const colourType = png[25];
const problems: string[] = [];
if (width !== height) problems.push(`not square (${width}×${height})`);
if (width < 512) problems.push(`too small (${width} px; need at least 512)`);
if (colourType !== 6)
  problems.push(`colour type ${colourType} (need 6 = RGBA, for transparent corners)`);
if (problems.length > 0) {
  throw new Error(`make-icon: ${file} ${problems.join('; ')}`);
}
console.info(`make-icon: ${file} ok — ${width}×${height} RGBA (${png.length} bytes)`);
