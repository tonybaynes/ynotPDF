/**
 * The field properties panel (M60) — the right pane, bound to the selection.
 *
 * Five tabs, the ones Foxit's field properties dialog has and the PDF specification's own
 * grouping: **General** (name, tooltip, read-only, required, visibility), **Appearance** (border,
 * fill, style, width, font, size, colour, alignment), **Position** (x, y, width, height and the
 * alignment tools), **Options** (per type — multiline, password, comb, maximum length, check
 * style, export value, choices, button caption and layout, date format, barcode symbology) and
 * **Actions** (the `/AA` list; what the entries *mean* is M61's, the editor is here).
 *
 * Every control is a plain labelled input, keyboard-reachable, and commits on change rather than
 * on every keystroke — a number field that applied as the reader typed "1" on the way to "120"
 * would move the field twice. Colour inputs are PDF content, not interface, so they carry real
 * colour values; every one of them is marked, and the swatch is never the only thing that says
 * what is set — the hex value is beside it as text.
 */

import { el, button as domButton } from '@app/dom';
import type { ModelField } from '@core/model';
import { fieldDesignOf, widgetAppearanceOf } from '@core/model';
import { errorCorrectionRange } from '@engine/forms/barcode';
import {
  ACTION_TRIGGERS,
  ACTION_TYPES,
  BARCODE_SYMBOLOGIES,
  BARCODE_SYMBOLOGY_LABELS,
  BORDER_STYLES,
  BORDER_STYLE_LABELS,
  BUTTON_FLAGS,
  BUTTON_LAYOUTS,
  BUTTON_LAYOUT_LABELS,
  CHECK_STYLES,
  CHECK_STYLE_LABELS,
  CHOICE_FLAGS,
  COMMON_FLAGS,
  FIELD_ROLE_LABELS,
  TEXT_FLAGS,
  WIDGET_HIGHLIGHTS,
  hasFlag,
  withFlag,
  type BorderStyle,
  type ButtonLayout,
  type CheckStyle,
  type FieldAction,
  type FieldDesign,
  type FieldOption,
  type WidgetAppearance,
  type WidgetHighlight,
} from '@engine/forms/model';
import type { StandardFontName } from '@engine/appearance/types';
import { STANDARD_FONT_NAMES } from './fonts';
import type { FormService } from './FormService';

type TabId = 'general' | 'appearance' | 'position' | 'options' | 'actions';

const TABS: ReadonlyArray<{ readonly id: TabId; readonly label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'position', label: 'Position' },
  { id: 'options', label: 'Options' },
  { id: 'actions', label: 'Actions' },
];

function hex(colour: number): string {
  return `#${(colour & 0xffffff).toString(16).padStart(6, '0')}`;
}

function parseHex(value: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return m?.[1] ? Number.parseInt(m[1], 16) : null;
}

function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

export function mountFieldPropertiesPanel(host: HTMLElement, service: FormService): () => void {
  const root = el('div.field-props');
  host.replaceChildren(root);
  let tab: TabId = 'general';

  const render = (): void => {
    const selection = service.selectionInfo();
    root.replaceChildren();
    const field = selection.fields[0];
    const ref = selection.widgets[0];
    if (!field || !ref) {
      root.append(
        el(
          'p.field-props-empty',
          null,
          'Select a field with the Select Field tool, or in the Fields panel.',
        ),
      );
      return;
    }
    const design = fieldDesignOf(field);
    const appearance = widgetAppearanceOf(ref.widget, design);

    root.append(
      el(
        'p.field-props-what',
        null,
        selection.fields.length > 1
          ? `${String(selection.fields.length)} fields selected — changes apply to "${field.name}".`
          : `${FIELD_ROLE_LABELS[design.role]} "${field.name}"`,
      ),
    );

    const tabList = el('div.field-props-tabs', { role: 'tablist' });
    for (const t of TABS) {
      const b = domButton('field-props-tab', {
        role: 'tab',
        'aria-selected': String(tab === t.id),
        tabindex: tab === t.id ? '0' : '-1',
      });
      b.textContent = t.label;
      b.addEventListener('click', () => {
        tab = t.id;
        render();
      });
      tabList.append(b);
    }
    root.append(tabList);

    const body = el('div.field-props-body', { role: 'tabpanel' });
    root.append(body);
    switch (tab) {
      case 'general':
        general(body, service, field, design);
        break;
      case 'appearance':
        appearanceTab(body, service, field, design, appearance, ref.key);
        break;
      case 'position':
        position(body, service, field, ref.key);
        break;
      case 'options':
        options(body, service, field, design, appearance, ref.key);
        break;
      case 'actions':
        actions(body, service, field, design);
        break;
    }
  };

  render();
  const off = service.onChange(render);
  return () => {
    off();
    host.replaceChildren();
  };
}

