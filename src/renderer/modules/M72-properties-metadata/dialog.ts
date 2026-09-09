/**
 * The Document Properties dialog (M72) — six tabs, one opaque window.
 *
 * Foxit's File → Properties is the model for *what* is here: Description, Custom, Security,
 * Fonts, Initial View, Advanced. What it looks like and how it reads is ours, and shaped by the
 * operator's requirements rather than by any other product:
 *
 * - **Every status is a word.** "Embedded subset", "Not embedded", "Protected", "Yes"/"No" for
 *   tagged and fast web view. Icons go beside the words; nothing means anything by its colour.
 * - **The read-only facts read as a description list**, not a grid of boxes, because a box a
 *   reader cannot type into is a box that wastes their time finding out.
 * - **The tab strip is a real tablist**: arrow keys move and activate, Home and End jump, and
 *   the panel below is what Tab reaches next.
 * - **Nothing is transparent** and no colour is a literal, like every other dialog in the app.
 */

import { field, formGrid, type Dialogs } from '@app/dialog/Dialogs';
import { button, el, srOnly } from '@app/dom';
import { icon } from '@app/icons';
import { makeRoving } from '@app/focus';
import type { FontUsage } from '@engine/PdfEngine';
import type { ModelId } from '@core/Ids';
import { baseName, embeddingIcon, embeddingLabel, embeddingNote, fontTypeLabel } from './fonts';
import {
  customNameProblem,
  type CustomProperty,
  type DocumentProperties,
  type InitialViewSettings,
} from './properties';

/** One page of the document, as the "open to page" control needs it. */
export interface PageChoice {
  readonly id: ModelId;
  readonly label: string;
}

/** Everything the dialog shows that it cannot edit. */
export interface PropertiesFacts {
  readonly fileName: string;
  readonly path: string | null;
  /** Bytes on disk, or null for a document that has never been saved. */
  readonly fileSize: number | null;
  readonly pageCount: number;
  /** Displayed size of the first page, already formatted ("210 × 297 mm (A4)"). */
  readonly pageSize: string;
  readonly version: string;
  readonly created: string | null;
  readonly modified: string | null;
  readonly tagged: boolean;
  readonly linearized: boolean;
  readonly hasForm: boolean;
  readonly hasXfa: boolean;
  /** The raw XMP packet, shown read-only on the Advanced tab. */
  readonly xmp: string | null;
  readonly signatureCount: number;
}

export interface PropertiesDialogOptions {
  readonly properties: DocumentProperties;
  readonly view: InitialViewSettings;
  readonly facts: PropertiesFacts;
  readonly pages: ReadonlyArray<PageChoice>;
  /** Fonts, or null while they are still being read, or `'unavailable'` when the engine cannot. */
  readonly fonts: ReadonlyArray<FontUsage> | 'unavailable';
  /** The Security tab's content — M70's own panel when it is in the build. */
  readonly security: HTMLElement;
  /** Runs M70's Protect command; absent when that module is not there. */
  readonly onProtect?: (() => void) | undefined;
  /** Opens the signature panel, when there is one to open. */
  readonly onShowSignatures?: (() => void) | undefined;
  /** Which tab to open on. */
  readonly tab?: PropertiesTabId;
  /** True when the document may not be modified — every input is then read-only. */
  readonly readOnly?: boolean;
}

export type PropertiesTabId =
  'description' | 'custom' | 'security' | 'fonts' | 'initialView' | 'advanced';

export interface PropertiesDialogResult {
  readonly properties: DocumentProperties;
  readonly view: InitialViewSettings;
}

const TABS: ReadonlyArray<{ id: PropertiesTabId; label: string; icon: string }> = [
  { id: 'description', label: 'Description', icon: 'file-text' },
  { id: 'custom', label: 'Custom', icon: 'list' },
  { id: 'security', label: 'Security', icon: 'lock' },
  { id: 'fonts', label: 'Fonts', icon: 'type' },
  { id: 'initialView', label: 'Initial View', icon: 'eye' },
  { id: 'advanced', label: 'Advanced', icon: 'settings' },
];

/**
 * Opens the dialog. Resolves with the edited values when the reader pressed OK, or `null` when
 * they cancelled — the caller decides what is an actual change and what is not.
 */
