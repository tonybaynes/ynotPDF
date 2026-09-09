/**
 * Renders every stamp in `resources/stamps/catalogue.json` to a vector PDF beside it (M31).
 *
 * The drawing and the PDF come from `src/engine/appearance/stampPdf.ts`, which the unit suite
 * runs for every catalogue entry; this script only writes the files. They are generated, not
 * committed: the repository refuses PDFs outside `test/fixtures/`.
 *
 * Usage: `npm run stamps` (writes into resources/stamps/).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStampCatalogue } from '../src/engine/appearance/stamp.ts';
import { renderStampPdf } from '../src/engine/appearance/stampPdf.ts';

const DIR = join(process.cwd(), 'resources', 'stamps');
mkdirSync(DIR, { recursive: true });

const catalogue = parseStampCatalogue(
  JSON.parse(readFileSync(join(DIR, 'catalogue.json'), 'utf8')) as unknown,
);

for (const definition of catalogue.stamps) {
  const bytes = await renderStampPdf(definition);
  writeFileSync(join(DIR, `${definition.id}.pdf`), bytes);
  console.info(`stamps: ${definition.id}.pdf (${bytes.byteLength} bytes)`);
}
console.info('stamps: done');
