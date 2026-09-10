/**
 * The properties sections a measurement adds to M30's panel (ADR 0015): its value and scale, the
 * line colour, width and dash, the leaders of a dimension line, and the caption — whether it is
 * drawn, where, and how big.
 *
 * The same rules as M30's and M31's panels, because it *is* their panel: every colour swatch
 * carries its name as text, every control has a real `<label>`, nothing is disabled without
 * saying why in words, and every change writes straight through so the page updates as the
 * control moves.
 */

import { button, el } from '@app/dom';
import { field } from '@app/dialog/Dialogs';
import type { ModelAnnotation } from '@core/model';
import { dashOf, measureStyleOf, scaleRatioText } from '@engine/appearance';
import {
  INK_PRESETS,
  hexOf,
  parseHexColour,
  type ColourPreset,
} from '@modules/M30-markup-annotations/presets';
import type { MeasureService } from './MeasureService';
import { measurementFor } from './overlay';
import { measurementRect } from './provider';
import type { MeasureDefaults, MeasureToolId } from './settings';

/** The tool a selected measurement's defaults belong to. */
export function toolOfMeasurement(a: ModelAnnotation): MeasureToolId {
  switch (a.subtype) {
    case 'Polygon':
      return 'area';
    case 'PolyLine':
      return 'perimeter';
    default:
      return 'distance';
  }
}

/** The heading's wording. */
export function describeMeasurement(a: ModelAnnotation): string {
  switch (a.subtype) {
    case 'Polygon':
      return 'Area measurement';
    case 'PolyLine':
      return 'Perimeter measurement';
    default:
      return 'Distance measurement';
  }
}

type Patch = (
  p: Parameters<MeasureService['annotationService']['patchSelection']>[0],
  label?: string,
) => void;

/**
 * The provider's `panel` hook, bound to the service. Here rather than in `provider.ts` because
 * everything it reaches needs a DOM, and this is the file that has one.
 */
export function measurePanel(
  service: MeasureService,
): (a: ModelAnnotation, refresh: () => void) => HTMLElement[] {
  return (a, refresh) => mountMeasureSections(service, a, refresh);
}

/** The sections, in order, for one measurement. */
export function mountMeasureSections(
  service: MeasureService,
  a: ModelAnnotation,
  refresh: () => void,
): HTMLElement[] {
  const annotations = service.annotationService;
  const patch: Patch = (p, label) => {
    void annotations.patchSelection(p, label);
  };
  /** An `extra` change that also moves the rect: the caption and the leaders live inside it. */
  const extra = (values: Record<string, unknown>, label?: string): void => {
    const next = { ...a.extra, ...values };
    const vertices = a.family === 'shape' ? a.vertices : [];
    patch(
      {
        extra: next,
        rect: measurementRect({ ...a, extra: next }, vertices),
      },
      label,
    );
  };
  const out: HTMLElement[] = [valueSection(service, a)];
  out.push(
    colourField({
      label: 'Line colour',
      presets: INK_PRESETS,
      value: a.color,
      onPick: (v) => {
        patch({ color: v }, 'Change colour');
      },
    }),
  );
  out.push(strokeFields(a, patch, extra));
  if (a.subtype === 'Line') out.push(leaderFields(a, extra));
  out.push(captionFields(a, extra));
  out.push(defaultsRow(service, a, refresh));
  return out;
}

/** What this measurement says, and the ruler it was measured with. */
function valueSection(service: MeasureService, a: ModelAnnotation): HTMLElement {
  const wrapper = el('div.annot-field');
  const measurement = measurementFor(a);
  const value = el('p.measure-value', null, measurement ? measurement.text : '—');
  const ratio = el(
    'p.annot-field-note',
    null,
    measurement
      ? `Measured at ${scaleRatioText(measurement.scale)}`
      : 'This measurement has no scale.',
  );
  wrapper.append(el('p.annot-field-label', null, 'Value'), value, ratio);
  const document = service.annotationService.activeDocument();
  const page = document ? document.pageIndex(a.pageId) : -1;
  if (page >= 0 && measurement) {
    const current = service.ratioText(page);
    if (current !== scaleRatioText(measurement.scale)) {
      wrapper.append(
        el(
          'p.annot-field-note',
          null,
          `The page now measures at ${current}. Recalibrating the page brings this one with it.`,
        ),
      );
    }
  }
  return wrapper;
}

