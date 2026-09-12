/**
 * The Crop Pages dialog (M41).
 *
 * Margins in the reader's own unit, a box to write them to, a page range, and two buttons that
 * do the thinking: **Remove white margins**, which measures where the content actually is, and
 * **Whole page**, which puts them back to nothing.
 *
 * The preview beside the fields is the reason the dialog is worth having at all: four numbers do
 * not tell anyone what a page will look like, and a rectangle over a picture of the page does.
 * It is drawn from the same render the detector uses, so what the reader sees is what is
 * measured.
 *
 * The dialog changes nothing. It answers with a rectangle and a range, and `MergeService` turns
 * that into one undoable command per page.
 */

import { type DialogHandle, type Dialogs } from '@app/dialog/Dialogs';
import { el } from '@app/dom';
import { PageGeometry } from '@engine/geometry';
import { marginsFromRect, rectFromMargins, type Margins } from '@engine/ops/crop';
import type { PageBoxes, PageBoxName, PdfRect, Rotation } from '@shared/pdf';
import { formatLength, type Unit } from '@view/units';
import type { RangeContext } from '@modules/M40-organise-pages/range';
import { CROP_BOXES } from './settings';
import { checkbox, lengthField, rangeField, select } from './fields';
import { cropRatioField } from './cropRatioField';
import {
  FREE_CROP_RATIO,
  fitCropRatio,
  pageCropRatio,
  usableCrop,
  type CropRatioChoice,
} from './cropRatio';

export interface CropChoice {
  readonly margins: Margins;
  /** The rectangle those margins leave of the current page — what the preview showed. */
  readonly rect: PdfRect;
  readonly box: PageBoxName;
  readonly changePageSize: boolean;
  readonly pages: ReadonlyArray<number>;
  readonly ratio: number | null;
  readonly ratioChoice: CropRatioChoice;
}

export interface CropDialogOptions {
  readonly dialogs: Dialogs;
  readonly unit: Unit;
  readonly page: number;
  readonly pageLabel: string;
  /** The current page's boxes, so the dialog can say which ones the file actually carries. */
  readonly boxes: PageBoxes;
  readonly box: PageBoxName;
  readonly changePageSize: boolean;
  readonly rangeContext: RangeContext;
  /** The rectangle to start from — a drag on the page, or the whole box. */
  readonly initial?: PdfRect;
  readonly ratioChoice?: CropRatioChoice;
  readonly rotation?: Rotation;
  /** Renders the current page for the preview; `null` when it cannot be drawn. */
  readonly preview: () => Promise<{ readonly url: string; readonly rect: PdfRect } | null>;
  /** Measures where the content is. `null` when the page is blank. */
  readonly detectMargins: () => Promise<PdfRect | null>;
}