// ---- small builders ------------------------------------------------------------------------------

let seq = 0;

function nextId(): string {
  return `fp-${String(++seq)}`;
}

function section(host: HTMLElement, title: string): HTMLElement {
  const s = el('section.field-props-section');
  s.append(el('h4', null, title));
  host.append(s);
  return s;
}

function textRow(
  host: HTMLElement,
  label: string,
  value: string,
  apply: (v: string) => void,
  attrs: Readonly<Record<string, string>> = {},
): HTMLInputElement {
  const id = nextId();
  const input = el('input', { id, type: 'text', value, ...attrs });
  input.addEventListener('change', () => {
    apply(input.value);
  });
  host.append(el('label', { for: id }, label), input);
  return input;
}

function numberRow(
  host: HTMLElement,
  label: string,
  value: number,
  apply: (v: number) => void,
  attrs: Readonly<Record<string, string>> = {},
): void {
  const id = nextId();
  const input = el('input', { id, type: 'number', step: '0.5', value: fmt(value), ...attrs });
  input.addEventListener('change', () => {
    const n = Number.parseFloat(input.value);
    if (Number.isFinite(n)) apply(n);
  });
  host.append(el('label', { for: id }, label), input);
}

function checkRow(
  host: HTMLElement,
  label: string,
  value: boolean,
  apply: (v: boolean) => void,
  description?: string,
): void {
  const id = nextId();
  const input = el('input', { id, type: 'checkbox' });
  input.checked = value;
  input.addEventListener('change', () => {
    apply(input.checked);
  });
  const row = el('div.field-props-check', null, input, el('label', { for: id }, label));
  if (description) row.append(el('p.field-props-hint', null, description));
  host.append(row);
}

function selectRow<T extends string>(
  host: HTMLElement,
  label: string,
  value: T,
  choices: ReadonlyArray<{ readonly value: T; readonly label: string }>,
  apply: (v: T) => void,
): void {
  const id = nextId();
  const select = el('select', { id });
  for (const c of choices) {
    const option = el('option', { value: c.value });
    option.textContent = c.label;
    option.selected = c.value === value;
    select.append(option);
  }
  select.addEventListener('change', () => {
    apply(select.value as T);
  });
  host.append(el('label', { for: id }, label), select);
}

/**
 * A colour row: a swatch, the hex value as text, and a "none" box for the colours that may be
 * absent. The value is written into the PDF, so it is a real colour rather than a theme token —
 * the one place CLAUDE.md's rule bends, and it bends the same way M30's annotation colours do.
 */
function colourRow(
  host: HTMLElement,
  label: string,
  value: number | null,
  apply: (v: number | null) => void,
  allowNone: boolean,
): void {
  const id = nextId();
  const row = el('div.field-props-colour');
  const input = el('input', { id, type: 'color', value: hex(value ?? 0x000000) });
  input.disabled = value === null;
  const text = el('input.field-props-hexvalue', {
    type: 'text',
    value: value === null ? '' : hex(value),
    'aria-label': `${label} value`,
    placeholder: 'None',
    size: '8',
  });
  input.addEventListener('change', () => {
    apply(parseHex(input.value));
  });
  text.addEventListener('change', () => {
    const parsed = parseHex(text.value);
    if (parsed !== null || (allowNone && text.value.trim() === '')) apply(parsed);
  });
  row.append(input, text);
  if (allowNone) {
    const noneId = nextId();
    const none = el('input', { id: noneId, type: 'checkbox' });
    none.checked = value === null;
    none.addEventListener('change', () => {
      apply(none.checked ? null : 0x000000);
    });
    row.append(none, el('label.field-props-none', { for: noneId }, 'None'));
  }
  host.append(el('label', { for: id }, label), row);
}

