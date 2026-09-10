/**
 * The calibration dialog (M33): "the line you drew is *this* long — what should everything else
 * measure?"
 *
 * It is deliberately the *only* place a scale is entered by hand as well: the same dialog, opened
 * without a drawn line, sets the ratio directly. Two dialogs that both mean "set the ruler" is one
 * too many, and the second one is always the one that is out of date.
 */

import { el } from '@app/dom';
import { field, formGrid } from '@app/dialog/Dialogs';
import {
  FRACTION_DENOMINATORS,
  MEASURE_UNITS,
  UNIT_NAMES,
  formatMeasurement,
  measureLength,
  normaliseScale,
  scaleRatioText,
  unitLabel,
  type MeasureScale,
  type MeasureUnit,
} from '@engine/appearance';
import type { MeasureService } from './MeasureService';

/** What the dialog was opened with. */
export interface CalibrateRequest {
  /** The page the scale is for. */
  readonly page: number;
  /** The length that was drawn, in page points; absent when the scale is being typed directly. */
  readonly pagePoints?: number;
}

/** What the reader chose, or null when they cancelled. */
export interface CalibrateResult {
  readonly scale: MeasureScale;
  readonly scope: 'document' | 'page';
}

const PRECISIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '0', label: '1 (whole numbers)' },
  { value: '1', label: '0.1' },
  { value: '2', label: '0.01' },
  { value: '3', label: '0.001' },
  { value: '4', label: '0.0001' },
  ...FRACTION_DENOMINATORS.map((d) => ({
    value: `f${String(d)}`,
    label: `Fractions to 1/${String(d)}`,
  })),
];

function precisionKey(scale: MeasureScale): string {
  return scale.denominator > 0 ? `f${String(scale.denominator)}` : String(scale.precision);
}

function precisionOf(key: string): { precision: number; denominator: number } {
  if (key.startsWith('f')) return { precision: 1, denominator: Number.parseInt(key.slice(1), 10) };
  return { precision: Number.parseInt(key, 10), denominator: 0 };
}

function unitSelect(label: string, selected: MeasureUnit): HTMLSelectElement {
  const select = el('select', { 'aria-label': label });
  for (const unit of MEASURE_UNITS) {
    const option = el(
      'option',
      { value: unit },
      `${UNIT_NAMES[unit]} (${unitLabel(unit, 'length')})`,
    );
    if (unit === selected) option.setAttribute('selected', '');
    select.append(option);
  }
  return select;
}

function numberInput(value: number, label: string): HTMLInputElement {
  return el('input', {
    type: 'number',
    min: '0',
    step: 'any',
    value: String(Math.round(value * 1e6) / 1e6),
    'aria-label': label,
  });
}

/**
 * Opens the dialog and resolves with the scale the reader set, or null.
 *
 * With a drawn line it asks for that line's real length and works the ratio out; without one it
 * asks for the ratio itself. Either way the preview underneath says, in words, what the ratio
 * means — and, when there is a line, what that line then measures — so nobody has to work out
 * from a ratio whether they typed the numbers the right way round.
 */
