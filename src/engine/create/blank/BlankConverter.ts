/**
 * A blank document (M91): a page size, an orientation and a count. Takes no input; it is a
 * converter so the same registry, progress and result shape serve every creator.
 */

import { PDFDocument } from 'pdf-lib';
import type { Orientation, PageSizeChoice } from '@shared/create';
import { resolvePageSize } from '@shared/pageSizes';
import {
  checkCancelled,
  type ConvertContext,
  type ConvertInput,
  type ConvertResult,
  type Converter,
} from '../types';

export interface BlankConvertOptions {
  readonly pageSize: PageSizeChoice;
  readonly orientation: Orientation;
  /** 1–1000. */
  readonly count: number;
  readonly title?: string;
}

export const DEFAULT_BLANK_OPTIONS: BlankConvertOptions = {
  pageSize: { kind: 'preset', id: 'A4' },
  orientation: 'portrait',
  count: 1,
};

export const MAX_BLANK_PAGES = 1000;

export class BlankConverter implements Converter<BlankConvertOptions> {
  readonly id = 'blank';
  readonly label = 'Blank document';
  readonly extensions: ReadonlyArray<string> = [];
  readonly mimes: ReadonlyArray<string> = [];
  readonly multi = false;

  accepts(): boolean {
    return false;
  }

  defaults(): BlankConvertOptions {
    return { ...DEFAULT_BLANK_OPTIONS };
  }

  async convert(
    _inputs: ReadonlyArray<ConvertInput>,
    options: BlankConvertOptions,
    ctx: ConvertContext,
  ): Promise<ConvertResult> {
    const settings = { ...DEFAULT_BLANK_OPTIONS, ...options };
    const count = Math.min(MAX_BLANK_PAGES, Math.max(1, Math.floor(settings.count) || 1));
    const size = resolvePageSize(settings.pageSize, settings.orientation);
    const doc = await PDFDocument.create({ updateMetadata: false });
    for (let i = 0; i < count; i++) {
      if (i % 100 === 0) {
        checkCancelled(ctx.signal);
        ctx.progress?.(i / count, `Adding page ${i + 1} of ${count}`);
      }
      doc.addPage([size.width, size.height]);
    }
    const title = settings.title ?? 'Untitled';
    doc.setTitle(title);
    doc.setProducer('ynotPDF');
    doc.setCreator('ynotPDF');
    const bytes = await doc.save({ addDefaultPage: false, updateFieldAppearances: false });
    return { bytes, pageCount: count, title, warnings: [] };
  }
}