export async function askCrop(options: CropDialogOptions): Promise<CropChoice | null> {
  const media = options.boxes.media ?? { x0: 0, y0: 0, x1: 612, y1: 792 };
  const outer = PageGeometry.fromBoxes(media, options.boxes.crop ?? media, 0).box;
  let box = options.box;
  let rect = options.initial ?? outer;
  let handle: DialogHandle | null = null;
  const rotation = options.rotation ?? 0;
  const geometry = PageGeometry.fromBoxes(outer, outer, rotation);
  const ratio = cropRatioField(options.ratioChoice ?? FREE_CROP_RATIO, () => {
    if (validMargins()) constrain();
    paint();
  });

  const boxSelect = select<PageBoxName>({
    label: 'Set which box',
    hint: `Margins use the unrotated crop box of page ${options.pageLabel}. Ratios use its displayed width : height.`,
    value: box,
    choices: CROP_BOXES.map((choice) => ({
      value: choice.value,
      // Saying which boxes the file carries is the whole reason `pageBoxes` exists (ADR 0017).
      label: `${choice.label}${options.boxes[choice.value] === null ? ' (not set on this page)' : ''}`,
    })),
    onChange: (value) => {
      box = value;
      paint();
    },
  });

  const margins = marginsFromRect(outer, rect);
  const left = lengthField({ label: 'Left', points: margins.left, unit: options.unit, min: 0 });
  const right = lengthField({ label: 'Right', points: margins.right, unit: options.unit, min: 0 });
  const top = lengthField({ label: 'Top', points: margins.top, unit: options.unit, min: 0 });
  const bottom = lengthField({
    label: 'Bottom',
    points: margins.bottom,
    unit: options.unit,
    min: 0,
  });
  for (const f of [left, right, top, bottom]) {
    f.onChange(() => {
      rect = rectFromMargins(outer, currentMargins());
      if (validMargins()) constrain();
      paint();
    });
  }

  const changePageSize = checkbox({
    label: 'Change the page size to match',
    checked: options.changePageSize,
    hint: 'Off keeps the paper as it is, so the crop can be taken back in any reader.',
  });

  const range = rangeField({
    label: 'Apply to',
    value: String(options.page + 1),
    context: options.rangeContext,
  });
  range.onChange(paint);

  const preview = el('div.ops-preview', {
    role: 'img',
    'aria-label': 'Preview of the cropped page',
  });
  const previewImage = el('img.ops-preview-image', { alt: '' });
  const previewBox = el('div.ops-preview-rect', { 'aria-hidden': 'true' });
  const previewSurface = el('div.ops-preview-surface');
  previewSurface.append(previewImage, previewBox);
  preview.append(previewSurface);
  let previewRect: PdfRect | null = null;

  const summary = el('p.ops-summary', { role: 'status' });

  const detect = el('button.btn', { type: 'button' }, 'Remove white margins');
  detect.addEventListener('click', () => {
    void (async () => {
      detect.disabled = true;
      try {
        const found = await options.detectMargins();
        if (!found) {
          summary.textContent = 'There is nothing on this page to crop to.';
          return;
        }
        rect = found;
        constrain();
        paint();
      } finally {
        detect.disabled = false;
      }
    })();
  });

  const whole = el('button.btn', { type: 'button' }, 'Whole page');
  whole.addEventListener('click', () => {
    rect = outer;
    left.set(0);
    right.set(0);
    top.set(0);
    bottom.set(0);
    constrain();
    paint();
  });

  function currentMargins(): Margins {
    return {
      left: left.points(),
      right: right.points(),
      top: top.points(),
      bottom: bottom.points(),
    };
  }

  function validMargins(): boolean {
    return [left, right, top, bottom].every(
      (f) =>
        f.input.value !== '' &&
        Number.isFinite(f.input.valueAsNumber) &&
        f.input.valueAsNumber >= 0,
    );
  }

  function constrain(): void {
    const value = ratio.ratio();
    if (value === undefined) return;
    rect = fitCropRatio(rect, outer, pageCropRatio(value, rotation));
    const next = marginsFromRect(outer, rect);
    left.set(next.left);
    right.set(next.right);
    top.set(next.top);
    bottom.set(next.bottom);
  }

  function paint(): void {
    const shown = geometry.rectToDevice(rect, 1);
    const width = shown.width;
    const height = shown.height;
    const pages = range.pages();
    summary.textContent = !validMargins()
      ? 'Enter finite, non-negative margins.'
      : width < 1 || height < 1
        ? 'Those margins would leave nothing of the page.'
        : `${formatLength(width, options.unit)} × ${formatLength(height, options.unit)}` +
          (pages === null
            ? ''
            : `, on ${String(pages.length)} ${pages.length === 1 ? 'page' : 'pages'}`);
    if (previewRect) {
      const previewGeometry = PageGeometry.fromBoxes(previewRect, previewRect, rotation);
      const previewCrop = previewGeometry.rectToDevice(rect, 1);
      previewBox.style.left = `${String((previewCrop.x / previewGeometry.width) * 100)}%`;
      previewBox.style.width = `${String((previewCrop.width / previewGeometry.width) * 100)}%`;
      previewBox.style.top = `${String((previewCrop.y / previewGeometry.height) * 100)}%`;
      previewBox.style.height = `${String((previewCrop.height / previewGeometry.height) * 100)}%`;
    }
    handle?.setEnabled(
      'ok',
      usableCrop(rect) && validMargins() && ratio.ratio() !== undefined && (pages?.length ?? 0) > 0,
    );
  }

  // The two buttons sit straight under the numbers they fill in, because "remove white margins"
  // is what most readers came here to press and it must not be below the fold.
  const buttons = el('div.ops-toolbar');
  buttons.append(detect, whole);

  const marginGrid = el('div.ops-margins');
  marginGrid.append(top.element, bottom.element, left.element, right.element);

  const controls = el('div.ops-crop-controls');
  controls.append(
    ratio.element,
    marginGrid,
    buttons,
    boxSelect.element,
    changePageSize.element,
    range.element,
  );

  // The summary goes under the picture rather than under the fields: it is *about* the picture,
  // and that column has the room.
  const side = el('div.ops-crop-side');
  side.append(preview, summary);

  const body = el('div.ops-dialog.ops-crop');
  body.append(controls, side);

  void (async () => {
    const drawn = await options.preview();
    if (!drawn) {
      preview.replaceChildren(el('p.ops-empty', null, 'This page cannot be drawn.'));
      return;
    }
    previewImage.src = drawn.url;
    previewRect = drawn.rect;
    paint();
  })();

  handle = options.dialogs.open({
    title: 'Crop pages',
    id: 'ops-crop',
    width: 720,
    className: 'ops-wide',
    content: body,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'ok', label: 'Crop', primary: true },
    ],
  });
  constrain();
  paint();

  const result = await handle.result;
  if (result !== 'ok') return null;
  const pages = range.pages();
  const chosenRatio = ratio.ratio();
  if (
    !pages ||
    pages.length === 0 ||
    chosenRatio === undefined ||
    !validMargins() ||
    !usableCrop(rect)
  )
    return null;
  return {
    margins: currentMargins(),
    rect,
    box,
    changePageSize: changePageSize.input.checked,
    pages,
    ratio: chosenRatio,
    ratioChoice: ratio.value(),
  };
}
