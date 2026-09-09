/**
 * The custom-stamp dialog (M31): a picture file, the clipboard or a page of a PDF, cropped by
 * dragging on the preview, with white made transparent on request — and out comes a PNG the
 * palette keeps (see `stampImport.ts` for why everything becomes PNG).
 *
 * Fully opaque, like every dialog here; the preview sits on paper-white so a stamp is judged the
 * way it will look on a page.
 */

import { button, el } from '@app/dom';
import { field } from '@app/dialog/Dialogs';
import { hasBridge, invoke } from '@shared/ipc';
import type { DrawingService } from './DrawingService';
import {
  clampCrop,
  decodePicture,
  encodeStampPng,
  renderPdfPage,
  type CropBox,
  type SourcePicture,
} from './stampImport';

/** Opens the dialog; resolves with the new stamp's id, or null when cancelled. */
export async function openStampDialog(service: DrawingService): Promise<string | null> {
  const dialogs = service.shellServices.dialogs;
  let source: SourcePicture | null = null;
  let sourceBytes: Uint8Array | null = null;
  let sourceIsPdf = false;
  let crop: CropBox | null = null;

  const preview = el('div.stamp-dialog-preview', { 'aria-label': 'Preview; drag to crop' });
  const canvas = el('canvas');
  const cropBox = el('div.stamp-dialog-crop');
  cropBox.hidden = true;
  preview.append(canvas, cropBox);
  const name = el('input', { type: 'text', value: '', placeholder: 'What the stamp is called' });
  const white = el('input', { type: 'checkbox' });
  const page = el('input', { type: 'number', min: '1', value: '1', step: '1' });
  page.disabled = true;
  const note = el('p.stamp-dialog-note', null, 'Choose where the picture comes from.');

  const paint = (): void => {
    const context = canvas.getContext('2d');
    if (!source || !context) return;
    const scale = Math.min(1, 480 / source.width, 240 / source.height);
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source.bitmap, 0, 0, canvas.width, canvas.height);
    if (crop) {
      const box = canvas.getBoundingClientRect();
      const host = preview.getBoundingClientRect();
      const sx = box.width / source.width;
      const sy = box.height / source.height;
      cropBox.hidden = false;
      cropBox.style.left = `${box.left - host.left + crop.x * sx}px`;
      cropBox.style.top = `${box.top - host.top + crop.y * sy}px`;
      cropBox.style.width = `${crop.width * sx}px`;
      cropBox.style.height = `${crop.height * sy}px`;
    } else {
      cropBox.hidden = true;
    }
  };

  const setSource = (picture: SourcePicture | null, what: string): void => {
    source = picture;
    crop = null;
    note.textContent = picture
      ? `${what}: ${picture.width} × ${picture.height} pixels. Drag on the preview to crop.`
      : `${what} could not be read as a picture.`;
    paint();
  };

  // Crop by dragging on the canvas, in picture pixels.
  let dragging: { x: number; y: number } | null = null;
  const toPicture = (e: PointerEvent): { x: number; y: number } => {
    const box = canvas.getBoundingClientRect();
    const w = source?.width ?? 1;
    const h = source?.height ?? 1;
    return {
      x: Math.max(0, Math.min(w, ((e.clientX - box.left) / Math.max(box.width, 1)) * w)),
      y: Math.max(0, Math.min(h, ((e.clientY - box.top) / Math.max(box.height, 1)) * h)),
    };
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!source) return;
    dragging = toPicture(e);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || !source) return;
    const now = toPicture(e);
    crop = clampCrop(
      {
        x: Math.min(dragging.x, now.x),
        y: Math.min(dragging.y, now.y),
        width: Math.abs(now.x - dragging.x),
        height: Math.abs(now.y - dragging.y),
      },
      source.width,
      source.height,
    );
    paint();
  });
  canvas.addEventListener('pointerup', (e) => {
    canvas.releasePointerCapture(e.pointerId);
    dragging = null;
    if (crop && (crop.width < 4 || crop.height < 4)) crop = null;
    paint();
  });

  const fromFile = button('btn', { type: 'button' }, 'From a picture or PDF file…');
  const fromClipboard = button('btn', { type: 'button' }, 'From the clipboard');
  const clearCrop = button('btn', { type: 'button' }, 'Clear the crop');
  fromFile.addEventListener('click', () => {
    void (async () => {
      if (!hasBridge()) return;
      const files = await invoke('file:openFilesDialog', {
        title: 'Choose a picture or a PDF',
        buttonLabel: 'Use',
        multi: false,
        filters: [
          {
            name: 'Pictures and PDFs',
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'pdf'],
          },
        ],
      });
      const first = files[0];
      if (!first) return;
      sourceBytes = first.bytes;
      sourceIsPdf = first.name.toLowerCase().endsWith('.pdf');
      if (name.value === '') name.value = first.name.replace(/\.[^.]+$/, '');
      if (sourceIsPdf) {
        page.disabled = false;
        await loadPage();
      } else {
        page.disabled = true;
        setSource(await decodePicture(first.bytes), first.name);
      }
    })();
  });
  fromClipboard.addEventListener('click', () => {
    void (async () => {
      if (!hasBridge()) return;
      const contents = await invoke('clipboard:read');
      if (!contents.image) {
        note.textContent = 'The clipboard holds no picture.';
        return;
      }
      sourceBytes = null;
      sourceIsPdf = false;
      page.disabled = true;
      if (name.value === '') name.value = 'Clipboard stamp';
      setSource(await decodePicture(contents.image, 'image/png'), 'The clipboard picture');
    })();
  });
  clearCrop.addEventListener('click', () => {
    crop = null;
    paint();
  });
  const loadPage = async (): Promise<void> => {
    const client = service.engineClient;
    if (!sourceBytes || !client) return;
    const index = Math.max(0, Number.parseInt(page.value, 10) - 1 || 0);
    const rendered = await renderPdfPage(client, sourceBytes, index).catch(() => null);
    if (!rendered) {
      setSource(null, 'The PDF');
      return;
    }
    page.max = String(rendered.pageCount);
    setSource(rendered.picture, `Page ${index + 1} of ${rendered.pageCount}`);
  };
  page.addEventListener('change', () => {
    if (sourceIsPdf) void loadPage();
  });

  const handle = dialogs.open({
    id: 'stamp-dialog',
    title: 'Custom stamp',
    width: 560,
    content: (body) => {
      body.append(
        el('div.stamp-dialog-row', null, fromFile, fromClipboard, clearCrop),
        note,
        preview,
        el(
          'div.stamp-dialog-row',
          null,
          field({ label: 'Name', input: name }),
          field({ label: 'PDF page', input: page }),
        ),
        (() => {
          const check = el('div.annot-check');
          check.append(
            field({
              label: 'Treat white as transparent (for a scan or a logo on white paper)',
              input: white,
            }),
          );
          return check;
        })(),
      );
    },
    buttons: [
      {
        id: 'ok',
        label: 'Add stamp',
        primary: true,
        onPress: () => {
          if (!source) {
            note.textContent = 'Choose a picture first.';
            return false;
          }
          return true;
        },
      },
      { id: 'cancel', label: 'Cancel' },
    ],
    initialFocus: fromFile,
  });
  const result = await handle.result;
  if (result !== 'ok' || !source) return null;
  const encoded = await encodeStampPng(source, {
    ...(crop ? { crop } : {}),
    whiteToAlpha: white.checked,
  });
  const stamp = await service.addCustomStamp({
    label: name.value,
    png: encoded.png,
    width: encoded.width,
    height: encoded.height,
  });
  await service.setDefaults('stamp', { stampId: stamp.id });
  return stamp.id;
}
