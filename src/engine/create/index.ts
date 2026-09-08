/**
 * Create PDF — the converter layer (M91, ADR 0011). Pure over bytes; see `types.ts`.
 */

export * from './types';
export { ConverterRegistry, createRegistry } from './registry';
export { ImageConverter, type ImageConvertOptions } from './images/ImageConverter';
export {
  DEFAULT_IMAGE_LAYOUT,
  layoutImage,
  naturalSize,
  type DisplayedImage,
  type ImageFit,
  type ImageLayout,
  type ImageLayoutOptions,
  type ImagePageMode,
} from './images/layout';
export {
  IMAGE_EXTENSIONS,
  IMAGE_MIMES,
  readHeader,
  sniffFormat,
  orientationSwaps,
  type ExifOrientation,
  type ImageFormat,
  type ImageHeader,
} from './images/headers';
export {
  TextConverter,
  convertText,
  DEFAULT_TEXT_OPTIONS,
  TEXT_EXTENSIONS,
  type TextConvertOptions,
  type TextFontChoice,
} from './text/TextConverter';
export { decodeText } from './text/decode';
export {
  BlankConverter,
  DEFAULT_BLANK_OPTIONS,
  MAX_BLANK_PAGES,
  type BlankConvertOptions,
} from './blank/BlankConverter';
export {
  HtmlConverter,
  DEFAULT_HTML_OPTIONS,
  isMarkdown,
  MARKDOWN_EXTENSIONS,
  HTML_EXTENSIONS,
  stamp,
  type HtmlConvertOptions,
} from './html/HtmlConverter';
export { markdownToHtml, renderMarkdown, fileUrl, folderUrl } from './markdown';
export { WebConverter, DEFAULT_WEB_OPTIONS, type WebConvertOptions } from './web/WebConverter';
export {
  crawl,
  DEFAULT_MAX_PAGES,
  MAX_DEPTH,
  type CrawlOptions,
  type CrawlResult,
  type CrawledPage,
} from './web/crawl';
export {
  assembleWebPdf,
  type AssemblePage,
  type AssembleOptions,
  type AssembleResult,
} from './web/assemble';
export { normalizeUrl, sameSite, labelOf } from './web/urls';