interface ColourFieldOptions {
  readonly label: string;
  readonly presets: ReadonlyArray<ColourPreset>;
  readonly value: number | null;
  onPick(value: number | null): void;
}

/** Named swatches plus a custom value — the same control M30's and M31's panels use. */
function colourField(options: ColourFieldOptions): HTMLElement {
  const wrapper = el('div.annot-field');
  const legend = el('p.annot-field-label', null, options.label);
  const grid = el('div.annot-swatches', { role: 'group', 'aria-label': options.label });
  for (const preset of options.presets) {
    if (preset.value === null) continue;
    const chosen = preset.value === options.value;
    const chip = el('span.annot-swatch-chip', { 'aria-hidden': 'true' });
    // ynot-allow-color: an annotation's colour is document content, not chrome.
    chip.style.backgroundColor = hexOf(preset.value);
    const b = button(
      'annot-swatch',
      { 'aria-pressed': chosen ? 'true' : 'false', title: preset.name },
      chip,
      el('span.annot-swatch-name', null, preset.name),
    );
    b.addEventListener('click', () => {
      options.onPick(preset.value);
    });
    grid.append(b);
  }
  const custom = el('input.annot-colour-input', {
    type: 'text',
    value: options.value === null ? '' : hexOf(options.value),
    placeholder: 'RRGGBB',
    'aria-label': `${options.label}: a colour of your own, as six hexadecimal digits`,
  });
  custom.addEventListener('change', () => {
    const parsed = parseHexColour(custom.value);
    if (parsed !== null) options.onPick(parsed);
  });
  wrapper.append(legend, grid, field({ label: 'Custom', input: custom }));
  return wrapper;
}

type ExtraPatch = (values: Record<string, unknown>, label?: string) => void;

/** Width and dash. The rect follows the width, since the caption and leaders grow with it. */
function strokeFields(a: ModelAnnotation, patch: Patch, extra: ExtraPatch): HTMLElement {
  const width = el('input', {
    type: 'number',
    min: '0',
    max: '36',
    step: '0.5',
    value: String(a.borderWidth ?? 1),
    'aria-label': 'Line width in points',
  });
  width.addEventListener('change', () => {
    const value = Number.parseFloat(width.value);
    if (!Number.isFinite(value)) return;
    const next = Math.max(0, value);
    const vertices = a.family === 'shape' ? a.vertices : [];
    patch(
      {
        borderWidth: next,
        rect: measurementRect({ ...a, borderWidth: next }, vertices),
      },
      'Change width',
    );
  });
  const dash = el('select', { 'aria-label': 'Dash pattern' });
  const current = dashOf(a.extra).join(',');
  for (const [value, label] of [
    ['', 'Solid'],
    ['3,3', 'Dashed'],
    ['6,3', 'Long dashes'],
    ['1,2', 'Dotted'],
  ] as const) {
    const option = el('option', { value }, label);
    if (value === current) option.setAttribute('selected', '');
    dash.append(option);
  }
  dash.addEventListener('change', () => {
    const numbers = dash.value === '' ? [] : dash.value.split(',').map(Number);
    extra({ dashArray: numbers }, 'Change dash');
  });
  const wrapper = el('div.annot-field');
  wrapper.append(
    field({ label: 'Line width (points)', input: width }),
    field({ label: 'Line style', input: dash }),
  );
  return wrapper;
}

