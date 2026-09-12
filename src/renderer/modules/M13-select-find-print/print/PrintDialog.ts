/**
 * The print dialog (M13) — ours, not the OS's, because Foxit's option set (subsets, booklets,
 * n-up, tiling, scaling, page setup, a live preview) is not something a platform print dialog
 * offers. It is a normal modal from M02's `Dialogs`, so it is opaque, keyboard-reachable and
 * themed by the same tokens as everything else.
 *
 * Every control writes straight into a working copy of `PrintSettings` and asks for a fresh
 * plan; the summary line and the preview are functions of that plan, so what the reader sees is
 * what the imposition will do.
 */

import { field, formGrid, type DialogHandle, type Dialogs } from '@app/dialog/Dialogs';
import { button, el } from '@app/dom';
import { icon } from '@app/icons';
import type { PrinterInfo } from '@shared/ipc';
import type { PrintSettings } from '../settings';
import type { NUpOrder, ScalingMode, Sheet } from './imposition';
import { describePlan, type PrintPlan } from './plan';
import { PAPER_SIZES } from './paper';

export type PrintAction = 'print' | 'pdf';

export interface PrintDialogResult {
  readonly action: PrintAction;
  readonly settings: PrintSettings;
}

export interface PrintDialogOptions {
  readonly dialogs: Dialogs;
  readonly settings: PrintSettings;
  readonly printers: ReadonlyArray<PrinterInfo>;
  readonly pageCount: number;
  readonly hasSelection: boolean;
  /** Rebuilds the plan for the settings as they now stand. */
  readonly plan: (settings: PrintSettings) => PrintPlan;
  /** Renders one sheet for the preview; the dialog revokes the URL when it is done with it. */
  readonly preview: (sheet: Sheet, settings: PrintSettings) => Promise<string>;
}

type Mode = PrintSettings['mode'];

const MODES: ReadonlyArray<{ value: Mode; label: string }> = [
  { value: 'single', label: 'One page per sheet' },
  { value: 'nup', label: 'Multiple pages per sheet' },
  { value: 'booklet', label: 'Booklet' },
  { value: 'tile', label: 'Tile large pages' },
];

const SCALINGS: ReadonlyArray<{ value: ScalingMode; label: string }> = [
  { value: 'shrink', label: 'Shrink oversized pages' },
  { value: 'fit', label: 'Fit to printable area' },
  { value: 'actual', label: 'Actual size' },
  { value: 'fill', label: 'Fill the sheet' },
  { value: 'custom', label: 'Custom scale' },
];

const ORDERS: ReadonlyArray<{ value: NUpOrder; label: string }> = [
  { value: 'horizontal', label: 'Across, then down' },
  { value: 'horizontalReverse', label: 'Across reversed, then down' },
  { value: 'vertical', label: 'Down, then across' },
  { value: 'verticalReverse', label: 'Down, then across reversed' },
];

function select(
  label: string,
  options: ReadonlyArray<{ value: string; label: string }>,
  value: string,
  onChange: (value: string) => void,
): { element: HTMLElement; input: HTMLSelectElement } {
  const input = el('select');
  for (const option of options) {
    const node = el('option', { value: option.value }, option.label);
    input.append(node);
  }
  input.value = value;
  input.addEventListener('change', () => {
    onChange(input.value);
  });
  return { element: field({ label, input }), input };
}

function number(
  label: string,
  value: number,
  onChange: (value: number) => void,
  bounds: { min?: number; max?: number; step?: number } = {},
): { element: HTMLElement; input: HTMLInputElement } {
  const input = el('input', {
    type: 'number',
    value: String(value),
    ...(bounds.min !== undefined ? { min: bounds.min } : {}),
    ...(bounds.max !== undefined ? { max: bounds.max } : {}),
    ...(bounds.step !== undefined ? { step: bounds.step } : {}),
  });
  input.addEventListener('change', () => {
    onChange(Number(input.value));
  });
  return { element: field({ label, input }), input };
}

function check(label: string, value: boolean, onChange: (value: boolean) => void): HTMLElement {
  const input = el('input', { type: 'checkbox' });
  input.checked = value;
  input.addEventListener('change', () => {
    onChange(input.checked);
  });
  return el('label.print-check', null, input, el('span', null, label));
}

