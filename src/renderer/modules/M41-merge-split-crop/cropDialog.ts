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
import { marginsFromRect, rectFromMargins, type Margins } from '@engine/ops/crop';
import type { PageBoxes, PageBoxName, PdfRect } from '@shared/pdf';
import { formatLength, type Unit } from '@view/units';
import type { RangeContext } from '@modules/M40-organise-pages/range';
import { CROP_BOXES } from './settings';
import { checkbox, lengthField, rangeField, select } from './fields';

export interface CropChoice {
  readonly margins: Margins;
  /** The rectangle those margins leave of the current page — what the preview showed. */
  readonly rect: PdfRect;
  readonly box: PageBoxName;
  readonly changePageSize: boolean;
  readonly pages: ReadonlyArray<number>;
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
  /** Renders the current page for the preview; `null` when it cannot be drawn. */
  readonly preview: () => Promise<{ readonly url: string; readonly rect: PdfRect } | null>;
  /** Measures where the content is. `null` when the page is blank. */
  readonly detectMargins: () => Promise<PdfRect | null>;
}

export async function askCrop(options: CropDialogOptions): Promise<CropChoice | null> {
  const outer = options.boxes.crop ?? options.boxes.media ?? { x0: 0, y0: 0, x1: 612, y1: 792 };
  let box = options.box;
  let rect = options.initial ?? outer;
  let handle: DialogHandle | null = null;

  const boxSelect = select<PageBoxName>({
    label: 'Set which box',
    hint: `Measured from the ${nameOf(options.box)} of page ${options.pageLabel}.`,
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
        const next = marginsFromRect(outer, rect);
        left.set(next.left);
        right.set(next.right);
        top.set(next.top);
        bottom.set(next.bottom);
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

  function paint(): void {
    const width = rect.x1 - rect.x0;
    const height = rect.y1 - rect.y0;
    const pages = range.pages();
    summary.textContent =
      width < 1 || height < 1
        ? 'Those margins would leave nothing of the page.'
        : `${formatLength(width, options.unit)} × ${formatLength(height, options.unit)}` +
          (pages === null
            ? ''
            : `, on ${String(pages.length)} ${pages.length === 1 ? 'page' : 'pages'}`);
    if (previewRect) {
      const pw = previewRect.x1 - previewRect.x0;
      const ph = previewRect.y1 - previewRect.y0;
      previewBox.style.left = `${String(((rect.x0 - previewRect.x0) / pw) * 100)}%`;
      previewBox.style.width = `${String((width / pw) * 100)}%`;
      // CSS counts from the top; PDF space counts from the bottom.
      previewBox.style.top = `${String(((previewRect.y1 - rect.y1) / ph) * 100)}%`;
      previewBox.style.height = `${String((height / ph) * 100)}%`;
    }
    handle?.setEnabled('ok', width >= 1 && height >= 1 && (pages?.length ?? 0) > 0);
  }

  // The two buttons sit straight under the numbers they fill in, because "remove white margins"
  // is what most readers came here to press and it must not be below the fold.
  const buttons = el('div.ops-toolbar');
  buttons.append(detect, whole);

  const marginGrid = el('div.ops-margins');
  marginGrid.append(top.element, bottom.element, left.element, right.element);

  const controls = el('div.ops-crop-controls');
  controls.append(marginGrid, buttons, boxSelect.element, changePageSize.element, range.element);

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
  paint();

  const result = await handle.result;
  if (result !== 'ok') return null;
  const pages = range.pages();
  if (!pages || pages.length === 0) return null;
  return {
    margins: currentMargins(),
    rect,
    box,
    changePageSize: changePageSize.input.checked,
    pages,
  };
}

/** The plain name of a box, for a sentence rather than a menu. */
function nameOf(box: PageBoxName): string {
  switch (box) {
    case 'media':
      return 'media box';
    case 'crop':
      return 'crop box';
    case 'bleed':
      return 'bleed box';
    case 'trim':
      return 'trim box';
    case 'art':
      return 'art box';
  }
}