// ---- tabs -----------------------------------------------------------------------------------------

function general(
  host: HTMLElement,
  service: FormService,
  field: ModelField,
  design: FieldDesign,
): void {
  const s = section(host, 'General');
  const grid = el('div.field-props-grid');
  s.append(grid);
  const name = textRow(grid, 'Name', field.name, () => undefined);
  const problem = el('p.field-props-problem');
  problem.hidden = true;
  s.append(problem);
  name.addEventListener('change', () => {
    void service.rename(field.id, name.value).then((message) => {
      problem.textContent = message ?? '';
      problem.hidden = message === null;
      if (message !== null) name.value = field.name;
    });
  });
  s.append(
    el(
      'p.field-props-hint',
      null,
      'A dot makes a group: "address.city" is the field "city" inside "address". Two fields with the same name are one field and share a value.',
    ),
  );
  const grid2 = el('div.field-props-grid');
  s.append(grid2);
  textRow(grid2, 'Tooltip', design.tooltip ?? '', (v) => {
    void service.setDesign(field.id, { tooltip: v === '' ? null : v }, 'Change tooltip');
  });
  textRow(grid2, 'Default value', design.defaultValue ?? '', (v) => {
    void service.setDesign(field.id, { defaultValue: v === '' ? null : v }, 'Change default');
  });

  const flags = section(host, 'Behaviour');
  checkRow(
    flags,
    'Read-only',
    hasFlag(design.flags, COMMON_FLAGS.readOnly),
    (on) => {
      void service.setDesign(
        field.id,
        { flags: withFlag(design.flags, COMMON_FLAGS.readOnly, on) },
        'Change read-only',
      );
    },
    'The field is shown but cannot be changed.',
  );
  checkRow(
    flags,
    'Required',
    hasFlag(design.flags, COMMON_FLAGS.required),
    (on) => {
      void service.setDesign(
        field.id,
        { flags: withFlag(design.flags, COMMON_FLAGS.required, on) },
        'Change required',
      );
    },
    'Marked as "must be filled in", and outlined on the page.',
  );
  checkRow(
    flags,
    'Do not export',
    hasFlag(design.flags, COMMON_FLAGS.noExport),
    (on) => {
      void service.setDesign(
        field.id,
        { flags: withFlag(design.flags, COMMON_FLAGS.noExport, on) },
        'Change export',
      );
    },
    'The value is left out when the form is submitted or exported.',
  );

  const visibility = section(host, 'Visibility');
  const widget = field.widgets[0];
  if (!widget) return;
  const appearance = widgetAppearanceOf(widget, design);
  const key = `${field.id}:${widget.id}`;
  selectRow<'visible' | 'hidden' | 'no-print' | 'print-only'>(
    visibility,
    'Show the field',
    appearance.hidden
      ? appearance.noPrint
        ? 'hidden'
        : 'print-only'
      : appearance.noPrint
        ? 'no-print'
        : 'visible',
    [
      { value: 'visible', label: 'On screen and on paper' },
      { value: 'no-print', label: 'On screen only' },
      { value: 'print-only', label: 'On paper only' },
      { value: 'hidden', label: 'Neither — hidden' },
    ],
    (v) => {
      void service.setWidgetAppearance(
        key,
        {
          hidden: v === 'hidden' || v === 'print-only',
          noPrint: v === 'hidden' || v === 'no-print',
        },
        'Change visibility',
      );
    },
  );
}

