# M13 — Text selection, find, copy, snapshot & print

| | |
|---|---|
| **Module id** | `M13` — folder `src/renderer/modules/M13-select-find-print/`, branch `mod/M13-select-find-print` |
| **Earliest wave** | 3 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M11 |
| **Unlocks** | [M54 Find & replace, spell-check](./M54-find-replace-spellcheck.md), [M111 Read aloud, accessibility check & alt text](./M111-read-aloud-accessibility.md) |

## Your task — the prompt for this conversation

You are building **M13 — Text selection, find, copy, snapshot & print** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M11 Viewer — rendering, navigation, zoom, layouts](./M11-viewer.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M13-select-find-print` from `main` in a new git worktree and
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

Turn the text layer into a selectable, searchable surface; copy text/RTF/
images; snapshot regions; find with full options and a results panel,
across open documents and folders; print with Foxit's options.

## Foxit 14 reference — what to emulate

Foxit Home tab: Select Text & Image, Snapshot; Find (Ctrl+F bar with
match case / whole word / include bookmarks & comments / previous / next),
Advanced Search panel (current doc / all open / folder, results tree with
context, proximity), Print dialog (printer, copies, pages/range/current/
selected, subset odd/even, reverse, scaling fit/actual/custom/shrink
oversized, auto-rotate & centre, page setup, print as image, comments &
forms options, booklet, multiple pages per sheet, tile large pages,
grayscale, print preview).

## Scope — build all of this

- Text layer per page from `textRuns`: positioned transparent spans (or a
  hit-test model + drawn selection rects in the selection layer), reading
  order, line/paragraph grouping heuristics (shared util for M51).
- Select tool: click-drag, double/triple click (word/paragraph), Shift-
  extend, Ctrl+A page, column select (Alt-drag), cross-page selection,
  keyboard selection; selection highlight via `--selection` token; copy as
  plain text and RTF (fonts/styles), copy image (right-click on image
  object → PNG to clipboard via IPC), "Select All".
- Snapshot tool: marquee → rendered bitmap at chosen DPI to clipboard
  and/or file.
- Find bar (Ctrl+F): incremental, highlights all hits on visible pages,
  current hit emphasised, next/prev/Enter/Shift+Enter, options (case,
  whole word, regex, diacritics-insensitive, include bookmarks/comments/
  form values), hit count "n of m".
- Advanced Search panel (left pane): scope current/all open/folder
  (recursive, via main-process worker using the engine on files not open),
  results grouped by document → page with context snippet, click navigates
  and selects, export results as CSV, cancel.
- Print: Electron print pipeline with our own opaque print dialog covering
  the Foxit option set above; render pages through the engine (with/without
  annotations & forms, print-as-image toggle, grayscale), n-up and booklet
  imposition computed in-house, tile large pages, print preview pane
  (rendered first page with settings applied), page setup (paper size,
  orientation, margins), remember last settings; "Print to PDF" reuses the
  same imposition to produce a file.

## Out of scope

Find & replace (M54). Read-aloud (M111).

## Design notes & constraints

- Search runs in the engine worker over `textRuns` with a normalised text
  index per page (built lazily, cached with the document); folder search
  spawns a separate worker in main so the UI never blocks.
- Printing renders at printer DPI into a hidden BrowserWindow whose pages
  are `<img>` at exact paper size, then `webContents.print()` — the only
  cross-platform route in Electron; document this in an ADR.
- Selection model lives in `core/Selection.ts` (text selection variant);
  M50 adds object selection to the same model.

## Files you will create or touch

`src/renderer/modules/M13-select-find-print/**`, text-layer builder in
`src/renderer/view/TextLayer.ts`, `src/main/print/**`,
`src/main/search/**`, `docs/adr/000N-printing.md`, tests.

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

None new (RTF built in-house).

## Acceptance tests — the module is done when these pass on all three OSes

- Find "the" in the text fixture reports the same count as the engine's
  raw text; regex and whole-word modes verified; cross-open-doc search
  lists both fixtures; folder search over `test/fixtures` finds a known
  string and can be cancelled midway.
- Selection: triple-click selects the paragraph; copied RTF opens in
  WordPad/TextEdit (manual check recorded) and plain text matches.
- Snapshot of a known rect yields a PNG of the expected size.
- Print to PDF of pages 2-3, 2-up, booklet → page count and imposition
  order verified by reopening the result in the engine.

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

- **One text model per page, and it lives in `view/`, not here.** `view/TextLayer.ts` turns
  `textRuns(page)` into a flat reading-order string with one box per character, grouped into lines
  and paragraphs. It is shared on purpose — M13 selects, searches and copies from it, M51 will
  reflow from the same grouping, M54 replaces inside it, M111 reads it aloud — and it is pure, so
  all of it is unit-tested in Node. `TextService` caches one model per page with the document, so
  a find and a selection on the same page read the same object.
- **`chars.length === text.length`, always.** A character outside the BMP is two UTF-16 units and
  gets the _same_ box twice, so a string offset is always a valid index into the boxes and no
  caller has to think about surrogates. Line separators are real newline characters with a
  zero-width box parked at the end of the line they close, so slicing the text is already the text
  to copy and a selection over a line break has somewhere to draw.
- **Reading order is the content stream sorted into lines**, by angle bucket, then _across_ the
  writing direction, then _along_ it. "Across" and "along" are the two components of the run's own
  direction vector, so rotated text needs no special case.
- **Drawn selection rectangles, not the browser's selection.** A text layer of transparent spans
  would give `::selection` for free, but a selection colour drawn over a word hides the word
  unless it is translucent, and translucency is not available here. The rectangles are ours and
  blend with the paper — `mix-blend-mode: multiply` on a light page, `screen` under Night Mode —
  which is fully opaque paint that darkens the paper and leaves the ink. It also means the
  selection _model_ is ours, which is what makes column select, cross-page runs and "n of m" work
  the same way on every platform (ADR 0012).
- **Selection listens on the viewport, not on the page tool layer.** A drag that starts on page 3
  and ends on page 5 has to keep producing coordinates after it has left the page it started on,
  and a pointer capture on a page element reports that page's coordinates for ever. `ToolSpec` is
  the switch; `TextSelectionController` is the machine.
- **`tool.selectText` stays M11's id.** Two tools with one id would leave the shell dispatching to
  whichever module registered first. M13 watches `ui.activeTool` instead. M13 contributes
  `tool.snapshot`, which _is_ a marquee inside one page and so is a real `ToolSpec`.
- **Case is the regular expression's `i` flag; only accents fold the text.** Lower-casing the
  haystack and not the query is an easy bug to write (it was written, and the acceptance test
  caught it), and lower-casing a regular expression's source turns a "not a digit" class into a
  "digit" one. Diacritic folding does change the text, so normalisation returns a map from every
  folded unit back to the offset it came from, and matches are always reported in **original**
  offsets.
- **Find scans the whole document, yielding every four pages.** "n of m" is a promise about the
  document, not about what is on screen. The count climbs while the reader is still typing rather
  than appearing at the end, and a newer query abandons the older one — checked _after_ every
  await, not only before, or the old query's next result lands in the new query's list.
- **The imposition is pure, and one plan feeds three consumers.** The preview renders sheet _n_ of
  the plan, the printer rasterises the same plan, and "Print to PDF" draws it with pdf-lib. They
  cannot disagree, and the acceptance test can state the imposition as a table with no printer.
- **Printing is an HTML document of images in a hidden window** (ADR 0012) — the only
  cross-platform route Electron offers. Sheets go to main one at a time and are referenced by
  relative path, because a hundred 300-DPI sheets inlined as data URLs is about 300 MB of base64.
- **"Print as image" is given the one place it can mean something.** Everything that reaches a
  printer is a raster, so the switch would be meaningless there; for _Print to PDF_ it chooses
  between embedding pages as Form XObjects (searchable text, with printable appearances baked
  into a separate snapshot) and embedding the rendered sheets (no searchable text).
  Greyscale uses PDFium's raster colour conversion; the dialog says so in words.
- **The folder search is a Node worker thread started by main**, with its own PDFium and the
  _same_ pure matcher the find bar uses, so it cannot disagree with a search of an open document.
  The wasm bytes are read in main and handed over in `workerData`: in a packaged app they are
  inside `app.asar`, and asar-aware `fs` is a main-process guarantee.
- **The matcher runs in the renderer, over the text model, not inside the engine worker.** The
  brief's design note suggested the worker; the worker would then have to hold a text index that
  the renderer *also* needs for selection, and two copies of a page's text is two chances to
  disagree about an offset. The engine worker still does the expensive part — `textRuns` — and the
  match itself is a regular expression over a few kilobytes. The folder search does run in its own
  worker, in main, exactly as the brief says, because there the files are not open and the tree
  can be large.
- **The working selection model lives in the module; `core/Selection` gets the published form.**
  Carets, granularity and a column rectangle are what a drag needs; `SelectionState.kind === 'text'`
  with its run ranges is what the rest of the app reads, and it is written on every change. M50
  adds object selection to the same core model without meeting any of this.
- **Paper sizes are data** (`resources/print/paper-sizes.json`), per PLAN.md §4.4.
- **Ctrl+C and Ctrl+A fall back to the focused field.** They act on the document selection in the
  page area and on the field in the find bar or a dialog, so typing still behaves the way it does
  everywhere else.

## Build log (fill in at merge)

**Built 2026-09-08 on `mod/M13-select-find-print` (worktree `../ynotPDF-M13`).** Green locally on
Windows and in CI on all three OSes plus the arm64 installer smoke: lint (eslint, prettier, the
colour/opacity rules, `tsc` on both projects), then — with M91 merged in — 1 924 unit tests with
the coverage gates and 178 Playwright tests.

M91 landed on `main` while this was being built, so the branch carries a merge: both modules add
to `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/main/index.ts`, `src/renderer/main.ts`,
`src/renderer/index.html` and `vitest.config.ts`, and every conflict was two additions to one
list. M91 also took ADR **0011**, so this module's printing ADR is **0012**.

**Shipped:**

- **`src/renderer/view/TextLayer.ts`** — the text model, shared with M51/M54/M111: reading order
  from the runs' own direction vectors, line and paragraph grouping, hit testing, word and
  paragraph spans, merged selection rectangles, column spans, and the conversion to and from
  `core/Selection`'s run ranges. Pure; 29 unit tests.
- **Selection.** `selection/model.ts` (pure: two carets, a granularity, an optional column
  rectangle) plus a controller that listens on the viewport. Click-drag, double click (word),
  triple click (paragraph), Shift-extend, Ctrl+A (page, then document), Alt-drag column select,
  cross-page selection, arrow / Home / End movement, and the highlight rectangles.
- **Copy.** Plain text and RTF in one clipboard item, so a word processor takes the formatting and
  a plain editor takes the text. The RTF writer is in-house (`selection/rtf.ts`): font table,
  colour table, bold, italic, sizes, and Unicode escapes for anything above ASCII. Copy Image
  renders the image object under the pointer at its own resolution.
- **Snapshot.** A marquee becomes a PNG at a chosen DPI, to the clipboard, a file, or both.
- **Find.** The Ctrl+F bar (incremental, "n of m", next / previous / Enter / Shift+Enter, seven
  options behind a disclosure) over a matcher that does case, whole word, regular expressions,
  accent folding and proximity, and a controller that also searches bookmarks, comments and form
  values. Every hit on a visible page is highlighted and the current one is outlined.
- **Advanced search.** A left-pane panel: scope (this document / all open / a folder), the full
  option set, a proximity box, a results tree grouped document → page with a line of context,
  click-to-navigate-and-select, progress, cancel, and Export to CSV.
- **Folder search** in a main-process worker thread with its own PDFium (ADR 0012), streaming
  batched results and cancellable by `terminate()`.
- **Printing.** Our own opaque dialog covering Foxit's option set — printer, copies, collate,
  range (all / current / selection / custom), odd-even subset, reverse, scaling (fit / actual /
  custom / shrink / fill), auto-rotate, auto-centre, paper and orientation, margins, n-up with
  order and borders, booklet with binding and duplex subset, tiling with scale, overlap and marks,
  comments and form fields, greyscale, print-as-image, DPI — with a live preview of any sheet. The
  imposition is pure and shared by the preview, the paper and Print to PDF.
- **Docs.** ADR 0012, `docs/shortcuts.md` rows for selection, copy, find, search and print,
  READMEs for the module and the view layer.

**The manual check the brief asks for, recorded.** "Copied RTF opens in WordPad/TextEdit and
plain text matches" was done objectively rather than by eye: the RTF for the whole of
`text.pdf` page 1 was loaded into a `System.Windows.Forms.RichTextBox` — the same RichEdit
control WordPad is built on — from PowerShell on Windows 11. It parsed, its text is character for
character the plain-text copy, and the formatting survived: the heading came back as **Arial
24 pt** and the body as **Times New Roman 11 pt**, which are exactly the substitutions a Windows
RTF reader makes for Helvetica and Times-Roman.

**Bugs the tests found, all real:**

- Case-insensitive search folded the _text_ and not the _query_, so it found nothing at all: the
  first acceptance test ("the same count as the engine's raw text") failed on it. Case is now the
  regular expression's `i` flag, which cannot get out of step with itself.
- A second find query started while the first was awaiting a page let that first query's next
  result land in the new query's freshly cleared hit list — exactly what typing quickly does. The
  generation is now checked after the await as well as before.
- "Advanced Search" ran the Registry's generated `panel.nav.search` command, which _toggles_:
  asking for the search panel while it was already open put it away.
- The Snapshot icon was registered in `activate`, which runs after the shell has mounted, so the
  ribbon painted a placeholder glyph on the first frame. `test/e2e/shell.spec.ts` catches exactly
  that; icons are now registered at module scope.
- Two Home ribbon groups with three large buttons between them pushed the demo module's own group
  into a collapsed popup on a 1024 px-wide window — which is what the macOS and Windows CI runners
  are, while the Linux job pins 1280 through xvfb. M13 now contributes **one** compact Home group
  with one large button, and `shell.spec.ts` pins its own window width rather than inheriting the
  runner's, so the next module to reach for the Home tab does not learn this the same way.

**Shared files touched (minimal, additive, per ADR 0012):** `src/shared/ipc.ts` and
`src/main/ipc.ts` (clipboard, folder picker, folder search, printing; `SaveDialogOptions.filters`),
`src/main/index.ts` (own the print jobs and the searches, release them with the window),
`src/main/menu.ts` (Print, Print to PDF, and Copy / Copy with Formatting / Select All / Find as
_commands_ rather than Chromium roles, so they act on the document), `electron.vite.config.ts` (a
second `main` entry for the search worker), `src/renderer/main.ts` (register M13),
`src/renderer/index.html` (link the module's CSS), `vitest.config.ts` (coverage include and
gates), `docs/shortcuts.md`, `src/renderer/view/README.md`, `PLAN.md` section 0, and two
expectations plus a pinned window width in `test/e2e/shell.spec.ts` — the navigation strip now
has a third panel, the backstage **Print** slot belongs to a real module (disabled until a
document is open, exactly as **Save** came to belong to M21), and the ribbon-layout tests set
their own 1280 px window rather than inheriting the runner's display, which differs per OS. The
demo module itself is untouched.

**Deferred, and why:**

- **Find & replace and spell-check** — M54's, explicitly out of scope.
- **Read aloud** — M111's, explicitly out of scope.
- **A vector path to the printer.** Electron has none (ADR 0012). Everything that reaches paper is
  a raster at the chosen DPI; the dialog exposes the DPI, and Print to PDF keeps a vector route.
- **The original vector appearance omission is repaired in the 2026-09-12 completion work below.**
- **The folder search does not honour a document's password.** An encrypted file it cannot open is
  skipped rather than prompting a hundred times through a folder.
- **The status bar does not show a character count for the selection.** `selectionLength()` is
  there for it; M02's status bar is a shared file and the slot is not worth an edit to it yet.
- **Print preview renders one sheet at a time**, not a strip of thumbnails. The sheet stepper does
  the job, and a strip would render every sheet of a long document to show six of them.

### Completion repair — 2026-09-12

Vector Print to PDF now preserves printable annotation and widget appearances. A print-only
snapshot captures the model plan and engine bytes together through `document.undo.capture`, then
runs M21's writer without Save security stages, marking saved, rebasing, or touching recovery.
Queued/concurrent edits and writer warnings stop output with an explanation.

The print compositor reuses M41's `placementMatrix` while keeping its own print semantics:
Print controls inclusion, Hidden excludes, NoView does not suppress printing, and NoRotate keeps
the annotation upright. Both comment/form switches apply independently. Existing normal streams,
state appearances, fonts and image XObjects survive. Missing form appearances are generated by
pdf-lib's existing field providers; unresolvable marks fail explicitly before any file is written.
Unknown subtypes with valid appearances are preserved without relabelling them.

CropBox/MediaBox intersection, nonzero origins and page rotation are normalised before n-up,
booklet or tiling. Page borders and tile labels are now included in vector output. Greyscale uses
the documented raster route. High-quality print permission is required for vector output or DPI
above 150, in addition to the existing print permission gate.

Validation and remaining limits are recorded in
[`docs/reviews/M13-completion-review.md`](../reviews/M13-completion-review.md). No dependency,
shared engine/writer contract, shared IPC, clipboard, theme or central tracker is changed.

### Printer and preview snapshot follow-up — 2026-09-12

**Design:** all raster print consumers use `withRasterSnapshot`: materialise the current model
and engine bytes, bake only the requested printable marks on pages actually placed on sheets,
open one temporary engine handle, then close it in `finally`. A printer job uses that same handle
for every sheet. The existing source document, undo journal and recovery state are never replaced.
The shared engine/writer/IPC contracts are unchanged; M11's unrelated reopened Fit Visible work
is not a dependency of this snapshot lifecycle.

The dialog cancels obsolete preview requests and closes outstanding work on dismissal. It shows
plain loading/error text and only reveals an image after decoding. The print plan is bound to the
document revision; queued edits or authority changes stop preparation before printer delivery.
Preview is always 96 DPI; physical/dry-run output above 150 DPI requires high-quality print
permission. Raster Print to PDF uses the same appearance preparation and cancellation checks.

**Validation checkpoint:** unit coverage checks real PDFium content at all source rotations,
independent annotation/form switches, selected pages, cancellation before capture and after open,
handle disposal, one snapshot per multi-sheet job, and spool cancellation on source changes.
Actual-dialog journeys compare settled preview PNGs against the real prepared print-window PNGs,
with native delivery intercepted so no physical printer receives a test job. Synthetic screenshots
are inspected, and encrypted fixtures exercise no/low/full print authority. Integrated main
`c492bfd` passes 4,139 unit tests with coverage (24 existing skips) and all 11 focused UI journeys,
including exact preview/spool pixels for each current print job. Final lint, full UI and platform
CI results will be recorded in the follow-up PR before handoff; this entry does not mark M13 done.
