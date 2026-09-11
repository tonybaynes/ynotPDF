/**
 * The four decoration dialogs (M53): header and footer, Bates numbering, watermark, background.
 *
 * Each is a settings column handed to {@link openDecorationDialog}, which supplies the preview,
 * the page range, the presets and the buttons. Nothing here draws anything: it collects a spec.
 */

import { field } from '@app/dialog/Dialogs';
import type { ShellServices } from '@app/services';
import { el } from '@app/dom';
import type { Document } from '@core/Document';
import { MACROS } from '@engine/decorations/macros';
import {
  DECORATION_FONTS,
  DEFAULT_MARGINS,
  POSITIONS,
  ZONES,
  type BatesSpec,
  type HeaderFooterSpec,
  type Margins,
  type PositionName,
  type WatermarkSpec,
  type ZoneName,
} from '@engine/decorations/types';
import {
  checkbox,
  lengthField,
  select,
  type LengthField,
} from '@modules/M41-merge-split-crop/fields';
import type { Unit } from '@view/units';
import { openDecorationDialog, type DecorationDialogResult } from './decorationDialog';

export interface DialogDeps {
  readonly shell: ShellServices;
  readonly document: Document;
  readonly units: Unit;
  readonly presets: string;
  savePresets(json: string): Promise<void>;
}

const FONT_CHOICES = DECORATION_FONTS.map((value) => ({ value, label: fontLabel(value) }));

function fontLabel(name: string): string {
  const [family = name, style] = name.split('-');
  const words: Record<string, string> = {
    Bold: 'bold',
    Oblique: 'italic',
    Italic: 'italic',
    BoldOblique: 'bold italic',
    BoldItalic: 'bold italic',
    Roman: 'regular',
  };
  return style ? `${family} ${words[style] ?? style.toLowerCase()}` : `${family} regular`;
}

/** A colour input plus its hex box. PDF content colour, so a literal is right here, not a token. */
function colourField(options: {
  readonly label: string;
  readonly value: number;
  readonly hint?: string;
  readonly onChange: (colour: number) => void;
}): { element: HTMLElement; set(colour: number): void } {
  const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
  const swatch = el('input.decoration-colour', { type: 'color', value: hex(options.value) });
  const text = el('input.input.decoration-colour-hex', {
    type: 'text',
    value: hex(options.value),
    spellcheck: 'false',
    'aria-label': `${options.label}, as a hex value`,
  });
  const push = (value: string): void => {
    const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
    if (!match?.[1]) return;
    const colour = parseInt(match[1], 16);
    swatch.value = hex(colour);
    text.value = hex(colour);
    options.onChange(colour);
  };
  swatch.addEventListener('input', () => {
    push(swatch.value);
  });
  text.addEventListener('change', () => {
    push(text.value);
  });
  const row = el('div.decoration-colour-row', null, swatch, text);
  return {
    element: field({
      label: options.label,
      input: row,
      ...(options.hint === undefined ? {} : { hint: options.hint }),
    }),
    set: (colour) => {
      swatch.value = hex(colour);
      text.value = hex(colour);
    },
  };
}

/** The four margin boxes, in the reader's own unit. */
function marginFields(
  margins: Margins,
  units: Unit,
  onChange: () => void,
): { element: HTMLElement; read(): Margins; set(m: Margins): void } {
  const make = (label: string, points: number): LengthField => {
    const f = lengthField({ label, points, unit: units, min: 0 });
    f.onChange(onChange);
    return f;
  };
  const left = make('Left', margins.left);
  const right = make('Right', margins.right);
  const top = make('Top', margins.top);
  const bottom = make('Bottom', margins.bottom);
  const grid = el('div.decoration-margins');
  grid.append(
    el('h4.decoration-subheading', null, 'Margins'),
    el('div.decoration-grid', null, left.element, right.element, top.element, bottom.element),
  );
  return {
    element: grid,
    read: () => ({
      left: left.points(),
      right: right.points(),
      top: top.points(),
      bottom: bottom.points(),
    }),
    set: (m) => {
      left.set(m.left);
      right.set(m.right);
      top.set(m.top);
      bottom.set(m.bottom);
    },
  };
}

