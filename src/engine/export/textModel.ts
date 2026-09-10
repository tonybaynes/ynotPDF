/**
 * The shape of a page's text that the text, HTML and RTF exporters work from (M92).
 *
 * This is deliberately *structural*. `view/TextLayer.ts` (M13) already builds the one text model
 * this application has — reading order, one box per UTF-16 unit, lines, paragraphs — and every
 * word of it is right for an export. But `src/engine/` must not import `src/renderer/`, so rather
 * than inverting the layering, the exporters state the shape they need and M13's `PageText`
 * satisfies it without either side importing the other. There is still exactly one text model.
 *
 * The invariants the exporters rely on, which are M13's own:
 * - `chars.length === text.length`, so an offset into `text` is always an index into `chars`.
 * - every line ends with a `\n` that is in `text` and has a zero-width box in `chars`.
 * - `lines` and `paragraphs` hold half-open `[start, end)` offsets into `text`, `end` excluding
 *   the separator.
 */

/** A rectangle in page space, origin bottom-left — `@shared/pdf`'s `PdfRect`. */
export interface TextRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** One character's box and which run it came from. */
export interface TextCharBox {
  readonly rect: TextRect;
  readonly run: number;
  readonly synthetic: boolean;
}

/** A run of text with one font, size and colour — the engine's `TextRun`, in the part used here. */
export interface TextRunLike {
  readonly text: string;
  readonly fontName: string;
  readonly fontSize: number;
  readonly color: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

export interface TextLineLike {
  readonly start: number;
  readonly end: number;
  readonly rect: TextRect;
  readonly angle: number;
  readonly fontSize: number;
}

export interface TextParagraphLike {
  readonly start: number;
  readonly end: number;
  readonly rect: TextRect;
  readonly lines: ReadonlyArray<number>;
}

/** Everything textual about one page. `view/TextLayer.ts`'s `PageText` satisfies this. */
export interface PageTextLike {
  readonly page: number;
  readonly runs: ReadonlyArray<TextRunLike>;
  readonly text: string;
  readonly chars: ReadonlyArray<TextCharBox>;
  readonly lines: ReadonlyArray<TextLineLike>;
  readonly paragraphs: ReadonlyArray<TextParagraphLike>;
}

/** A page of a document as an exporter sees it: its text, its size, and its pictures. */
export interface ExportPage {
  /** 0-based index in the document. */
  readonly index: number;
  /** Page size in points, as the reader sees it (rotation already applied). */
  readonly width: number;
  readonly height: number;
  readonly text: PageTextLike;
  /** The page's own label, when the document numbers its pages itself. */
  readonly label?: string;
  /** Pictures on the page, already encoded, for the HTML export to embed. */
  readonly images?: ReadonlyArray<ExportPageImage>;
}

/** One picture on a page, ready to be written into an HTML file. */
export interface ExportPageImage {
  /** Where it is drawn, in page space. */
  readonly rect: TextRect;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  /** Alternative text, when the document has any. */
  readonly alt?: string;
}

/** The attributes of the run a character came from, with sensible answers for a missing one. */
export function styleAt(
  page: PageTextLike,
  offset: number,
): {
  readonly fontName: string;
  readonly fontSize: number;
  readonly color: number;
  readonly bold: boolean;
  readonly italic: boolean;
} {
  const box = page.chars[offset];
  const run = box === undefined ? undefined : page.runs[box.run];
  return {
    fontName: run?.fontName ?? '',
    fontSize: run?.fontSize ?? 11,
    color: run?.color ?? 0,
    bold: run?.bold ?? false,
    italic: run?.italic ?? false,
  };
}

/** The text of a line without its separator. */
export function lineText(page: PageTextLike, line: TextLineLike): string {
  return page.text.slice(line.start, line.end);
}
