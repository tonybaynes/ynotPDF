/**
 * The four export dialogs (M92): images, pictures-inside-a-document, text, HTML and RTF.
 *
 * Each is an opaque modal on M02's `Dialogs`, built out of native controls so every one is
 * keyboard-reachable and carries the shell's focus ring, and each returns the options the reader
 * confirmed or `null` when they cancelled — the service does the rest.
 *
 * The form pieces are **M41's** (`fields.ts`): the page-range field with its live summary, the
 * labelled checkbox, the select. A second page-range input in the same application that disagreed
 * about what `2-4, even` means would be a bug waiting to be reported, and M41's is already the one
 * M40's dialect belongs to.
 *
 * Every dialog carries a live line saying what will actually be written — the pixel size of a
 * page, or how many files there will be. An export is one of the few operations where the reader
 * cannot see the result until it is on disk, so the arithmetic is on screen before they commit.
 */

import type { Dialogs } from '@app/dialog/Dialogs';
import { el } from '@app/dom';
import { IMAGE_FORMATS, pixelSize, type ImageFormat } from '@engine/export/images';
import type { ColourMode } from '@engine/export/pixels';
import type { RangeContext } from '@modules/M40-organise-pages/range';
import { checkbox, rangeField, select } from '@modules/M41-merge-split-crop/fields';
import {
  COLOUR_OPTIONS,
  DITHER_OPTIONS,
  DPI_PRESETS,
  ENCODING_OPTIONS,
  EMBEDDED_OUTPUT_OPTIONS,
  FORMAT_OPTIONS,
  LAYOUT_OPTIONS,
  LINE_ENDING_OPTIONS,
  SEPARATOR_OPTIONS,
  TIFF_COMPRESSION_OPTIONS,
  type ExportSettings,
} from './settings';

const BUTTONS = [
  { id: 'export', label: 'Export', primary: true },
  { id: 'cancel', label: 'Cancel' },
] as const;

/** A number input with a label, for the dialogs' quality / level / threshold rows. */
function numberField(options: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly hint?: string;
  readonly onChange?: (value: number) => void;
}): { element: HTMLElement; input: HTMLInputElement; value: () => number } {
  const input = el('input.input.export-number', {
    type: 'number',
    min: String(options.min),
    max: String(options.max),
    step: String(options.step ?? 1),
  });
  input.value = String(options.value);
  const read = (): number => {
    const typed = Number(input.value);
    if (!Number.isFinite(typed)) return options.value;
    return Math.min(options.max, Math.max(options.min, typed));
  };
  if (options.onChange) {
    input.addEventListener('input', () => {
      options.onChange?.(read());
    });
  }
  const wrapper = el('div.field');
  const id = `export-number-${String(++seq)}`;
  input.id = id;
  wrapper.append(el('label.field-label', { for: id }, options.label), input);
  if (options.hint !== undefined) wrapper.append(el('p.field-hint', null, options.hint));
  return { element: wrapper, input, value: read };
}

let seq = 0;

/** A text input with a label, for the name patterns. */
function textField(options: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly onChange?: (value: string) => void;
}): { element: HTMLElement; input: HTMLInputElement } {
  const input = el('input.input', { type: 'text', spellcheck: 'false' });
  input.value = options.value;
  if (options.onChange) {
    input.addEventListener('input', () => {
      options.onChange?.(input.value);
    });
  }
  const wrapper = el('div.field');
  const id = `export-text-${String(++seq)}`;
  input.id = id;
  wrapper.append(el('label.field-label', { for: id }, options.label), input);
  if (options.hint !== undefined) wrapper.append(el('p.field-hint', null, options.hint));
  return { element: wrapper, input };
}

// ---- images ------------------------------------------------------------------------------------

