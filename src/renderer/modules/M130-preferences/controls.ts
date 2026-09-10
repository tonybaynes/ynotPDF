/**
 * One control per setting type (M130).
 *
 * Every control here follows the same three rules, which come from the operator's requirements
 * rather than from taste: it has a real `<label>` tied to it, it is reachable and operable from
 * the keyboard with the theme's focus ring intact, and it never says anything with colour alone —
 * a colour swatch carries its token's name in words beside it, and a changed setting is marked
 * with the word "changed", not a dot.
 *
 * Colour settings hold a **theme token name**, not a literal, so the interface keeps following
 * the theme (CLAUDE.md). A module may allow a custom `#rrggbb` where the colour ends up inside a
 * PDF rather than on the interface; the control then offers a native colour input as well.
 */

import { field } from '@app/dialog/Dialogs';
import { button, el, srOnly } from '@app/dom';
import { icon } from '@app/icons';
import type { SettingSpec } from '@shared/module';
import { t } from './i18n';
import { clampNumber } from './model';

/**
 * Theme tokens a colour setting offers when its schema names none. Deliberately short: these are
 * the semantic roles that mean something in every one of the four themes, and every one of them
 * clears the contrast floor on every surface (M01's tests enforce that, not this list).
 */
export const DEFAULT_COLOUR_TOKENS: ReadonlyArray<{ token: string; label: string }> = [
  { token: 'accent', label: 'Accent' },
  { token: 'fg', label: 'Text' },
  { token: 'fg-muted', label: 'Secondary text' },
  { token: 'info', label: 'Information' },
  { token: 'success', label: 'Success' },
  { token: 'warning', label: 'Warning' },
  { token: 'danger', label: 'Danger' },
  { token: 'selection', label: 'Selection' },
  { token: 'border-strong', label: 'Border' },
];

/** A six-digit hex colour, the only literal form a custom PDF-content colour may take. */
const HEX = /^#[0-9a-fA-F]{6}$/;
/** The value a native colour input falls back to when nothing usable is stored. */
const BLACK = '#000000'; // ynot-allow-color: PDF content, never interface colour

/** What a rendered control offers its owner. */
export interface Control {
  /** The whole field: label, control, hint. */
  readonly element: HTMLElement;
  /** What "focus this setting" focuses — the search result jump target. */
  readonly focusTarget: HTMLElement;
  /** Redraws from a value that changed elsewhere (a reset, an import, another window). */
  set(value: unknown): void;
}

export interface ControlOptions {
  readonly spec: SettingSpec;
  readonly value: unknown;
  /** Stable id so the label's `for` is unique across pages. */
  readonly id: string;
  onChange(value: unknown): void;
  /** Opens a native picker for a `path` setting. Absent means the Browse button is not offered. */
  browse?: (spec: Extract<SettingSpec, { type: 'path' }>) => Promise<string | null>;
}

/** Builds the control for one setting. */
export function renderControl(options: ControlOptions): Control {
  switch (options.spec.type) {
    case 'boolean':
      return booleanControl(options, options.spec);
    case 'number':
      return numberControl(options, options.spec);
    case 'string':
      return stringControl(options, options.spec);
    case 'enum':
      return enumControl(options, options.spec);
    case 'colour':
      return colourControl(options, options.spec);
    case 'path':
      return pathControl(options, options.spec);
    case 'list':
      return listControl(options, options.spec);
  }
}

