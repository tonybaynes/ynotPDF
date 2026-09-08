/**
 * The Create dialogs (M91): one per source kind, each an opaque modal on the shell's `Dialogs`
 * with the options as native controls and a preview where one is cheap. Every function returns
 * the options the reader confirmed, or `null` when they cancelled — the service does the rest.
 *
 * Built inside the `content` callback so the functions are usable where there is no DOM.
 */

import { el } from '@app/dom';
import { field, formGrid, type Dialogs } from '@app/dialog/Dialogs';
import { icon } from '@app/icons';
import type { WebPrintSettings } from '@shared/create';
import { PAGE_SIZE_PRESETS, resolvePageSize } from '@shared/pageSizes';
import type { BlankConvertOptions } from '@engine/create/blank/BlankConverter';
import type { HtmlConvertOptions } from '@engine/create/html/HtmlConverter';
import type { ImageConvertOptions } from '@engine/create/images/ImageConverter';
import { orientationSwaps, readHeader } from '@engine/create/images/headers';
import { layoutImage } from '@engine/create/images/layout';
import type { TextConvertOptions, TextFontChoice } from '@engine/create/text/TextConverter';
import type { ConvertInput } from '@engine/create/types';
import type { WebConvertOptions } from '@engine/create/web/WebConverter';
import { MAX_DEPTH } from '@engine/create/web/crawl';
import { normalizeUrl } from '@engine/create/web/urls';
import {
  checkbox,
  describePage,
  formatBytes,
  marginsOf,
  numberInput,
  numberOf,
  orientationOf,
  pageFields,
  pagePreview,
  pageSizeOf,
  select,
  textInput,
} from './forms';
import { previewUrl } from './rasterDecoder';

const BUTTONS = [
  { id: 'create', label: 'Create', primary: true },
  { id: 'cancel', label: 'Cancel' },
] as const;

// ---- images ------------------------------------------------------------------------------------