export interface ImageDialogAnswer {
  readonly format: ImageFormat;
  readonly dpi: number;
  readonly colour: ColourMode;
  readonly dither: ExportSettings['imageDither'];
  readonly monoThreshold: number;
  readonly quality: number;
  readonly level: number;
  readonly tiffCompression: ExportSettings['tiffCompression'];
  readonly multiPage: boolean;
  readonly namePattern: string;
  readonly annotations: boolean;
  readonly forms: boolean;
  readonly pages: ReadonlyArray<number>;
}

export interface ImageDialogContext {
  readonly range: RangeContext;
  /** The first chosen page's size in points, for the live "this will be n × m pixels" line. */
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly initialRange: string;
}

export async function askImageOptions(
  dialogs: Dialogs,
  settings: ExportSettings,
  context: ImageDialogContext,
): Promise<ImageDialogAnswer | null> {
  let answer: ImageDialogAnswer | null = null;
  const handle = dialogs.open({
    id: 'export-images-dialog',
    title: 'Export pages as images',
    width: 620,
    buttons: [...BUTTONS],
    content: (body, dialog) => {
      const range = rangeField({
        label: 'Pages',
        value: context.initialRange,
        context: context.range,
      });
      const format = select<ImageFormat>({
        label: 'Format',
        value: settings.imageFormat,
        choices: FORMAT_OPTIONS,
      });
      const dpi = numberField({
        label: 'Resolution (dpi)',
        value: settings.imageDpi,
        min: 12,
        max: 1200,
        hint: `Common choices: ${DPI_PRESETS.join(', ')}. 72 is actual size.`,
      });
      const colour = select<ColourMode>({
        label: 'Colour',
        value: settings.imageColour,
        choices: COLOUR_OPTIONS,
      });
      const dither = select({
        label: 'Black and white method',
        value: settings.imageDither,
        choices: DITHER_OPTIONS,
      });
      const threshold = numberField({
        label: 'Black and white threshold',
        value: settings.monoThreshold,
        min: 1,
        max: 254,
      });
      const quality = numberField({
        label: 'JPEG quality',
        value: settings.jpegQuality,
        min: 1,
        max: 100,
      });
      const level = numberField({
        label: 'Compression (0–9)',
        value: settings.compressionLevel,
        min: 0,
        max: 9,
      });
      const tiffCompression = select({
        label: 'TIFF compression',
        value: settings.tiffCompression,
        choices: TIFF_COMPRESSION_OPTIONS,
      });
      const multiPage = checkbox({
        label: 'Put every page in one TIFF file',
        checked: settings.tiffMultiPage,
      });
      const name = textField({
        label: 'Name for each file',
        value: settings.imageNamePattern,
        hint: 'Tokens: {name}, {page}, {n}, {label}, {dpi}, {date}. Anything else is kept as it is.',
      });
      const annotations = checkbox({
        label: 'Draw comments and markup',
        checked: settings.imageAnnotations,
      });
      const forms = checkbox({ label: 'Draw form fields', checked: settings.imageForms });
      const summary = el('p.export-summary', { role: 'status' });

      const paint = (): void => {
        const chosenFormat = format.input.value as ImageFormat;
        const isTiff = chosenFormat === 'tiff';
        const isJpeg = chosenFormat === 'jpeg';
        const isMono = colour.input.value === 'mono';
        const invalidGroup4 = isTiff && tiffCompression.input.value === 'group4' && !isMono;
        quality.element.hidden = !isJpeg;
        level.element.hidden =
          chosenFormat !== 'png' && !(isTiff && tiffCompression.input.value === 'deflate');
        tiffCompression.element.hidden = !isTiff;
        multiPage.element.hidden = !isTiff;
        dither.element.hidden = !isMono;
        threshold.element.hidden = !isMono;
        name.element.hidden = isTiff && multiPage.input.checked;
        const size = pixelSize(context.pageWidth, context.pageHeight, dpi.value());
        const pages = range.pages() ?? [];
        const one = isTiff && multiPage.input.checked;
        const files = one ? 1 : pages.length;
        summary.textContent =
          pages.length === 0
            ? 'No pages chosen.'
            : `${String(files)} ${files === 1 ? 'file' : 'files'}, ${String(size.width)} × ${String(size.height)} pixels a page, as ${IMAGE_FORMATS[chosenFormat].label}.`;
        if (invalidGroup4) {
          summary.textContent =
            'CCITT Group 4 requires black and white (1-bit). Change Colour or choose another TIFF compression.';
        }
        dialog.setEnabled('export', pages.length > 0 && !invalidGroup4);
      };

      range.onChange(paint);
      format.input.addEventListener('change', paint);
      colour.input.addEventListener('change', paint);
      tiffCompression.input.addEventListener('change', paint);
      dpi.input.addEventListener('input', paint);
      multiPage.input.addEventListener('change', paint);

      body.append(
        range.element,
        el(
          'div.form-grid',
          null,
          format.element,
          dpi.element,
          colour.element,
          dither.element,
          threshold.element,
          quality.element,
          level.element,
          tiffCompression.element,
        ),
        multiPage.element,
        name.element,
        el('div.export-checks', null, annotations.element, forms.element),
        summary,
      );
      paint();

      dialog.result
        .then((pressed) => {
          if (pressed !== 'export') return;
          answer = {
            format: format.input.value as ImageFormat,
            dpi: dpi.value(),
            colour: colour.input.value as ColourMode,
            dither: dither.input.value as ExportSettings['imageDither'],
            monoThreshold: threshold.value(),
            quality: quality.value(),
            level: level.value(),
            tiffCompression: tiffCompression.input.value as ExportSettings['tiffCompression'],
            multiPage: multiPage.input.checked,
            namePattern: name.input.value,
            annotations: annotations.input.checked,
            forms: forms.input.checked,
            pages: range.pages() ?? [],
          };
        })
        .catch(() => undefined);
    },
  });
  await handle.result;
  return answer;
}