/** The hint under a control: the schema's description, plus the "needs a restart" warning. */
function hintOf(spec: SettingSpec): string | undefined {
  const parts: string[] = [];
  if (spec.description) parts.push(spec.description);
  if (spec.live === false) {
    parts.push(t('prefs.notLive', 'This one takes effect the next time the application starts.'));
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function wrap(options: ControlOptions, input: HTMLElement, extra?: HTMLElement): HTMLElement {
  input.id = options.id;
  const hint = hintOf(options.spec);
  const wrapper = field({
    label: options.spec.title,
    input: extra ?? input,
    ...(hint !== undefined ? { hint } : {}),
  });
  wrapper.classList.add('pref-field', `pref-${options.spec.type}`);
  wrapper.dataset['setting'] = options.id;
  if (extra) {
    // `field()` labels whatever it was given; a composite control labels its real input instead.
    const label = wrapper.querySelector('label');
    if (label) label.htmlFor = options.id;
    extra.id = `${options.id}-group`;
  }
  return wrapper;
}

// ---- boolean ------------------------------------------------------------------------------------

function booleanControl(
  options: ControlOptions,
  spec: Extract<SettingSpec, { type: 'boolean' }>,
): Control {
  const input = el('input', { type: 'checkbox' });
  input.checked = options.value === true;
  input.addEventListener('change', () => {
    options.onChange(input.checked);
  });
  // A tick box reads better with its label beside it than above it, so this one is built by hand.
  const label = el('label.pref-check', { for: options.id });
  input.id = options.id;
  label.append(input, el('span', null, spec.title));
  const wrapper = el('div.field.pref-field.pref-boolean', { 'data-setting': options.id }, label);
  const hint = hintOf(spec);
  if (hint !== undefined) {
    const hintId = `${options.id}-hint`;
    wrapper.append(el('p.field-hint', { id: hintId }, hint));
    input.setAttribute('aria-describedby', hintId);
  }
  return {
    element: wrapper,
    focusTarget: input,
    set: (value) => {
      input.checked = value === true;
    },
  };
}

// ---- number -------------------------------------------------------------------------------------

function numberControl(
  options: ControlOptions,
  spec: Extract<SettingSpec, { type: 'number' }>,
): Control {
  const input = el('input.pref-number', { type: 'number', inputmode: 'decimal' });
  if (spec.min !== undefined) input.min = String(spec.min);
  if (spec.max !== undefined) input.max = String(spec.max);
  if (spec.step !== undefined) input.step = String(spec.step);
  const current = typeof options.value === 'number' ? options.value : spec.default;
  input.value = String(current);

  const row = el('div.pref-number-row');
  input.id = options.id;
  row.append(input);
  if (spec.unit) row.append(el('span.pref-unit', { 'aria-hidden': 'true' }, spec.unit));

  // A slider as well when the range is bounded: it is the control that actually helps someone
  // with a tremor or a trackpad, and the number stays there for someone who knows the value.
  const slider =
    spec.min !== undefined && spec.max !== undefined
      ? el('input.pref-slider', {
          type: 'range',
          min: String(spec.min),
          max: String(spec.max),
          step: String(spec.step ?? 1),
          'aria-label': `${spec.title}${spec.unit ? ` (${spec.unit})` : ''}`,
        })
      : null;
  if (slider) {
    slider.value = String(current);
    row.append(slider);
  }

  const commit = (raw: string, from: 'input' | 'slider'): void => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    const next = clampNumber(spec, parsed);
    if (from !== 'input') input.value = String(next);
    if (slider && from !== 'slider') slider.value = String(next);
    options.onChange(next);
  };
  input.addEventListener('change', () => {
    commit(input.value, 'input');
  });
  slider?.addEventListener('input', () => {
    commit(slider.value, 'slider');
  });

  const wrapper = wrap(options, input, row);
  return {
    element: wrapper,
    focusTarget: input,
    set: (value) => {
      const n = typeof value === 'number' ? value : spec.default;
      input.value = String(n);
      if (slider) slider.value = String(n);
    },
  };
}

// ---- string -------------------------------------------------------------------------------------

function stringControl(
  options: ControlOptions,
  spec: Extract<SettingSpec, { type: 'string' }>,
): Control {
  const input = el('input.pref-text', { type: 'text' });
  input.value = typeof options.value === 'string' ? options.value : spec.default;
  input.addEventListener('change', () => {
    options.onChange(input.value);
  });
  return {
    element: wrap(options, input),
    focusTarget: input,
    set: (value) => {
      input.value = typeof value === 'string' ? value : spec.default;
    },
  };
}

// ---- enum ---------------------------------------------------------------------------------------

function enumControl(
  options: ControlOptions,
  spec: Extract<SettingSpec, { type: 'enum' }>,
): Control {
  const select = el('select.pref-select');
  for (const option of spec.options) {
    select.append(el('option', { value: option.value }, option.label));
  }
  select.value = spec.options.some((o) => o.value === options.value)
    ? String(options.value)
    : spec.default;
  select.addEventListener('change', () => {
    options.onChange(select.value);
  });
  return {
    element: wrap(options, select),
    focusTarget: select,
    set: (value) => {
      select.value = spec.options.some((o) => o.value === value) ? String(value) : spec.default;
    },
  };
}

// ---- colour -------------------------------------------------------------------------------------

function colourControl(
  options: ControlOptions,
  spec: Extract<SettingSpec, { type: 'colour' }>,
): Control {
  const tokens = (spec.tokens ?? DEFAULT_COLOUR_TOKENS.map((c) => c.token)).map((token) => ({
    token,
    label: DEFAULT_COLOUR_TOKENS.find((c) => c.token === token)?.label ?? token,
  }));
  const group = el('div.pref-colours', { role: 'radiogroup', 'aria-label': spec.title });
  const buttons = new Map<string, HTMLButtonElement>();
  let value = typeof options.value === 'string' ? options.value : spec.default;

  const paint = (): void => {
    for (const [token, element] of buttons) {
      const chosen = token === value;
      element.setAttribute('aria-checked', chosen ? 'true' : 'false');
      element.tabIndex = chosen || (value === '' && token === tokens[0]?.token) ? 0 : -1;
      element.classList.toggle('is-chosen', chosen);
    }
    // A native colour input needs a concrete value, and this control's custom mode only exists
    // for colour that ends up inside a PDF, never for interface colour.
    if (custom) custom.value = HEX.test(value) ? value : BLACK; // ynot-allow-color
  };

  for (const { token, label } of tokens) {
    const swatch = button('pref-colour', { role: 'radio', 'data-token': token, title: label });
    // The word matters more than the square: nothing in this app means anything by colour alone.
    swatch.append(
      el('span.pref-colour-chip', {
        'aria-hidden': 'true',
        style: `background: var(--${token})`,
      }),
      el('span.pref-colour-label', null, label),
    );
    swatch.addEventListener('click', () => {
      value = token;
      paint();
      options.onChange(token);
    });
    buttons.set(token, swatch);
    group.append(swatch);
  }

  let custom: HTMLInputElement | null = null;
  if (spec.allowCustom) {
    custom = el('input.pref-colour-custom', { type: 'color', 'aria-label': 'A specific colour' });
    custom.addEventListener('change', () => {
      value = custom?.value ?? value;
      paint();
      options.onChange(value);
    });
    group.append(el('label.pref-colour-custom-wrap', null, custom, el('span', null, 'Choose…')));
  }

  // Arrow keys move within the group, as a radio group should.
  group.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    const order = [...buttons.values()];
    const index = order.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    order[(index + step + order.length) % order.length]?.focus();
  });

  paint();
  const first = [...buttons.values()][0] ?? group;
  const wrapper = wrap(options, first, group);
  return {
    element: wrapper,
    focusTarget: first,
    set: (next) => {
      value = typeof next === 'string' ? next : spec.default;
      paint();
    },
  };
}