export async function askImageOptions(
  dialogs: Dialogs,
  inputs: ReadonlyArray<ConvertInput>,
  defaults: ImageConvertOptions,
): Promise<ImageConvertOptions | null> {
  let result: ImageConvertOptions = defaults;
  const urls: string[] = [];
  const build = (body: HTMLElement): void => {
    const first = inputs[0];
    const list = el('ul.create-image-list', { 'aria-label': 'Images' });
    for (const input of inputs) {
      const header = readHeader(input.bytes);
      const swap = orientationSwaps(header.orientation);
      const w = swap ? header.height : header.width;
      const h = swap ? header.width : header.height;
      const size =
        w && h
          ? `${String(w)} × ${String(h)} px`
          : header.format === 'unknown'
            ? 'unknown format'
            : header.format.toUpperCase();
      const dpi = header.dpiX ? `, ${String(Math.round(header.dpiX))} dpi` : '';
      const pages = header.pages && header.pages > 1 ? `, ${String(header.pages)} pages` : '';
      const item = el('li.create-image-item');
      const thumb = el('div.create-image-thumb', { 'aria-hidden': 'true' });
      const url =
        header.format === 'png' ||
        header.format === 'jpeg' ||
        header.format === 'gif' ||
        header.format === 'bmp' ||
        header.format === 'webp'
          ? previewUrl(input.bytes, input.mime)
          : null;
      if (url) {
        urls.push(url);
        const img = el('img', { src: url, alt: '' });
        thumb.append(img);
      } else {
        thumb.append(icon('image', { size: 'lg' }));
      }
      item.append(
        thumb,
        el(
          'div.create-image-meta',
          null,
          el('span.create-image-name', null, input.name),
          el(
            'span.create-image-size',
            null,
            `${size}${dpi}${pages}, ${formatBytes(input.bytes.byteLength)}`,
          ),
        ),
      );
      list.append(item);
    }
    const mode = select(
      [
        { value: 'fixed', label: 'A page size, image fitted inside the margins' },
        { value: 'image', label: 'The size of each image (at its resolution)' },
      ],
      defaults.pageMode,
    );
    const fit = select(
      [
        { value: 'fit', label: 'Fit inside the margins' },
        { value: 'fill', label: 'Fill the page (cropped)' },
        { value: 'actual', label: 'Actual size (reduced only if it would not fit)' },
      ],
      defaults.fit,
    );
    const page = pageFields(defaults, true);
    const dpi = numberInput(defaults.defaultDpi, { min: 36, max: 1200, step: 1 });
    const previewHost = el('div.create-preview');
    const summary = el('p.field-hint.create-summary', { 'aria-live': 'polite' });

    const read = (): ImageConvertOptions => ({
      ...defaults,
      pageMode: mode.value === 'image' ? 'image' : 'fixed',
      fit: fit.value === 'fill' || fit.value === 'actual' ? fit.value : 'fit',
      pageSize: pageSizeOf(page.size),
      orientation: orientationOf(page.orientation),
      margins: marginsOf(page.margins, defaults.margins),
      defaultDpi: numberOf(dpi, defaults.defaultDpi),
    });
    const refresh = (): void => {
      result = read();
      const fixed = result.pageMode === 'fixed';
      page.size.disabled = !fixed;
      page.orientation.disabled = !fixed;
      fit.disabled = !fixed;
      previewHost.replaceChildren();
      if (!first) return;
      const header = readHeader(first.bytes);
      const swap = orientationSwaps(header.orientation);
      const displayed = {
        widthPx: (swap ? header.height : header.width) ?? 100,
        heightPx: (swap ? header.width : header.height) ?? 100,
        ...(header.dpiX === undefined ? {} : { dpiX: header.dpiX }),
        ...(header.dpiY === undefined ? {} : { dpiY: header.dpiY }),
      };
      const layout = layoutImage(displayed, result);
      const mm = (pt: number): string => String(Math.round((pt / 72) * 25.4));
      const words = fixed
        ? describePage(result.pageSize, result.orientation, displayed.widthPx / displayed.heightPx)
        : `${mm(layout.page.width)} × ${mm(layout.page.height)} mm from the image at ${String(Math.round(layout.dpi.x))} dpi`;
      previewHost.append(
        pagePreview(layout.page, layout.rect, `Preview of the first page: ${words}`),
      );
      summary.textContent = `${String(inputs.length)} ${inputs.length === 1 ? 'image' : 'images'}; first page ${words}.`;
    };
    for (const control of [mode, fit, page.size, page.orientation, page.margins, dpi]) {
      control.addEventListener('change', refresh);
      control.addEventListener('input', refresh);
    }
    body.append(
      list,
      formGrid(
        field({ label: 'Page', input: mode }),
        field({ label: 'Placement', input: fit }),
        ...page.fields,
        field({ label: 'Resolution to assume when an image has none (dpi)', input: dpi }),
      ),
      el('div.create-preview-row', null, previewHost, summary),
    );
    refresh();
  };
  const answer = await dialogs.open({
    id: 'create-images-dialog',
    title:
      inputs.length === 1
        ? 'Create PDF from image'
        : `Create PDF from ${String(inputs.length)} images`,
    content: build,
    width: 640,
    buttons: [...BUTTONS],
  }).result;
  for (const url of urls) URL.revokeObjectURL(url);
  return answer === 'create' ? result : null;
}

// ---- web page ----------------------------------------------------------------------------------

/** The print-settings controls shared by the web and HTML dialogs. */
function printFields(
  defaults: WebPrintSettings,
  timeoutSeconds: number,
): {
  readonly fields: HTMLElement[];
  read(): WebPrintSettings;
} {
  const page = pageFields(defaults, false);
  const headerFooter = checkbox(
    'Header and footer (title, address, page numbers)',
    defaults.headerFooter,
  );
  const background = checkbox('Background colours and images', defaults.backgroundGraphics);
  const cssSize = checkbox(
    'Let the page choose its own paper size (@page)',
    defaults.preferCssPageSize,
  );
  const scale = numberInput(Math.round(defaults.scale * 100), { min: 10, max: 200, step: 5 });
  const media = select(
    [
      { value: 'print', label: 'Print (as a printer would)' },
      { value: 'screen', label: 'Screen (as the browser shows it)' },
    ],
    defaults.media,
  );
  const timeout = numberInput(timeoutSeconds, { min: 5, max: 300, step: 5 });
  return {
    fields: [
      ...page.fields,
      field({ label: 'Scale (%)', input: scale }),
      field({ label: 'Style', input: media }),
      field({ label: 'Give up after (seconds)', input: timeout }),
      headerFooter.row,
      background.row,
      cssSize.row,
    ],
    read: () => ({
      pageSize: pageSizeOf(page.size),
      orientation: orientationOf(page.orientation),
      margins: marginsOf(page.margins, defaults.margins),
      headerFooter: headerFooter.input.checked,
      backgroundGraphics: background.input.checked,
      scale: numberOf(scale, 100) / 100,
      media: media.value === 'screen' ? 'screen' : 'print',
      timeoutMs: numberOf(timeout, timeoutSeconds) * 1000,
      preferCssPageSize: cssSize.input.checked,
    }),
  };
}