// ---- pictures inside a document ------------------------------------------------------------

export interface EmbeddedDialogAnswer {
  readonly output: ExportSettings['embeddedOutput'];
  readonly namePattern: string;
  readonly minPixels: number;
  readonly keepDuplicates: boolean;
}

export async function askEmbeddedOptions(
  dialogs: Dialogs,
  settings: ExportSettings,
): Promise<EmbeddedDialogAnswer | null> {
  let answer: EmbeddedDialogAnswer | null = null;
  const handle = dialogs.open({
    id: 'export-embedded-dialog',
    title: 'Export all images',
    width: 560,
    buttons: [...BUTTONS],
    content: (body, dialog) => {
      const output = select({
        label: 'Output',
        value: settings.embeddedOutput,
        choices: EMBEDDED_OUTPUT_OPTIONS,
      });
      const name = textField({
        label: 'Name for each picture',
        value: settings.embeddedNamePattern,
        hint: 'Tokens: {name}, {page}, {index}, {date}.',
      });
      const minPixels = numberField({
        label: 'Smallest picture worth keeping (px)',
        value: settings.embeddedMinPixels,
        min: 1,
        max: 512,
        hint: 'Anything narrower or shorter than this is a rule or a spacer, not a picture.',
      });
      const keepDuplicates = checkbox({
        label: 'Write a file for every placement',
        checked: settings.embeddedKeepDuplicates,
        hint: 'A logo on every page is one picture. Turn this on to get one file per page instead.',
      });
      body.append(
        el(
          'p.export-note',
          null,
          'Original formats keep JPEG and JPEG 2000 bytes unchanged; external PDF masks may be omitted. PNG with transparency applies image masks and keeps each picture’s stored dimensions. Page clipping and drawing opacity are excluded.',
        ),
        output.element,
        name.element,
        minPixels.element,
        keepDuplicates.element,
      );
      dialog.result
        .then((pressed) => {
          if (pressed !== 'export') return;
          answer = {
            output: output.input.value as ExportSettings['embeddedOutput'],
            namePattern: name.input.value,
            minPixels: minPixels.value(),
            keepDuplicates: keepDuplicates.input.checked,
          };
        })
        .catch(() => undefined);
    },
  });
  await handle.result;
  return answer;
}

