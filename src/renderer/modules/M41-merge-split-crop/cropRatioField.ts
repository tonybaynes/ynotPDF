import { field, type Dialogs } from '@app/dialog/Dialogs';
import { el } from '@app/dom';
import { select } from './fields';
import { CROP_RATIOS, readCropRatio, RATIO_ERROR, type CropRatioChoice } from './cropRatio';

export function cropRatioField(initial: CropRatioChoice, changed: () => void) {
  const width = el('input.input', {
    type: 'number',
    min: '0.01',
    max: '1000',
    step: 'any',
    value: initial.width,
  });
  const height = el('input.input', {
    type: 'number',
    min: '0.01',
    max: '1000',
    step: 'any',
    value: initial.height,
  });
  const custom = el('div.ops-margins');
  custom.append(
    field({ label: 'Ratio width', input: width }),
    field({ label: 'Ratio height', input: height }),
  );
  const error = el('p.field-error', { role: 'alert' });
  const mode = select({
    label: 'Aspect ratio',
    value: initial.mode,
    choices: [
      { value: 'free', label: 'Free' },
      ...CROP_RATIOS,
      { value: 'custom', label: 'Custom' },
    ],
    onChange: refresh,
  });
  const value = (): CropRatioChoice => ({
    mode: mode.input.value,
    width: width.value,
    height: height.value,
  });
  function refresh(): void {
    custom.hidden = mode.input.value !== 'custom';
    const invalid = readCropRatio(value()) === undefined;
    error.hidden = !invalid;
    error.textContent = invalid ? RATIO_ERROR : '';
    for (const input of [width, height]) input.setAttribute('aria-invalid', String(invalid));
    changed();
  }
  width.addEventListener('input', refresh);
  height.addEventListener('input', refresh);
  custom.hidden = initial.mode !== 'custom';
  error.hidden = true;
  const element = el('div.ops-crop-ratio');
  element.append(mode.element, custom, error);
  return { element, value, ratio: () => readCropRatio(value()) };
}

export async function askCropRatio(
  dialogs: Dialogs,
  initial: CropRatioChoice,
): Promise<CropRatioChoice | null> {
  const control = cropRatioField(initial, () => {
    handle.setEnabled('ok', control.ratio() !== undefined);
  });
  const body = el('div.ops-dialog');
  body.append(
    control.element,
    el(
      'p.field-hint',
      null,
      'Width : height as displayed. Choose a ratio, then drag with the Crop Tool.',
    ),
  );
  const handle = dialogs.open({
    title: 'Crop aspect ratio',
    id: 'crop-ratio-dialog',
    content: body,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'ok', label: 'Use ratio', primary: true },
    ],
  });
  return (await handle.result) === 'ok' && control.ratio() !== undefined ? control.value() : null;
}