/** `/LL`, `/LLE`, `/LLO` — how far a dimension line stands off what it measures. */
function leaderFields(a: ModelAnnotation, extra: ExtraPatch): HTMLElement {
  const style = measureStyleOf(a.extra);
  const wrapper = el('div.annot-field');
  wrapper.append(el('p.annot-field-label', null, 'Leader lines'));
  const numbers: Array<[string, string, number, number, number]> = [
    ['Offset from the measured line (points)', 'leaderLength', style.leaderLength, -144, 144],
    ['How far the leaders run past it (points)', 'leaderExtend', style.leaderExtend, 0, 144],
    ['Gap at the measured point (points)', 'leaderOffset', style.leaderOffset, 0, 144],
  ];
  for (const [label, key, value, min, max] of numbers) {
    const input = el('input', {
      type: 'number',
      min: String(min),
      max: String(max),
      step: '1',
      value: String(value),
      'aria-label': label,
    });
    input.addEventListener('change', () => {
      const next = Number.parseFloat(input.value);
      if (!Number.isFinite(next)) return;
      extra({ [key]: Math.max(min, Math.min(max, next)) }, 'Change leaders');
    });
    wrapper.append(field({ label, input }));
  }
  return wrapper;
}

/** `/Cap`, `/CP` and the caption's size. */
function captionFields(a: ModelAnnotation, extra: ExtraPatch): HTMLElement {
  const style = measureStyleOf(a.extra);
  const wrapper = el('div.annot-field');
  const on = el('input', { type: 'checkbox' });
  if (style.caption) on.setAttribute('checked', '');
  on.addEventListener('change', () => {
    extra({ caption: on.checked }, 'Show the value');
  });
  const where = el('select', { 'aria-label': 'Where the value sits' });
  for (const [value, label] of [
    ['Top', 'Above the line'],
    ['Inline', 'On the line, breaking it'],
  ] as const) {
    const option = el('option', { value }, label);
    if (value === style.captionPosition) option.setAttribute('selected', '');
    where.append(option);
  }
  where.disabled = !style.caption;
  where.addEventListener('change', () => {
    extra({ captionPosition: where.value }, 'Move the value');
  });
  const size = el('input', {
    type: 'number',
    min: '4',
    max: '72',
    step: '1',
    value: String(style.fontSize),
    'aria-label': 'Size of the value, in points',
  });
  size.disabled = !style.caption;
  size.addEventListener('change', () => {
    const next = Number.parseFloat(size.value);
    if (Number.isFinite(next)) extra({ fontSize: Math.max(4, Math.min(72, next)) }, 'Change size');
  });
  wrapper.append(
    field({ label: 'Show the value on the page', input: on }),
    field({ label: 'Where', input: where }),
    field({ label: 'Size (points)', input: size }),
  );
  if (!style.caption) {
    wrapper.append(
      el(
        'p.annot-field-note',
        null,
        'The value is hidden, so where it sits and how big it is do not apply.',
      ),
    );
  }
  return wrapper;
}

/** "Set as default for this tool": the values of the selected measurement become the tool's. */
function defaultsRow(
  service: MeasureService,
  a: ModelAnnotation,
  refresh: () => void,
): HTMLElement {
  const tool = toolOfMeasurement(a);
  const style = measureStyleOf(a.extra);
  const b = button('btn', { type: 'button' }, 'Set as default for this tool');
  b.addEventListener('click', () => {
    const patch: Partial<MeasureDefaults> = {
      ...(a.color === null ? {} : { color: a.color }),
      borderWidth: a.borderWidth ?? service.defaults(tool).borderWidth,
      dashArray: dashOf(a.extra),
      leaderLength: style.leaderLength,
      leaderExtend: style.leaderExtend,
      leaderOffset: style.leaderOffset,
      caption: style.caption,
      captionPosition: style.captionPosition,
      fontSize: style.fontSize,
    };
    void service
      .setDefaults(tool, patch)
      .then(refresh)
      .catch(() => undefined);
  });
  const wrapper = el('div.annot-field.annot-actions');
  wrapper.append(b);
  return wrapper;
}