// ---- text ------------------------------------------------------------------------------------

export interface TextDialogAnswer {
  readonly encoding: ExportSettings['textEncoding'];
  readonly lineEnding: ExportSettings['textLineEnding'];
  readonly pageSeparator: ExportSettings['textPageSeparator'];
  readonly bom: boolean;
  readonly skipBlankLines: boolean;
  readonly pages: ReadonlyArray<number>;
}

export async function askTextOptions(
  dialogs: Dialogs,
  settings: ExportSettings,
  context: { readonly range: RangeContext; readonly initialRange: string },
): Promise<TextDialogAnswer | null> {
  let answer: TextDialogAnswer | null = null;
  const handle = dialogs.open({
    id: 'export-text-dialog',
    title: 'Export text',
    width: 560,
    buttons: [...BUTTONS],
    content: (body, dialog) => {
      const range = rangeField({
        label: 'Pages',
        value: context.initialRange,
        context: context.range,
      });
      const encoding = select({
        label: 'Encoding',
        value: settings.textEncoding,
        choices: ENCODING_OPTIONS,
      });
      const lineEnding = select({
        label: 'Line endings',
        value: settings.textLineEnding,
        choices: LINE_ENDING_OPTIONS,
      });
      const separator = select({
        label: 'Between pages',
        value: settings.textPageSeparator,
        choices: SEPARATOR_OPTIONS,
      });
      const bom = checkbox({
        label: 'Start the file with a byte-order mark',
        checked: settings.textBom,
        hint: 'UTF-8 only. Helps Excel and older Windows tools; confuses most other software.',
      });
      const skipBlank = checkbox({ label: 'Leave out blank lines', checked: false });
      const paint = (): void => {
        bom.element.hidden = encoding.input.value !== 'utf-8';
        dialog.setEnabled('export', (range.pages() ?? []).length > 0);
      };
      encoding.input.addEventListener('change', paint);
      range.onChange(paint);
      body.append(
        range.element,
        el('div.form-grid', null, encoding.element, lineEnding.element, separator.element),
        bom.element,
        skipBlank.element,
      );
      paint();
      dialog.result
        .then((pressed) => {
          if (pressed !== 'export') return;
          answer = {
            encoding: encoding.input.value as ExportSettings['textEncoding'],
            lineEnding: lineEnding.input.value as ExportSettings['textLineEnding'],
            pageSeparator: separator.input.value as ExportSettings['textPageSeparator'],
            bom: bom.input.checked,
            skipBlankLines: skipBlank.input.checked,
            pages: range.pages() ?? [],
          };
        })
        .catch(() => undefined);
    },
  });
  await handle.result;
  return answer;
}

// ---- HTML ------------------------------------------------------------------------------------

export interface HtmlDialogAnswer {
  readonly layout: ExportSettings['htmlLayout'];
  readonly perPage: boolean;
  readonly embedImages: boolean;
  readonly keepStyles: boolean;
  readonly pages: ReadonlyArray<number>;
}