function appearanceTab(
  host: HTMLElement,
  service: FormService,
  field: ModelField,
  design: FieldDesign,
  appearance: WidgetAppearance,
  key: string,
): void {
  const box = section(host, 'Box');
  const grid = el('div.field-props-grid');
  box.append(grid);
  colourRow(
    grid,
    'Border colour',
    appearance.borderColor,
    (v) => {
      void service.setWidgetAppearance(key, { borderColor: v }, 'Change border colour');
    },
    true,
  );
  colourRow(
    grid,
    'Fill colour',
    appearance.fillColor,
    (v) => {
      void service.setWidgetAppearance(key, { fillColor: v }, 'Change fill colour');
    },
    true,
  );
  numberRow(
    grid,
    'Border width (pt)',
    appearance.borderWidth,
    (v) => {
      void service.setWidgetAppearance(key, { borderWidth: Math.max(0, v) }, 'Change border width');
    },
    { min: '0', max: '12', step: '0.5' },
  );
  selectRow<BorderStyle>(
    grid,
    'Border style',
    appearance.borderStyle,
    BORDER_STYLES.map((s) => ({ value: s, label: BORDER_STYLE_LABELS[s] })),
    (v) => {
      void service.setWidgetAppearance(key, { borderStyle: v }, 'Change border style');
    },
  );

  const text = section(host, 'Text');
  const grid2 = el('div.field-props-grid');
  text.append(grid2);
  selectRow<StandardFontName>(
    grid2,
    'Font',
    typeof design.font === 'string' ? design.font : design.font.fallback,
    STANDARD_FONT_NAMES.map((f) => ({ value: f, label: f })),
    (v) => {
      void service.setDesign(field.id, { font: v }, 'Change font');
    },
  );
  if (typeof design.font !== 'string') {
    text.append(
      el(
        'p.field-props-hint',
        null,
        `This field asks for "${design.font.baseFont}", which the file does not embed. It is laid out with ${design.font.fallback}'s widths and drawn with whatever the reader has; choosing a standard font above makes it the same everywhere.`,
      ),
    );
  }
  numberRow(
    grid2,
    'Size (pt, 0 = fit)',
    design.fontSize,
    (v) => {
      void service.setDesign(field.id, { fontSize: Math.max(0, v) }, 'Change font size');
    },
    { min: '0', max: '144', step: '0.5' },
  );
  colourRow(
    grid2,
    'Text colour',
    design.textColor,
    (v) => {
      void service.setDesign(field.id, { textColor: v ?? 0 }, 'Change text colour');
    },
    false,
  );
  selectRow<'0' | '1' | '2'>(
    grid2,
    'Alignment',
    String(design.align) as '0' | '1' | '2',
    [
      { value: '0', label: 'Left' },
      { value: '1', label: 'Centre' },
      { value: '2', label: 'Right' },
    ],
    (v) => {
      void service.setDesign(field.id, { align: Number(v) as 0 | 1 | 2 }, 'Change alignment');
    },
  );

  const behaviour = section(host, 'When clicked');
  const grid3 = el('div.field-props-grid');
  behaviour.append(grid3);
  selectRow<WidgetHighlight>(
    grid3,
    'Highlight',
    appearance.highlight,
    WIDGET_HIGHLIGHTS.map((h) => ({
      value: h,
      label:
        h === 'none' ? 'None' : h === 'invert' ? 'Invert' : h === 'outline' ? 'Outline' : 'Push',
    })),
    (v) => {
      void service.setWidgetAppearance(key, { highlight: v }, 'Change highlight');
    },
  );
  selectRow<'0' | '90' | '180' | '270'>(
    grid3,
    'Rotate contents',
    String(appearance.rotation) as '0',
    [
      { value: '0', label: '0°' },
      { value: '90', label: '90°' },
      { value: '180', label: '180°' },
      { value: '270', label: '270°' },
    ],
    (v) => {
      void service.setWidgetAppearance(
        key,
        { rotation: Number(v) as 0 | 90 | 180 | 270 },
        'Rotate field contents',
      );
    },
  );
}