export async function openCalibrateDialog(
  service: MeasureService,
  request: CalibrateRequest,
): Promise<CalibrateResult | null> {
  const current = normaliseScale(service.scaleFor(request.page));
  const drawn = request.pagePoints ?? null;
  let unit: MeasureUnit = current.toUnit;
  let scope: 'document' | 'page' = drawn === null ? 'document' : 'page';
  let precision = precisionKey(current);

  const real = numberInput(
    drawn === null ? current.toValue : Math.round(measureLength(drawn, current) * 100) / 100,
    drawn === null ? 'Real-world length' : 'How long the line you drew really is',
  );
  const pageValue = numberInput(current.fromValue, 'Length on the page');
  const pageUnit = unitSelect('Unit on the page', current.fromUnit);
  const realUnit = unitSelect('Real-world unit', current.toUnit);
  const precisionSelect = el('select', { 'aria-label': 'Precision' });
  for (const option of PRECISIONS) {
    const item = el('option', { value: option.value }, option.label);
    if (option.value === precision) item.setAttribute('selected', '');
    precisionSelect.append(item);
  }
  const scopeSelect = el('select', { 'aria-label': 'What the scale applies to' });
  for (const [value, label] of [
    ['page', `This page only (page ${String(request.page + 1)})`],
    ['document', 'The whole document'],
  ] as const) {
    const item = el('option', { value }, label);
    if (value === scope) item.setAttribute('selected', '');
    scopeSelect.append(item);
  }

  const summary = el('p.measure-preview');
  const build = (): MeasureScale | null => {
    unit = (realUnit.value as MeasureUnit) || current.toUnit;
    const { precision: places, denominator } = precisionOf(precision);
    if (drawn !== null) {
      const realValue = Number.parseFloat(real.value);
      if (!Number.isFinite(realValue) || realValue <= 0) return null;
      return service.calibrationFrom({
        pagePoints: drawn,
        realValue,
        unit,
        precision: places,
        denominator,
      });
    }
    const from = Number.parseFloat(pageValue.value);
    const to = Number.parseFloat(real.value);
    if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) return null;
    return normaliseScale({
      fromValue: from,
      fromUnit: (pageUnit.value as MeasureUnit) || current.fromUnit,
      toValue: to,
      toUnit: unit,
      precision: places,
      denominator,
    });
  };

  const dialog = service.shellServices.dialogs.open({
    id: 'measure-calibrate',
    title: drawn === null ? 'Measurement scale' : 'Calibrate',
    width: 480,
    content: (body) => {
      if (drawn !== null) {
        body.append(
          el(
            'p.dlg-text',
            null,
            'Type the real length of the line you just drew. Everything measured on this page is then worked out from it.',
          ),
        );
        body.append(
          formGrid(
            field({ label: 'That line really is', input: real, required: true }),
            field({ label: 'Unit', input: realUnit }),
          ),
        );
      } else {
        body.append(
          el('p.dlg-text', null, 'Set the ratio between the page and the real world directly.'),
        );
        body.append(
          formGrid(
            field({ label: 'On the page', input: pageValue, required: true }),
            field({ label: 'Page unit', input: pageUnit }),
            field({ label: 'Is really', input: real, required: true }),
            field({ label: 'Real unit', input: realUnit }),
          ),
        );
      }
      body.append(
        formGrid(
          field({ label: 'Show values to', input: precisionSelect }),
          field({ label: 'Apply to', input: scopeSelect }),
        ),
      );
      body.append(summary);
    },
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'ok', label: drawn === null ? 'Set scale' : 'Calibrate', primary: true },
    ],
  });

  const update = (): void => {
    const scale = build();
    if (!scale) {
      summary.textContent = 'Type a length greater than zero.';
      dialog.setEnabled('ok', false);
      return;
    }
    dialog.setEnabled('ok', true);
    const parts = [`Scale: ${scaleRatioText(scale)}.`];
    if (drawn !== null) {
      parts.push(
        `The line you drew measures ${formatMeasurement(measureLength(drawn, scale), scale, 'length')}.`,
      );
    }
    parts.push(
      `A 100 mm length on the page would measure ${formatMeasurement(measureLength(283.4645669291339, scale), scale, 'length')}.`,
    );
    summary.textContent = parts.join(' ');
  };

  for (const control of [real, pageValue, pageUnit, realUnit]) {
    control.addEventListener('input', update);
    control.addEventListener('change', update);
  }
  precisionSelect.addEventListener('change', () => {
    precision = precisionSelect.value;
    update();
  });
  scopeSelect.addEventListener('change', () => {
    scope = scopeSelect.value === 'document' ? 'document' : 'page';
  });
  update();

  const answer = await dialog.result;
  if (answer !== 'ok') return null;
  const scale = build();
  return scale === null ? null : { scale, scope };
}