export function openPropertiesDialog(
  dialogs: Dialogs,
  options: PropertiesDialogOptions,
): Promise<PropertiesDialogResult | null> {
  const readOnly = options.readOnly ?? false;
  const properties: {
    -readonly [K in keyof DocumentProperties]: DocumentProperties[K];
  } = { ...options.properties, custom: [...options.properties.custom] };
  const view: { -readonly [K in keyof InitialViewSettings]: InitialViewSettings[K] } = {
    ...options.view,
  };

  const panels = new Map<PropertiesTabId, HTMLElement>();

  const result = dialogs.open({
    id: 'properties-dialog',
    title: 'Document Properties',
    width: 720,
    className: 'properties-dialog',
    content: (body) => {
      const tablist = el('div.properties-tabs', {
        role: 'tablist',
        'aria-label': 'Document properties sections',
      });
      const host = el('div.properties-panels');
      body.append(tablist, host);

      const build = (id: PropertiesTabId): HTMLElement => {
        switch (id) {
          case 'description':
            return descriptionTab(properties, options.facts, readOnly);
          case 'custom':
            return customTab(properties, readOnly);
          case 'security':
            return securityTab(options);
          case 'fonts':
            return fontsTab(options.fonts);
          case 'initialView':
            return initialViewTab(view, options.pages, readOnly);
          case 'advanced':
            return advancedTab(properties, view, options.facts, readOnly);
        }
      };

      let active: PropertiesTabId = options.tab ?? 'description';
      const select = (id: PropertiesTabId): void => {
        active = id;
        for (const tab of TABS) {
          const button_ = tablist.querySelector<HTMLElement>(`[data-tab="${tab.id}"]`);
          button_?.setAttribute('aria-selected', tab.id === id ? 'true' : 'false');
          const panel = panels.get(tab.id);
          if (panel) panel.hidden = tab.id !== id;
        }
        if (!panels.has(id)) {
          const panel = build(id);
          panel.id = `properties-panel-${id}`;
          panel.setAttribute('role', 'tabpanel');
          panel.setAttribute('aria-labelledby', `properties-tab-${id}`);
          panel.tabIndex = 0;
          panels.set(id, panel);
          host.append(panel);
        }
        const panel = panels.get(id);
        if (panel) panel.hidden = false;
      };

      for (const tab of TABS) {
        const control = button('properties-tab', {
          role: 'tab',
          id: `properties-tab-${tab.id}`,
          'data-tab': tab.id,
          'aria-selected': 'false',
          'aria-controls': `properties-panel-${tab.id}`,
        });
        control.append(icon(tab.icon), el('span', null, tab.label));
        control.addEventListener('click', () => {
          select(tab.id);
        });
        tablist.append(control);
      }
      const roving = makeRoving(tablist, { selector: '[role="tab"]' });
      // Arrow keys activate as they move, which is the pattern the ribbon already uses.
      tablist.addEventListener('focusin', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;
        const id = target.dataset['tab'] as PropertiesTabId | undefined;
        if (id && id !== active) select(id);
      });
      select(active);
      roving.refresh();
    },
    buttons: readOnly
      ? [{ id: 'cancel', label: 'Close', primary: true }]
      : [
          { id: 'ok', label: 'OK', primary: true },
          { id: 'cancel', label: 'Cancel' },
        ],
  });

  return result.result.then((answer) => {
    if (answer !== 'ok') return null;
    return { properties: { ...properties }, view: { ...view } };
  });
}

// ---- shared pieces ------------------------------------------------------------------------------

/** A read-only fact: its name, then its value. A description list, because that is what it is. */
function facts(...rows: ReadonlyArray<readonly [string, string | HTMLElement]>): HTMLElement {
  const list = el('dl.properties-facts');
  for (const [name, value] of rows) {
    list.append(el('dt', null, name), el('dd', null, typeof value === 'string' ? value : value));
  }
  return list;
}

/** A word with an icon beside it. The word is the meaning; the icon is a second cue. */
function worded(word: string, iconName: string): HTMLElement {
  return el('span.properties-word', null, icon(iconName), el('span', null, word));
}

function yesNo(value: boolean): HTMLElement {
  return worded(value ? 'Yes' : 'No', value ? 'circle-check' : 'circle-slash');
}

function textInput(
  value: string,
  onInput: (value: string) => void,
  options: { readOnly?: boolean; multiline?: boolean } = {},
): HTMLElement {
  const input = options.multiline
    ? el('textarea', { rows: '3', spellcheck: 'false' })
    : el('input', { type: 'text', spellcheck: 'false' });
  input.value = value;
  if (options.readOnly) input.readOnly = true;
  input.addEventListener('input', () => {
    onInput(input.value);
  });
  return input;
}