function position(host: HTMLElement, service: FormService, field: ModelField, key: string): void {
  const widget = field.widgets.find((w) => `${field.id}:${w.id}` === key) ?? field.widgets[0];
  if (!widget) return;
  const r = widget.rect;
  const s = section(host, 'Position and size');
  const grid = el('div.field-props-grid');
  s.append(grid);
  const set = (patch: Partial<{ x: number; y: number; w: number; h: number }>): void => {
    const x0 = patch.x ?? r.x0;
    const y0 = patch.y ?? r.y0;
    const width = patch.w ?? r.x1 - r.x0;
    const height = patch.h ?? r.y1 - r.y0;
    void service.updateField(
      {
        ...field,
        widgets: field.widgets.map((w) =>
          w.id === widget.id
            ? { ...w, rect: { x0, y0, x1: x0 + Math.max(1, width), y1: y0 + Math.max(1, height) } }
            : w,
        ),
      },
      'Move field',
    );
  };
  numberRow(grid, 'X (pt)', r.x0, (v) => {
    set({ x: v });
  });
  numberRow(grid, 'Y (pt)', r.y0, (v) => {
    set({ y: v });
  });
  numberRow(grid, 'Width (pt)', r.x1 - r.x0, (v) => {
    set({ w: v });
  });
  numberRow(grid, 'Height (pt)', r.y1 - r.y0, (v) => {
    set({ h: v });
  });

  const tools = section(host, 'Align and space');
  const row = el('div.field-props-row');
  const add = (label: string, run: () => void): void => {
    const b = domButton('btn', null, label);
    b.addEventListener('click', run);
    row.append(b);
  };
  add('Left', () => void service.align('left'));
  add('Centre', () => void service.align('centre'));
  add('Right', () => void service.align('right'));
  add('Top', () => void service.align('top'));
  add('Middle', () => void service.align('middle'));
  add('Bottom', () => void service.align('bottom'));
  tools.append(row);
  const row2 = el('div.field-props-row');
  const add2 = (label: string, run: () => void): void => {
    const b = domButton('btn', null, label);
    b.addEventListener('click', run);
    row2.append(b);
  };
  add2('Space across', () => void service.distribute('horizontal'));
  add2('Space down', () => void service.distribute('vertical'));
  add2('Same width', () => void service.matchSize('width'));
  add2('Same height', () => void service.matchSize('height'));
  add2('Same size', () => void service.matchSize('both'));
  tools.append(row2);
  tools.append(
    el(
      'p.field-props-hint',
      null,
      'Align and match use the first field you selected as the reference. Spacing needs three.',
    ),
  );
}