// ---- path ---------------------------------------------------------------------------------------

function pathControl(
  options: ControlOptions,
  spec: Extract<SettingSpec, { type: 'path' }>,
): Control {
  const input = el('input.pref-text.pref-path', {
    type: 'text',
    spellcheck: 'false',
    placeholder: spec.pathKind === 'directory' ? 'No folder chosen' : 'No file chosen',
  });
  input.value = typeof options.value === 'string' ? options.value : spec.default;
  input.addEventListener('change', () => {
    options.onChange(input.value.trim());
  });
  const row = el('div.pref-path-row');
  input.id = options.id;
  row.append(input);
  if (options.browse) {
    const browse = button('btn pref-browse');
    browse.append(icon('folder-open'), el('span', null, t('prefs.browse', 'Browse…')));
    browse.addEventListener('click', () => {
      void options.browse?.(spec).then((chosen) => {
        if (chosen === null) return;
        input.value = chosen;
        options.onChange(chosen);
      });
    });
    row.append(browse);
  }
  const clear = button('icon-btn pref-clear', { title: t('prefs.clearPath', 'Clear') });
  clear.append(icon('x'), srOnly(t('prefs.clearPath', 'Clear')));
  clear.addEventListener('click', () => {
    input.value = '';
    options.onChange('');
  });
  row.append(clear);
  return {
    element: wrap(options, input, row),
    focusTarget: input,
    set: (value) => {
      input.value = typeof value === 'string' ? value : spec.default;
    },
  };
}

