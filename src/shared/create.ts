/**
 * Types shared by M91's dialogs, its pure converters and the main-process printer (ADR 0011).
 *
 * Everything here crosses `postMessage` or IPC, so it is plain data: no classes, no functions,
 * bytes as `Uint8Array`.
 */

/** Which way up a page is. `auto` follows the content (an image's aspect, a web page's CSS). */
export type Orientation = 'auto' | 'portrait' | 'landscape';

/** The four margins of a page, in millimetres. */
export interface MarginsMm {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * A page size: a preset id from `resources/page-sizes.json` (`"A4"`, `"Letter"`) or an explicit
 * size in millimetres.
 */
export type PageSizeChoice =
  | { readonly kind: 'preset'; readonly id: string }
  | { readonly kind: 'custom'; readonly widthMm: number; readonly heightMm: number };

/** How a web page is printed by Chromium. Defined once; the dialog, the crawler and main share it. */
export interface WebPrintSettings {
  readonly pageSize: PageSizeChoice;
  readonly orientation: Orientation;
  readonly margins: MarginsMm;
  /** Print the page's own header/footer (URL, title, page number) in the margins. */
  readonly headerFooter: boolean;
  /** Print background colours and images. */
  readonly backgroundGraphics: boolean;
  /** 0.1 – 2. */
  readonly scale: number;
  /** Which CSS media the page is rendered under. */
  readonly media: 'print' | 'screen';
  /** How long to wait for the page to load before giving up, in milliseconds. */
  readonly timeoutMs: number;
  /** Let a `@page { size }` rule in the page override the chosen page size. */
  readonly preferCssPageSize: boolean;
}

/** What main is asked to render. */
export type WebRenderSource =
  | { readonly kind: 'url'; readonly url: string }
  /** HTML we generated (Markdown). `baseUrl` resolves relative images and links. */
  | { readonly kind: 'html'; readonly html: string; readonly baseUrl: string | null };

export interface WebRenderRequest {
  /** Caller-chosen; `webpdf:cancel` names it. */
  readonly jobId: string;
  readonly source: WebRenderSource;
  readonly settings: WebPrintSettings;
}

export interface WebRenderResult {
  /** The URL that was finally loaded (after redirects), or the temporary file's URL for HTML. */
  readonly url: string;
  /** `<title>`, or the URL when the page has none. */
  readonly title: string;
  readonly pdf: Uint8Array;
  /** Every `<a href>` on the page, absolute, in document order, fragments kept. */
  readonly links: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

/** What the clipboard held when asked. */
export interface ClipboardContents {
  readonly text: string;
  readonly html: string;
  /** PNG bytes when the clipboard holds an image, else `null`. */
  readonly image: Uint8Array | null;
  readonly formats: ReadonlyArray<string>;
}

/** A decoded picture: 8-bit RGBA, row-major, top-left first. */
export interface DecodedRaster {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/** A filter row for the OS open dialog. */
export interface FileFilter {
  readonly name: string;
  /** Extensions without the dot. */
  readonly extensions: ReadonlyArray<string>;
}

export interface OpenFilesOptions {
  readonly title?: string;
  readonly filters?: ReadonlyArray<FileFilter>;
  /** Default `true`. */
  readonly multi?: boolean;
  readonly buttonLabel?: string;
}

export const DEFAULT_MARGINS_MM: MarginsMm = { top: 20, right: 20, bottom: 20, left: 20 };

export const DEFAULT_WEB_PRINT_SETTINGS: WebPrintSettings = {
  pageSize: { kind: 'preset', id: 'A4' },
  orientation: 'portrait',
  margins: { top: 15, right: 15, bottom: 15, left: 15 },
  headerFooter: false,
  backgroundGraphics: true,
  scale: 1,
  media: 'print',
  timeoutMs: 30_000,
  preferCssPageSize: false,
};