export async function askWebOptions(
  dialogs: Dialogs,
  defaults: WebConvertOptions,
): Promise<WebConvertOptions | null> {
  let result: WebConvertOptions = defaults;
  const build = (
    body: HTMLElement,
    dialog: { setEnabled(id: string, enabled: boolean): void },
  ): void => {
    const url = textInput(defaults.url, {
      placeholder: 'https://example.com/page',
      autocomplete: 'url',
      spellcheck: 'false',
    });
    const error = el('p.field-error', { role: 'alert', hidden: true });
    const depth = numberInput(defaults.depth, { min: 1, max: MAX_DEPTH, step: 1 });
    const sameSite = checkbox('Follow only links on the same site', defaults.sameSiteOnly);
    const bookmarks = checkbox('A bookmark for every page', defaults.bookmarks);
    const print = printFields(defaults.settings, Math.round(defaults.settings.timeoutMs / 1000));
    const read = (): WebConvertOptions => ({
      ...defaults,
      url: url.value.trim(),
      depth: numberOf(depth, 1),
      sameSiteOnly: sameSite.input.checked,
      bookmarks: bookmarks.input.checked,
      settings: print.read(),
    });
    const validate = (): void => {
      result = read();
      const ok = result.url !== '' && normalizeUrl(withScheme(result.url)) !== null;
      error.hidden = ok || result.url === '';
      error.textContent = ok
        ? ''
        : 'That is not a web address ynotPDF can load. It needs to start with http://, https:// or file://.';
      dialog.setEnabled('create', ok);
    };
    url.addEventListener('input', validate);
    for (const control of [depth, sameSite.input, bookmarks.input])
      control.addEventListener('change', validate);
    body.append(
      field({
        label: 'Address',
        input: url,
        required: true,
        hint: 'A web page, or a local file (file:///…)',
      }),
      error,
      formGrid(
        field({
          label: 'Pages deep (1 = this page only)',
          input: depth,
          hint: `Up to ${String(MAX_DEPTH)}; every page linked from the page before is included`,
        }),
        sameSite.row,
        bookmarks.row,
      ),
      el('h3.create-section', null, 'Paper'),
      formGrid(...print.fields),
    );
    validate();
  };
  const answer = await dialogs.open({
    id: 'create-web-dialog',
    title: 'Create PDF from web page',
    content: build,
    width: 640,
    buttons: [...BUTTONS],
    initialFocus: 'first',
  }).result;
  if (answer !== 'create') return null;
  return { ...result, url: withScheme(result.url) };
}

