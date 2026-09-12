import { el } from '@app/dom';
import { PageGeometry } from '@engine/geometry';
import { inkBounds } from '@engine/ops/crop';
import type { Document } from '@core/Document';
import type { Rotation } from '@shared/pdf';
import { fitCropRatio } from './cropRatio';

/** Crop alone needs the same view rotation for its picture, detector and overlay. */
export async function cropPreview(doc: Document, page: number, extra: Rotation, margin: number) {
  const model = doc.state.pages[page];
  if (!model) return null;
  const index = doc.enginePage(model.id);
  if (index === undefined) return null;
  const geometry = PageGeometry.fromBoxes(model.mediaBox, model.cropBox, model.rotation, extra);
  const result = await doc.engine.render(doc.handle, index, 100 / 72, undefined, {
    rotation: extra,
    annotations: false,
    forms: false,
  });
  const canvas = el('canvas');
  canvas.width = result.bitmap.width;
  canvas.height = result.bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) {
    result.bitmap.close();
    return null;
  }
  context.drawImage(result.bitmap, 0, 0);
  result.bitmap.close();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const ink = inkBounds(pixels);
  const found =
    ink === null
      ? null
      : geometry.rectToPage(
          {
            x: (ink.left / canvas.width) * geometry.width,
            y: (ink.top / canvas.height) * geometry.height,
            width: ((ink.right - ink.left) / canvas.width) * geometry.width,
            height: ((ink.bottom - ink.top) / canvas.height) * geometry.height,
          },
          1,
        );
  return {
    url: canvas.toDataURL('image/png'),
    rect: geometry.box,
    ink:
      found === null
        ? null
        : fitCropRatio(
            {
              x0: found.x0 - margin,
              y0: found.y0 - margin,
              x1: found.x1 + margin,
              y1: found.y1 + margin,
            },
            geometry.box,
            null,
          ),
  };
}