function select<T extends string>(
  options: ReadonlyArray<readonly [T, string]>,
  value: T,
  onChange: (value: T) => void,
  readOnly: boolean,
): HTMLSelectElement {
  const control = el('select');
  for (const [v, label] of options) {
    const option = el('option', { value: v }, label);
    if (v === value) option.selected = true;
    control.append(option);
  }
  if (readOnly) control.disabled = true;
  control.addEventListener('change', () => {
    onChange(control.value as T);
  });
  return control;
}

function checkbox(
  label: string,
  checked: boolean,
  onChange: (value: boolean) => void,
  readOnly: boolean,
): HTMLElement {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.disabled = readOnly;
  input.id = `properties-check-${String(++seq)}`;
  input.addEventListener('change', () => {
    onChange(input.checked);
  });
  return el('div.properties-check', null, input, el('label', { for: input.id }, label));
}

let seq = 0;

/** A worded note. `kind` picks the icon; the word is always in the sentence. */
function note(kind: 'info' | 'caution', text: string): HTMLElement {
  return el(
    'p.properties-note',
    { 'data-kind': kind },
    el(
      'span.properties-note-icon',
      { 'aria-hidden': 'true' },
      icon(kind === 'info' ? 'info' : 'triangle-alert'),
    ),
    el('span', null, `${kind === 'info' ? 'Note' : 'Caution'}: ${text}`),
  );
}

// ---- Description --------------------------------------------------------------------------------

function descriptionTab(
  properties: { -readonly [K in keyof DocumentProperties]: DocumentProperties[K] },
  f: PropertiesFacts,
  readOnly: boolean,
): HTMLElement {
  const panel = el('div.properties-panel');
  panel.append(
    formGrid(
      field({
        label: 'Title',
        input: textInput(properties.title, (v) => (properties.title = v), { readOnly }),
      }),
      field({
        label: 'Author',
        input: textInput(properties.author, (v) => (properties.author = v), { readOnly }),
        hint: 'Several authors are separated with a semicolon.',
      }),
      field({
        label: 'Subject',
        input: textInput(properties.subject, (v) => (properties.subject = v), { readOnly }),
      }),
      field({
        label: 'Keywords',
        input: textInput(properties.keywords, (v) => (properties.keywords = v), {
          readOnly,
          multiline: true,
        }),
        hint: 'Separated with commas or semicolons.',
      }),
    ),
    el('h3.properties-heading', null, 'About this document'),
    facts(
      ['File', f.fileName],
      ...(f.path ? ([['Location', f.path]] as const) : []),
      ['Created', f.created ?? 'Not recorded'],
      ['Modified', f.modified ?? 'Not recorded'],
      ['Application', properties.creator === '' ? 'Not recorded' : properties.creator],
      ['PDF producer', properties.producer === '' ? 'Not recorded' : properties.producer],
      ['PDF version', f.version],
      ['Pages', String(f.pageCount)],
      ['Page size', f.pageSize],
      ['File size', f.fileSize === null ? 'Not saved yet' : formatBytes(f.fileSize)],
      ['Tagged PDF', yesNo(f.tagged)],
      ['Fast web view', yesNo(f.linearized)],
    ),
  );
  return panel;
}

/** File size in the units a reader thinks in, with the exact byte count beside it. */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? String(bytes) : value.toFixed(value < 10 ? 1 : 0);
  const exact = new Intl.NumberFormat('en-GB').format(bytes);
  return unit === 0 ? `${rounded} bytes` : `${rounded} ${units[unit] ?? ''} (${exact} bytes)`;
}

// ---- Custom -------------------------------------------------------------------------------------