function options(
  host: HTMLElement,
  service: FormService,
  field: ModelField,
  design: FieldDesign,
  appearance: WidgetAppearance,
  key: string,
): void {
  const setFlag = (bit: number, on: boolean, label: string): void => {
    void service.setDesign(field.id, { flags: withFlag(design.flags, bit, on) }, label);
  };
  switch (design.role) {
    case 'text':
    case 'date':
    case 'barcode': {
      const s = section(host, 'Text options');
      checkRow(s, 'Several lines', hasFlag(design.flags, TEXT_FLAGS.multiline), (on) => {
        setFlag(TEXT_FLAGS.multiline, on, 'Change multiline');
      });
      checkRow(
        s,
        'Password — show dots instead of the characters',
        hasFlag(design.flags, TEXT_FLAGS.password),
        (on) => {
          setFlag(TEXT_FLAGS.password, on, 'Change password');
        },
      );
      checkRow(
        s,
        'Comb — one box per character',
        hasFlag(design.flags, TEXT_FLAGS.comb),
        (on) => {
          setFlag(TEXT_FLAGS.comb, on, 'Change comb');
        },
        'Needs a maximum length, and cannot be used with several lines.',
      );
      checkRow(
        s,
        'Do not scroll long text',
        hasFlag(design.flags, TEXT_FLAGS.doNotScroll),
        (on) => {
          setFlag(TEXT_FLAGS.doNotScroll, on, 'Change scrolling');
        },
      );
      const grid = el('div.field-props-grid');
      s.append(grid);
      numberRow(
        grid,
        'Maximum length',
        design.maxLength ?? 0,
        (v) => {
          void service.setDesign(
            field.id,
            { maxLength: v > 0 ? Math.round(v) : null },
            'Change maximum length',
          );
        },
        { min: '0', max: '9999', step: '1' },
      );
      if (design.role === 'date') {
        textRow(grid, 'Date format', design.dateFormat ?? 'dd/mm/yyyy', (v) => {
          void service.setDesign(field.id, { dateFormat: v || null }, 'Change date format');
        });
        s.append(
          el(
            'p.field-props-hint',
            null,
            'd, m and y are day, month and year: "dd/mm/yyyy", "d mmm yyyy". The format is written into the file so other readers format the field too.',
          ),
        );
      }
      if (design.role === 'barcode') {
        const bar = section(host, 'Barcode');
        const bgrid = el('div.field-props-grid');
        bar.append(bgrid);
        const spec = design.barcode;
        if (!spec) break;
        selectRow(
          bgrid,
          'Symbology',
          spec.symbology,
          BARCODE_SYMBOLOGIES.map((b) => ({ value: b, label: BARCODE_SYMBOLOGY_LABELS[b] })),
          (v) => {
            void service.setDesign(
              field.id,
              { barcode: { ...spec, symbology: v } },
              'Change symbology',
            );
          },
        );
        const range = errorCorrectionRange(spec.symbology);
        if (range) {
          numberRow(
            bgrid,
            range.label,
            spec.errorCorrection,
            (v) => {
              void service.setDesign(
                field.id,
                { barcode: { ...spec, errorCorrection: Math.round(v) } },
                'Change error correction',
              );
            },
            { min: String(range.min), max: String(range.max), step: '1' },
          );
        }
        numberRow(
          bgrid,
          'Module size (pt)',
          spec.cellSize,
          (v) => {
            void service.setDesign(
              field.id,
              { barcode: { ...spec, cellSize: Math.max(0.2, v) } },
              'Change module size',
            );
          },
          { min: '0.2', max: '10', step: '0.1' },
        );
        bar.append(
          el(
            'p.field-props-hint',
            null,
            'The symbol is drawn from the field value and keeps its shape: a bigger module makes a bigger symbol, never a stretched one.',
          ),
        );
      }
      break;
    }
    case 'checkbox':
    case 'radio': {
      const s = section(host, design.role === 'radio' ? 'Radio options' : 'Check box options');
      const grid = el('div.field-props-grid');
      s.append(grid);
      selectRow<CheckStyle>(
        grid,
        'Style',
        appearance.checkStyle,
        CHECK_STYLES.map((c) => ({ value: c, label: CHECK_STYLE_LABELS[c] })),
        (v) => {
          void service.setWidgetAppearance(key, { checkStyle: v }, 'Change check style');
        },
      );
      textRow(grid, 'Export value', appearance.exportValue, (v) => {
        void service.setWidgetAppearance(key, { exportValue: v || 'Yes' }, 'Change export value');
      });
      if (design.role === 'radio') {
        checkRow(
          s,
          'Buttons with the same value change together',
          hasFlag(design.flags, BUTTON_FLAGS.unison),
          (on) => {
            setFlag(BUTTON_FLAGS.unison, on, 'Change unison');
          },
        );
        checkRow(
          s,
          'Clicking the chosen button turns it off',
          !hasFlag(design.flags, BUTTON_FLAGS.noToggleToOff),
          (on) => {
            setFlag(BUTTON_FLAGS.noToggleToOff, !on, 'Change toggle');
          },
        );
      }
      s.append(
        el(
          'p.field-props-hint',
          null,
          'The export value is what the form sends when this button is chosen. Radio buttons of one group share a name and differ by export value.',
        ),
      );
      break;
    }
    case 'combobox':
    case 'listbox': {
      const s = section(host, 'Choices');
      choiceEditor(s, service, field, design);
      checkRow(s, 'Sort the list', hasFlag(design.flags, CHOICE_FLAGS.sort), (on) => {
        setFlag(CHOICE_FLAGS.sort, on, 'Change sorting');
      });
      if (design.role === 'combobox') {
        checkRow(
          s,
          'The reader may type a value of their own',
          hasFlag(design.flags, CHOICE_FLAGS.edit),
          (on) => {
            setFlag(CHOICE_FLAGS.edit, on, 'Change editable');
          },
        );
      } else {
        checkRow(
          s,
          'Several may be chosen',
          hasFlag(design.flags, CHOICE_FLAGS.multiSelect),
          (on) => {
            setFlag(CHOICE_FLAGS.multiSelect, on, 'Change multi-select');
          },
        );
        const grid = el('div.field-props-grid');
        s.append(grid);
        numberRow(
          grid,
          'First visible choice',
          design.topIndex,
          (v) => {
            void service.setDesign(
              field.id,
              { topIndex: Math.max(0, Math.round(v)) },
              'Change first choice',
            );
          },
          { min: '0', step: '1' },
        );
      }
      break;
    }
    case 'button':
    case 'image': {
      const s = section(host, design.role === 'image' ? 'Image field' : 'Button');
      const grid = el('div.field-props-grid');
      s.append(grid);
      textRow(grid, 'Caption', appearance.caption ?? '', (v) => {
        void service.setWidgetAppearance(key, { caption: v || null }, 'Change caption');
      });
      textRow(grid, 'Caption while the pointer is over', appearance.rolloverCaption ?? '', (v) => {
        void service.setWidgetAppearance(key, { rolloverCaption: v || null }, 'Change caption');
      });
      textRow(grid, 'Caption while pressed', appearance.downCaption ?? '', (v) => {
        void service.setWidgetAppearance(key, { downCaption: v || null }, 'Change caption');
      });
      selectRow<ButtonLayout>(
        grid,
        'Layout',
        appearance.layout,
        BUTTON_LAYOUTS.map((l) => ({ value: l, label: BUTTON_LAYOUT_LABELS[l] })),
        (v) => {
          void service.setWidgetAppearance(key, { layout: v }, 'Change layout');
        },
      );
      s.append(
        el(
          'p.field-props-hint',
          null,
          design.role === 'image'
            ? 'An image field is a button that shows a picture. Choosing the picture arrives with the form-logic module; the field, its box and its layout are set here.'
            : 'What the button does when it is pressed is set on the Actions tab.',
        ),
      );
      break;
    }
    case 'signature': {
      const s = section(host, 'Signature field');
      s.append(
        el(
          'p.field-props-hint',
          null,
          'An empty box for a signature. Signing it — by hand or with a certificate — arrives with the signature modules; the field itself is saved now and opens in any reader.',
        ),
      );
      break;
    }
  }
}

