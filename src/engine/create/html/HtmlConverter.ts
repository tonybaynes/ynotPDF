/**
 * HTML and Markdown files → PDF (M91). Markdown is rendered to HTML first; both are then printed
 * by the host's `HtmlPrinter` (Chromium, in main) and the result is stamped with a title.
 */

import { PDFDocument } from 'pdf-lib';
import type { WebPrintSettings, WebRenderSource } from '@shared/create';
import { DEFAULT_WEB_PRINT_SETTINGS } from '@shared/create';
import { fileUrl, folderUrl, markdownToHtml } from '../markdown';
import { decodeText } from '../text/decode';
import {
  checkCancelled,
  ConvertCancelled,
  ConvertUnsupported,
  extensionOf,
  stemOf,
  type ConvertContext,
  type ConvertInput,
  type ConvertResult,
  type Converter,
  type RoutingInput,
} from '../types';

export interface HtmlConvertOptions {
  readonly settings: WebPrintSettings;
  /** CSS for Markdown documents — the contents of `resources/create/markdown.css`. */
  readonly markdownStylesheet?: string;
  readonly title?: string;
}

export const DEFAULT_HTML_OPTIONS: HtmlConvertOptions = {
  settings: DEFAULT_WEB_PRINT_SETTINGS,
};

export const MARKDOWN_EXTENSIONS: ReadonlyArray<string> = [
  'md',
  'markdown',
  'mdown',
  'mkd',
  'mkdn',
];
export const HTML_EXTENSIONS: ReadonlyArray<string> = ['html', 'htm', 'xhtml', 'shtml'];
export const HTML_MIMES: ReadonlyArray<string> = [
  'text/html',
  'application/xhtml+xml',
  'text/markdown',
];

export function isMarkdown(input: RoutingInput): boolean {
  if (input.mime?.toLowerCase() === 'text/markdown') return true;
  return MARKDOWN_EXTENSIONS.includes(extensionOf(input.name));
}

export class HtmlConverter implements Converter<HtmlConvertOptions> {
  readonly id = 'html';
  readonly label = 'HTML and Markdown';
  readonly extensions: ReadonlyArray<string> = [...HTML_EXTENSIONS, ...MARKDOWN_EXTENSIONS];
  readonly mimes = HTML_MIMES;
  readonly multi = false;

  accepts(input: RoutingInput): boolean {
    const mime = input.mime?.toLowerCase();
    if (mime && this.mimes.includes(mime)) return true;
    return this.extensions.includes(extensionOf(input.name));
  }

  defaults(): HtmlConvertOptions {
    return { ...DEFAULT_HTML_OPTIONS };
  }

  async convert(
    inputs: ReadonlyArray<ConvertInput>,
    options: HtmlConvertOptions,
    ctx: ConvertContext,
  ): Promise<ConvertResult> {
    const input = inputs[0];
    if (!input) throw new ConvertUnsupported('empty', 'No file was given');
    const printer = ctx.env.printer;
    if (!printer) {
      throw new ConvertUnsupported(
        'no-printer',
        `${input.name} needs the app's web renderer, which is not available here`,
      );
    }
    const settings = { ...DEFAULT_WEB_PRINT_SETTINGS, ...options.settings };
    const markdown = isMarkdown(input);
    const stem = stemOf(input.name);
    let source: WebRenderSource;
    if (markdown) {
      const html = markdownToHtml(decodeText(input.bytes), {
        title: stem,
        ...(options.markdownStylesheet === undefined
          ? {}
          : { stylesheet: options.markdownStylesheet }),
        baseHref: input.path ? folderUrl(input.path) : null,
      });
      source = { kind: 'html', html, baseUrl: input.path ? folderUrl(input.path) : null };
    } else if (input.path) {
      source = { kind: 'url', url: fileUrl(input.path) };
    } else {
      source = { kind: 'html', html: decodeText(input.bytes), baseUrl: null };
    }
    checkCancelled(ctx.signal);
    ctx.progress?.(null, `Rendering ${input.name}`);
    const printed = await printer.render(source, settings, ctx.signal);
    checkCancelled(ctx.signal);
    ctx.progress?.(0.9, 'Finishing the document');
    const title = options.title ?? (markdown ? stem : printed.title.trim() || stem);
    const { bytes, pageCount } = await stamp(printed.pdf, title);
    return { bytes, pageCount, title, warnings: [...printed.warnings] };
  }
}

/** Sets the title and producer on a printed PDF and counts its pages. */
export async function stamp(
  pdf: Uint8Array,
  title: string,
): Promise<{ readonly bytes: Uint8Array; readonly pageCount: number }> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
  } catch (error) {
    if (error instanceof ConvertCancelled) throw error;
    throw new ConvertUnsupported(
      'corrupt',
      `The rendered PDF could not be read: ${message(error)}`,
    );
  }
  doc.setTitle(title);
  doc.setProducer('ynotPDF');
  doc.setCreator('ynotPDF');
  const bytes = await doc.save({ addDefaultPage: false, updateFieldAppearances: false });
  return { bytes, pageCount: doc.getPageCount() };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
