/**
 * The converter contract (M91, ADR 0011).
 *
 * A converter is a pure function from input bytes and options to PDF bytes. It may not touch
 * the DOM, Node or Electron; anything it needs from the outside world arrives as an adapter on
 * `ConvertContext.env`, and a converter that needs one the host did not install throws
 * {@link ConvertUnsupported} with a reason in words. That is what lets the same code run in the
 * renderer's Worker, in a batch job (M120) and from the command line (M121).
 */

import type {
  DecodedRaster,
  WebPrintSettings,
  WebRenderResult,
  WebRenderSource,
} from '@shared/create';

/** One input file: its name (for routing and titles) and its bytes. */
export interface ConvertInput {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** MIME type when the source knew it (drag-and-drop, clipboard); routing prefers it. */
  readonly mime?: string;
  /** Absolute path when the input came from disk — resolves relative links in HTML/Markdown. */
  readonly path?: string;
}

export interface ConvertResult {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  /** Suggested document title (also written to `/Title`). */
  readonly title: string;
  /** Things worth telling the reader that did not stop the conversion. */
  readonly warnings: ReadonlyArray<string>;
}

/** `fraction` 0..1 (or `null` while unknown) and a sentence about what is happening. */
export type ConvertProgress = (fraction: number | null, message: string) => void;

/** Decodes a picture the converter cannot decode itself (BMP, GIF, WebP, HEIC…). */
export type RasterDecoder = (
  bytes: Uint8Array,
  mime: string | undefined,
) => Promise<DecodedRaster | null>;

/** Renders a web page (or generated HTML) to PDF bytes — Chromium in main, behind IPC. */
export interface HtmlPrinter {
  render(
    source: WebRenderSource,
    settings: WebPrintSettings,
    signal?: AbortSignal,
  ): Promise<WebRenderResult>;
}

/** The adapters a host may install. Every one is optional; converters say when one is missing. */
export interface ConvertEnvironment {
  readonly rasterDecoder?: RasterDecoder;
  readonly printer?: HtmlPrinter;
}

export interface ConvertContext {
  readonly env: ConvertEnvironment;
  readonly signal?: AbortSignal;
  readonly progress?: ConvertProgress;
}

/** What a converter says about a file it is asked to route. */
export interface RoutingInput {
  readonly name?: string;
  readonly mime?: string;
}

export interface Converter<O = unknown> {
  /** `"image"`, `"text"`, `"html"`, `"web"`, `"blank"`. */
  readonly id: string;
  readonly label: string;
  /** Extensions without the dot, lower case. */
  readonly extensions: ReadonlyArray<string>;
  readonly mimes: ReadonlyArray<string>;
  /** Whether this converter takes several inputs into one document (images) or one at a time. */
  readonly multi: boolean;
  accepts(input: RoutingInput): boolean;
  /** The options a caller gets when it has nothing better. */
  defaults(): O;
  convert(
    inputs: ReadonlyArray<ConvertInput>,
    options: O,
    ctx: ConvertContext,
  ): Promise<ConvertResult>;
}

/** The conversion was cancelled through the signal. Nothing was produced. */
export class ConvertCancelled extends Error {
  override readonly name = 'ConvertCancelled';
  constructor() {
    super('The conversion was cancelled');
  }
}

/** The input is something this host cannot convert — the reason is a sentence for the reader. */
export class ConvertUnsupported extends Error {
  override readonly name = 'ConvertUnsupported';
  readonly reason: ConvertUnsupportedReason;
  constructor(reason: ConvertUnsupportedReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export type ConvertUnsupportedReason =
  /** No converter accepts the file. */
  | 'unknown-format'
  /** The bytes are not what the name says, or are damaged. */
  | 'corrupt'
  /** The host installed no `rasterDecoder`, or it declined the image. */
  | 'no-decoder'
  /** The host installed no `printer`. */
  | 'no-printer'
  /** The page did not load in time. */
  | 'timeout'
  /** The input is empty. */
  | 'empty';

/** Throws {@link ConvertCancelled} when the signal has fired. Call between units of work. */
export function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ConvertCancelled();
}

/** Lower-case extension of a file name without the dot, or `""`. */
export function extensionOf(name: string | undefined): string {
  if (!name) return '';
  const base = name.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** The file name without folder or extension — the default title of a converted file. */
export function stemOf(name: string): string {
  const base = name.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.trim() === '' ? base : stem;
}
