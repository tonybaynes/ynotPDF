/**
 * Assets the engine Worker needs at boot (M10): the PDFium wasm and the bundled fonts.
 *
 * Both are inlined into the renderer build as base64 (`?inline`) because `fetch()` of a
 * `file://` URL fails in the packaged app (`loadFile`). The wasm lands in this chunk; each font
 * is its own lazily imported chunk via `import.meta.glob`, so a build without fetched fonts
 * still works (PDFium then uses its built-in fonts). Node tests bypass this file and read the
 * same bytes from disk.
 */

import wasmDataUrl from '@hyzyla/pdfium/pdfium.wasm?inline';
import substitutions from '../../resources/fonts/substitutions.json';
import type { PdfiumEngineOptions } from './pdfium/PdfiumEngine';
import type { SubstitutionTable } from './pdfium/fonts';

const fontModules = import.meta.glob('../../resources/fonts/*.ttf', {
  query: '?inline',
  import: 'default',
}) as Record<string, () => Promise<string>>;

/** Decodes a `data:` URL (or bare base64) into bytes. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function loadEngineAssets(): Promise<PdfiumEngineOptions> {
  const wasm = dataUrlToBytes(wasmDataUrl);
  const fonts = new Map<string, Uint8Array>();
  await Promise.all(
    Object.entries(fontModules).map(async ([path, load]) => {
      const name = path.split('/').pop() ?? path;
      try {
        fonts.set(name, dataUrlToBytes(await load()));
      } catch (error) {
        console.warn(`engine: font ${name} could not be loaded`, error);
      }
    }),
  );
  return { wasm, fonts, substitutions: substitutions as unknown as SubstitutionTable };
}