function customTab(
  properties: { -readonly [K in keyof DocumentProperties]: DocumentProperties[K] },
  readOnly: boolean,
): HTMLElement {
  const panel = el('div.properties-panel');
  const list = el('div.properties-custom-list', { role: 'list' });
  const error = el('p.field-error', { role: 'alert' });
  error.hidden = true;

  const render = (): void => {
    list.replaceChildren();
    if (properties.custom.length === 0) {
      list.append(
        el(
          'p.properties-empty',
          { role: 'listitem' },
          'No custom properties. Add one to record something this document needs that the standard properties do not cover — a reference, a department, a review date.',
        ),
      );
    }
    properties.custom.forEach((property, index) => {
      const row = el('div.properties-custom-row', { role: 'listitem' });
      const name = el('input', {
        type: 'text',
        spellcheck: 'false',
        'aria-label': 'Property name',
      });
      name.value = property.name;
      name.readOnly = readOnly;
      const value = el('input', {
        type: 'text',
        spellcheck: 'false',
        'aria-label': 'Property value',
      });
      value.value = property.value;
      value.readOnly = readOnly;
      const update = (patch: Partial<CustomProperty>): void => {
        const next = [...properties.custom];
        const current = next[index];
        if (!current) return;
        next[index] = { ...current, ...patch };
        properties.custom = next;
        const problem = customNameProblem(next[index].name, next, index);
        error.textContent = problem ?? '';
        error.hidden = problem === null;
        name.setAttribute('aria-invalid', problem === null ? 'false' : 'true');
      };
      name.addEventListener('input', () => {
        update({ name: name.value });
      });
      value.addEventListener('input', () => {
        update({ value: value.value });
      });
      const remove = button('icon-btn', {
        'aria-label': `Remove the property "${property.name}"`,
        title: 'Remove this property',
      });
      remove.append(icon('trash-2'));
      remove.disabled = readOnly;
      remove.addEventListener('click', () => {
        properties.custom = properties.custom.filter((_p, i) => i !== index);
        error.hidden = true;
        render();
      });
      row.append(name, value, remove);
      list.append(row);
    });
  };

  const add = button('btn', {}, icon('plus'), el('span', null, 'Add a property'));
  add.disabled = readOnly;
  add.addEventListener('click', () => {
    properties.custom = [...properties.custom, { name: '', value: '' }];
    render();
    const inputs = list.querySelectorAll<HTMLInputElement>('input');
    inputs[inputs.length - 2]?.focus();
  });

  render();
  panel.append(
    el(
      'p.properties-lead',
      null,
      'Custom properties are stored in the document and travel with it. They are written to the information dictionary and mirrored in the XMP metadata, so other PDF applications can read them too.',
    ),
    el(
      'div.properties-custom-head',
      { 'aria-hidden': 'true' },
      el('span', null, 'Name'),
      el('span', null, 'Value'),
      el('span', null, ''),
    ),
    list,
    error,
    add,
  );
  return panel;
}

// ---- Security -----------------------------------------------------------------------------------

function securityTab(options: PropertiesDialogOptions): HTMLElement {
  const panel = el('div.properties-panel');
  panel.append(options.security);
  if (options.onProtect) {
    const change = button('btn', {}, icon('lock'), el('span', null, 'Change protection…'));
    change.addEventListener('click', () => {
      options.onProtect?.();
    });
    panel.append(change);
  }
  const count = options.facts.signatureCount;
  panel.append(
    el('h3.properties-heading', null, 'Signatures'),
    el(
      'p.properties-lead',
      null,
      count === 0
        ? 'This document is not signed.'
        : count === 1
          ? 'This document carries one signature.'
          : `This document carries ${String(count)} signatures.`,
    ),
  );
  if (count > 0 && options.onShowSignatures) {
    const show = button('btn', {}, icon('pen-line'), el('span', null, 'Show the signatures'));
    show.addEventListener('click', () => {
      options.onShowSignatures?.();
    });
    panel.append(show);
  }
  return panel;
}

// ---- Fonts --------------------------------------------------------------------------------------

function fontsTab(fonts: ReadonlyArray<FontUsage> | 'unavailable'): HTMLElement {
  const panel = el('div.properties-panel');
  if (fonts === 'unavailable') {
    panel.append(
      note('info', 'The PDF engine in this build cannot list the fonts a document uses.'),
    );
    return panel;
  }
  if (fonts.length === 0) {
    panel.append(el('p.properties-lead', null, 'This document does not use any fonts.'));
    return panel;
  }

  const table = el('table.properties-table');
  const head = el('thead');
  head.append(
    el(
      'tr',
      null,
      el('th', { scope: 'col' }, 'Font'),
      el('th', { scope: 'col' }, 'Type'),
      el('th', { scope: 'col' }, 'Encoding'),
      el('th', { scope: 'col' }, 'Embedding'),
      el('th', { scope: 'col' }, 'First used'),
    ),
  );
  const body = el('tbody');
  for (const font of fonts) {
    const name = el('td');
    name.append(el('span.properties-font-name', null, baseName(font)));
    if (font.subset) name.append(srOnly(' (subset)'));
    body.append(
      el(
        'tr',
        null,
        name,
        el('td', null, fontTypeLabel(font)),
        el('td', null, font.encoding ?? 'Not stated'),
        el('td', null, worded(embeddingLabel(font), embeddingIcon(font))),
        el('td', null, `Page ${String(font.firstPage + 1)}`),
      ),
    );
  }
  table.append(head, body);
  panel.append(el('div.properties-table-scroll', null, table));
  const message = embeddingNote(fonts);
  if (message) panel.append(note('info', message));
  return panel;
}

