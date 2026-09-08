/**
 * Clipboard access (M13). Everything goes through main (`clipboard:write`), because Electron's
 * clipboard can offer text and RTF as one item and the renderer's `navigator.clipboard` cannot —
 * a word processor that receives both picks the formatting, and a plain editor still gets text.
 *
 * The `navigator.clipboard` fallback exists for the dev server, where there is no bridge; it can
 * only carry plain text, which is honest about what it is.
 */

import { hasBridge, invoke, type ClipboardPayload } from '@shared/ipc';

/** Puts every format given on the clipboard as one item. */
export async function writeClipboard(payload: ClipboardPayload): Promise<void> {
  if (hasBridge()) {
    await invoke('clipboard:write', payload);
    return;
  }
  if (payload.text !== undefined && navigator.clipboard) {
    await navigator.clipboard.writeText(payload.text);
  }
}

/** Puts a PNG on the clipboard as an image. */
export async function writeClipboardImage(png: Uint8Array): Promise<void> {
  if (hasBridge()) {
    // The buffer is transferred, so hand IPC a copy the caller can keep using.
    await invoke('clipboard:writeImage', png.slice());
    return;
  }
  if (navigator.clipboard && typeof ClipboardItem === 'function') {
    const blob = new Blob([png.slice()], { type: 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }
}
