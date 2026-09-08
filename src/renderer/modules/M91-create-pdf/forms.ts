/**
 * Form pieces the Create dialogs share (M91): page size, orientation, margins, a number, a
 * select, a checkbox, and a page-shape preview. Native controls throughout, so every one is
 * keyboard-reachable and carries the shell's focus ring; labels come from the shell's `field()`.
 */

import { el } from '@app/dom';
import { field } from '@app/dialog/Dialogs';
import type { MarginsMm, Orientation, PageSizeChoice } from '@shared/create';
import { PAGE_SIZE_PRESETS, resolvePageSize, type SizePt } from '@shared/pageSizes';
import type { Rect } from '@engine/create/images/raster';

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${String(++seq)}`;

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export function select(
  options: ReadonlyArray<SelectOption>,
  value: string,
  id = nextId('create-select'),
): HTMLSelectElement {
  const control = el('select.create-control', { id });
  for (const o of options) {
    const option = el('option', { value: o.value }, o.label);
    if (o.value === value) option.selected = true;
    control.append(option);
  }
  return control;
}

export function numberInput(
  value: number,
  range: { readonly min: number; readonly max: number; readonly step?: number },
  id = nextId('create-number'),
): HTMLInputElement {
  const input = el('input.create-control', {
    id,
    type: 'number',
    min: String(range.min),
    max: String(range.max),
    step: String(range.step ?? 1),
  });
  input.value = String(value);
  return input;
}

/** The number the input holds, clamped to its range; the fallback when it is not a number. */
export function numberOf(input: HTMLInputElement, fallback: number): number {
  const n = Number(input.value);
  if (!Number.isFinite(n)) return fallback;
  const min = Number(input.min);
  const max = Number(input.max);
  return Math.min(Number.isFinite(max) ? max : n, Math.max(Number.isFinite(min) ? min : n, n));
}

export function textInput(
  value: string,
  attrs: Record<string, string> = {},
  id = nextId('create-text'),
): HTMLInputElement {
  const input = el('input.create-control', { id, type: 'text', ...attrs });
  input.value = value;
  return input;
}

/** A checkbox with its label to the right, as a form row. */
export function checkbox(
  label: string,
  checked: boolean,
  id = nextId('create-check'),
): { readonly row: HTMLElement; readonly input: HTMLInputElement } {
  const input = el('input', { id, type: 'checkbox' });
  input.checked = checked;
  const row = el('div.field.create-check-row');
  row.append(input, el('label.field-label', { for: id }, label));
  return { row, input };
}

export function pageSizeSelect(value: PageSizeChoice): HTMLSelectElement {
  const current = value.kind === 'preset' ? value.id : 'A4';
  const control = el('select.create-control', { id: nextId('create-page-size') });
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const preset of PAGE_SIZE_PRESETS) {
    let group = groups.get(preset.group);
    if (!group) {
      group = el('optgroup', { label: preset.group });
      groups.set(preset.group, group);
      control.append(group);
    }
    const option = el(
      'option',
      { value: preset.id },
      `${preset.label} (${preset.widthMm} × ${preset.heightMm} mm)`,
    );
    if (preset.id === current) option.selected = true;
    group.append(option);
  }
  return control;
}

export function pageSizeOf(control: HTMLSelectElement): PageSizeChoice {
  return { kind: 'preset', id: control.value };
}

export function orientationSelect(value: Orientation, includeAuto: boolean): HTMLSelectElement {
  const options: SelectOption[] = [
    ...(includeAuto ? [{ value: 'auto', label: 'Automatic (from the content)' }] : []),
    { value: 'portrait', label: 'Portrait' },
    { value: 'landscape', label: 'Landscape' },
  ];
  return select(options, includeAuto || value !== 'auto' ? value : 'portrait');
}

export function orientationOf(control: HTMLSelectElement): Orientation {
  const v = control.value;
  return v === 'landscape' || v === 'portrait' || v === 'auto' ? v : 'portrait';
}

/** One value for all four margins: the common case, and one fewer thing to tab through. */
export function marginsInput(value: MarginsMm): HTMLInputElement {
  return numberInput(value.top, { min: 0, max: 50, step: 1 });
}

export function marginsOf(input: HTMLInputElement, fallback: MarginsMm): MarginsMm {
  const mm = numberOf(input, fallback.top);
  return { top: mm, right: mm, bottom: mm, left: mm };
}

/** The standard page-size / orientation / margins trio, as fields ready for a grid. */
export interface PageFields {
  readonly size: HTMLSelectElement;
  readonly orientation: HTMLSelectElement;
  readonly margins: HTMLInputElement;
  readonly fields: ReadonlyArray<HTMLElement>;
}

export function pageFields(
  value: {
    readonly pageSize: PageSizeChoice;
    readonly orientation: Orientation;
    readonly margins: MarginsMm;
  },
  includeAuto: boolean,
): PageFields {
  const size = pageSizeSelect(value.pageSize);
  const orientation = orientationSelect(value.orientation, includeAuto);
  const margins = marginsInput(value.margins);
  return {
    size,
    orientation,
    margins,
    fields: [
      field({ label: 'Page size', input: size }),
      field({ label: 'Orientation', input: orientation }),
      field({ label: 'Margins (mm)', input: margins }),
    ],
  };
}

/**
 * A page drawn to scale inside a fixed box, with an optional content rectangle — the preview
 * of the blank and image dialogs. Colours are tokens: the page is the panel surface with the
 * border colour around it, the content is the accent.
 */
export function pagePreview(page: SizePt, rect: Rect | null, label: string): SVGSVGElement {
  const box = 120;
  const scale = box / Math.max(page.width, page.height);
  const w = page.width * scale;
  const h = page.height * scale;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${String(box + 4)} ${String(box + 4)}`);
  svg.setAttribute('width', String(box + 4));
  svg.setAttribute('height', String(box + 4));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.classList.add('create-page-preview');
  const x0 = (box + 4 - w) / 2;
  const y0 = (box + 4 - h) / 2;
  const pageRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  pageRect.setAttribute('x', String(x0));
  pageRect.setAttribute('y', String(y0));
  pageRect.setAttribute('width', String(w));
  pageRect.setAttribute('height', String(h));
  pageRect.classList.add('create-page-preview-page');
  svg.append(pageRect);
  if (rect) {
    const content = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    content.setAttribute('x', String(x0 + rect.x * scale));
    // PDF y is up; SVG y is down.
    content.setAttribute('y', String(y0 + (page.height - rect.y - rect.height) * scale));
    content.setAttribute('width', String(rect.width * scale));
    content.setAttribute('height', String(rect.height * scale));
    content.classList.add('create-page-preview-content');
    svg.append(content);
  }
  return svg;
}

/** "A4 landscape, 297 × 210 mm" for the preview's label and the summary line. */
export function describePage(
  choice: PageSizeChoice,
  orientation: Orientation,
  aspect?: number,
): string {
  const size = resolvePageSize(choice, orientation, aspect);
  const name = choice.kind === 'preset' ? choice.id : 'Custom';
  const way = size.width > size.height ? 'landscape' : 'portrait';
  const mm = (pt: number): string => String(Math.round((pt / 72) * 25.4));
  return `${name} ${way}, ${mm(size.width)} × ${mm(size.height)} mm`;
}

/** "1.2 MB" — en-GB, through `Intl`. */
export function formatBytes(n: number): string {
  const units = ['bytes', 'kB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
  return `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: digits }).format(value)} ${units[unit] ?? ''}`.trim();
}
