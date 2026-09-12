# M92 — Export to images, text, HTML & RTF

| | |
|---|---|
| **Module id** | `M92` — folder `src/renderer/modules/M92-export/`, branch `mod/M92-export` |
| **Earliest wave** | 5 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M11, M13 |
| **Unlocks** | [M120 Batch processing & action wizard](./M120-batch-actions.md) |

## Your task — the prompt for this conversation

You are building **M92 — Export to images, text, HTML & RTF** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M11 Viewer — rendering, navigation, zoom, layouts](./M11-viewer.md), [M13 Text selection, find, copy, snapshot & print](./M13-select-find-print.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M92-export` from `main` in a new git worktree and
   work there.
3. Fill in **Design decisions** below (short, concrete) before writing code;
   update it as you go. Write ADRs for any contract change.
4. Implement the **Scope** section — all of it, not the easy parts. Every
   document change is an undoable `Command`; every user action is a
   registered command with a palette entry and, where sensible, a shortcut.
5. Write the tests listed under **Acceptance tests** (plus whatever unit
   tests you needed while building). Run `npm run lint`, `npm test`,
   `npm run e2e` locally, then push and make CI green on all three OSes.
6. Merge to `main` (PR if the remote supports it, else fast-forward), tick
   this module ☑ in `PLAN.md` §0 in the same merge, and fill in the
   **Build log** below with what shipped, what was deferred and why.
7. Report back in a few plain lines: what works, what to try, anything 
   Tony must do by hand.

---

## Purpose

Convert pages or the document to PNG/JPEG/TIFF/BMP (with DPI, ranges,
naming), and to text, HTML and RTF using the text layer.

## Foxit 14 reference — what to emulate

Foxit Convert → To Image (format, DPI, colour, range, one file per page or
multi-page TIFF), To Text, To HTML (single page/paginated), To RTF; Export
all images.

## Scope — build all of this

- Export-to-image dialog: format, DPI, colour/greyscale/mono, range, per-
  page files with naming pattern or multi-page TIFF, JPEG quality, PNG
  compression, include annotations/forms; runs in worker with progress.
- Export all images from the document (embedded image objects) with
  original format when DCT/JPX.
- Text export: reading order from M13's grouping, page separators option,
  encoding UTF-8/UTF-16.
- HTML export: single HTML with positioned text (absolute) or flowing
  paragraphs (heuristic), images as embedded PNG, per-page or single file,
  tokens-based stylesheet.
- RTF export: paragraphs/fonts/sizes/bold/italic via a small RTF writer.

## Out of scope

Office formats (M93).

## Design notes & constraints

- TIFF writer in-house or `utif` (encode) — verify multi-page support.

## Files you will create or touch

`src/renderer/modules/M92-export/**`, `src/engine/export/**`, tests.

## Libraries

_Credit rule (Tony): every open-source component this module adds
must be creditable by M131's generated acknowledgements page — npm
packages need only a licence in their metadata; binaries/WASM go in
`resources/binaries.json` with `license`, `homepage`, `copyright`; anything
vendored, adapted or copied (code, icons, fonts, data) goes in
`resources/credits.json`. Permissive licences only (MIT, BSD, ISC,
Apache-2.0, 0BSD, OFL for fonts; MPL-2.0 only for an external program the
user installs, never bundled). **Never bundle or link, however tempting:
Ghostscript, MuPDF, iText (AGPL); Poppler/pdftotext/pdftoppm, pdf2htmlEX,
GPL-only Hunspell dictionaries (GPL).** Dual-licensed packages are used
under their permissive option and credited as such (`node-forge` = BSD).
The app is sold commercially; a copyleft component would block that._

utif, pngjs, jpeg-js.

## Acceptance tests — the module is done when these pass on all three OSes

- Export 3 pages at 150 dpi PNG ⇒ pixel dimensions match page size × dpi;
  multi-page TIFF has 3 frames.
- Text export equals engine text; HTML opens in Chrome with the same
  reading order; RTF opens in WordPad (recorded).

---

## Project context (identical in every module brief — read once per session)

**ynotPDF** is a cross-platform (Windows / macOS / Linux) desktop PDF editor
targeting the feature set of **Foxit PDF Editor 14** — *feature set only*:
**never copy Foxit's icons, artwork, wording, help text or documentation.**
Industry-standard icon conventions shared by Adobe, Foxit, Tungsten and
others (magnifier = zoom, hand = pan, highlighter, stamp, padlock, pen for
sign) are generic — use them freely; what must not be copied is Foxit's
*specific artwork*: its exact shapes, colours, pixel layouts. Icons come
from **Lucide (ISC) first**; when it lacks one, **Tabler Icons (MIT)** or
**Phosphor (MIT)** — same stroke style — then Fluent UI System Icons (MIT),
Material Symbols / Remix Icon (Apache-2.0); otherwise draw our own in the
Lucide stroke style. Not Font Awesome, Flaticon/Freepik, Noun Project or
Icons8. **Clipart / illustrations** (stamps, cover sheets, help, first
run): Openclipart and Public Domain Vectors (CC0), Wikimedia Commons (only
files marked CC0 / public domain / CC BY), unDraw and Pixabay (own free
commercial licences). Never CC BY-SA, BY-NC or BY-ND; never Freepik,
Flaticon, Vecteezy, Clker or image-search results. CC0 preferred, CC BY
acceptable. Every set and every clipart item used is entered in
`resources/credits.json` with source URL, author and licence. Similar in
idea or better, never traced or pixel-copied. **Never open, read, extract or decompile anything from an
installed Foxit, Adobe or Tungsten product** (e.g. `C:\Program Files\Foxit
Software\…`) — not icons, strings, templates, fonts, help, stamps or
JavaScript; their EULAs forbid it and it would leave a copying trail. Learn
their behaviour only as a user would, from the running app and public
documentation. Record in your Design decisions where a feature's
behaviour came from (public docs, the PDF spec ISO 32000, our own choice)
— this file is the provenance record. Help and
documentation are written from scratch for ynotPDF. *(Tony's rule,
2026-09-09.)* Four colour themes
and a dark default. Project root: `D:\Projects\ynotPDF` (Windows path;
`/d/Projects/ynotPDF` in Git Bash). Master plan: `PLAN.md`. Session rules:
`CLAUDE.md`. This brief is one module of that plan.

**Stack (fixed — do not substitute):**
- **TypeScript** end-to-end, `strict`. **Electron** shell, **electron-vite**
  build, **vitest** unit tests, **Playwright** e2e. Node 26.
- **Vanilla DOM UI, no framework.** State → DOM via the in-house store in
  `src/renderer/core/store.ts`.
- **PDF engine:** PDFium (BSD) behind the `PdfEngine` interface in
  `src/engine/PdfEngine.ts`, running in a Web Worker. Writing via **pdf-lib**
  (MIT); structural work via **qpdf** (Apache-2.0); fonts via **fontkit**
  (MIT); OCR via **Tesseract** (Apache-2.0). Permissive licences only —
  never MuPDF, iText, Ghostscript or anything AGPL/commercial.
- **No Docker, ever** (build or runtime). The installer is self-contained;
  native binaries are bundled per OS **and CPU architecture** and fetched
  at build time by `scripts/fetch-binaries.ts` (`resources/binaries.json`,
  pinned checksums, git-ignored). **Supported targets: Windows x64 and
  Windows arm64, macOS universal (x64 + arm64), Linux x64.** Any module that
  adds a native binary must supply a `win32-arm64` entry or a WASM fallback
  that is used automatically on that architecture — the arm64 installer must
  never ship a feature that silently fails. Installing
  build toolchains locally (Rust, C++, emsdk) is pre-approved if a module
  needs one — record it in `docs/adr/` and `README.md`.

**Architecture contracts (stubbed by M00; code against these):**
- `PdfEngine` — open/close, pageCount, pageSize, render(page, scale, rect) →
  ImageBitmap, textRuns, pageObjects, annotations, formFields, outline, layers,
  attachments, metadata, plus mutation counterparts. Runs in a Worker; the
  renderer talks to it through `src/engine/EngineClient.ts`.
- `Document` (`src/renderer/core/Document.ts`) — in-memory model (pages,
  annotations, fields, objects, metadata) plus a journal of `Command`s. Engine
  = source of truth for bytes; Document = source of truth for intent.
- `Command` — `{ id, label, do(), undo(), merge?(next) }`. **Every document
  change is a Command** so undo/redo, autosave and batch all work for free.
- `Tool` — pointer/keyboard handler bound to a page overlay layer. One
  active tool at a time. Modules provide tools.
- `ModuleManifest` (`src/shared/module.ts`) — a module folder exports
  `manifest.ts` registering commands, ribbon groups, panels, tools,
  shortcuts and a settings schema. The shell is data-driven from manifests.
- Page overlay layers, bottom → top: raster canvas · text layer · annotation
  layer (SVG) · form-widget layer · object-edit layer · tool layer.
- IPC: renderer ↔ main only through the typed API in `src/shared/ipc.ts`,
  exposed by `src/preload/`.

**Folders:** `src/main/` (Electron main) · `src/preload/` · `src/shared/`
(types, IPC, manifest type) · `src/engine/` (engine + adapters, Worker) ·
`src/renderer/app/` (shell) · `src/renderer/core/` (Document, Command,
Store, Registry, Selection) · `src/renderer/view/` (PageView, Viewport,
tiles, layers) · `src/renderer/theme/` · `src/renderer/modules/<Mid>-<slug>/`
(**your module lives here**) · `resources/` · `test/{fixtures,unit,e2e}` ·
`docs/{adr,modules}` · `scripts/`.

**UI & accessibility rules (non-negotiable — Tony has low vision and is
colourblind: black and red read as the same colour):**
- Colours **only** via theme tokens (`--bg-app`, `--bg-panel`, `--fg`,
  `--fg-muted`, `--icon`, `--accent`, `--border`, `--focus`, `--selection`,
  `--danger`, `--warning`, `--success`, `--info`, …). Never a literal.
- Text ≥ 4.5:1, icons/borders ≥ 3:1 in all four themes (Graphite dark
  default, Midnight, Daylight, High Contrast). No grey-on-dark text.
- **Never differentiate by red/green or gold/green alone.** Status = word +
  icon. Distinguish on blue↔yellow and lightness.
- Modals/overlays/popups **fully opaque**: no `rgba()` alpha < 1, no
  `opacity` < 1, no `backdrop-filter`.
- Every control keyboard-reachable with a visible focus ring; every command
  registered so it appears in the command palette (Ctrl/Cmd+Shift+P).
- Icons: **Lucide** (ISC), stroke, `currentColor`.

**Working conventions:**
- Branch `mod/<Mid>-<slug>` from `main`, in its own git worktree
  (`git worktree add ../ynotPDF-<Mid> mod/<Mid>-<slug>`). Merge to `main`
  only when acceptance tests pass in CI on all three OSes.
- Write only inside your module folder, your engine adapter file(s), your
  tests, `resources/` data and this spec. Edits to shared files
  (`src/shared`, `src/renderer/core`, `src/renderer/app`, `package.json`)
  must be minimal, additive, and listed in the PR description. Changing a
  contract needs an ADR (`docs/adr/NNNN-*.md`) merged first as its own PR.
- **A feature is not covered until a test reaches it the way a person does**
  (M04). Asserting that something is *visible* is not asserting that it is
  *usable*: a UI test presses the button by its **visible label**, clicks the
  panel tile, clicks the page, and then asserts *where* things are —
  `test/e2e/journey.ts` and `test/e2e/layout.ts` are the helpers, and
  `test/README.md` states the rule in full. `app.run(...)` is for setup, never
  for the action under test.
- Data that can change (presets, stamp catalogues, substitution tables)
  goes in `resources/` data files, not code.
- Commits: `<Mid>: <what>` and end with
  `Co-Authored-By: Claude <noreply@anthropic.com>`. Never commit real
  customer PDFs, binaries, or secrets — fixtures are public-domain/synthetic.
- **Real sample PDFs for hands-on testing live in `test/fixtures/local/`**
  (git-ignored; Tony drops files there, so they carry personal
  data). Currently: three airline boarding passes and **`Sample
  Portfolio.pdf`, a Foxit-made PDF Portfolio (`/Collection`) containing
  those three** — use it for attachments, embedded-file and portfolio
  behaviour. Open them when you manually check
  your module against real-world files, and prefer them over synthetic
  fixtures for "does it look right" judgements. Tests may use them only
  with `it.skipIf(!existsSync(...))` — CI and other machines don't have
  them. Never copy, commit or quote their contents; `local/README.md`
  lists what is there.
- **Tony is who you are working for — call him Tony, not "the operator"**
  (2026-09-11). `CLAUDE.md`, `PLAN.md` and every module brief use his name.
  Source comments and ADRs still say "the operator" in places; that is
  history, not a style to copy. New writing uses his name.
- Replies to Tony: short and plain (eyesight). Never leave him a to-do you
  could do yourself.

---

## Design decisions (fill in before coding; keep current)

- **Group 4 completion (2026-09-12).** Reuse M100's public `encodeGroup4` with unpacked
  monochrome samples; TIFF uses Compression 4, WhiteIsZero, MSB-first fill order and
  T6Options 0 (TIFF 6.0 section 11 / ITU-T T.6). Reject colour or grey frames, and explain
  incompatible choices in the dialog. Pass the compression choice to both per-page and
  multi-page output. Prove pixels with the independent utif decoder, including row padding.

- **Everything that decides what a file contains is pure, and lives in `src/engine/export/`.**
  Bytes and pixels in, bytes out — no DOM, no engine handle, no Electron — exactly the shape
  M41's ops and M91's converters already have (`OpContext` = a progress callback and an
  `AbortSignal`). That is what lets one implementation serve the dialogs, M120's batch runner and
  M121's command line, and it is what makes an encoder testable in Node against a picture the
  test drew itself.
- **The renderer supplies pixels; the exporter never asks for them.** `exportPagesToImages` takes
  a `renderPage(index, dpi)` callback, so the pure code is the same whether the pixels came from
  PDFium in the app or from an array in a test. The module's side of that callback is the engine's
  `render()` plus M41's `renderRaster` trick for pulling RGBA out of an `ImageBitmap`.
- **Our own PNG, TIFF and BMP writers; the platform's JPEG.** The brief suggested `pngjs` and
  `utif`; neither survived contact:
  - `pngjs` is a Node stream API around `Buffer` and `zlib`, which is not what a Worker has.
    PNG is a header, a `pHYs` chunk, filtered scanlines and one deflate stream, and `pako` is
    already a dependency (M91 installs it for utif), so `codecs/png.ts` is in-house. It is also
    the only way to get the two things the dialog offers: a real DPI in the file, and a chosen
    compression level.
  - **`utif` cannot write a multi-page TIFF** — verified, not assumed: `UTIF.encode(ifds)` writes
    the IFD chain into a fixed 20 000-byte buffer and `UTIF.encodeImage` glues one image's pixels
    on at a hard-coded strip offset of 1000, so a second page has nowhere to put its strips. The
    design note asked for that check; the answer is an in-house writer (`codecs/tiff.ts`), which
    also buys 1-bit and 8-bit frames and Deflate/PackBits compression. `utif` stays where M91
    left it, decoding.
  - JPEG is `jpeg-js` (BSD-3, the brief's own choice) rather than a fourth in-house encoder,
    promoted from a dev dependency to a real one. It returns a `Buffer` when it can see a CJS
    `module`, which a bundled Worker can, so `codecs/installBuffer.ts` gives it a five-line
    `Buffer.from` the same way M91's `installPako.ts` gives utif its inflate. The JFIF density is
    patched afterwards, as `scripts/make-fixtures.ts` already does, so a 150 dpi JPEG says so.
- **Colour is a pipeline over RGBA, not a codec setting.** Greyscale (Rec. 601 luma) and
  monochrome (threshold, or Floyd–Steinberg) are one pure step in `pixels.ts` that every format
  shares, so "150 dpi, greyscale" means the same thing in PNG, TIFF and BMP.
- **The text model is M13's, and the engine layer does not import it.** `view/TextLayer.ts` is
  already the reading order, the lines and the paragraphs (M13's design decision, shared on
  purpose), and the text, HTML and RTF exporters work from exactly that. But `src/engine/`
  importing `src/renderer/view/` would invert the layering, so `export/textModel.ts` declares the
  *structural* shape it needs (`text`, `chars`, `lines`, `paragraphs`, `runs`) and `PageText`
  satisfies it without either side importing the other. The module builds the models with
  `buildPageText` and hands them over.
- **A second RTF writer, and it is not a duplicate of M13's.** M13's writes a clipboard
  *fragment*: a flat run of styled characters, because that is what "Copy with formatting" is.
  A document needs paragraph structure, page breaks, a default font and a header — so
  `export/rtf.ts` is the document writer. Both escape RTF the same way, which is 30 lines; the
  alternative was the engine layer importing a module's file, which is worse than the repetition.
- **Export changes nothing, so no `Command` is written.** The rule is that every *document change*
  is undoable; an export reads a document and writes files beside it. Every user action is still a
  registered command with a palette entry, and every one of them can be driven entirely from its
  arguments so the e2e suite runs it with no dialog in the way (M41's convention).
- **No new IPC.** M42 already added `file:writeInto` (write one file under a base directory,
  sanitised, creating directories) and `dialog:pickFolder`; M21 added `file:saveAsDialog`. Per-page
  export writes one file at a time through `file:writeInto`, which is what keeps the memory flat
  when a 500-page document becomes 500 PNGs.
- **One new engine method, `pageImages`, and it is optional (ADR 0019).** "Export all images with
  the original format when DCT/JPX" cannot be done from a render: it needs the image XObject's own
  stream. PDFium's `FPDFImageObj_GetImageDataRaw` gives it, and the raw bytes are a usable JPEG or
  JPEG 2000 file **only** when the stream has exactly one filter — otherwise the decoded pixels
  are the honest answer, and `FPDFImageObj_GetRenderedBitmap` provides them with the soft mask
  already applied. So the method returns `encoding: 'jpeg' | 'jp2' | 'rgba'` and the exporter
  decides the extension from that, never from a guess.
- **The exporter runs in its own Worker, and the engine stays where it is.** Encoding a 300 dpi A4
  page is 8 MP of filtering and deflating per page; on the main thread that is a frozen window and
  a Cancel button that cannot be pressed. The pixels come from the *engine* worker, cross to the
  renderer as an `ImageBitmap`, and are transferred on to the *export* worker as RGBA — the same
  two-worker split M41 uses, for the same reason (PDFium is not re-entrant and must not be asked
  to render while it is being driven by something else).
- **HTML has two modes because they answer two questions.** *Positioned* places every line at its
  own PDF coordinates in a `position: absolute` box inside a page-sized `<div>` — what the page
  looked like. *Flowing* keeps the paragraph grouping and drops the geometry — what the page
  said, and what survives being read on a phone. Foxit's "single page / paginated" is the third
  axis (one file or one per page) and is independent of both.
- **The generated stylesheet is token-based, but they are the export's tokens, not the app's.**
  A file that leaves the app has no ynotPDF theme behind it, so the HTML declares its own
  `--page-bg`, `--ink`, `--muted` on `:root` and every rule uses `var()`. The app's accessibility
  rules govern the app's chrome; a document's colours are the document's, and are carried across
  as the PDF stored them.
- **Images inside exported HTML are embedded, not written beside it.** A single `.html` that opens
  anywhere is worth more than a folder that must travel with it; the pictures are `data:` URIs of
  the same PNG encoder the image export uses. There is a size ceiling on it, and a warning when
  the ceiling is hit.
- **Ranges are M40's dialect.** `parseRange` already understands `1-3, 7, odd, even, current,
  selected`, and a second page-range grammar in the same app would be a bug waiting to be
  reported. Progress and cancelling are M40's `withProgress`, which only shows a dialog if the
  work turns out to be slow.

## Build log (fill in at merge)

**Built 2026-09-10 on `mod/M92-export` (worktree `../ynotPDF-M92`).** Green locally on Windows and
in CI on all three OSes: lint (eslint, prettier, the colour/opacity rules, the i18n check, `tsc`
on both projects), 3 607 unit tests with the coverage gates, and 459 Playwright tests.

**Shipped:**

- **`src/engine/export/` — the whole module's decisions, pure.** `types.ts` (the conventions),
  `pixels.ts` (flatten, grey, mono), `codecs/` (PNG, JPEG, TIFF, BMP), `naming.ts`, `images.ts`,
  `embedded.ts`, `textModel.ts`, `text.ts`, `html.ts`, `rtf.ts`. Pixels arrive through a
  `RenderPage` callback the caller supplies, so the same functions serve the dialogs, a unit test
  that draws its own pages, M120's batch runner and M121's command line.
- **Export to image**: format, resolution, colour (colour / greyscale / 1-bit), page range, one
  file per page with a name pattern or one multi-page TIFF, JPEG quality, PNG and TIFF compression
  level, TIFF compression method, and whether comments and form fields are drawn. Runs in its own
  Worker with a progress dialog and a Cancel button that works.
- **Four writers.** PNG (adaptive filtering, `pHYs`, colour types 0 at 1 and 8 bits and 2 at 8),
  TIFF (multi-page, 1 / 8 / 24-bit, None / PackBits / Deflate, resolution in inches), BMP (24 / 8 /
  1-bit, bottom-up, padded rows, `biXPelsPerMeter`) and JPEG (`jpeg-js` with the JFIF density
  patched in). Every one is round-tripped through an independent decoder in the unit tests.
- **Export all images**: the picture that is _in_ the file. A stream whose only filter is
  `DCTDecode` or `JPXDecode` is written out byte for byte as `.jpg` / `.jp2`; anything else is
  read at its own resolution and written as PNG. The same picture drawn on many pages is written
  once, and it says how many it merged.
- **Text**: M13's reading order, five page separators, UTF-8 / UTF-16LE / UTF-16BE, LF or CRLF, an
  optional BOM, optional blank-line stripping.
- **HTML**: positioned (every line at its PDF coordinates in a page-sized box) or flowing (M13's
  paragraphs, reflowable), one file or one per page, pictures embedded as `data:` URIs under a
  size ceiling, and a token-based stylesheet that lives in `resources/export/html.css` as data.
- **RTF**: a document writer — paragraphs, page breaks, paper size, font table, colour table,
  sizes, bold and italic, and pure ASCII by construction so any reader opens it.
- **Five dialogs**, each opaque, keyboard-reachable and carrying a live line saying what will
  actually be written (the pixel size of a page, the number of files). The page-range field, the
  checkbox and the select are **M41's** `fields.ts`, so there is one page-range dialect in the app
  rather than two.
- **Two progress passes, not one.** The encoding runs under M40's progress dialog, and so does
  the writing: a five-hundred-page export is five hundred IPC round trips after the work is done,
  and it used to spend those seconds with nothing on screen. Both appear only if the job turns out
  to be slow, both can be cancelled, and a cancelled write says how many files it got to.
- **Docs**: ADR 0019, `docs/shortcuts.md`, a module README.

**The engine change, and the bug the acceptance test found.** `pageImages` (ADR 0019) is one new
optional `PdfEngine` method. Its first cut answered with `FPDFImageObj_GetRenderedBitmap`, which
renders an image at the size the _page draws it_ — so `image.pdf`'s one 64×64 PNG, drawn once at
256 pt and once at 128 pt rotated, came back as two different pictures and was exported twice. The
adapter now reads the stream's own samples (`FPDFImageObj_GetImageDataDecoded`) at the image's own
resolution for the three lossless layouts that need no colour conversion — 24-bit DeviceRGB, 8-bit
and 1-bit DeviceGray — and falls back to the rendered bitmap for everything else. That is what
"export all images" means, and it is what makes the de-duplication work at all.

**Other bugs the tests found, all real:**

- The JFIF density was being written two bytes early, over the version field. The write and the
  read were wrong in the same way, so they round-tripped happily; the test that asserted a _fresh_
  `jpeg-js` file declares no resolution is what caught it.
- Vitest hands back an **empty string** for a `?raw` CSS import unless `css: true` is set. The
  exported HTML would have shipped with an empty `<style>` block and no test could have told —
  the assertion that the stylesheet declares `--page-bg` failed the moment the stylesheet moved
  into `resources/`.
- Every dialog called `handle.setEnabled` from inside its own `content` callback, which the dialog
  service runs _before_ `open()` returns — a temporal-dead-zone `ReferenceError` on the first
  paint. They use the handle the callback is given instead.
- The first acceptance test asserted A4 for all three pages of `multipage.pdf`, which is mixed
  sizes on purpose; page 3 is US Letter. It now asks the engine for each page's own size, which is
  what "page size × dpi" actually means.
- **Every `style="..."` attribute in the exported HTML was closing early.** `fontStack` quoted a
  family name with double quotes, which ends the attribute and turns the rest of the line into
  stray markup. The reading-order test could not see it — the words were all still there and still
  in order, just no longer in a positioned box — and neither could looking at the file, until the
  markup was read line by line. Font names are single-quoted now, every attribute value goes
  through an attribute-specific escape, and two tests were added that would have caught it: one
  reads the raw markup for a quote inside an attribute value, and one asks a real Chromium what it
  *computed* for the first line (`position`, `left`, `top`, `font-family`, `font-size`).
- A rotated line was written as `rotate(-330deg)`. It renders identically to `rotate(30deg)`, but
  it is not what anyone means; the angle is normalised into (−180°, 180°] now.

**The manual checks the brief asks for, recorded.**

- _"HTML opens in Chrome with the same reading order"_ — done objectively rather than by eye:
  `test/e2e/export.spec.ts` loads the exported file into a real Chromium `BrowserWindow` in the
  running app and compares `document.body.innerText`, word for word, with the plain-text export of
  the same pages. They are identical.
- _"RTF opens in WordPad"_ — the file is loaded into a `System.Windows.Forms.RichTextBox`, the
  RichEdit control WordPad is built on, from PowerShell on Windows 11; it parses, and its text
  carries the document's words. The test runs on the Windows CI runner and skips elsewhere.

**Shared files touched (minimal, additive, per ADR 0019):** `src/engine/PdfEngine.ts` (one optional
method, its types, its `ENGINE_METHODS` entry and a `NotImplementedEngine` stub),
`src/engine/pdfium/PdfiumEngine.ts` and `constants.ts` (the adapter for it), `src/renderer/main.ts`
and `src/renderer/index.html` (register the module, link its stylesheet), `vitest.config.ts`
(coverage include, excludes, gates and `css: true`), `package.json` (`jpeg-js` from a dev
dependency to a real one), `docs/shortcuts.md` and `PLAN.md` §0. **No IPC channel was added and no
`Command` is written** — an export reads a document and writes files beside it.

**Deferred, and why:**

- **Office formats** — M93's, explicitly out of scope.
- **CCITT Group 4 for bilevel TIFF was deferred in the original build.** Completed in the
  2026-09-12 follow-up below by reusing M100's public encoder.
- **Greyscale and bilevel JPEG.** `jpeg-js` encodes 4:2:0 colour only, so a greyscale JPEG is grey
  pixels in three channels. The dialog says so in words rather than pretending otherwise; PNG and
  TIFF keep grey at one channel and mono at one bit.
- **Indexed, CMYK and ICCBased images come out of "export all images" as a render** rather than as
  their stored samples, because reading those needs the colour space as well as the stream. They
  are still the right picture in the common case. Named here so the next person knows where the
  line is.
- **`/SMask` is not applied** to a stored picture. The transparency a page applies when it draws a
  picture belongs to the drawing, not to the picture — and applying it would make the same logo on
  two hundred pages two hundred different files again.
- **A File ▸ Export backstage page.** `BackstageSlot` is a fixed list in M02's contract (ADR 0004);
  adding one would be a contract change for a second route to five commands that are already on
  the Convert tab, in the palette and on a shortcut.
- **Exporting a _selection_ rather than pages.** M13 owns the text selection and already copies it
  as text and RTF; "export the selection to a file" would be a third path to the same bytes.

### Completion follow-up — 2026-09-12

CCITT Group 4 now exports black-and-white TIFF pages, separately or in a multi-page file,
with resolution tags, correct polarity and byte-aligned source-row handling. The export
dialog and stored preferences expose the option and explain incompatible colour choices.
Separate TIFFs now also honour the existing None/PackBits/Deflate choice; the original
single-frame path had silently defaulted to Deflate.

Independent decoder tests compare every pixel for odd widths, all-black/all-white pages,
alternating pixels, shifted transitions and long runs; they verify strip bounds and IFD
termination. A second decoder (PDFium) verifies the short-strip case affected by utif's
existing dispatcher bug. Real UI journeys export files through the ribbon, options dialog,
Worker and filesystem, check remembered settings, and exercise all themes at 200% scale.
The detailed reading inventory, additional unfinished scope, decoder limitation and final
validation are in [the completion review](../reviews/M92-completion-review.md).
