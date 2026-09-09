# M91 — Create PDF from images, web pages, clipboard, HTML/Markdown & text

| | |
|---|---|
| **Module id** | `M91` — folder `src/renderer/modules/M91-create-pdf/`, branch `mod/M91-create-pdf` |
| **Earliest wave** | 2 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M21 |
| **Unlocks** | [M40 Organise pages — insert, delete, extract, replace, rotate, move, labels](./M40-organise-pages.md), [M41 Merge, split, extract to files, crop & flatten](./M41-merge-split-crop.md), [M120 Batch processing & action wizard](./M120-batch-actions.md) |

## Your task — the prompt for this conversation

You are building **M91 — Create PDF from images, web pages, clipboard, HTML/Markdown & text** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M21 Save, Save As, autosave & recovery](./M21-save.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M91-create-pdf` from `main` in a new git worktree and
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
7. Report back in a few plain lines: what works, what to try, anything the
   operator must do by hand.

---

## Purpose

File → Create: new PDFs (and pages for M40) from images, web pages,
clipboard, HTML/Markdown, and plain text, using pdf-lib and Electron's
own Chromium print-to-PDF.

## Foxit 14 reference — what to emulate

Foxit Create: Blank, From File (images, text, HTML, Office → M93), From
Multiple Files, From Scanner ✗, From Clipboard, From Web Page (URL, depth,
page settings), Combine (M41). Print-to-PDF virtual printer ✗.

## Scope — build all of this

- Converter registry (`engine/create/`): `{ accepts(mime/ext), convert(input,
  options) → PDF bytes }` used by File → Create, drag-drop of non-PDFs onto
  the window, M40 insert-from-file and M41 combine.
- Images (PNG/JPEG/TIFF multi-page/BMP/GIF/WebP/HEIC via OS if available):
  page size from image DPI or fixed size with fit options, margins,
  orientation, multiple images → pages, EXIF rotation, JPEG passthrough.
- Web page: hidden `BrowserWindow` (main) loads URL with settings (page
  size, margins, headers/footers, background graphics, scale, media type,
  timeout, link depth 1–n same-site crawl with progress), `printToPDF`,
  plus bookmarks per page; links preserved.
- HTML/Markdown files: same path via file URL (Markdown → HTML with a
  bundled stylesheet using tokens).
- Plain text: monospace/proportional, wrap, page size, header with
  filename.
- Clipboard: image or text → PDF.
- Blank document: size/orientation/count.
- Create dialogs opaque with preview where cheap.

## Out of scope

Office (M93). Scanner/virtual printer (Parked).

## Design notes & constraints

- All converters are pure over bytes except web (needs main), so CLI and
  batch reuse them.

## Files you will create or touch

`src/engine/create/**`, `src/main/webpdf/**`, `src/renderer/modules/M91-
create-pdf/**`, tests.

## Libraries

_Credit rule (operator): every open-source component this module adds
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

pngjs, jpeg-js, utif, marked (MIT).

## Acceptance tests — the module is done when these pass on all three OSes

- 5 mixed images → one PDF with correct page sizes and rotations;
  TIFF multi-page → n pages.
- A local HTML fixture with 3 linked pages, depth 2 ⇒ PDF with bookmarks
  and working internal links.
- Markdown → PDF renders headings/tables; text file → paginated with
  header.

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
Icons8. Every set used is entered in `resources/credits.json`. Similar in
idea or better, never traced or pixel-copied. **Never open, read, extract or decompile anything from an
installed Foxit, Adobe or Tungsten product** (e.g. `C:\Program Files\Foxit
Software\…`) — not icons, strings, templates, fonts, help, stamps or
JavaScript; their EULAs forbid it and it would leave a copying trail. Learn
their behaviour only as a user would, from the running app and public
documentation. Record in your Design decisions where a feature's
behaviour came from (public docs, the PDF spec ISO 32000, our own choice)
— this file is the provenance record. Help and
documentation are written from scratch for ynotPDF. *(Operator rule,
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

**UI & accessibility rules (non-negotiable — the operator has low vision and
is colourblind: black and red read as the same colour):**
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
- Data that can change (presets, stamp catalogues, substitution tables)
  goes in `resources/` data files, not code.
- Commits: `<Mid>: <what>` and end with
  `Co-Authored-By: Claude <noreply@anthropic.com>`. Never commit real
  customer PDFs, binaries, or secrets — fixtures are public-domain/synthetic.
- **Real sample PDFs for hands-on testing live in `test/fixtures/local/`**
  (git-ignored; the operator drops files there, so they carry personal
  data). Currently: three airline boarding passes and **`Sample
  Portfolio.pdf`, a Foxit-made PDF Portfolio (`/Collection`) containing
  those three** — use it for attachments, embedded-file and portfolio
  behaviour. Open them when you manually check
  your module against real-world files, and prefer them over synthetic
  fixtures for "does it look right" judgements. Tests may use them only
  with `it.skipIf(!existsSync(...))` — CI and other machines don't have
  them. Never copy, commit or quote their contents; `local/README.md`
  lists what is there.
- Replies to the operator: short and plain (eyesight). Never leave the
  operator a to-do you could do yourself.

---

## Design decisions (fill in before coding; keep current)

- **A converter is a pure function over bytes, and the registry is data.** `src/engine/create/`
  exports `Converter { id, label, extensions, mimes, accepts(input), convert(inputs, options, ctx) }`
  and a `ConverterRegistry` that routes a file by extension or MIME type. Nothing under
  `src/engine/create/` imports from `src/renderer/` or touches Node, so M40 (insert from file),
  M41 (combine), M120 (batch) and M121 (CLI) call the same functions the dialogs call. Everything
  a converter cannot do for itself is an **adapter** on `ctx.env`: a `RasterDecoder` (for BMP,
  GIF, WebP and anything else the platform can decode) and an `HtmlPrinter` (Chromium's print to
  PDF, which only main has). A converter that needs an adapter the host did not install throws
  `ConvertUnsupported` with a reason in words — it never silently produces an empty page.
- **Images are embedded, not re-encoded, wherever the PDF allows it.** JPEG bytes go straight
  into a `DCTDecode` XObject (pdf-lib `embedJpg`); PNG is handed to pdf-lib's own PNG decoder,
  which produces `FlateDecode` plus an `SMask` for alpha. Only formats PDF has no filter for are
  decoded to RGBA first — TIFF by utif (MIT, pure JS, one page per IFD), BMP/GIF/WebP by the
  host's `RasterDecoder` (`createImageBitmap` in the renderer and its Worker, `nativeImage` in
  main), and HEIC only where the OS decoder can (macOS) — and then written as a raw
  `FlateDecode` XObject with its own SMask. Size and DPI come from our own header parsers (PNG
  `pHYs`, JFIF density, EXIF `XResolution`), and **EXIF orientation is applied by transforming
  the drawing, not by setting `/Rotate`**, so a phone photo lands upright on a page whose
  orientation matches what the reader sees. Images with no DPI are assumed to be 96 dpi (what a
  browser assumes), a setting.
- **Page geometry is one function.** `layoutImage(image, options)` takes the displayed image size
  in points and returns the page size plus the image rectangle for the three modes — *image
  size* (page = image at its DPI plus margins), *fixed page* (a preset, fitted inside the
  margins, never enlarged unless asked) and *fill* — with orientation *auto*, *portrait* or
  *landscape*. It is pure, so the dialog's preview and the converter cannot disagree.
- **Web pages are printed by Chromium and stitched by us.** `src/main/webpdf/WebPdfPrinter.ts`
  owns one hidden, sandboxed `BrowserWindow` per job: load the URL (or a temporary file for
  HTML we generated), emulate the requested media type through the DevTools protocol, wait for
  `load` plus `document.fonts.ready` under the job's timeout, collect `document.links`, then
  `webContents.printToPDF` with the page size, margins, header/footer, background and scale the
  reader chose. The **crawl** (`engine/create/web/crawl.ts`) is pure breadth-first search over
  a `render(url)` function — same-site rule, depth limit, fragment stripping, de-duplication,
  progress and cancellation are all unit-tested against a fake printer. The **assembly**
  (`engine/create/web/assemble.ts`) merges the per-page PDFs with pdf-lib, adds one bookmark per
  crawled page, and **rewrites every URI link that points at a crawled page into a `GoTo` to its
  first page**, so a link between two crawled pages works inside the PDF while links to pages
  outside the crawl stay as URLs. Main returns bytes and link lists only; it never decides what
  the document looks like.
- **Markdown becomes HTML in the renderer, then takes the HTML path.** `marked` (MIT) renders
  GitHub-flavoured Markdown to HTML; the stylesheet is a data file,
  `resources/create/markdown.css`, that declares its palette as `--doc-*` custom properties at
  the top and uses only those below, so the look of a converted document is changed in one place
  without touching code. Relative images resolve through a `<base href>` on the source file's
  folder, which is why generated HTML is printed from a temporary file rather than a `data:` URL
  (a `data:` origin may not load `file:` images; a `file:` page may).
- **Plain text is set with the standard fonts and paginated by us.** Courier or Helvetica from
  the base 14, so the converter needs no font file and the output is byte-deterministic; a
  character WinAnsi cannot encode becomes `?` and is counted in the warnings. Wrapping is greedy
  on measured widths (long words are broken), tabs expand to a setting, and the header carries
  the file name and page number in the top margin. Embedding a Unicode font waits for M51,
  which brings fontkit.
- **A created document is a Document with no path that is dirty from birth.** The bytes are
  opened through `DocumentService.open(bytes, { title })` exactly as a file would be, so M11
  gives it a viewport and M21 adopts it, then `UndoStack.markUnsaved()` (new, additive, ADR 0011)
  makes it dirty until the first save. Without that a fresh document is "clean", `Ctrl+S` does
  nothing and closing it asks nothing — the reader would lose the document they just made.
  Creation itself is not a `Command`: there is no document to undo it against, and the recipe
  (which files, which options) is not something a journal can replay once the clipboard has
  changed. M91 changes no existing document, so it adds no document commands; the converters
  return bytes, and M40 is where those bytes become pages of an open document, as commands.
- **Titles come from the source.** An image document is named after its first image, a web
  document after the page's `<title>`, a text or Markdown document after the file, a blank or
  clipboard document "Untitled 1", "Untitled 2"… per session; the same string goes into the
  PDF's `/Title` so it survives a save and pre-fills Save As.
- **Dialogs are the options, with a preview when one is cheap.** One opaque dialog per source
  kind, built on the shell's `Dialogs` and `field()`/`formGrid()` helpers, every control
  keyboard-reachable, defaults from the `create.*` settings and the last-used options. The image
  dialog shows thumbnails (object URLs of the picked bytes) and the computed page for the first
  image; the blank dialog draws the page shape; the text dialog shows the first lines; the web
  dialog has no preview because loading the page *is* the work. Every headless path exists as a
  hidden `create.convert` command so e2e tests and later modules can run a conversion with
  explicit options and no dialog.
- **Conversion runs off the main thread when it is CPU work.** Image and text conversion run in
  a module Worker (`create.worker.ts`, the same shape as M21's writer Worker: request, progress,
  done, failed, cancel), which is also where `createImageBitmap` decodes the formats pdf-lib does
  not. HTML, Markdown and web conversion stay on the renderer thread because their heavy half is
  in main's hidden window and their IPC cannot be reached from a Worker; the final stitch of a
  crawl is sent to the Worker. The progress dialog appears after 400 ms, as M21's does.
- **Drag-and-drop and Open route through the registry.** The shell's drop handler (one shared
  edit) still opens PDFs one tab each; any other files are handed, as a group, to
  `create.fromDropped`, which asks the registry what they are: images become one document, and
  each text, Markdown or HTML file becomes its own. A file nothing accepts is named in a toast
  rather than dropped on the floor. The OS file association stays PDF-only.
- **IPC additions are five, all additive (ADR 0011):** `file:openFilesDialog` (multi-select with
  filters), `webpdf:render`, `webpdf:cancel`, `clipboard:read` and `image:decode`.
- **Presets are data.** `resources/page-sizes.json` (ISO A/B, North American, envelopes) with
  sizes in millimetres, consumed by `engine/create/pageSizes.ts`; M130's preferences and every
  later dialog that needs a page size read the same file.

## Build log (fill in at merge)

**Built 2026-09-08 on `mod/M91-create-pdf` (worktree `../ynotPDF-M91`).**

### What shipped

- **The converter registry** (`src/engine/create/`) — `Converter { id, label, extensions, mimes,
  multi, accepts, defaults, convert }` over a `ConvertContext` whose `env` carries the adapters a
  converter cannot be: a `RasterDecoder` and an `HtmlPrinter`. Nothing under `src/engine/create/`
  imports from the renderer, main or Node, so File → Create, drag-and-drop, M40's insert, M41's
  combine, M120's batch and M121's CLI all call the same functions. `ConverterRegistry.group()`
  is the routing every caller shares: images batch into one document, every other file becomes
  its own, and a file nothing accepts comes back named rather than dropped.
- **Images** — JPEG straight into a `DCTDecode` XObject and PNG through pdf-lib's own decoder
  (`FlateDecode` plus an `SMask`); TIFF decoded page by page with utif, thumbnails skipped;
  BMP, GIF, WebP and AVIF through Chromium's `createImageBitmap` in the Worker, HEIC through
  main's `nativeImage` where the OS has a codec. Size and DPI come from our own header parsers
  (PNG `pHYs`, JFIF density, EXIF `XResolution` in either byte order), and **EXIF orientation is
  applied to the drawing, not to `/Rotate`**, so a phone photo lands upright on a page whose
  orientation matches. `layoutImage` is the one geometry function the converter and the dialog's
  preview both call: image-sized or fixed page, fit, fill (clipped) or actual size, orientation
  automatic from the aspect.
- **Web pages** — `WebPdfPrinter` (`src/main/webpdf/`) owns one hidden, sandboxed
  `BrowserWindow` per job: media emulation through the DevTools protocol, a wait for load plus
  `document.fonts.ready` under the job's timeout, the links collected, then `printToPDF` with the
  page size, margins, header/footer, background and scale the reader chose. The crawl is a pure
  breadth-first search over a `render(url)` function — same-site rule, depth 1–10, fragments
  stripped, redirects recorded as aliases, a page cap, progress and cancellation — and the
  assembly merges the printed PDFs, adds one bookmark per page and **rewrites every link that
  points at a crawled page into a `GoTo`**, leaving links off the site as URLs.
- **HTML and Markdown** — the same printer; a `.html` file is printed from its own `file:` URL so
  its relative images resolve, and Markdown is rendered by `marked` into a document carrying a
  `<base href>` and the stylesheet from `resources/create/markdown.css`.
- **Plain text** — Courier, Helvetica or Times from the base 14, greedy wrapping on measured
  widths with long words broken by character, tabs expanded, a header with the file name and
  "Page n of m". A character WinAnsi cannot encode becomes `?` and is counted in the warnings.
- **Blank documents and the clipboard** — a size, an orientation and a count; the clipboard's
  image or its text, named "Untitled 1", "Untitled 2"… per session.
- **The module** (`src/renderer/modules/M91-create-pdf/`) — seven commands with palette entries
  (Blank is `Ctrl+N`), a Create PDF group on the Convert ribbon tab, five `creators` that fill
  the File → New page and the empty state, a context menu when nothing is open, and the
  `create.*` settings every dialog starts from. One opaque dialog per source kind, built on the
  shell's `Dialogs`, with a page-shape preview for blank and images, thumbnails of the pictures
  and a first-lines preview for text. CPU work runs in the module's own Worker
  (`create.worker.ts`); the printer's work runs on the renderer thread, where its IPC lives. The
  progress dialog appears after 400 ms and its Cancel is real.
- **Page-size presets** are `resources/page-sizes.json` (ISO A/B, North American, envelopes),
  read by `src/shared/pageSizes.ts` — the file M130 and every later page-size dialog will use.

### Decisions worth knowing about

- **A created document is dirty from birth.** `UndoStack.isDirty` compares the journal against
  the last save, so a document with no journal is clean — and a document that was never a file
  would then have `Ctrl+S` do nothing and close without a question, losing what the reader just
  made. `UndoStack.markUnsaved()` (additive, ADR 0011) is the fix; M21 then treats it exactly as
  it treats an edited file with no path.
- **Creation is not a `Command`.** There is no document for an undo to revert to, and a journal
  entry naming the sources could not be replayed honestly once the clipboard has changed or the
  files have moved. The bytes are the truth; M40 is where converted bytes become pages of an
  open document, as commands.
- **Converters are pure and the environment is an argument**, which is what lets the image and
  text paths run in a Worker, the web path run where its IPC is, and a future CLI run both with
  no adapters and get a worded error rather than a blank page.
- **A conversion that needs a decoder the Worker has not got is retried on the window**, where
  `nativeImage` can be reached. The reader sees one conversion, not two.
- **Main returns bytes and data, never decisions.** `printToPDF` gives a PDF and a list of links;
  what the document looks like — the bookmarks, the rewritten links, the title — is decided in
  the pure assembly, where it can be tested.

### Bugs found while building, and what they were

- **utif could not find its inflate in a bundle.** It looks for `require("pako")` or `self.pako`,
  and an ES module has neither — so a deflate-compressed TIFF decoded to garbage in the renderer
  while passing in Node. `installPako.ts` puts pako where utif looks, before utif is imported.
- **A TIFF was decoded through a view of the wrong buffer.** utif reads every offset from the
  start of the buffer it is handed, so a `Uint8Array` that is a window onto a larger buffer put
  every strip offset out by the window's start. The decoder copies into a buffer of its own.
- **`dev.pageText` put a space between every letter.** PDFium reports one text run per glyph for
  a page Chromium printed, so joining the runs with a space turned "Heading" into "H e a d i n g"
  and every assertion about rendered text failed for the wrong reason. The runs already carry
  their own spaces; they are joined with nothing.
- **A malformed `/Annots` entry crashed the link rewriter.** pdf-lib's `lookupMaybe` throws
  rather than returning `undefined` when the entry is not a dictionary at all. A link that cannot
  be read is now a link left alone.
- **The style rule reads `rgb(` in a `.ts` file as a UI colour literal**, which pdf-lib's colour
  helper would have tripped. The image code emits numeric components instead, as M21's appearance
  generators already do.
- **`tsconfig.node.json` could not see the engine's ambient declarations**, so a unit test that
  imported the TIFF decoder failed on utif's missing types while the web project was happy. The
  node project now includes `src/engine/**/*.d.ts`.

### Shared files touched (PLAN.md §12.3)

- `src/shared/create.ts` — new: the option and result types the dialogs, the converters and main
  all share.
- `src/shared/pageSizes.ts`, `resources/page-sizes.json` — new: the presets, as data.
- `src/shared/ipc.ts` — additive: `file:openFilesDialog`, `webpdf:render`, `webpdf:cancel`,
  `clipboard:read`, `image:decode`, with their payload types (ADR 0011).
- `src/main/{index,ipc,menu}.ts` — additive: the five handlers, the printer on `IpcDeps`, its
  disposal on quit, and a New submenu in the File menu.
- `src/renderer/core/UndoStack.ts` — additive: `markUnsaved()`.
- `src/renderer/app/shell.ts` — one behaviour change: a drop of files that are not PDFs is handed
  to `create.fromDropped` when that command exists; PDFs behave exactly as before and, without
  M91, so do the rest.
- `src/renderer/main.ts`, `src/renderer/index.html` — registers the M91 manifest and its CSS.
- `tsconfig.node.json` — the engine's `.d.ts` files, so a unit test can import the engine half.
- `vitest.config.ts` — coverage gates for the converters; the DOM and shell half excluded as M11's
  and M21's are, and proved by Playwright.
- `package.json` — `marked` 16 (MIT), `utif` 3 (MIT), `pako` 1 (MIT/Zlib) as dependencies;
  `jpeg-js` 0.4 (BSD-3) and `@types/pako` as dev dependencies for the fixtures.
- `scripts/make-fixtures.ts`, `test/fixtures/README.md`, `.gitattributes`, `.prettierignore` — the
  new `test/fixtures/create/` corpus, generated deterministically like every other fixture.

### Tests

1 792 unit tests and 150 e2e tests, green on Windows locally. The three acceptance tests:

- **Five mixed images → one PDF with the right page sizes and rotations** — a JPEG, an EXIF-rotated
  JPEG, a 300 dpi PNG, an alpha PNG and a greyscale scan, opened in the real engine afterwards:
  the landscape ones get landscape pages, the rotated one is landscape because it *displays*
  landscape, and no page carries a `/Rotate`. The three-page TIFF becomes three pages, each its
  own size at its own DPI.
- **A local HTML site, depth 2 → bookmarks and working internal links** — in the running app: one
  bookmark per crawled page pointing at the page it names, the links between crawled pages
  resolved to destinations inside the document, the link to another site still a URL, and the
  page that is three hops away absent.
- **Markdown → headings and a table; text → paginated with a header** — the Markdown's headings,
  ordered list, table and code block all present in the rendered text; `long.txt` over several
  pages, each carrying its file name and "Page n of m".

Plus: the dialogs are opaque and keyboard-driven, Cancel creates nothing, an address that cannot
be loaded is refused in words, a created document arrives unsaved with its title in the file, and
a dropped file nothing accepts is named to the reader.

### Deferred, and why

- **Office formats are M93's**, which registers its converters in this registry — the brief's
  own division.
- **The scanner and a virtual printer stay parked**, as the brief says.
- **HEIC depends on the operating system.** Chromium does not decode it; macOS's `nativeImage`
  does, and Windows and Linux say so in a sentence rather than producing a blank page.
- **A Unicode font is not embedded for plain text.** The base 14 keep the converter
  dependency-free and byte-deterministic; a character outside WinAnsi becomes `?` and is counted.
  Embedding waits for M51, which brings fontkit.
- **The crawl is breadth-first and single-threaded**, one page at a time. Printing is the slow
  part and Chromium is doing it either way; parallel windows would race for the same resources
  for no clear gain, and the progress dialog would stop meaning anything.
