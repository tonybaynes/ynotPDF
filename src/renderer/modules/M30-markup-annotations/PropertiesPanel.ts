/**
 * The annotation properties panel (M30) — the right pane, bound to the selection.
 *
 * Every control writes straight through to the model, so the page updates as the control moves:
 * that is the "live preview" the brief asks for, and it costs nothing extra because
 * `UpdateAnnotationCommand` merges, so dragging a slider is still one undo step.
 *
 * Accessibility rules this panel exists to obey (CLAUDE.md): every colour swatch carries its
 * **name as text**, not colour alone; every control has a real `<label>`; nothing is disabled
 * without saying why; and the panel is fully opaque like everything else in the chrome.
 */

import { button, el } from '@app/dom';
import { field } from '@app/dialog/Dialogs';
import { icon } from '@app/icons';
import type { ModelAnnotation } from '@core/model';
import {
  buildDefaultAppearance,
  buildDefaultStyle,
  intentOf,
  NOTE_ICONS,
  rotateOf,
  styleOf,
  type FreeTextStyle,
} from '@engine/appearance';
import { hasBridge, invoke } from '@shared/ipc';
import type { AnnotationService } from './AnnotationService';
import {
  BASE_FONT_FAMILIES,
  FILL_PRESETS,
  FONT_SIZES,
  HIGHLIGHT_PRESETS,
  INK_PRESETS,
  colourName,
  hexOf,
  parseHexColour,
  type ColourPreset,
} from './presets';
import type { AnnotationToolId } from './settings';

/** The tool a selected annotation's defaults belong to, so "Set as default" knows where to put it. */
export function toolOf(a: ModelAnnotation): AnnotationToolId {
  switch (a.subtype) {
    case 'Highlight':
      return 'highlight';
    case 'Underline':
      return 'underline';
    case 'Squiggly':
      return 'squiggly';
    case 'StrikeOut':
      return 'strikeout';
    case 'Text':
      return 'note';
    case 'Caret':
      return 'insert';
    case 'FreeText': {
      const intent = intentOf(a.extra);
      return intent === 'FreeTextCallout'
        ? 'callout'
        : intent === 'FreeTextTypewriter'
          ? 'typewriter'
          : 'textbox';
    }
    default:
      return 'note';
  }
}

/** Mounts the panel. Returns a disposer, as `PanelSpec.mount` requires. */
export function mountPropertiesPanel(host: HTMLElement, service: AnnotationService): () => void {
  const root = el('div.annot-props', { id: 'annot-props' });
  host.append(root);
  let systemFonts: string[] = [];
  let rendering = false;

  const render = (): void => {
    if (rendering) return;
    rendering = true;
    try {
      root.replaceChildren(...build(service, systemFonts, render));
    } finally {
      rendering = false;
    }
  };

  const unsubscribe = service.subscribe(render);
  render();
  if (hasBridge()) {
    void invoke('fonts:list')
      .then((list) => {
        systemFonts = list;
        render();
      })
      .catch(() => undefined);
  }
  return () => {
    unsubscribe();
    root.remove();
  };
}

function build(
  service: AnnotationService,
  systemFonts: ReadonlyArray<string>,
  refresh: () => void,
): HTMLElement[] {
  const selected = service.selectedAnnotations();
  const out: HTMLElement[] = [];
  if (selected.length === 0) {
    out.push(el('p.annot-props-empty', null, 'Select an annotation to see its properties.'));
    out.push(keepToolToggle(service, refresh));
    return out;
  }
  const first = selected[0];
  if (!first) return out;
  const many = selected.length > 1;
  out.push(
    el(
      'p.annot-props-what',
      null,
      many
        ? `${selected.length} annotations selected`
        : `${describe(first)} by ${first.author ?? 'an unnamed author'}`,
    ),
  );
  if (!many && first.modified) {
    out.push(el('p.annot-props-when', null, `Last changed ${formatDate(first.modified)}`));
  }

  const families = new Set(selected.map((a) => a.family));
  const isMarkup = families.has('markup');
  const isFreeText = families.has('freeText');
  const isNote = families.has('note');

  out.push(
    colourField({
      label: isMarkup ? 'Highlight colour' : 'Colour',
      presets: isMarkup && first.subtype === 'Highlight' ? HIGHLIGHT_PRESETS : INK_PRESETS,
      value: first.color,
      onPick: (value) => {
        void service.patchSelection({ color: value }, 'Change colour');
      },
    }),
  );

  if (isFreeText) {
    out.push(
      colourField({
        label: 'Fill',
        presets: FILL_PRESETS,
        value: first.interiorColor,
        allowNone: true,
        onPick: (value) => {
          void service.patchSelection({ interiorColor: value }, 'Change fill');
        },
      }),
    );
    out.push(borderFields(service, first));
    out.push(...textFields(service, first, systemFonts));
  }

  if (isNote) out.push(iconField(service, first));

  if (!many) {
    out.push(contentsField(service, first));
    out.push(subjectField(service, first));
  }

  out.push(lockField(service, first));
  out.push(defaultsRow(service, first, refresh));
  out.push(keepToolToggle(service, refresh));
  return out;
}