const ZONE_LABELS: Readonly<Record<ZoneName, string>> = {
  'header-left': 'Header, left',
  'header-centre': 'Header, centre',
  'header-right': 'Header, right',
  'footer-left': 'Footer, left',
  'footer-centre': 'Footer, centre',
  'footer-right': 'Footer, right',
};

/** The macro menu: a button per macro, inserting its token at the caret of the last-used zone. */
function macroBar(target: () => HTMLInputElement | null, onInsert: () => void): HTMLElement {
  const bar = el('div.decoration-macros', { 'data-testid': 'macro-bar' });
  bar.append(el('span.decoration-macros-label', null, 'Insert:'));
  for (const macro of MACROS) {
    const button = el(
      'button.btn.btn-small.decoration-macro',
      { type: 'button', title: `${macro.description} For example: ${macro.example}` },
      macro.label,
    );
    button.addEventListener('click', () => {
      const input = target();
      if (!input) return;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.value = `${input.value.slice(0, start)}${macro.token}${input.value.slice(end)}`;
      const caret = start + macro.token.length;
      input.setSelectionRange(caret, caret);
      input.focus();
      onInsert();
    });
    bar.append(button);
  }
  return bar;
}

// ---- header and footer ------------------------------------------------------------------------

export async function openHeaderFooterDialog(
  deps: DialogDeps,
  options: { readonly spec: HeaderFooterSpec; readonly range: string; readonly existing: boolean },
): Promise<DecorationDialogResult<HeaderFooterSpec>> {
  const zoneInputs = new Map<ZoneName, HTMLInputElement>();
  let lastFocused: HTMLInputElement | null = null;
  let font = options.spec.font;
  let size = options.spec.size;
  let colour = options.spec.colour;
  let underline = options.spec.underline;
  let shrink = options.spec.shrink;
  let startNumber = options.spec.startNumber;
  let margins: { read(): Margins; set(m: Margins): void } | null = null;
  let setFont = (_v: string): void => undefined;
  let setSize = (_v: number): void => undefined;
  let setColour = (_v: number): void => undefined;
  let setUnderline = (_v: boolean): void => undefined;
  let setShrink = (_v: boolean): void => undefined;
  let setStart = (_v: number): void => undefined;

  return await openDecorationDialog<HeaderFooterSpec>({
    shell: deps.shell,
    document: deps.document,
    kind: 'header-footer',
    id: 'header-footer-dialog',
    title: 'Header and footer',
    spec: options.spec,
    range: options.range,
    existing: options.existing,
    units: deps.units,
    presets: deps.presets,
    savePresets: (json) => deps.savePresets(json),
    build: ({ body, changed, units }) => {
      const zones = el('div.decoration-zones');
      zones.append(el('h4.decoration-subheading', null, 'What goes where'));
      const grid = el('div.decoration-grid');
      for (const zone of ZONES) {
        const input = el('input.input', {
          type: 'text',
          value: options.spec.zones[zone] ?? '',
          spellcheck: 'false',
          'data-zone': zone,
        });
        input.addEventListener('input', changed);
        input.addEventListener('focus', () => {
          lastFocused = input;
        });
        zoneInputs.set(zone, input);
        grid.append(field({ label: ZONE_LABELS[zone], input }));
      }
      zones.append(
        grid,
        macroBar(() => lastFocused ?? zoneInputs.get('footer-centre') ?? null, changed),
      );
      body.append(zones);

      const fontSelect = select({
        label: 'Font',
        value: font,
        choices: FONT_CHOICES,
        onChange: (value) => {
          font = value;
          changed();
        },
      });
      setFont = (value) => {
        fontSelect.input.value = value;
      };
      const sizeInput = el('input.input', {
        type: 'number',
        min: '4',
        max: '96',
        step: '0.5',
        value: String(size),
      });
      sizeInput.addEventListener('input', () => {
        const typed = Number(sizeInput.value);
        if (Number.isFinite(typed) && typed > 0) size = typed;
        changed();
      });
      setSize = (value) => {
        sizeInput.value = String(value);
      };
      const colourInput = colourField({
        label: 'Colour',
        value: colour,
        hint: 'The colour of the text on the page — this is the document, not the interface.',
        onChange: (value) => {
          colour = value;
          changed();
        },
      });
      setColour = (value) => {
        colourInput.set(value);
      };
      body.append(
        el(
          'div.decoration-grid',
          null,
          fontSelect.element,
          field({ label: 'Size (points)', input: sizeInput }),
          colourInput.element,
        ),
      );

      const marginBlock = marginFields(options.spec.margins, units, changed);
      margins = marginBlock;
      body.append(marginBlock.element);

      const startInput = el('input.input', {
        type: 'number',
        min: '0',
        step: '1',
        value: String(startNumber),
      });
      startInput.addEventListener('input', () => {
        const typed = Number(startInput.value);
        if (Number.isFinite(typed)) startNumber = Math.round(typed);
        changed();
      });
      setStart = (value) => {
        startInput.value = String(value);
      };
      const underlineBox = checkbox({
        label: 'Rule under the header and over the footer',
        checked: underline,
        onChange: (value) => {
          underline = value;
          changed();
        },
      });
      setUnderline = (value) => {
        underlineBox.input.checked = value;
      };
      const shrinkBox = checkbox({
        label: 'Shrink the page contents to make room',
        checked: shrink > 0,
        hint: 'The page keeps its size; what is printed on it is scaled to 92 % and centred.',
        onChange: (value) => {
          shrink = value ? 0.92 : 0;
          changed();
        },
      });
      setShrink = (value) => {
        shrinkBox.input.checked = value;
      };
      body.append(
        el(
          'div.decoration-grid',
          null,
          field({
            label: 'Start numbering at',
            input: startInput,
            hint: 'What <<1>> means on the first page of the range.',
          }),
        ),
        underlineBox.element,
        shrinkBox.element,
      );
    },
    read: () => {
      const zones: Partial<Record<ZoneName, string>> = {};
      for (const [zone, input] of zoneInputs) {
        if (input.value !== '') zones[zone] = input.value;
      }
      return {
        kind: 'header-footer',
        zones,
        font,
        size,
        colour,
        margins: margins?.read() ?? DEFAULT_MARGINS,
        underline,
        shrink,
        startNumber,
        totalOverride: options.spec.totalOverride,
      };
    },
    applyPreset: (spec) => {
      for (const [zone, input] of zoneInputs) input.value = spec.zones[zone] ?? '';
      font = spec.font;
      size = spec.size;
      colour = spec.colour;
      underline = spec.underline;
      shrink = spec.shrink;
      startNumber = spec.startNumber;
      setFont(font);
      setSize(size);
      setColour(colour);
      setUnderline(underline);
      setShrink(shrink > 0);
      setStart(startNumber);
      margins?.set(spec.margins);
    },
  });
}