/** Opens the dialog. Resolves with the chosen action, or `null` when it was cancelled. */
export async function openPrintDialog(
  options: PrintDialogOptions,
): Promise<PrintDialogResult | null> {
  let settings: PrintSettings = { ...options.settings };
  let action: PrintAction = 'print';
  let plan = options.plan(settings);
  let sheetIndex = 0;
  let previewUrl: string | null = null;
  let previewToken = 0;

  const summary = el('p.print-summary', { role: 'status' });
  const previewImage = el('img.print-preview-image', { alt: 'Print preview' });
  const previewLabel = el('span.print-preview-label', { 'aria-live': 'polite' });
  const previousSheet = button(
    'icon-btn',
    { 'aria-label': 'Previous sheet', title: 'Previous sheet' },
    icon('chevron-left'),
  );
  const nextSheet = button(
    'icon-btn',
    { 'aria-label': 'Next sheet', title: 'Next sheet' },
    icon('chevron-right'),
  );
  const rangeInput = el('input', {
    type: 'text',
    value: settings.rangeText,
    placeholder: '2-4, 7',
  });
  const rangeError = el('p.field-error', { role: 'alert' });
  rangeError.hidden = true;

  const nUpBox = el('div.print-subgroup');
  const bookletBox = el('div.print-subgroup');
  const tileBox = el('div.print-subgroup');
  const customScaleBox = el('div.print-subgroup');

  const refresh = (): void => {
    plan = options.plan(settings);
    sheetIndex = Math.min(sheetIndex, Math.max(0, plan.sheets.length - 1));
    summary.textContent = describePlan(plan);
    rangeError.hidden = !plan.error || settings.rangeMode !== 'custom';
    rangeError.textContent = plan.error ?? '';
    nUpBox.hidden = settings.mode !== 'nup';
    bookletBox.hidden = settings.mode !== 'booklet';
    tileBox.hidden = settings.mode !== 'tile';
    customScaleBox.hidden = settings.scaling !== 'custom';
    previousSheet.disabled = sheetIndex <= 0;
    nextSheet.disabled = sheetIndex >= plan.sheets.length - 1;
    previewLabel.textContent = plan.sheets.length
      ? `Sheet ${sheetIndex + 1} of ${plan.sheets.length}`
      : 'Nothing to print';
    void updatePreview();
  };

  const updatePreview = async (): Promise<void> => {
    const sheet = plan.sheets[sheetIndex];
    const token = ++previewToken;
    if (!sheet) {
      previewImage.removeAttribute('src');
      return;
    }
    try {
      const url = await options.preview(sheet, settings);
      if (token !== previewToken) {
        URL.revokeObjectURL(url);
        return;
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = url;
      previewImage.src = url;
    } catch {
      previewImage.removeAttribute('src');
    }
  };

  const set = <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]): void => {
    settings = { ...settings, [key]: value };
    refresh();
  };

  // ---- printer ---------------------------------------------------------------------------------
  const printerOptions = [
    { value: '', label: 'Default printer' },
    ...options.printers.map((p) => ({ value: p.name, label: p.displayName })),
  ];
  const printer = select('Printer', printerOptions, settings.printer, (value) => {
    set('printer', value);
  });
  const copies = number(
    'Copies',
    settings.copies,
    (value) => {
      set('copies', Math.max(1, Math.round(value)));
    },
    { min: 1, max: 999, step: 1 },
  );

  // ---- pages -----------------------------------------------------------------------------------
  const rangeFieldset = el('fieldset.print-group');
  rangeFieldset.append(el('legend', null, 'Pages'));
  const rangeModes: ReadonlyArray<{ value: PrintSettings['rangeMode']; label: string }> = [
    { value: 'all', label: `All ${options.pageCount} pages` },
    { value: 'current', label: 'Current page' },
    { value: 'selection', label: 'Selected pages' },
    { value: 'custom', label: 'Pages' },
  ];
  for (const mode of rangeModes) {
    const input = el('input', { type: 'radio', name: 'print-range' });
    input.checked = settings.rangeMode === mode.value;
    if (mode.value === 'selection' && !options.hasSelection) input.disabled = true;
    input.addEventListener('change', () => {
      if (input.checked) set('rangeMode', mode.value);
    });
    const row = el('label.print-radio', null, input, el('span', null, mode.label));
    if (mode.value === 'custom') row.append(rangeInput);
    rangeFieldset.append(row);
  }
  rangeInput.addEventListener('input', () => {
    settings = { ...settings, rangeText: rangeInput.value, rangeMode: 'custom' };
    for (const radio of rangeFieldset.querySelectorAll<HTMLInputElement>('input[type=radio]')) {
      radio.checked = radio.parentElement?.contains(rangeInput) ?? false;
    }
    refresh();
  });
  rangeFieldset.append(
    rangeError,
    select(
      'Subset',
      [
        { value: 'all', label: 'All pages in range' },
        { value: 'odd', label: 'Odd pages only' },
        { value: 'even', label: 'Even pages only' },
      ],
      settings.subset,
      (value) => {
        set('subset', value as PrintSettings['subset']);
      },
    ).element,
    check('Reverse order', settings.reverse, (value) => {
      set('reverse', value);
    }),
  );

  // ---- page handling ---------------------------------------------------------------------------
  const modeSelect = select('Layout', MODES, settings.mode, (value) => {
    set('mode', value as Mode);
  });
  nUpBox.append(
    formGrid(
      number(
        'Columns',
        settings.nUpColumns,
        (value) => {
          set('nUpColumns', Math.max(1, Math.round(value)));
        },
        { min: 1, max: 8, step: 1 },
      ).element,
      number(
        'Rows',
        settings.nUpRows,
        (value) => {
          set('nUpRows', Math.max(1, Math.round(value)));
        },
        { min: 1, max: 8, step: 1 },
      ).element,
    ),
    select('Order', ORDERS, settings.nUpOrder, (value) => {
      set('nUpOrder', value as NUpOrder);
    }).element,
    check('Draw a border round each page', settings.nUpBorder, (value) => {
      set('nUpBorder', value);
    }),
  );
  bookletBox.append(
    select(
      'Binding',
      [
        { value: 'left', label: 'Left (left-to-right reading)' },
        { value: 'right', label: 'Right (right-to-left reading)' },
      ],
      settings.bookletBinding,
      (value) => {
        set('bookletBinding', value as PrintSettings['bookletBinding']);
      },
    ).element,
    select(
      'Sheets',
      [
        { value: 'both', label: 'Both sides' },
        { value: 'front', label: 'Front sides only' },
        { value: 'back', label: 'Back sides only' },
      ],
      settings.bookletSubset,
      (value) => {
        set('bookletSubset', value as PrintSettings['bookletSubset']);
      },
    ).element,
  );
  tileBox.append(
    number(
      'Tile scale (%)',
      Math.round(settings.tileScale * 100),
      (value) => {
        set('tileScale', Math.max(0.1, value / 100));
      },
      { min: 10, max: 800, step: 5 },
    ).element,
    number(
      'Overlap (points)',
      settings.tileOverlap,
      (value) => {
        set('tileOverlap', Math.max(0, value));
      },
      { min: 0, max: 144, step: 1 },
    ).element,
    check('Print cut marks and labels', settings.tileMarks, (value) => {
      set('tileMarks', value);
    }),
  );
  const scaling = select('Scaling', SCALINGS, settings.scaling, (value) => {
    set('scaling', value as ScalingMode);
  });
  customScaleBox.append(
    number(
      'Scale (%)',
      settings.customScale,
      (value) => {
        set('customScale', Math.max(1, value));
      },
      { min: 1, max: 1000, step: 1 },
    ).element,
  );

  // ---- paper -----------------------------------------------------------------------------------
  const paper = select(
    'Paper',
    PAPER_SIZES.map((p) => ({ value: p.id, label: p.label })),
    settings.paperId,
    (value) => {
      set('paperId', value);
    },
  );
  const orientation = select(
    'Orientation',
    [
      { value: 'auto', label: 'Automatic' },
      { value: 'portrait', label: 'Portrait' },
      { value: 'landscape', label: 'Landscape' },
    ],
    settings.orientation,
    (value) => {
      set('orientation', value as PrintSettings['orientation']);
    },
  );
  const margins = formGrid(
    number('Top margin (pt)', settings.marginTop, (v) => {
      set('marginTop', Math.max(0, v));
    }).element,
    number('Right margin (pt)', settings.marginRight, (v) => {
      set('marginRight', Math.max(0, v));
    }).element,
    number('Bottom margin (pt)', settings.marginBottom, (v) => {
      set('marginBottom', Math.max(0, v));
    }).element,
    number('Left margin (pt)', settings.marginLeft, (v) => {
      set('marginLeft', Math.max(0, v));
    }).element,
  );

  // ---- content ---------------------------------------------------------------------------------
  const contentBox = el(
    'fieldset.print-group',
    null,
    el('legend', null, 'What to print'),
    check('Comments and annotations', settings.annotations, (value) => {
      set('annotations', value);
    }),
    check('Form fields', settings.forms, (value) => {
      set('forms', value);
    }),
    check('Greyscale', settings.grayscale, (value) => {
      set('grayscale', value);
    }),
    check('Print as image', settings.printAsImage, (value) => {
      set('printAsImage', value);
    }),
    el(
      'p.print-note',
      null,
      'Print to PDF preserves printable comments and form fields according to these options. Text stays searchable; Print as image or Greyscale produces a bitmap at the chosen DPI.',
    ),
    number(
      'Resolution (DPI)',
      settings.dpi,
      (value) => {
        set('dpi', Math.min(1200, Math.max(72, Math.round(value))));
      },
      { min: 72, max: 1200, step: 1 },
    ).element,
  );

  previousSheet.addEventListener('click', () => {
    sheetIndex = Math.max(0, sheetIndex - 1);
    refresh();
  });
  nextSheet.addEventListener('click', () => {
    sheetIndex = Math.min(plan.sheets.length - 1, sheetIndex + 1);
    refresh();
  });

  const body = (host: HTMLElement, _dialog: DialogHandle): void => {
    const left = el(
      'div.print-columns-left',
      null,
      el(
        'fieldset.print-group',
        null,
        el('legend', null, 'Printer'),
        printer.element,
        formGrid(
          copies.element,
          el(
            'div.field',
            null,
            check('Collate copies', settings.collate, (value) => {
              set('collate', value);
            }),
          ),
        ),
      ),
      rangeFieldset,
      el(
        'fieldset.print-group',
        null,
        el('legend', null, 'Page handling'),
        modeSelect.element,
        nUpBox,
        bookletBox,
        tileBox,
        scaling.element,
        customScaleBox,
        check('Rotate pages to fit the sheet', settings.autoRotate, (value) => {
          set('autoRotate', value);
        }),
        check('Centre on the sheet', settings.autoCentre, (value) => {
          set('autoCentre', value);
        }),
      ),
      el(
        'fieldset.print-group',
        null,
        el('legend', null, 'Page setup'),
        paper.element,
        orientation.element,
        margins,
      ),
      contentBox,
    );
    const right = el(
      'div.print-columns-right',
      null,
      el('div.print-preview', null, previewImage),
      el('div.print-preview-bar', null, previousSheet, previewLabel, nextSheet),
      summary,
    );
    host.append(el('div.print-columns', null, left, right));
    refresh();
  };

  const handle = options.dialogs.open({
    id: 'print-dialog',
    title: 'Print',
    className: 'print-dialog',
    width: 900,
    content: body,
    buttons: [
      {
        id: 'print',
        label: 'Print',
        primary: true,
        onPress: () => {
          if (plan.error) return false;
          action = 'print';
          return true;
        },
      },
      {
        id: 'pdf',
        label: 'Print to PDF…',
        onPress: () => {
          if (plan.error) return false;
          action = 'pdf';
          return true;
        },
      },
      { id: 'cancel', label: 'Cancel' },
    ],
  });

  const result = await handle.result;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  if (result !== 'print' && result !== 'pdf') return null;
  return { action, settings };
}