// ---- list ---------------------------------------------------------------------------------------

function listControl(
  options: ControlOptions,
  spec: Extract<SettingSpec, { type: 'list' }>,
): Control {
  let items: string[] = Array.isArray(options.value)
    ? (options.value as unknown[]).filter((v): v is string => typeof v === 'string')
    : [...spec.default];

  const listBox = el('ul.pref-list', { role: 'list' });
  const entry = el('input.pref-text.pref-list-entry', {
    type: 'text',
    placeholder: spec.itemLabel ?? t('prefs.listAdd', 'Add an entry'),
    'aria-label': `${spec.title}: ${spec.itemLabel ?? t('prefs.listAdd', 'Add an entry')}`,
  });

  const commit = (): void => {
    options.onChange([...items]);
    draw();
  };

  function draw(): void {
    listBox.replaceChildren();
    if (items.length === 0) {
      listBox.append(el('li.pref-list-empty', null, t('prefs.listEmpty', 'Nothing in this list.')));
    }
    items.forEach((item, index) => {
      const row = el('li.pref-list-row', { role: 'listitem' });
      row.append(el('span.pref-list-text', null, item));
      const controls = el('div.pref-list-controls');
      const move = (direction: -1 | 1, iconName: string, word: string): void => {
        const target = index + direction;
        const btn = button('icon-btn', { title: `${word}: ${item}` });
        btn.disabled = target < 0 || target >= items.length;
        btn.append(icon(iconName), srOnly(`${word}: ${item}`));
        btn.addEventListener('click', () => {
          const next = [...items];
          const [moved] = next.splice(index, 1);
          if (moved !== undefined) next.splice(target, 0, moved);
          items = next;
          commit();
        });
        controls.append(btn);
      };
      move(-1, 'arrow-up', t('prefs.listUp', 'Move up'));
      move(1, 'arrow-down', t('prefs.listDown', 'Move down'));
      const remove = button('icon-btn', { title: `${t('prefs.listRemove', 'Remove')}: ${item}` });
      remove.append(icon('trash-2'), srOnly(`${t('prefs.listRemove', 'Remove')}: ${item}`));
      remove.addEventListener('click', () => {
        items = items.filter((_, i) => i !== index);
        commit();
      });
      controls.append(remove);
      row.append(controls);
      listBox.append(row);
    });
  }

  const add = button('btn pref-list-add');
  add.append(icon('plus'), el('span', null, t('prefs.listAddButton', 'Add')));
  const addItem = (): void => {
    const text = entry.value.trim();
    if (text === '' || items.includes(text)) return;
    items = [...items, text];
    entry.value = '';
    commit();
    entry.focus();
  };
  add.addEventListener('click', addItem);
  entry.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addItem();
  });

  const group = el(
    'div.pref-list-wrap',
    null,
    listBox,
    el('div.pref-list-entry-row', null, entry, add),
  );
  entry.id = options.id;
  draw();
  return {
    element: wrap(options, entry, group),
    focusTarget: entry,
    set: (value) => {
      items = Array.isArray(value)
        ? (value as unknown[]).filter((v): v is string => typeof v === 'string')
        : [...spec.default];
      draw();
    },
  };
}