// ---- fields ---------------------------------------------------------------------------------------

interface ColourFieldOptions {
  readonly label: string;
  readonly presets: ReadonlyArray<ColourPreset>;
  readonly value: number | null;
  readonly allowNone?: boolean;
  onPick(value: number | null): void;
}

/**
 * A grid of named swatches plus a custom value.
 *
 * Every swatch is a button whose visible text is the colour's **name**; the colour itself is the
 * button's background. That is the whole point — a grid of unlabelled squares is unusable to a
 * colourblind reader, and this way the keyboard and a screen reader get the same information the
 * eye does.
 */
function colourField(options: ColourFieldOptions): HTMLElement {
  const wrapper = el('div.annot-field');
  const legend = el('p.annot-field-label', null, options.label);
  const grid = el('div.annot-swatches', { role: 'group', 'aria-label': options.label });
  for (const preset of options.presets) {
    if (preset.value === null && !options.allowNone) continue;
    const chosen = preset.value === options.value;
    /*
     * The colour goes in a chip and the name stays in the theme's own foreground on the theme's
     * own surface. Colouring the label instead would make its contrast a property of whatever the
     * reader picked, which is exactly the thing this app is not allowed to do.
     */
    const chip = el('span.annot-swatch-chip', { 'aria-hidden': 'true' });
    if (preset.value === null) chip.classList.add('annot-swatch-chip-none');
    // ynot-allow-color: an annotation's colour is document content, not chrome.
    else chip.style.backgroundColor = hexOf(preset.value);
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

function borderFields(service: AnnotationService, a: ModelAnnotation): HTMLElement {
  const width = el('input', {
    type: 'number',
    min: '0',
    max: '12',
    step: '0.5',
    value: String(a.borderWidth ?? 1),
  });
  width.addEventListener('change', () => {
    const value = Number.parseFloat(width.value);
    if (Number.isFinite(value)) void service.patchSelection({ borderWidth: Math.max(0, value) });
  });
  const style = el('select', { 'aria-label': 'Border style' });
  for (const [value, label] of [
    ['solid', 'Solid'],
    ['dashed', 'Dashed'],
  ] as const) {
    const option = el('option', { value }, label);
    if ((a.extra['borderStyle'] === 'dashed' ? 'dashed' : 'solid') === value) {
      option.setAttribute('selected', '');
    }
    style.append(option);
  }
  style.addEventListener('change', () => {
    void service.patchSelection({
      extra: { ...a.extra, borderStyle: style.value },
    });
  });
  const wrapper = el('div.annot-field');
  wrapper.append(
    field({ label: 'Border width (points)', input: width }),
    field({ label: 'Border style', input: style }),
  );
  return wrapper;
}

/** Font family, size, bold/italic, alignment and line spacing — everything `/DA` and `/DS` say. */
function textFields(
  service: AnnotationService,
  a: ModelAnnotation,
  systemFonts: ReadonlyArray<string>,
): HTMLElement[] {
  const style = styleOf(a.extra);
  const write = (patch: Partial<FreeTextStyle>): void => {
    const next: FreeTextStyle = { ...style, ...patch };
    void service.patchSelection({
      ...(patch.color === undefined ? {} : {}),
      extra: {
        ...a.extra,
        defaultAppearance: buildDefaultAppearance(next),
        defaultStyle: buildDefaultStyle(next),
        align: next.align,
      },
    });
  };

  const family = el('select', { 'aria-label': 'Font' });
  const seen = new Set<string>();
  const addFamily = (name: string, group: HTMLElement): void => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const option = el('option', { value: name }, name);
    if (name.toLowerCase() === style.family.toLowerCase()) option.setAttribute('selected', '');
    group.append(option);
  };
  const base = el('optgroup', { label: 'Always available' });
  for (const name of BASE_FONT_FAMILIES) addFamily(name, base);
  family.append(base);
  if (systemFonts.length > 0) {
    const installed = el('optgroup', { label: 'Installed on this computer' });
    for (const name of systemFonts) addFamily(name, installed);
    family.append(installed);
  }
  if (!seen.has(style.family.toLowerCase())) {
    const other = el('optgroup', { label: 'From this document' });
    addFamily(style.family, other);
    family.append(other);
  }
  family.addEventListener('change', () => {
    write({ family: family.value });
  });

  const size = el('input', {
    type: 'number',
    min: '4',
    max: '288',
    step: '1',
    list: 'annot-font-sizes',
    value: String(style.size),
  });
  size.addEventListener('change', () => {
    const value = Number.parseFloat(size.value);
    if (Number.isFinite(value) && value > 0) write({ size: value });
  });
  const sizes = el('datalist', { id: 'annot-font-sizes' });
  for (const n of FONT_SIZES) sizes.append(el('option', { value: String(n) }));

  const toggles = el('div.annot-buttons', { role: 'group', 'aria-label': 'Text style' });
  const toggle = (
    label: string,
    iconName: string,
    on: boolean,
    apply: () => void,
  ): HTMLButtonElement => {
    const b = button(
      'icon-btn',
      { 'aria-pressed': on ? 'true' : 'false', 'aria-label': label, title: label },
      icon(iconName),
    );
    b.addEventListener('click', apply);
    return b;
  };
  toggles.append(
    toggle('Bold', 'bold', style.bold, () => {
      write({ bold: !style.bold });
    }),
    toggle('Italic', 'italic', style.italic, () => {
      write({ italic: !style.italic });
    }),
  );

  const align = el('div.annot-buttons', { role: 'group', 'aria-label': 'Alignment' });
  const alignments: ReadonlyArray<readonly [0 | 1 | 2, string, string]> = [
    [0, 'Align left', 'align-left'],
    [1, 'Align centre', 'align-center'],
    [2, 'Align right', 'align-right'],
  ];
  for (const [value, label, iconName] of alignments) {
    align.append(
      toggle(label, iconName, style.align === value, () => {
        write({ align: value });
      }),
    );
  }

  const spacing = el('input', {
    type: 'number',
    min: '0.8',
    max: '3',
    step: '0.05',
    value: String(style.lineSpacing),
  });
  spacing.addEventListener('change', () => {
    const value = Number.parseFloat(spacing.value);
    if (Number.isFinite(value) && value > 0) write({ lineSpacing: value });
  });

  /*
   * `/Rotate` turns the words inside the box without moving the box, which is what a reader wants
   * for a note down the margin of a page. Only the four right angles: the spec allows any multiple
   * of 90 and viewers disagree about anything else.
   */
  const rotation = el('select', { 'aria-label': 'Text rotation' });
  const currentRotation = rotateOf(a.extra);
  for (const [value, label] of [
    [0, 'None'],
    [90, '90° anticlockwise'],
    [180, 'Upside down'],
    [270, '90° clockwise'],
  ] as const) {
    const option = el('option', { value: String(value) }, label);
    if (value === currentRotation) option.setAttribute('selected', '');
    rotation.append(option);
  }
  rotation.addEventListener('change', () => {
    void service.patchSelection(
      { extra: { ...a.extra, rotate: Number.parseInt(rotation.value, 10) } },
      'Rotate text',
    );
  });

  const note = el(
    'p.annot-field-note',
    null,
    'Helvetica, Times New Roman and Courier New are drawn the same by every reader. Other ' +
      'families are named in the file but not embedded, so another application may substitute one.',
  );

  const wrapper = el('div.annot-field');
  wrapper.append(
    field({ label: 'Font', input: family }),
    field({ label: 'Size (points)', input: size }),
    sizes,
    field({ label: 'Style', input: toggles }),
    field({ label: 'Alignment', input: align }),
    field({ label: 'Line spacing', input: spacing }),
    field({ label: 'Rotation', input: rotation }),
    note,
  );
  return [wrapper];
}

function iconField(service: AnnotationService, a: ModelAnnotation): HTMLElement {
  const select = el('select', { 'aria-label': 'Note icon' });
  const current = typeof a.extra['icon'] === 'string' ? a.extra['icon'] : 'Comment';
  for (const item of NOTE_ICONS) {
    const option = el('option', { value: item.name }, item.label);
    if (item.name === current) option.setAttribute('selected', '');
    select.append(option);
  }
  select.addEventListener('change', () => {
    void service.patchSelection({ extra: { ...a.extra, icon: select.value } }, 'Change icon');
  });
  const wrapper = el('div.annot-field');
  wrapper.append(field({ label: 'Icon', input: select }));
  return wrapper;
}

function contentsField(service: AnnotationService, a: ModelAnnotation): HTMLElement {
  const input = el('textarea', { rows: '4', 'aria-label': 'Note text' });
  input.value = a.contents ?? '';
  input.addEventListener('change', () => {
    void service.patch(a.id, { contents: input.value });
  });
  const wrapper = el('div.annot-field');
  wrapper.append(field({ label: 'Note', input }));
  return wrapper;
}

function subjectField(service: AnnotationService, a: ModelAnnotation): HTMLElement {
  const input = el('input', { type: 'text', value: a.subject ?? '' });
  input.addEventListener('change', () => {
    void service.patch(a.id, { subject: input.value === '' ? null : input.value });
  });
  const wrapper = el('div.annot-field');
  wrapper.append(field({ label: 'Subject', input }));
  return wrapper;
}

function lockField(service: AnnotationService, a: ModelAnnotation): HTMLElement {
  const input = el('input', { type: 'checkbox' });
  if (a.flags.locked) input.setAttribute('checked', '');
  input.addEventListener('change', () => {
    void service.patchSelection(
      { flags: { ...a.flags, locked: input.checked } },
      input.checked ? 'Lock annotation' : 'Unlock annotation',
    );
  });
  const wrapper = el('div.annot-field.annot-check');
  wrapper.append(field({ label: 'Locked (cannot be moved or resized)', input }));
  return wrapper;
}

function defaultsRow(
  service: AnnotationService,
  a: ModelAnnotation,
  refresh: () => void,
): HTMLElement {
  const tool = toolOf(a);
  const b = button('btn', { type: 'button' }, 'Set as default for this tool');
  b.addEventListener('click', () => {
    const style = styleOf(a.extra);
    void service
      .setDefaults(tool, {
        color: a.color ?? service.defaults(tool).color,
        fillColor: a.interiorColor,
        borderWidth: a.borderWidth ?? 1,
        borderStyle: a.extra['borderStyle'] === 'dashed' ? 'dashed' : 'solid',
        ...(a.family === 'note' && typeof a.extra['icon'] === 'string'
          ? { icon: a.extra['icon'] }
          : {}),
        ...(a.family === 'freeText'
          ? {
              fontFamily: style.family,
              fontSize: style.size,
              bold: style.bold,
              italic: style.italic,
              align: style.align,
              lineSpacing: style.lineSpacing,
            }
          : {}),
      })
      .then(refresh)
      .catch(() => undefined);
  });
  const wrapper = el('div.annot-field.annot-actions');
  wrapper.append(b);
  return wrapper;
}

function keepToolToggle(service: AnnotationService, refresh: () => void): HTMLElement {
  const input = el('input', { type: 'checkbox' });
  if (service.settings.keepToolSelected) input.setAttribute('checked', '');
  input.addEventListener('change', () => {
    void service
      .setSetting('keepToolSelected', input.checked)
      .then(refresh)
      .catch(() => undefined);
  });
  const wrapper = el('div.annot-field.annot-check');
  wrapper.append(field({ label: 'Keep the tool selected after using it', input }));
  return wrapper;
}

// ---- wording --------------------------------------------------------------------------------------

function describe(a: ModelAnnotation): string {
  switch (a.subtype) {
    case 'Highlight':
      return `Highlight (${colourName(a.color)})`;
    case 'Underline':
      return 'Underline';
    case 'Squiggly':
      return 'Squiggly underline';
    case 'StrikeOut':
      return 'Strikeout';
    case 'Text':
      return 'Note';
    case 'Caret':
      return a.extra['intent'] === 'Replace' ? 'Replacement mark' : 'Insertion mark';
    case 'FreeText': {
      const intent = intentOf(a.extra);
      return intent === 'FreeTextCallout'
        ? 'Callout'
        : intent === 'FreeTextTypewriter'
          ? 'Typewriter'
          : 'Text box';
    }
    default:
      return a.subtype;
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
