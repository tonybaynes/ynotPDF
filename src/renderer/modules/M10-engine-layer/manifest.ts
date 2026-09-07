/**
 * M10 — PDF engine layer. The engine itself lives in `src/engine/`; this module contributes the
 * developer-facing probe command that proves the PDFium worker inside the running app (used by
 * the e2e suite) and reports what the engine sees in a file.
 */

import type { ShellState } from '@app/shell';
import type { Store } from '@core/Store';
import type { EngineClient } from '@engine/EngineClient';
import { dhash } from '@engine/imageHash';
import type { OpenOptions } from '@engine/PdfEngine';
import { hasBridge, invoke } from '@shared/ipc';
import { defineModule } from '@shared/module';

/** What `dev.engineOpen` reports. Structured-cloneable so the e2e harness can read it. */
export interface EngineProbe {
  readonly name: string;
  readonly pages: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly text: string;
  readonly annotations: number;
  readonly fields: number;
  readonly layers: number;
  readonly attachments: number;
  readonly outline: number;
  readonly links: number;
  readonly encrypted: boolean;
  readonly hasXfa: boolean;
  readonly renderMs: number;
  readonly bitmapWidth: number;
  readonly bitmapHeight: number;
  /** 64-bit difference hash of the page-0 render at 72 dpi. */
  readonly hash: string;
  readonly fonts: number;
}

/** Reads the pixels of an `ImageBitmap` (renderer has OffscreenCanvas; Node tests pass data). */
function pixelsOf(bitmap: ImageBitmap): Uint8ClampedArray {
  const raw = bitmap as unknown as { data?: Uint8ClampedArray };
  if (raw.data) return raw.data;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

export async function probeDocument(
  client: EngineClient,
  bytes: Uint8Array,
  name: string,
  options: OpenOptions = {},
): Promise<EngineProbe> {
  await client.ready();
  const e = client.engine;
  const doc = await e.open(bytes, { ...options, name });
  try {
    const [pages, size, runs, annots, fields, layers, attachments, outline, links, meta] =
      await Promise.all([
        e.pageCount(doc),
        e.pageSize(doc, 0),
        e.textRuns(doc, 0),
        e.annotations(doc, 0),
        e.formFields(doc),
        e.layers(doc),
        e.attachments(doc),
        e.outline(doc),
        e.links(doc, 0),
        e.metadata(doc),
      ]);
    const t0 = performance.now();
    const { bitmap } = await e.render(doc, 0, 1);
    const renderMs = performance.now() - t0;
    const pixels = pixelsOf(bitmap);
    const hash = dhash(pixels, bitmap.width, bitmap.height);
    const info = await e.info();
    const result: EngineProbe = {
      name: info.name,
      pages,
      width: size.width,
      height: size.height,
      rotation: size.rotation,
      text: runs
        .map((r) => r.text)
        .join(' ')
        .slice(0, 120),
      annotations: annots.length,
      fields: fields.length,
      layers: layers.length,
      attachments: attachments.length,
      outline: outline.length,
      links: links.length,
      encrypted: meta.encrypted,
      hasXfa: meta.hasXfa,
      renderMs,
      bitmapWidth: bitmap.width,
      bitmapHeight: bitmap.height,
      hash,
      fonts: 0,
    };
    bitmap.close();
    return result;
  } finally {
    await e.close(doc);
  }
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return null;
}

export default defineModule({
  id: 'M10',
  name: 'PDF engine layer',
  commands: [
    {
      id: 'dev.engineOpen',
      label: 'Engine: probe a PDF',
      category: 'Developer',
      icon: 'scan-search',
      description:
        'Opens a PDF in the engine worker and reports pages, text, annotations, fields, layers and a render hash',
      run: async (ctx) => {
        const client = ctx.service<EngineClient>('engineClient');
        let bytes = toBytes(ctx.args['bytes']);
        let name = typeof ctx.args['name'] === 'string' ? ctx.args['name'] : 'document.pdf';
        if (!bytes) {
          if (!hasBridge()) return null;
          const file = await invoke('file:openDialog');
          if (!file) return null;
          bytes = file.bytes;
          name = file.name;
        }
        const password =
          typeof ctx.args['password'] === 'string' ? ctx.args['password'] : undefined;
        const probe = await probeDocument(
          client,
          bytes,
          name,
          password === undefined ? {} : { password },
        );
        const shell = ctx.service<Store<ShellState>>('shell');
        shell.set({
          statusMessage: `${name}: ${probe.pages} page(s), ${probe.annotations} annotation(s), rendered in ${probe.renderMs.toFixed(0)} ms`,
        });
        return probe;
      },
    },
  ],
});