// ---- Initial view -------------------------------------------------------------------------------

const PAGE_MODES: ReadonlyArray<readonly [InitialViewSettings['pageMode'], string]> = [
  ['none', 'Page only'],
  ['outlines', 'Bookmarks panel and page'],
  ['thumbnails', 'Page thumbnails and page'],
  ['attachments', 'Attachments panel and page'],
  ['ocg', 'Layers panel and page'],
  ['fullscreen', 'Full screen'],
];

const PAGE_LAYOUTS: ReadonlyArray<readonly [InitialViewSettings['pageLayout'], string]> = [
  ['default', "The reader's own setting"],
  ['single', 'Single page'],
  ['one-column', 'Continuous'],
  ['two-column-left', 'Two pages, continuous'],
  ['two-column-right', 'Two pages, continuous, cover page alone'],
  ['two-page-left', 'Two pages'],
  ['two-page-right', 'Two pages, cover page alone'],
];

const FITS: ReadonlyArray<readonly [string, string]> = [
  ['none', "The reader's own setting"],
  ['fit', 'Fit page'],
  ['fitH', 'Fit width'],
  ['fitB', 'Fit visible'],
  ['xyz', 'A percentage'],
];

function initialViewTab(
  view: { -readonly [K in keyof InitialViewSettings]: InitialViewSettings[K] },
  pages: ReadonlyArray<PageChoice>,
  readOnly: boolean,
): HTMLElement {
  const panel = el('div.properties-panel');

  const zoomInput = el('input', {
    type: 'number',
    min: '10',
    max: '1600',
    step: '5',
    'aria-label': 'Magnification, percent',
  });
  zoomInput.value = String(Math.round((view.initialZoom ?? 1) * 100));
  zoomInput.disabled = readOnly || view.initialFit !== 'xyz';
  zoomInput.addEventListener('input', () => {
    const percent = Number(zoomInput.value);
    view.initialZoom = Number.isFinite(percent) && percent > 0 ? percent / 100 : null;
  });

  const fit = select(
    FITS,
    view.initialFit ?? 'none',
    (value) => {
      view.initialFit = value === 'none' ? null : (value as NonNullable<typeof view.initialFit>);
      zoomInput.disabled = readOnly || value !== 'xyz';
      if (value === 'xyz' && view.initialZoom === null) {
        view.initialZoom = 1;
        zoomInput.value = '100';
      }
    },
    readOnly,
  );

  const pageSelect = select(
    [['', 'The first page'] as const, ...pages.map((p) => [p.id, `Page ${p.label}`] as const)],
    view.initialPageId ?? '',
    (value) => {
      view.initialPageId = value === '' ? null : value;
    },
    readOnly,
  );

  panel.append(
    el('h3.properties-heading', null, 'Layout and magnification'),
    formGrid(
      field({
        label: 'Show on opening',
        input: select(
          PAGE_MODES,
          view.pageMode,
          (value) => {
            view.pageMode = value;
          },
          readOnly,
        ),
      }),
      field({
        label: 'Page layout',
        input: select(
          PAGE_LAYOUTS,
          view.pageLayout,
          (value) => {
            view.pageLayout = value;
          },
          readOnly,
        ),
      }),
      field({ label: 'Open at', input: pageSelect }),
      field({ label: 'Magnification', input: fit }),
      field({ label: 'Percentage', input: zoomInput }),
    ),
    el('h3.properties-heading', null, 'Window options'),
    checkbox(
      'Resize the window to fit the first page',
      view.fitWindow,
      (v) => (view.fitWindow = v),
      readOnly,
    ),
    checkbox(
      'Centre the window on the screen',
      view.centreWindow,
      (v) => (view.centreWindow = v),
      readOnly,
    ),
    checkbox(
      "Show the document's title instead of its file name",
      view.displayDocTitle,
      (v) => (view.displayDocTitle = v),
      readOnly,
    ),
    note(
      'info',
      'ynotPDF stores all of these and writes them to the file, and other readers will obey them. It does not resize or centre its own window for one document, because a window with several tabs in it belongs to all of them. Which navigation panel opens is your own setting, under View — a document cannot take that over.',
    ),
    el('h3.properties-heading', null, 'Interface options'),
    checkbox('Hide the toolbar', view.hideToolbar, (v) => (view.hideToolbar = v), readOnly),
    checkbox('Hide the menu bar', view.hideMenubar, (v) => (view.hideMenubar = v), readOnly),
    checkbox(
      'Hide the window furniture (panels, scroll bars, status bar)',
      view.hideWindowUi,
      (v) => (view.hideWindowUi = v),
      readOnly,
    ),
  );
  return panel;
}

