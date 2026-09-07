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
7. Report back in a few plain lines: what works, what to try, anything the
   operator must do by hand.

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
targeting the feature set of **Foxit PDF Editor 14**, with four colour themes
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
  native binaries are bundled per OS and fetched at build time by
  `scripts/fetch-binaries.ts` (pinned checksums, git-ignored). Installing
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
- Replies to the operator: short and plain (eyesight). Never leave the
  operator a to-do you could do yourself.

---

## Design decisions (fill in before coding; keep current)

_None yet._

## Build log (fill in at merge)

_Not started._