/** The list editor for a combo or list box: add, rename, reorder, remove, set the export value. */
function choiceEditor(
  host: HTMLElement,
  service: FormService,
  field: ModelField,
  design: FieldDesign,
): void {
  const list = el('div.field-choices', { role: 'list' });
  const commit = (next: ReadonlyArray<FieldOption>): void => {
    void service.setDesign(field.id, { options: next }, 'Change choices');
  };
  design.options.forEach((option, index) => {
    const row = el('div.field-choice', { role: 'listitem' });
    const label = el('input', {
      type: 'text',
      value: option.label,
      'aria-label': `Choice ${String(index + 1)} label`,
    });
    const value = el('input', {
      type: 'text',
      value: option.value,
      'aria-label': `Choice ${String(index + 1)} export value`,
    });
    const apply = (): void => {
      commit(
        design.options.map((o, i) =>
          i === index ? { label: label.value, value: value.value || label.value } : o,
        ),
      );
    };
    label.addEventListener('change', apply);
    value.addEventListener('change', apply);
    const up = domButton('btn-icon', { 'aria-label': `Move choice ${String(index + 1)} up` }, '↑');
    up.disabled = index === 0;
    up.addEventListener('click', () => {
      const next = [...design.options];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(index - 1, 0, moved);
      commit(next);
    });
    const down = domButton(
      'btn-icon',
      { 'aria-label': `Move choice ${String(index + 1)} down` },
      '↓',
    );
    down.disabled = index === design.options.length - 1;
    down.addEventListener('click', () => {
      const next = [...design.options];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(index + 1, 0, moved);
      commit(next);
    });
    const remove = domButton(
      'btn-icon',
      { 'aria-label': `Remove choice ${String(index + 1)}` },
      '×',
    );
    remove.addEventListener('click', () => {
      commit(design.options.filter((_o, i) => i !== index));
    });
    row.append(label, value, up, down, remove);
    list.append(row);
  });
  host.append(list);
  const add = domButton('btn', null, 'Add a choice');
  add.addEventListener('click', () => {
    const n = design.options.length + 1;
    commit([...design.options, { label: `Choice ${String(n)}`, value: `Choice ${String(n)}` }]);
  });
  host.append(add);
  host.append(
    el(
      'p.field-props-hint',
      null,
      'The first box is what the reader sees; the second is what the form sends. Leave the second empty to send what is shown.',
    ),
  );
}

