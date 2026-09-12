import { PageGeometry } from '@engine/geometry';
import { rectFromMargins } from '@engine/ops/crop';
import { OpFailed } from '@engine/ops/types';
import type { Rotation } from '@shared/pdf';
import type { CropChoice } from './cropDialog';
import type { MergeService } from './MergeService';
import { fitCropRatio, pageCropRatio, usableCrop } from './cropRatio';

/** Plan the complete range before changing any page, then keep it as one undo entry. */
export async function applyCropChoice(
  service: MergeService,
  choice: CropChoice,
  extra: Rotation,
): Promise<number> {
  const doc = service.require();
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
    return { index, rect };
  });
  let cropped = 0;
  await doc.batch(
    plans.length === 1 ? 'Crop page' : `Crop ${String(plans.length)} pages`,
    async () => {
      for (const plan of plans)
        cropped += await service.crop({
          target: service.organise.targetOf([plan.index], doc),
          box: choice.box,
          rect: plan.rect,
          changePageSize: choice.changePageSize,
        });
    },
  );
  return cropped;
}