// ---- Bates ---------------------------------------------------------------------------------------

export async function openBatesDialog(
  deps: DialogDeps,
  options: { readonly spec: BatesSpec; readonly range: string; readonly existing: boolean },
): Promise<DecorationDialogResult<BatesSpec>> {
  let prefix = options.spec.prefix;
  let suffix = options.spec.suffix;
  let digits = options.spec.digits;
  let startAt = options.spec.startAt;
  let zone = options.spec.zone;
  let font = options.spec.font;
  let size = options.spec.size;
  let colour = options.spec.colour;
  let margins: { read(): Margins; set(m: Margins): void } | null = null;
  const sample = el('p.decoration-sample', { role: 'status' });
  const setters: Array<(spec: BatesSpec) => void> = [];

  const paintSample = (): void => {
    sample.textContent = `First page: ${prefix}${String(startAt).padStart(digits, '0')}${suffix}`;
  };

  return await openDecorationDialog<BatesSpec>({
    shell: deps.shell,
    document: deps.document,
    kind: 'bates',
    id: 'bates-dialog',
    title: 'Bates numbering',
    spec: options.spec,
    range: options.range,
    existing: options.existing,
    units: deps.units,
    presets: deps.presets,
    savePresets: (json) => deps.savePresets(json),
    build: ({ body, changed, units }) => {
      const grid = el('div.decoration-grid');
      body.append(grid);
      const prefixInput = el('input.input', {
        type: 'text',
        value: prefix,
        spellcheck: 'false',
        'data-testid': 'bates-prefix',
      });
      prefixInput.addEventListener('input', () => {
        prefix = prefixInput.value;
        paintSample();
        changed();
      });
      const suffixInput = el('input.input', { type: 'text', value: suffix, spellcheck: 'false' });
      suffixInput.addEventListener('input', () => {
        suffix = suffixInput.value;
        paintSample();
        changed();
      });
      const digitsInput = el('input.input', {
        type: 'number',
        min: '1',
        max: '15',
        step: '1',
        value: String(digits),
        'data-testid': 'bates-digits',
      });
      digitsInput.addEventListener('input', () => {
        const typed = Number(digitsInput.value);
        if (Number.isFinite(typed)) digits = Math.max(1, Math.min(15, Math.round(typed)));
        paintSample();
        changed();
      });
      const startInput = el('input.input', {
        type: 'number',
        min: '0',
        step: '1',
        value: String(startAt),
        'data-testid': 'bates-start',
      });
      startInput.addEventListener('input', () => {
        const typed = Number(startInput.value);
        if (Number.isFinite(typed)) startAt = Math.max(0, Math.round(typed));
        paintSample();
        changed();
      });
      grid.append(
        field({ label: 'Prefix', input: prefixInput }),
        field({ label: 'Suffix', input: suffixInput }),
        field({ label: 'Digits', input: digitsInput, hint: 'How many, padded with zeros.' }),
        field({ label: 'Start at', input: startInput }),
      );
      body.append(sample);
      paintSample();

      const zoneSelect = select<ZoneName>({
        label: 'Where',
        value: zone,
        choices: ZONES.map((value) => ({ value, label: ZONE_LABELS[value] })),
        onChange: (value) => {
          zone = value;
          changed();
        },
      });
      const fontSelect = select({
        label: 'Font',
        value: font,
        choices: FONT_CHOICES,
        onChange: (value) => {
          font = value;
          changed();
        },
      });
      const sizeInput = el('input.input', {
        type: 'number',
        min: '4',
        max: '96',
        step: '0.5',
        value: String(size),
      });
      sizeInput.addEventListener('input', () => {
        const typed = Number(sizeInput.value);
        if (Number.isFinite(typed) && typed > 0) size = typed;
        changed();
      });
      const colourInput = colourField({
        label: 'Colour',
        value: colour,
        onChange: (value) => {
          colour = value;
          changed();
        },
      });
      body.append(
        el(
          'div.decoration-grid',
          null,
          zoneSelect.element,
          fontSelect.element,
          field({ label: 'Size (points)', input: sizeInput }),
          colourInput.element,
        ),
      );
      const marginBlock = marginFields(options.spec.margins, units, changed);
      margins = marginBlock;
      body.append(marginBlock.element);

      setters.push((spec) => {
        prefixInput.value = spec.prefix;
        suffixInput.value = spec.suffix;
        digitsInput.value = String(spec.digits);
        startInput.value = String(spec.startAt);
        zoneSelect.input.value = spec.zone;
        fontSelect.input.value = spec.font;
        sizeInput.value = String(spec.size);
        colourInput.set(spec.colour);
        marginBlock.set(spec.margins);
      });
    },
    read: () => ({
      kind: 'bates',
      prefix,
      suffix,
      digits,
      startAt,
      zone,
      font,
      size,
      colour,
      margins: margins?.read() ?? DEFAULT_MARGINS,
    }),
    applyPreset: (spec) => {
      prefix = spec.prefix;
      suffix = spec.suffix;
      digits = spec.digits;
      startAt = spec.startAt;
      zone = spec.zone;
      font = spec.font;
      size = spec.size;
      colour = spec.colour;
      for (const set of setters) set(spec);
      paintSample();
    },
  });
}

