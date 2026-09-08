/**
 * Web page → PDF (M91): crawl with the host's printer, then stitch. Takes no input file; the
 * address is in the options.
 */

import type { WebPrintSettings } from '@shared/create';
import { DEFAULT_WEB_PRINT_SETTINGS } from '@shared/create';
import {
  ConvertUnsupported,
  type ConvertContext,
  type ConvertInput,
  type ConvertResult,
  type Converter,
} from '../types';
import { assembleWebPdf } from './assemble';
import { crawl, DEFAULT_MAX_PAGES } from './crawl';

export interface WebConvertOptions {
  readonly url: string;
  /** 1 = this page only; 2 = plus the pages it links to; … */
  readonly depth: number;
  readonly sameSiteOnly: boolean;
  /** One bookmark per crawled page. */
  readonly bookmarks: boolean;
  readonly settings: WebPrintSettings;
  readonly maxPages?: number;
  readonly title?: string;
}

export const DEFAULT_WEB_OPTIONS: WebConvertOptions = {
  url: '',
  depth: 1,
  sameSiteOnly: true,
  bookmarks: true,
  settings: DEFAULT_WEB_PRINT_SETTINGS,
  maxPages: DEFAULT_MAX_PAGES,
};

export class WebConverter implements Converter<WebConvertOptions> {
  readonly id = 'web';
  readonly label = 'Web page';
  readonly extensions: ReadonlyArray<string> = [];
  readonly mimes: ReadonlyArray<string> = [];
  readonly multi = false;

  accepts(): boolean {
    return false;
  }

  defaults(): WebConvertOptions {
    return { ...DEFAULT_WEB_OPTIONS };
  }

  async convert(
    _inputs: ReadonlyArray<ConvertInput>,
    options: WebConvertOptions,
    ctx: ConvertContext,
  ): Promise<ConvertResult> {
    const printer = ctx.env.printer;
    if (!printer) {
      throw new ConvertUnsupported(
        'no-printer',
        "Web pages need the app's web renderer, which is not available here",
      );
    }
    const settings: WebConvertOptions = {
      ...DEFAULT_WEB_OPTIONS,
      ...options,
      settings: { ...DEFAULT_WEB_PRINT_SETTINGS, ...options.settings },
    };
    if (settings.url.trim() === '')
      throw new ConvertUnsupported('empty', 'No web address was given');
    const crawled = await crawl({
      url: settings.url.trim(),
      depth: settings.depth,
      sameSiteOnly: settings.sameSiteOnly,
      settings: settings.settings,
      ...(settings.maxPages === undefined ? {} : { maxPages: settings.maxPages }),
      render: (url, printSettings, signal) =>
        printer.render({ kind: 'url', url }, printSettings, signal),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      ...(ctx.progress === undefined ? {} : { progress: ctx.progress }),
    });
    const assembled = await assembleWebPdf(crawled.pages, {
      bookmarks: settings.bookmarks && crawled.pages.length > 0,
      ...(settings.title === undefined ? {} : { title: settings.title }),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      ...(ctx.progress === undefined ? {} : { progress: ctx.progress }),
    });
    return {
      bytes: assembled.bytes,
      pageCount: assembled.pageCount,
      title: assembled.title,
      warnings: [...crawled.warnings, ...assembled.warnings],
    };
  }
}
