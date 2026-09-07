# ADR 0006 — PDFium adapter: WebAssembly in the renderer worker (measured), native kept in reserve

- Status: accepted
- Date: 2026-09-07
- Module: M10 (engine layer)

## Context

`PLAN.md` §8.2 left the PDFium hosting question open: PDFium compiled to WebAssembly running in
the renderer's Web Worker (`@hyzyla/pdfium`), or native PDFium (`pdfium-binaries`) called from
the main process through `koffi` FFI and bridged over IPC. The M10 brief set targets and asked
for a measurement before deciding: render a 300-dpi A4 scan page and a vector-heavy CAD page as
a 1× DPR tile set in under 150 ms, and extract `textRuns` from a 500-page text document in
under 30 ms per page. It also required the full read API (text with glyph boxes, page objects,
annotations, forms, outline, layers, attachments, metadata, links, labels) and consistent
font substitution across the three OSes.

## What we found

1. **The wasm build exports the complete PDFium public C API** — 448 `FPDF*`/`FORM_*` symbols
   including `fpdf_annot`, `fpdf_edit`, `fpdf_formfill`, `fpdf_text`, `fpdf_doc`, `fpdf_attachment`,
   `fpdf_save`, `fpdf_structtree` and `fpdf_ppo`. Nothing we need is missing at the C level.
2. **But callbacks were impossible.** The binary's indirect function table is declared with
   `min = max = 3023`, so `WebAssembly.Table.grow()` throws and no JavaScript function can be
   handed to PDFium as a C function pointer. That blocks `FPDF_SetSystemFontInfo` (font
   registration), `FPDF_SaveAsCopy` (needs `FPDF_FILEWRITE.WriteBlock`), `FPDF_LoadCustomDocument`
   (streaming), and `IFSDK_PAUSE` (progressive rendering — our cancellation mechanism). The
   emscripten runtime helpers (`addFunction`, `FS`) are not exported either, so fonts cannot be
   dropped into the virtual file system as an alternative.
3. **A one-section patch fixes it.** The wasm table section is rewritten at load time to drop the
   maximum (`src/engine/pdfium/wasm.ts`, `patchTableLimits`); the binary shrinks by two bytes
   and `WebAssembly.validate` still passes. Our own `addFunction` compiles a two-instruction
   wrapper module per callback, exactly as emscripten does internally. With that, font
   registration, save and progressive/cancellable rendering all work (unit-tested).
4. **PDFium has no public API for optional-content groups or the XMP stream.** Neither adapter
   would help; the catalog is read with pdf-lib (already the project's writer) and, for
   encrypted files, from a security-stripped copy produced by `FPDF_SaveAsCopy`.
5. **Two PDFium API gaps needed the same raw pass:** `FPDFAnnot_GetColor` refuses to answer once
   an annotation has an appearance stream (and PDFium generates one for most markup subtypes on
   page load), and `FPDFAnnot_GetBorder` ignores `/BS /W`. `FPDFAttachment_GetStringValue` only
   reads the embedded stream's `/Params`, not the file specification's `/Desc`.

## Measurements

Windows 11, x64, Node 26.7, `@hyzyla/pdfium` 2.1.13, 24 bundled font files registered
(`npm run bench`, median of 5 for tile sets; raw JSON in `docs/bench/engine-win32-x64.json`):

| Measurement                                         | Result          | Target   |
| --------------------------------------------------- | --------------- | -------- |
| open 300-dpi A4 scan (250 KB)                       | 2.1 ms          |          |
| scan: 1× DPR tile set (4 × 512 px tiles)            | 18.4 ms         | < 150 ms |
| scan: full page at 2×                               | 35.0 ms         |          |
| open CAD page (20 000 lines, 1.7 MB)                | 0.2 ms          |          |
| CAD: 1× DPR tile set (4 × 512 px tiles)             | 62.8 ms         | < 150 ms |
| CAD: `pageObjects` (20 400 objects)                 | 39.2 ms         |          |
| open 500-page text document (522 KB)                | 1.2 ms          |          |
| `textRuns`, average per page over 500 pages         | 1.5 ms          | < 30 ms  |
| text page, full render at 1×                        | 6.9 ms          |          |
| `pageLabels` for 500 pages                          | 0.5 ms          |          |
| PDFium wasm instantiate + init                      | ~15 ms          |          |
| 50 queued renders cancelled mid-scroll → next reply | < 100 ms (test) | < 100 ms |

Every target is met with a margin of 2.4× (CAD) to 20× (text). The wasm build carries
emscripten assertions (a debug-flavoured runtime); a release build would only be faster.

## Decision

**PDFium WASM is the engine.** `PdfiumEngine` (`src/engine/pdfium/`) drives the C API directly
through a small FFI layer inside the renderer's engine Worker; the wrapper classes of
`@hyzyla/pdfium` are not used. The table patch and `addFunction` are part of the adapter and
covered by tests. No native binary, no IPC bridge, no `koffi`, and every OS runs byte-identical
engine code, which is why the render-hash regression files are shared across platforms.

`PdfiumNativeEngine` (pdfium-binaries + koffi in the main process) is **not built**. The
interface does not change if it ever is: `PdfEngine` is the contract, and the native path is
documented here as the fallback for a future need (very large scans where wasm memory becomes
the limit, or a PDFium feature compiled out of the wasm build — none found so far).

Supporting decisions:

- **Fonts.** Liberation 2.1.5 and DejaVu 2.37 are fetched at build time (`resources/binaries.json`,
  archive extraction added to `scripts/fetch-binaries.ts`) and registered through
  `FPDF_SetSystemFontInfo`; the mapping is the data file `resources/fonts/substitutions.json`.
  Unknown Latin faces are left to PDFium's built-in metric-compatible Foxit fonts; unknown faces
  in Greek, Cyrillic, Hebrew, Arabic, Baltic or Central-European charsets go to DejaVu. CJK has
  no bundled font (text extraction works, glyphs render as PDFium's fallback); a CJK font is a
  data-file addition when M90/M130 need it.
- **Loading.** The 4 MB wasm and the font files are inlined into the worker bundle as base64
  (`?inline`, fonts via `import.meta.glob` as lazy chunks) because `fetch()` of `file://` fails
  under `loadFile`. Boot cost is paid once per window in the worker, off the UI thread.
- **Cancellation.** Progressive rendering (`FPDF_RenderPageBitmap_Start/Continue`) with an
  `IFSDK_PAUSE` that yields every ~20 ms, a serialised request queue in the worker and a `cancel`
  RPC message (ADR 0005).
- **Layers / XMP / annotation colours / attachment descriptions** come from a lazily parsed
  pdf-lib view of the catalog, computed once per document and only when asked.

## Consequences

- `pdf-lib` and `@hyzyla/pdfium` become runtime dependencies (both MIT; licence gate passes).
- The wasm build is pinned exactly (`2.1.13`); upgrading means re-running the table-patch test,
  the corpus test and `npm run hashes`, and re-checking the export list.
- Mutation methods stay `NotImplementedError` (M20+); `save` already works via `FPDF_SaveAsCopy`.
- `RenderOptions.layers` overrides are accepted but not applied yet — PDFium exposes no OCG
  toggle; M12 can hide per-object marked content through `FPDFPageObj_SetIsActive`.
- No local toolchain was installed (`README.md` "Installing local toolchains" stays empty).
