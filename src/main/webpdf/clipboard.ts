/**
 * The OS clipboard, read once for `clipboard:read` (M91, ADR 0011): text, HTML and the image
 * as PNG bytes in one round trip, so the renderer can decide what to make of it.
 *
 * Electron 44's clipboard is the W3C-shaped async API: `clipboard.read()` yields
 * `ClipboardItem`s, each with the MIME types the platform offers and a `Blob` per type.
 */

import { clipboard, nativeImage } from 'electron';
import type { ClipboardContents } from '../../shared/create';

async function blobOf(item: Electron.ClipboardItem, type: string): Promise<Blob | null> {
  try {
    const payload = await item.getType(type);
    return payload instanceof Blob ? payload : null;
  } catch {
    return null;
  }
}

async function textOf(item: Electron.ClipboardItem, type: string): Promise<string | null> {
  const blob = await blobOf(item, type);
  return blob ? blob.text() : null;
}

/** PNG bytes for an `image/*` entry: PNG as-is, anything else re-encoded through `nativeImage`. */
async function pngOf(item: Electron.ClipboardItem, type: string): Promise<Uint8Array | null> {
  const blob = await blobOf(item, type);
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (type === 'image/png') return bytes;
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  // A copy, not a view: the bytes cross IPC and must not drag a shared Buffer pool with them.
  return image.isEmpty() ? null : new Uint8Array(image.toPNG());
}

export async function readClipboard(): Promise<ClipboardContents> {
  const items = await clipboard.read();
  const formats: string[] = [];
  let text = '';
  let html = '';
  let image: Uint8Array | null = null;
  for (const item of items) {
    for (const type of item.types) if (!formats.includes(type)) formats.push(type);
    if (!text && item.types.includes('text/plain')) {
      text = (await textOf(item, 'text/plain')) ?? '';
    }
    if (!html && item.types.includes('text/html')) {
      html = (await textOf(item, 'text/html')) ?? '';
    }
    if (!image) {
      const imageType =
        item.types.find((t) => t === 'image/png') ?? item.types.find((t) => t.startsWith('image/'));
      if (imageType !== undefined) image = await pngOf(item, imageType);
    }
  }
  return { text, html, image, formats };
}
