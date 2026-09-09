/**
 * The form pieces M41's five dialogs share (M41).
 *
 * Written once because the alternative is five page-range inputs that disagree about what
 * `2-4, even` means, and five number fields that round differently. Everything here is built out
 * of M02's dialog service, so it is opaque, keyboard-reachable and themed by tokens without this
 * file choosing a single colour.
 */

import { field } from '@app/dialog/Dialogs';
import { el } from '@app/dom';
import {
  countPages,
  formatRange,
  parseRange,
  type RangeContext,
} from '@modules/M40-organise-pages/range';
import { fromPoints, toPoints, type Unit } from '@view/units';

export const RANGE_HINT =
  'Pages like 1-3, 5, 8- . You can also write odd, even, landscape, portrait, current or selected.';

/** A live page-range input: the field, its summary line, and what it currently means. */
export interface RangeField {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  /** The pages the text names right now, or `null` while it does not parse. */
  pages(): ReadonlyArray<number> | null;
  /** Re-reads the text and repaints the summary. */
  refresh(): void;
  onChange(listener: () => void): void;
}

/**
 * The page-range field.
 *
 * The summary under it is the point: a reader who types `2-4, even` should see that it means one
 * page before they act on it, and a reader who types `9` in a five-page document should be told
 * so in words rather than have three pages quietly cropped.
 */
export function rangeField(options: {
  readonly label: string;
  readonly value: string;
  readonly context: RangeContext;
  readonly hint?: string;
}): RangeField {
  const input = el('input.input', { type: 'text', value: options.value, spellcheck: 'false' });
  const summary = el('p.field-hint.ops-summary', { role: 'status' });
  const error = el('p.field-error', { role: 'alert' });
  error.hidden = true;
  const listeners: Array<() => void> = [];
  let current: ReadonlyArray<number> | null = null;

  const refresh = (): void => {
    const parsed = parseRange(input.value, options.context);
    if (parsed.error !== null) {
      current = null;
      error.textContent = parsed.error;
      error.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      summary.textContent = '';
    } else {
      current = parsed.pages;
      error.hidden = true;
      input.removeAttribute('aria-invalid');
      summary.textContent =
        parsed.pages.length === 0
          ? 'No pages'
          : `${countPages(parsed.pages.length)}: ${formatRange(parsed.pages)}`;
    }
    for (const listener of listeners) listener();
  };

  input.addEventListener('input', refresh);
  const wrapper = el('div.ops-range');
  wrapper.append(
    field({
      label: options.label,
      input,
      hint: options.hint ?? RANGE_HINT,
    }),
    summary,
    error,
  );
  refresh();
  return {
    element: wrapper,
    input,
    pages: () => current,
    refresh,
    onChange: (listener) => listeners.push(listener),
  };
}

/** A number input that reads and writes **points** while showing the reader's own unit. */
export interface LengthField {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  /** The value in points. */
  points(): number;
  /** Sets the value from points, without firing `onChange`. */
  set(points: number): void;
  /** Re-labels and re-scales for a different unit, keeping the same length. */
  setUnit(unit: Unit): void;
  onChange(listener: (points: number) => void): void;
}

/** How many decimals a unit wants in an input box (points are whole; inches want two). */
const PLACES: Readonly<Record<Unit, number>> = { pt: 1, mm: 1, cm: 2, in: 2 };
const STEPS: Readonly<Record<Unit, number>> = { pt: 1, mm: 1, cm: 0.1, in: 0.05 };

export function lengthField(options: {
  readonly label: string;
  readonly points: number;
  readonly unit: Unit;
  readonly min?: number;
  readonly hint?: string;
}): LengthField {
  let unit = options.unit;
  let value = options.points;
  const listeners: Array<(points: number) => void> = [];
  const input = el('input.input.ops-length', {
    type: 'number',
    step: String(STEPS[unit]),
    min: String(fromPoints(options.min ?? 0, unit)),
  });
  const suffix = el('span.ops-unit', { 'aria-hidden': 'true' }, unit);

  const paint = (): void => {
    input.value = fromPoints(value, unit).toFixed(PLACES[unit]);
    input.step = String(STEPS[unit]);
    input.min = String(fromPoints(options.min ?? 0, unit));
    suffix.textContent = unit;
  };

  input.addEventListener('input', () => {
    const typed = Number(input.value);
    if (!Number.isFinite(typed)) return;
    value = toPoints(typed, unit);
    for (const listener of listeners) listener(value);
  });

  const row = el('div.ops-length-row');
  row.append(input, suffix);
  const wrapper = field({
    label: options.label,
    input: row,
    ...(options.hint === undefined ? {} : { hint: options.hint }),
  });
  // `field` moves its id onto the wrapper it was given; the label must point at the input.
  const label = wrapper.querySelector('label');
  if (label) {
    input.id = `${row.id || 'length'}-input`;
    label.setAttribute('for', input.id);
  }
  paint();

  return {
    element: wrapper,
    input,
    points: () => value,
    set: (points) => {
      value = points;
      paint();
    },
    setUnit: (next) => {
      unit = next;
      paint();
    },
    onChange: (listener) => listeners.push(listener),
  };
}