/** "example.com" → "https://example.com"; anything with a scheme is left alone. */
export function withScheme(url: string): string {
  const trimmed = url.trim();
  if (trimmed === '' || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

// ---- HTML / Markdown file ----------------------------------------------------------------------

export async function askHtmlOptions(
  dialogs: Dialogs,
  name: string,
  defaults: HtmlConvertOptions,
): Promise<HtmlConvertOptions | null> {
  let result: HtmlConvertOptions = defaults;
  const build = (body: HTMLElement): void => {
    const print = printFields(defaults.settings, Math.round(defaults.settings.timeoutMs / 1000));
    body.append(
      el('p.dlg-text', null, `${name} will be laid out by the app's own web renderer.`),
      formGrid(...print.fields),
    );
    result = { ...defaults, settings: print.read() };
    for (const control of body.querySelectorAll('input, select')) {
      control.addEventListener('change', () => {
        result = { ...defaults, settings: print.read() };
      });
    }
  };
  const answer = await dialogs.open({
    id: 'create-html-dialog',
    title: `Create PDF from ${name}`,
    content: build,
    width: 640,
    buttons: [...BUTTONS],
  }).result;
  return answer === 'create' ? result : null;
}

// ---- plain text --------------------------------------------------------------------------------

export async function askTextOptions(
  dialogs: Dialogs,
  name: string,
  preview: string,
  defaults: TextConvertOptions,
): Promise<TextConvertOptions | null> {
  let result: TextConvertOptions = defaults;
  const build = (body: HTMLElement): void => {
    const font = select(
      [
        { value: 'mono', label: 'Monospace (Courier)' },
        { value: 'sans', label: 'Proportional (Helvetica)' },
        { value: 'serif', label: 'Serif (Times)' },
      ],
      defaults.font,
    );
    const size = numberInput(defaults.fontSize, { min: 6, max: 24, step: 1 });
    const spacing = numberInput(defaults.lineSpacing, { min: 1, max: 2, step: 0.05 });
    const tab = numberInput(defaults.tabSize, { min: 1, max: 16, step: 1 });
    const page = pageFields(defaults, false);
    const header = checkbox('Header with the file name and page number', defaults.header);
    const wrap = checkbox('Wrap long lines', defaults.wrap);
    const lines = preview.split(/\r\n|\r|\n/);
    const shown = lines.slice(0, 12).join('\n');
    const more = lines.length > 12 ? `\n… ${String(lines.length - 12)} more lines` : '';
    const pre = el(
      'pre.create-text-preview',
      { 'aria-label': 'The first lines of the text' },
      shown + more,
    );
    const read = (): TextConvertOptions => ({
      ...defaults,
      font: (['mono', 'sans', 'serif'] as const).includes(font.value as TextFontChoice)
        ? (font.value as TextFontChoice)
        : 'mono',
      fontSize: numberOf(size, defaults.fontSize),
      lineSpacing: numberOf(spacing, defaults.lineSpacing),
      tabSize: numberOf(tab, defaults.tabSize),
      pageSize: pageSizeOf(page.size),
      orientation: orientationOf(page.orientation),
      margins: marginsOf(page.margins, defaults.margins),
      header: header.input.checked,
      wrap: wrap.input.checked,
    });
    const refresh = (): void => {
      result = read();
      pre.className = `create-text-preview create-text-preview-${result.font}`;
    };
    for (const control of [
      font,
      size,
      spacing,
      tab,
      page.size,
      page.orientation,
      page.margins,
      header.input,
      wrap.input,
    ]) {
      control.addEventListener('change', refresh);
    }
    body.append(
      pre,
      formGrid(
        field({ label: 'Font', input: font }),
        field({ label: 'Size (pt)', input: size }),
        field({ label: 'Line spacing', input: spacing }),
        field({ label: 'Tab width (spaces)', input: tab }),
        ...page.fields,
        header.row,
        wrap.row,
      ),
    );
    refresh();
  };
  const answer = await dialogs.open({
    id: 'create-text-dialog',
    title: `Create PDF from ${name}`,
    content: build,
    width: 640,
    buttons: [...BUTTONS],
  }).result;
  return answer === 'create' ? result : null;
}

// ---- blank -------------------------------------------------------------------------------------

export async function askBlankOptions(
  dialogs: Dialogs,
  defaults: BlankConvertOptions,
): Promise<BlankConvertOptions | null> {
  let result: BlankConvertOptions = defaults;
  const build = (body: HTMLElement): void => {
    const page = pageFields(
      { ...defaults, margins: { top: 0, right: 0, bottom: 0, left: 0 } },
      false,
    );
    const count = numberInput(defaults.count, { min: 1, max: 1000, step: 1 });
    const previewHost = el('div.create-preview');
    const summary = el('p.field-hint.create-summary', { 'aria-live': 'polite' });
    const read = (): BlankConvertOptions => ({
      ...defaults,
      pageSize: pageSizeOf(page.size),
      orientation: orientationOf(page.orientation),
      count: numberOf(count, 1),
    });
    const refresh = (): void => {
      result = read();
      const size = resolvePageSize(result.pageSize, result.orientation);
      const words = describePage(result.pageSize, result.orientation);
      previewHost.replaceChildren(pagePreview(size, null, `Preview: ${words}`));
      summary.textContent = `${String(result.count)} ${result.count === 1 ? 'page' : 'pages'}, ${words}.`;
    };
    for (const control of [page.size, page.orientation, count]) {
      control.addEventListener('change', refresh);
      control.addEventListener('input', refresh);
    }
    const [sizeField, orientationField] = page.fields;
    body.append(
      formGrid(
        sizeField ?? el('div'),
        orientationField ?? el('div'),
        field({ label: 'Pages', input: count }),
      ),
      el('div.create-preview-row', null, previewHost, summary),
    );
    refresh();
  };
  const answer = await dialogs.open({
    id: 'create-blank-dialog',
    title: 'New blank document',
    content: build,
    width: 560,
    buttons: [...BUTTONS],
  }).result;
  return answer === 'create' ? result : null;
}

/** The preset list, for a quick sanity check in tests. */
export const PRESET_IDS: ReadonlyArray<string> = PAGE_SIZE_PRESETS.map((p) => p.id);