// ---- watermark and background --------------------------------------------------------------------

const POSITION_LABELS: Readonly<Record<PositionName, string>> = {
  'top-left': 'Top left',
  'top-centre': 'Top centre',
  'top-right': 'Top right',
  'middle-left': 'Middle left',
  centre: 'Centre',
  'middle-right': 'Middle right',
  'bottom-left': 'Bottom left',
  'bottom-centre': 'Bottom centre',
  'bottom-right': 'Bottom right',
};

export interface WatermarkDialogDeps extends DialogDeps {
  /** Asks for a picture or a PDF and returns the key it was stored under, or null. */
  chooseFile(kind: 'image' | 'pdf'): Promise<{ key: string } | null>;
}

export async function openWatermarkDialog(
  deps: WatermarkDialogDeps,
  options: {
    readonly spec: WatermarkSpec;
    readonly range: string;
    readonly existing: boolean;
    readonly background: boolean;
  },
): Promise<DecorationDialogResult<WatermarkSpec>> {
  let spec = options.spec;
  const set = (patch: Partial<WatermarkSpec>): void => {
    spec = { ...spec, ...patch };
  };
  const setters: Array<(s: WatermarkSpec) => void> = [];

  return await openDecorationDialog<WatermarkSpec>({
    shell: deps.shell,
    document: deps.document,
    kind: options.background ? 'background' : 'watermark',
    id: options.background ? 'background-dialog' : 'watermark-dialog',
    title: options.background ? 'Background' : 'Watermark',
    spec: options.spec,
    range: options.range,
    existing: options.existing,
    units: deps.units,
    presets: deps.presets,
    savePresets: (json) => deps.savePresets(json),
    build: ({ body, changed, units }) => {
      // ---- what it is made of
      const textInput = el('input.input', {
        type: 'text',
        value: spec.source.kind === 'text' ? spec.source.text : '',
        spellcheck: 'false',
        'data-testid': 'watermark-text',
      });
      const fileLabel = el('span.decoration-file', null, 'No file chosen');
      const chooseImage = el('button.btn', { type: 'button' }, 'Choose a picture…');
      const choosePdf = el('button.btn', { type: 'button' }, 'Choose a PDF…');

      const kindChoices: Array<{ value: string; label: string }> = [
        { value: 'text', label: 'Text' },
        { value: 'image', label: 'A picture' },
        { value: 'pdf', label: 'A page of a PDF' },
      ];
      if (options.background) kindChoices.unshift({ value: 'colour', label: 'A flat colour' });

      const sourceSelect = select({
        label: options.background ? 'Background' : 'Watermark',
        value: spec.source.kind,
        choices: kindChoices,
        onChange: (value) => {
          if (value === 'text') set({ source: { kind: 'text', text: textInput.value } });
          else if (value === 'colour') set({ source: { kind: 'colour' } });
          else {
            const current = spec.source;
            const key = current.kind === 'image' || current.kind === 'pdf' ? current.key : '';
            set({ source: { kind: value as 'image' | 'pdf', key } });
          }
          paintSource();
          changed();
        },
      });

      const sourceRow = el('div.decoration-source');
      sourceRow.append(
        field({ label: 'Text', input: textInput }),
        el('div.decoration-file-row', null, chooseImage, choosePdf, fileLabel),
      );
      const paintSource = (): void => {
        const kind = spec.source.kind;
        sourceRow.querySelector('.field')?.classList.toggle('is-hidden', kind !== 'text');
        const fileRow = sourceRow.querySelector('.decoration-file-row');
        if (fileRow instanceof HTMLElement) fileRow.hidden = kind !== 'image' && kind !== 'pdf';
        fileLabel.textContent =
          (spec.source.kind === 'image' || spec.source.kind === 'pdf') && spec.source.key !== ''
            ? 'A file is chosen'
            : 'No file chosen';
      };
      textInput.addEventListener('input', () => {
        if (spec.source.kind === 'text') set({ source: { kind: 'text', text: textInput.value } });
        changed();
      });
      const pick = (kind: 'image' | 'pdf'): void => {
        void (async () => {
          const chosen = await deps.chooseFile(kind);
          if (!chosen) return;
          set({ source: { kind, key: chosen.key } });
          sourceSelect.input.value = kind;
          paintSource();
          changed();
        })();
      };
      chooseImage.addEventListener('click', () => {
        pick('image');
      });
      choosePdf.addEventListener('click', () => {
        pick('pdf');
      });
      body.append(sourceSelect.element, sourceRow);
      paintSource();

      // ---- how it looks
      const fontSelect = select({
        label: 'Font',
        value: spec.font,
        choices: FONT_CHOICES,
        onChange: (value) => {
          set({ font: value });
          changed();
        },
      });
      const sizeInput = el('input.input', {
        type: 'number',
        min: '4',
        max: '400',
        step: '1',
        value: String(spec.size),
      });
      sizeInput.addEventListener('input', () => {
        const typed = Number(sizeInput.value);
        if (Number.isFinite(typed) && typed > 0) set({ size: typed });
        changed();
      });
      const colourInput = colourField({
        label: 'Colour',
        value: spec.colour,
        hint: 'Solid — there is no transparency anywhere in this application.',
        onChange: (value) => {
          set({ colour: value });
          changed();
        },
      });
      body.append(
        el(
          'div.decoration-grid',
          null,
          fontSelect.element,
          field({ label: 'Size (points)', input: sizeInput }),
          colourInput.element,
        ),
      );

      // ---- where it goes
      const positionSelect = select<PositionName>({
        label: 'Position',
        value: spec.position,
        choices: POSITIONS.map((value) => ({ value, label: POSITION_LABELS[value] })),
        onChange: (value) => {
          set({ position: value });
          changed();
        },
      });
      const rotationInput = el('input.input', {
        type: 'number',
        min: '-180',
        max: '180',
        step: '1',
        value: String(spec.rotation),
      });
      rotationInput.addEventListener('input', () => {
        const typed = Number(rotationInput.value);
        if (Number.isFinite(typed)) set({ rotation: typed });
        changed();
      });
      const scaleInput = el('input.input', {
        type: 'number',
        min: '0',
        max: '400',
        step: '5',
        value: String(Math.round(spec.scale * 100)),
      });
      scaleInput.addEventListener('input', () => {
        const typed = Number(scaleInput.value);
        if (Number.isFinite(typed)) set({ scale: Math.max(0, typed) / 100 });
        changed();
      });
      const offsetX = lengthField({ label: 'Move across', points: spec.offsetX, unit: units });
      offsetX.onChange((points) => {
        set({ offsetX: points });
        changed();
      });
      const offsetY = lengthField({ label: 'Move up', points: spec.offsetY, unit: units });
      offsetY.onChange((points) => {
        set({ offsetY: points });
        changed();
      });
      body.append(
        el(
          'div.decoration-grid',
          null,
          positionSelect.element,
          field({ label: 'Turn (degrees)', input: rotationInput }),
          field({
            label: 'Size (% of page width)',
            input: scaleInput,
            hint: '0 keeps whatever size it naturally has.',
          }),
          offsetX.element,
          offsetY.element,
        ),
      );

      const behindBox = checkbox({
        label: options.background ? 'Behind the page contents' : 'Behind the page contents',
        checked: spec.behind,
        hint: 'Off puts it over the text instead.',
        onChange: (value) => {
          set({ behind: value });
          changed();
        },
      });
      const printBox = checkbox({
        label: 'Appears when the document is printed',
        checked: spec.print,
        onChange: (value) => {
          set({ print: value });
          changed();
        },
      });
      const screenBox = checkbox({
        label: 'Appears on screen',
        checked: spec.screen,
        onChange: (value) => {
          set({ screen: value });
          changed();
        },
      });
      body.append(behindBox.element, printBox.element, screenBox.element);

      setters.push((s) => {
        sourceSelect.input.value = s.source.kind;
        if (s.source.kind === 'text') textInput.value = s.source.text;
        fontSelect.input.value = s.font;
        sizeInput.value = String(s.size);
        colourInput.set(s.colour);
        positionSelect.input.value = s.position;
        rotationInput.value = String(s.rotation);
        scaleInput.value = String(Math.round(s.scale * 100));
        offsetX.set(s.offsetX);
        offsetY.set(s.offsetY);
        behindBox.input.checked = s.behind;
        printBox.input.checked = s.print;
        screenBox.input.checked = s.screen;
        paintSource();
      });
    },
    read: () => spec,
    applyPreset: (preset) => {
      spec = { ...preset, kind: options.background ? 'background' : 'watermark' };
      for (const apply of setters) apply(spec);
    },
  });
}