/**
 * The `/AA` editor. What an entry *does* is M61's; this round-trips the list so a form that
 * arrives with actions keeps them, and a form we design can carry them.
 */
function actions(
  host: HTMLElement,
  service: FormService,
  field: ModelField,
  design: FieldDesign,
): void {
  const s = section(host, 'Actions');
  const commit = (next: ReadonlyArray<FieldAction>): void => {
    void service.setDesign(field.id, { actions: next }, 'Change actions');
  };
  const list = el('div.field-actions', { role: 'list' });
  design.actions.forEach((action, index) => {
    const row = el('div.field-action', { role: 'listitem' });
    const trigger = el('select', { 'aria-label': `Action ${String(index + 1)} trigger` });
    for (const t of ACTION_TRIGGERS) {
      const option = el('option', { value: t.key });
      option.textContent = t.label;
      option.selected = t.key === action.trigger;
      trigger.append(option);
    }
    const type = el('select', { 'aria-label': `Action ${String(index + 1)} kind` });
    for (const t of ACTION_TYPES) {
      const option = el('option', { value: t.value });
      option.textContent = t.label;
      option.selected = t.value === action.type;
      type.append(option);
    }
    const value = el('input', {
      type: 'text',
      value: action.value,
      'aria-label': `Action ${String(index + 1)} value`,
    });
    const apply = (): void => {
      commit(
        design.actions.map((a, i) =>
          i === index ? { trigger: trigger.value, type: type.value, value: value.value } : a,
        ),
      );
    };
    trigger.addEventListener('change', apply);
    type.addEventListener('change', apply);
    value.addEventListener('change', apply);
    const remove = domButton(
      'btn-icon',
      { 'aria-label': `Remove action ${String(index + 1)}` },
      '×',
    );
    remove.addEventListener('click', () => {
      commit(design.actions.filter((_a, i) => i !== index));
    });
    row.append(trigger, type, value, remove);
    list.append(row);
  });
  s.append(list);
  const add = domButton('btn', null, 'Add an action');
  add.addEventListener('click', () => {
    commit([...design.actions, { trigger: 'U', type: 'ResetForm', value: '' }]);
  });
  s.append(add);
  s.append(
    el(
      'p.field-props-hint',
      null,
      'Actions are saved into the file and read back, so a form keeps the ones it arrived with. ynotPDF does not run form JavaScript — validation, formatting and calculation arrive with the form-logic module.',
    ),
  );
}