export async function askHtmlOptions(
  dialogs: Dialogs,
  settings: ExportSettings,
  context: { readonly range: RangeContext; readonly initialRange: string },
): Promise<HtmlDialogAnswer | null> {
  let answer: HtmlDialogAnswer | null = null;
  const handle = dialogs.open({
    id: 'export-html-dialog',
    title: 'Export as HTML',
    width: 600,
    buttons: [...BUTTONS],
    content: (body, dialog) => {
      const range = rangeField({
        label: 'Pages',
        value: context.initialRange,
        context: context.range,
      });
      const layout = select({
        label: 'Layout',
        value: settings.htmlLayout,
        choices: LAYOUT_OPTIONS,
      });
      const perPage = checkbox({
        label: 'Write one file per page',
        checked: settings.htmlPerPage,
      });
      const embedImages = checkbox({
        label: 'Put the pictures inside the file',
        checked: settings.htmlEmbedImages,
        hint: 'One file that opens anywhere, rather than a folder that has to travel with it.',
      });
      const keepStyles = checkbox({
        label: 'Keep the document’s fonts, sizes and colours',
        checked: settings.htmlKeepStyles,
      });
      const summary = el('p.export-summary', { role: 'status' });
      const paint = (): void => {
        const pages = range.pages() ?? [];
        const files = perPage.input.checked ? pages.length : 1;
        summary.textContent =
          pages.length === 0
            ? 'No pages chosen.'
            : `${String(files)} ${files === 1 ? 'file' : 'files'} from ${String(pages.length)} ${pages.length === 1 ? 'page' : 'pages'}.`;
        dialog.setEnabled('export', pages.length > 0);
      };
      range.onChange(paint);
      perPage.input.addEventListener('change', paint);
      body.append(
        range.element,
        layout.element,
        perPage.element,
        embedImages.element,
        keepStyles.element,
        summary,
      );
      paint();
      dialog.result
        .then((pressed) => {
          if (pressed !== 'export') return;
          answer = {
            layout: layout.input.value as ExportSettings['htmlLayout'],
            perPage: perPage.input.checked,
            embedImages: embedImages.input.checked,
            keepStyles: keepStyles.input.checked,
            pages: range.pages() ?? [],
          };
        })
        .catch(() => undefined);
    },
  });
  await handle.result;
  return answer;
}

// ---- RTF -------------------------------------------------------------------------------------

export interface RtfDialogAnswer {
  readonly pageBreaks: boolean;
  readonly keepColours: boolean;
  readonly keepSizes: boolean;
  readonly pages: ReadonlyArray<number>;
}

export async function askRtfOptions(
  dialogs: Dialogs,
  settings: ExportSettings,
  context: { readonly range: RangeContext; readonly initialRange: string },
): Promise<RtfDialogAnswer | null> {
  let answer: RtfDialogAnswer | null = null;
  const handle = dialogs.open({
    id: 'export-rtf-dialog',
    title: 'Export as RTF',
    width: 560,
    buttons: [...BUTTONS],
    content: (body, dialog) => {
      const range = rangeField({
        label: 'Pages',
        value: context.initialRange,
        context: context.range,
      });
      const pageBreaks = checkbox({
        label: 'Start each page on a new page',
        checked: settings.rtfPageBreaks,
      });
      const keepColours = checkbox({
        label: 'Keep the document’s text colours',
        checked: settings.rtfKeepColours,
      });
      const keepSizes = checkbox({
        label: 'Keep the document’s font sizes',
        checked: settings.rtfKeepSizes,
      });
      range.onChange(() => {
        dialog.setEnabled('export', (range.pages() ?? []).length > 0);
      });
      body.append(
        el(
          'p.export-note',
          null,
          'RTF keeps the words, the fonts, the sizes and the paragraph breaks. Columns, tables and anything the page draws rather than writes do not survive — a word processor has nowhere to put them.',
        ),
        range.element,
        pageBreaks.element,
        keepColours.element,
        keepSizes.element,
      );
      dialog.setEnabled('export', (range.pages() ?? []).length > 0);
      dialog.result
        .then((pressed) => {
          if (pressed !== 'export') return;
          answer = {
            pageBreaks: pageBreaks.input.checked,
            keepColours: keepColours.input.checked,
            keepSizes: keepSizes.input.checked,
            pages: range.pages() ?? [],
          };
        })
        .catch(() => undefined);
    },
  });
  await handle.result;
  return answer;
}
