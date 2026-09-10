# ADR 0019 — Export contracts: `pageImages` on `PdfEngine`, and a pure `engine/export/`

Status: accepted (M92, 2026-09-10)

## Context

M92 converts pages or a whole document to PNG / JPEG / TIFF / BMP, and to text, HTML and RTF.
Four of those five needs are already met by contracts that exist:

- **Pixels** come from `PdfEngine.render(doc, page, scale, rect, options)`. Rendering at a chosen
  DPI is `scale = dpi / 72`; annotations, form widgets, greyscale and print appearance are already
  `RenderOptions` flags.
- **Text** comes from `PdfEngine.textRuns(doc, page)`, turned into reading order, lines and
  paragraphs by `view/TextLayer.ts` (M13).
- **Where the pictures are on a page** comes from `PdfEngine.pageObjects(doc, page)`, which
  already reports `kind: 'image'`, a rect, a matrix and the stored pixel size.
- **Writing many files** is `file:writeInto` (M42) and `file:saveAsDialog` (M21). No new IPC.

One need is not met. "Export all images from the document, with the original format when DCT or
JPX" is about the image XObject's **own stream**, not about how it looks on the page. Nothing in
`PdfEngine` can reach a content object's bytes: `objectAsPdf` (M50) wraps an object in a
one-object PDF, which is the wrong answer for "give me the JPEG that is already in this file".

## Decision

### 1. `PdfEngine.pageImages?(doc, page)` — new, optional, additive

```ts
export type EmbeddedImageEncoding = 'jpeg' | 'jp2' | 'rgba';

export interface EmbeddedImage {
  readonly page: PageIndex;
  /** Index into `pageObjects(page)`, so a caller can tie it back to the object it came from. */
  readonly index: number;
  /** Stored pixel size — the image's own resolution, not the size it is drawn at. */
  readonly width: number;
  readonly height: number;
  /** Where it is drawn, in page space. */
  readonly rect: PdfRect;
  /** Effective resolution on the page, from the stored size and the drawn size. */
  readonly dpiX: number;
  readonly dpiY: number;
  /** The stream's filter chain, outermost last, as PDF names (`"DCTDecode"`). */
  readonly filters: ReadonlyArray<string>;
  readonly encoding: EmbeddedImageEncoding;
  /**
   * `jpeg` / `jp2`: the stream exactly as the file stores it — a usable `.jpg` / `.jp2`.
   * `rgba`: decoded pixels, rows top-down, soft mask already applied.
   */
  readonly data: Uint8Array;
}
```

The method is **optional**, like `pageObjectPaths` (ADR 0018): a backend that cannot do it simply
does not declare it, `serveEngine` answers `not-implemented`, and the caller degrades to
rendering. It is added to `ENGINE_METHODS` so `EngineClient`'s proxy forwards it.

**Why `encoding` rather than a `format` string.** The raw stream is a usable JPEG only when the
image stream carries exactly one filter. `[FlateDecode, DCTDecode]` is legal and its raw bytes are
deflated JPEG; a crypt filter is another case. So the adapter takes the raw bytes only when
`FPDFImageObj_GetImageFilterCount() === 1` and that filter is `DCTDecode` or `JPXDecode`, and
otherwise reports `rgba` from `FPDFImageObj_GetRenderedBitmap`, which applies the `/SMask` for us.
The caller then never has to guess: `jpeg` → write `.jpg`, `jp2` → write `.jp2`, `rgba` → encode.

**Why per page.** A scanned document is one large image per page; returning the whole document's
images in one array would put every one of them in memory at once, and the RPC would copy them all
across the worker boundary in a single message. One page at a time keeps the memory flat and lets
the progress bar move.

### 2. `src/engine/export/` is pure

The same shape M41's `src/engine/ops/` (ADR 0016) and M91's converters (ADR 0011) already have,
and for the same reasons:

- progress is `(fraction | null, message)`, cancelling is an `AbortSignal`, an aborted export
  throws `ExportCancelled` and produces nothing;
- no DOM, no Electron, no engine handle — so every encoder is tested in Node against pixels a test
  drew itself, and M120's batch runner and M121's command line can call the same functions;
- pixels arrive through a `RenderPage` callback the caller supplies, rather than the exporter
  holding an engine.

`src/engine/` must not import `src/renderer/`, so the text exporters declare the _structural_
shape of a page's text (`export/textModel.ts`) that `view/TextLayer.ts`'s `PageText` already
satisfies. Nothing is imported in either direction and there is still only one text model.

## Alternatives rejected

- **Extending `pageObjects` with the bytes.** The viewer, M50 and M33 all call it on every page
  they touch; carrying a megabyte of JPEG in a hit-test answer would be paid by everything.
- **`objectAsPdf` and then parsing the result.** It exists, but it answers a different question,
  and re-parsing our own output to find the stream we started from is a long way round.
- **Rendering the page and cropping to the image's rect.** That is the _drawn_ image at the page's
  resolution with everything drawn over it, not the picture that is in the file.

## Consequences

- `PdfEngine`, `ENGINE_METHODS` and `PdfiumEngine` gain one method. Nothing existing changes
  signature, so no other module has to move.
- The wasm build already exports every PDFium function this needs
  (`FPDFImageObj_GetImageDataRaw`, `GetImageFilterCount`, `GetImageFilter`, `GetImageMetadata`,
  `GetRenderedBitmap`); `Ffi.has()` guards each one so an older build degrades rather than throws.
- Export adds no IPC channel and no `Command`: it reads a document and writes files beside it.