/** A labelled checkbox: the box, then the words, on one line. */
export function checkbox(options: {
  readonly label: string;
  readonly checked: boolean;
  readonly hint?: string;
  readonly onChange?: (checked: boolean) => void;
}): { element: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { type: 'checkbox' });
  input.checked = options.checked;
  if (options.onChange) {
    input.addEventListener('change', () => {
      options.onChange?.(input.checked);
    });
  }
  const wrapper = el('label.ops-check');
  wrapper.append(input, el('span', null, options.label));
  if (options.hint === undefined) return { element: wrapper, input };
  const block = el('div.ops-check-block');
  block.append(wrapper, el('p.field-hint', null, options.hint));
  return { element: block, input };
}

/** A `<select>` from a list of `{ value, label }`. */
export function select<T extends string>(options: {
  readonly label: string;
  readonly value: T;
  readonly choices: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly hint?: string;
  readonly onChange?: (value: T) => void;
}): { element: HTMLElement; input: HTMLSelectElement } {
  const input = el('select.input');
  for (const choice of options.choices) {
    const option = el('option', { value: choice.value }, choice.label);
    if (choice.value === options.value) option.selected = true;
    input.append(option);
  }
  if (options.onChange) {
    input.addEventListener('change', () => {
      options.onChange?.(input.value as T);
    });
  }
  return {
    element: field({
      label: options.label,
      input,
      ...(options.hint === undefined ? {} : { hint: options.hint }),
    }),
    input,
  };
}

/** A group of radio buttons, which is what a "how should this be split" question is. */
export function radioGroup<T extends string>(options: {
  readonly legend: string;
  readonly name: string;
  readonly value: T;
  readonly choices: ReadonlyArray<{
    readonly value: T;
    readonly label: string;
    readonly extra?: HTMLElement;
  }>;
  readonly onChange?: (value: T) => void;
}): { element: HTMLElement; value: () => T } {
  const fieldset = el('fieldset.ops-radios');
  fieldset.append(el('legend', null, options.legend));
  const inputs: HTMLInputElement[] = [];
  for (const choice of options.choices) {
    const input = el('input', { type: 'radio', name: options.name, value: choice.value });
    input.checked = choice.value === options.value;
    inputs.push(input);
    const row = el('div.ops-radio-row');
    const label = el('label.ops-radio');
    label.append(input, el('span', null, choice.label));
    row.append(label);
    if (choice.extra) row.append(choice.extra);
    input.addEventListener('change', () => {
      if (input.checked) options.onChange?.(choice.value);
    });
    fieldset.append(row);
  }
  return {
    element: fieldset,
    value: () => (inputs.find((i) => i.checked)?.value ?? options.value) as T,
  };
}

/**
 * A number box that sits on the same line as whatever names it, with its own screen-reader
 * label and a visible unit after it: "Every [2] pages".
 *
 * A radio button's option and the number it governs are one sentence; giving the number a
 * heading of its own says they are two, and doubles the height of the dialog to say it.
 */
export function inlineNumber(options: {
  readonly label: string;
  readonly value: number;
  readonly suffix: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly onChange?: (value: number) => void;
}): { element: HTMLElement; input: HTMLInputElement } {
  const input = el('input.input.ops-number', {
    type: 'number',
    value: String(options.value),
    'aria-label': options.label,
    ...(options.min === undefined ? {} : { min: String(options.min) }),
    ...(options.max === undefined ? {} : { max: String(options.max) }),
    step: String(options.step ?? 1),
  });
  if (options.onChange) {
    input.addEventListener('input', () => {
      const typed = Number(input.value);
      if (Number.isFinite(typed)) options.onChange?.(typed);
    });
  }
  const row = el('div.ops-inline');
  row.append(input, el('span.ops-unit', null, options.suffix));
  return { element: row, input };
}

/** A number input with a unit-free label — page counts, megabytes, degrees. */
export function numberField(options: {
  readonly label: string;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly hint?: string;
  readonly onChange?: (value: number) => void;
}): { element: HTMLElement; input: HTMLInputElement } {
  const input = el('input.input.ops-number', {
    type: 'number',
    value: String(options.value),
    ...(options.min === undefined ? {} : { min: String(options.min) }),
    ...(options.max === undefined ? {} : { max: String(options.max) }),
    step: String(options.step ?? 1),
  });
  if (options.onChange) {
    input.addEventListener('input', () => {
      const typed = Number(input.value);
      if (Number.isFinite(typed)) options.onChange?.(typed);
    });
  }
  return {
    element: field({
      label: options.label,
      input,
      ...(options.hint === undefined ? {} : { hint: options.hint }),
    }),
    input,
  };
}
