import { PageGeometry } from '@engine/geometry';
import { rectFromMargins } from '@engine/ops/crop';
import { OpFailed } from '@engine/ops/types';
import type { Rotation } from '@shared/pdf';
import type { CropChoice } from './cropDialog';
import type { MergeService } from './MergeService';
import type { Document } from '@core/Document';
import { fitCropRatio, pageCropRatio, usableCrop } from './cropRatio';

/** Plan the complete range before changing any page, then keep it as one undo entry. */
export async function applyCropChoice(
  service: Pick<MergeService, 'require' | 'crop'> & {
    readonly organise: Pick<MergeService['organise'], 'targetOf'>;
  },
  choice: CropChoice,
  extra: Rotation,
  expected: { readonly document: Document; readonly revision: number },
): Promise<number> {
  const doc = expected.document;
  const requireSameDocument = (): void => {
    if (service.require() !== doc)
      throw new OpFailed('The active document changed. Review the crop again.');
  };
  requireSameDocument();
  if (doc.state.revision !== expected.revision)
    throw new OpFailed(
      'The document changed while the crop was being reviewed. Review the crop again.',
    );
  const plans = choice.pages.map((index) => {
    const page = doc.state.pages[index];
    if (!page) throw new OpFailed('A selected page is no longer available.');
    const geometry = PageGeometry.fromBoxes(page.mediaBox, page.cropBox, page.rotation, extra);
    const rect = fitCropRatio(
      rectFromMargins(geometry.box, choice.margins),
      geometry.box,
      pageCropRatio(choice.ratio, geometry.rotation),
    );
    if (!usableCrop(rect))
      throw new OpFailed(
        `Those margins and ratio leave less than one point on page ${String(index + 1)}.`,
      );
    return { index, id: page.id, rect };
  });
  let cropped = 0;
  await doc.batch(
    plans.length === 1 ? 'Crop page' : `Crop ${String(plans.length)} pages`,
    async () => {
      for (const plan of plans) {
        requireSameDocument();
        if (doc.state.pages[plan.index]?.id !== plan.id)
          throw new OpFailed('The page order changed. Review the crop again.');
        cropped += await service.crop({
          target: service.organise.targetOf([plan.index], doc),
          box: choice.box,
          rect: plan.rect,
          changePageSize: choice.changePageSize,
        });
      }
    },
  );
  return cropped;
}