// ---- Advanced -----------------------------------------------------------------------------------

const TRAPPED: ReadonlyArray<readonly [string, string]> = [
  ['', 'Not stated'],
  ['True', 'Yes — the document has been trapped'],
  ['False', 'No — the document has not been trapped'],
  ['Unknown', 'Unknown'],
];

const SCALING: ReadonlyArray<readonly [InitialViewSettings['printScaling'], string]> = [
  ['app-default', "The reader's own setting"],
  ['none', 'None — print at 100 %'],
];

const DIRECTION: ReadonlyArray<readonly [InitialViewSettings['direction'], string]> = [
  ['l2r', 'Left to right'],
  ['r2l', 'Right to left'],
];

function advancedTab(
  properties: { -readonly [K in keyof DocumentProperties]: DocumentProperties[K] },
  view: { -readonly [K in keyof InitialViewSettings]: InitialViewSettings[K] },
  f: PropertiesFacts,
  readOnly: boolean,
): HTMLElement {
  const panel = el('div.properties-panel');
  const xmp = el('textarea.properties-xmp', {
    rows: '10',
    spellcheck: 'false',
    readonly: 'readonly',
    'aria-label': 'XMP metadata',
  });
  xmp.value = f.xmp ?? 'This document has no XMP metadata packet.';

  panel.append(
    formGrid(
      field({
        label: 'Base URL',
        input: textInput(properties.baseUrl, (v) => (properties.baseUrl = v), { readOnly }),
        hint: 'Relative links in the document are resolved against this address.',
      }),
      field({
        label: 'Language',
        input: textInput(properties.lang, (v) => (properties.lang = v), { readOnly }),
        hint: 'A language tag such as en-GB. Screen readers use it to choose a voice.',
      }),
      field({
        label: 'Trapped',
        input: select(
          TRAPPED,
          properties.trapped ?? '',
          (value) => {
            properties.trapped = value === '' ? null : (value as 'True' | 'False' | 'Unknown');
          },
          readOnly,
        ),
        hint: 'Whether the document has been prepared for press with trapping applied.',
      }),
    ),
    el('h3.properties-heading', null, 'Reading and printing'),
    printingControls(view, readOnly),
    facts(
      ['Contains a form', yesNo(f.hasForm)],
      ...(f.hasXfa
        ? ([['XFA form', worded('Yes — shown as its AcroForm', 'triangle-alert')]] as const)
        : []),
    ),
    el('h3.properties-heading', null, 'XMP metadata'),
    el(
      'p.properties-lead',
      null,
      'The packet as it is stored in the file. ynotPDF keeps it in step with the properties above; editing it directly is not offered.',
    ),
    xmp,
  );
  return panel;
}

/** The print-scaling and reading-direction controls, mounted on the Advanced tab. */
function printingControls(
  view: { -readonly [K in keyof InitialViewSettings]: InitialViewSettings[K] },
  readOnly: boolean,
): HTMLElement {
  return formGrid(
    field({
      label: 'Print scaling',
      input: select(
        SCALING,
        view.printScaling,
        (value) => {
          view.printScaling = value;
        },
        readOnly,
      ),
    }),
    field({
      label: 'Reading direction',
      input: select(
        DIRECTION,
        view.direction,
        (value) => {
          view.direction = value;
        },
        readOnly,
      ),
      hint: 'Which way the interface reads, not the text.',
    }),
  );
}
