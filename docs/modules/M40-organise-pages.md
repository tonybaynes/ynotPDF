# M40 — Organise pages — insert, delete, extract, replace, rotate, move, labels

| | |
|---|---|
| **Module id** | `M40` — folder `src/renderer/modules/M40-organise-pages/`, branch `mod/M40-organise-pages` |
| **Earliest wave** | 3 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M21, M12 |
| **Unlocks** | [M41 Merge, split, extract to files, crop & flatten](./M41-merge-split-crop.md) |

## Your task — the prompt for this conversation

You are building **M40 — Organise pages — insert, delete, extract, replace, rotate, move, labels** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M21 Save, Save As, autosave & recovery](./M21-save.md), [M12 Navigation panels — thumbnails, bookmarks, layers, attachments, destinations](./M12-navigation-panels.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M40-organise-pages` from `main` in a new git worktree and
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

Page-level document surgery driven from the ribbon and the thumbnails
panel: insert (blank/from file/from clipboard), delete, extract, replace,
rotate, duplicate, reverse, move/reorder by drag, and page labels — all
undoable.

## Foxit 14 reference — what to emulate

Foxit Organize tab: Insert (From File, Blank Page, From Clipboard, From
Scanner ✗), Delete, Extract (to file / open in new tab, with comments,
delete after), Replace, Rotate, Move, Duplicate, Reverse, Page Labels
(style, prefix, start, range), Split/Merge/Crop (M41), Swap, Page
transitions ✗; thumbnails drag-and-drop with insertion marker, multi-select
actions, drag pages between two documents' thumbnail panels.

## Scope — build all of this

- Commands (all `Command`s, page-range aware with Foxit-style range
  syntax `1-3,5,8-`, odd/even, landscape/portrait, current, selected):
  insert blank (size presets from `resources/page-sizes.json`, orientation,
  count, position), insert from file (page range picker with thumbnails,
  position, keep bookmarks), insert from clipboard (image/text → page via
  M91's converters when merged, else image only), delete, extract (to new
  file / new tab; options: with comments, delete after extract, one file per
  page with naming pattern), replace (range from file), rotate (90/180/270
  per range), duplicate, reverse, move (dialog and drag), swap.
- Thumbnails drag-and-drop: single/multi, insertion marker, auto-scroll,
  drag between documents (copy), keyboard alternatives (Ctrl+Shift+arrows).
- Page labels: dialog (Decimal/Roman/Alpha, prefix, start, range) →
  `/PageLabels`, reflected in the page field and thumbnails.
- Thumbnail context menu items registered here (M12 provided the hook).
- Progress for large operations; all wired to the writer via the journal.

## Out of scope

Split/merge/crop/flatten (M41).

## Design notes & constraints

- Page identity: stable page ids from M20 so annotations/bookmarks/links/
  fields follow moved pages; outline and link destinations remap on delete
  (Foxit removes dangling ones — do the same, with an undoable Command).
- Insert-from-file copies pages with their resources via pdf-lib
  `copyPages` at save time; before save the engine shows an imported page
  via `PdfiumEngine.importPages` (add additively).

## Files you will create or touch

`src/renderer/modules/M40-organise-pages/**`, additive engine
`importPages`, `resources/page-sizes.json`, tests.

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

None new.

## Acceptance tests — the module is done when these pass on all three OSes

- Reorder 50 pages by drag → undo → redo ⇒ page order equals expected;
  saved bytes reopen with that order and every bookmark still targets
  the right page.
- Insert 3 pages from fixture B into A at position 2 with bookmarks
  ⇒ page count, sizes and outline entries correct.
- Extract pages 2-4 with comments ⇒ new file has 3 pages and their
  annotations.
- Page labels "A-1…" show in status bar and thumbnails; `/PageLabels`
  written.

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

Provenance (operator rule, 2026-09-09): the behaviour below comes from the PDF specification
(ISO 32000-1 §12.4.2 page labels, §7.7.3 the page tree), from this project's own `PLAN.md`
conventions, and from Foxit 14 **as a user sees it** — which commands exist on its Organize tab
and roughly what their dialogs ask for. No Foxit file has been opened, and no icon, string or
help text comes from one. Icons are Lucide (ISC) throughout, recorded in `resources/credits.json`.

- **One service, one targeting rule.** `OrganiseService` (service `"organise"`) answers the only
  question every command here asks: *which pages?* A command takes `{ pages }` or `{ range }` if
  given; failing that it uses the thumbnail multi-selection M12 already puts in the shell's
  `Selection` under the `pages` kind; failing that, the current page. One rule, one
  implementation, so the palette, the ribbon, the context menu and the e2e suite can never
  disagree about what "Delete Pages" would delete.
- **The range syntax is a pure parser** (`range.ts`), not a dialog. `1-3,5,8-` plus Foxit's
  extras — `odd`, `even`, `landscape`, `portrait`, `current`, `selected`, `all`, `last`, and a
  bare trailing dash for "to the end". It is a filter chain: tokens select, then odd/even and
  orientation narrow. Everything that takes a range in this module — and in M41 later — parses
  the same string with the same function, unit-tested against the awkward cases: reversed pairs,
  en dashes pasted from a document, out-of-range numbers, duplicates, empty text.
- **Page order stays model-only; page content is engine work.** M20's split is kept exactly.
  Delete, move, reverse and swap are edits to the model's page array with a `page-order` write
  intent, because `FPDFPage_Delete` cannot be undone and an engine-backed delete would make undo
  a lie. Only three operations genuinely add content — insert blank, insert from a file,
  duplicate — and those go to the engine **appended at its end**, so no existing engine index
  shifts and undo is a delete of the highest indexes. That is M20's `InsertPagesCommand` trick,
  reused rather than re-invented.
- **One command for every reordering.** `ReorderPagesCommand` takes the whole new page-id order
  and remembers the old one. Move, reverse, swap, and a multi-page drag are that one command with
  a different label — one thing to get right, one journal codec, one undo entry however many
  pages moved. A drag that ends where it started produces no command at all.
- **Insert-from-file is one path whatever the file is.** A PDF opens in the engine directly; an
  image, a text file, HTML or Markdown goes through M91's `CreateService.convertFile` first,
  which M91's own build log names as M40's path. So Insert → From File accepts a JPEG, and the
  clipboard insert is the same code with the clipboard as its source. Foxit's From Scanner is
  out of scope: the app has no scanner support anywhere yet.
- **Extract needs an empty document, so the engine gains one call.** `PdfEngine.createDocument()`
  (ADR 0016, additive, `FPDF_CreateNewDocument`) returns a handle with no pages, and `importPages`
  copies into it. The alternative — creating a one-page blank through M91 and deleting the page
  afterwards — would put a stray media box and an extra `FPDFPage_Delete` between the reader and
  their file for no reason. M41 needs the same call for split and merge, which is why it is a
  contract addition rather than a private helper.
- **"With comments" means markup, not every annotation.** PDFium's page import deep-copies a page
  with its `/Annots`, so extracting *with* comments is the default and costs nothing. Extracting
  *without* them removes the markup families only — highlight, underline, squiggly, strike-out,
  note, ink, shapes, free text, stamp, file attachment — and keeps `/Widget` and `/Link`, because
  a form field or a link is part of the page rather than a comment on it.
- **Deleting a page takes its dangling bookmarks with it**, as this brief asks, through
  `PruneOutlineCommand` inside the same undo entry as the delete — so one Ctrl+Z puts both back.
  This is a deliberate difference from M21's build log, which chose to leave the heading in place;
  M40's brief asks for Foxit's behaviour, so the setting `organise.pruneBookmarksOnDelete` exists
  and defaults to **on**, and turning it off gives M21's behaviour. Either way the writer still
  prunes the dead `/Dest` on the way out. Links are left to the writer: finding every dangling
  link would mean loading every page's annotations, and M21 already prunes them at save time.
- **Nothing has to follow a moved page, because nothing points at an index.** Annotations are
  filed under a `pageId`, destinations name a `pageId`, field widgets name a `pageId` (M20).
  Reordering rewrites one array. On save the writer reorders the same `PDFRef`s, so a bookmark's
  `/Dest [ref /XYZ …]` still names the page object it always named — which is why the reorder
  acceptance test needs no outline rebuild, and why a plain reorder deliberately records no
  `outline` write intent.
- **Page labels are resolved strings in the model and a numbering scheme in the file.**
  `labels.ts` turns (style, prefix, start, range) into the per-page strings the model, the
  thumbnails and the status bar all show. The file gets a real `/PageLabels` tree because
  `pageLabelNums` in M21's writer is taught to recognise runs of lower/upper roman and alphabetic
  labels as well as decimal ones, emitting `/S /r`, `/S /R`, `/S /a`, `/S /A` with an optional
  `/P` prefix. It is a pure function with a unit test and is exactly reversible, so a round-trip
  still reports no differences; anything it cannot describe as a run stays a literal `/P` entry,
  which reproduces any string at all.
- **Drag-and-drop is a pointer controller, not HTML5 drag.** It is installed once by this module
  and delegates from the document root, so M12's virtualised grid can build and drop cells
  underneath it without either module knowing the other's internals — M40 edits no M12 file.
  Pointer events give the insertion marker, edge auto-scroll and a Ctrl-to-copy modifier that a
  drag image cannot; and a drag under five pixels stays a click, so selecting still works.
- **Dragging pages "between two documents" lands on a tab.** Foxit shows two documents side by
  side and drags between their thumbnail panels; this shell has one navigation pane and no split
  view (M02), so there is no second panel to drop on. The reachable equivalent is dropping on
  another document's **tab**, which copies the pages into it, with the command
  `organize.copyToDocument` doing the same from the palette with a chooser. When a split view
  exists, the same controller gains a second drop target and nothing else changes.
- **Progress belongs to the operation, not to the loop.** Anything that touches more than twenty
  pages, or reads a file, runs under M02's cancellable progress dialog after the same 400 ms delay
  M21 uses — so a three-page insert never flashes a dialog and a 500-page extract can be stopped.
- **Every change is one undo entry with a name a reader recognises**: "Insert 3 pages", "Delete 2
  pages", "Reverse pages", "Label pages". M20's `dynamicLabel` reads them back on the Undo button.

## Build log (fill in at merge)

**Built 2026-09-09 on `mod/M40-organise-pages` (worktree `../ynotPDF-M40`).** Green locally on
Windows: lint (eslint, prettier, the colour/opacity rules, `tsc` on both projects), 2 438 unit
tests with the coverage gates, 251 Playwright tests.

### What shipped

- **The Organize tab, in four groups**, and twenty-one commands behind them: insert blank, insert
  from a file, insert from the clipboard, delete, extract, replace, duplicate, reverse, move, swap,
  copy to another document, rotate left / right / 180 / by range, move up / down / to the start /
  to the end, and page numbering with its own "remove numbering". Every one is in the command
  palette, five have shortcuts, and the thumbnail context menu is the same list rather than a
  second implementation of it.
- **One targeting rule, in one place.** `OrganiseService.target()` answers "which pages?" the same
  way for every command: what the caller passed (`{ pages }` or `{ range }`), else the thumbnail
  multi-selection M12 leaves in the shell's `Selection`, else the current page.
- **The range dialect** (`range.ts`, pure): `1-3,5,8-` plus `odd`, `even`, `landscape`,
  `portrait`, `current`, `selected`, `all`, `last`. It reads as a filter chain — selectors choose,
  the words narrow — so `"1-20, even, landscape"` and `"even"` both mean what a person expects.
  Reversed pairs, en dashes pasted out of a document, whitespace and duplicates are all handled;
  a page past the end is an *error in words*, not a silent trim.
- **Four document commands** with journal codecs. `ReorderPagesCommand` is the only one that
  rearranges anything — move, reverse, swap and every drag are that command with a different
  label, so there is one thing to get right and one undo entry however many pages moved.
  `ImportPagesCommand` carries the source bytes so it can replay itself after a crash;
  `SetPageLabelsCommand` renumbers a run in one entry; `PruneOutlineCommand` removes the bookmarks
  a deleted page leaves dangling, in the same undo entry as the delete.
- **Thumbnail drag-and-drop** (`dnd.ts`): single and multi-page, an insertion marker between
  cells, edge auto-scroll, Ctrl to copy, Escape to abandon, and a five-pixel threshold so a click
  is still a click. It delegates from the document root, so **no M12 file was touched** and the
  drag survives the auto-scroll that rebuilds the cells underneath it.
- **Page numbering, properly.** The dialog offers the five styles the format has plus "prefix
  only", with a live preview of what the first three pages would be called. The model holds
  resolved strings, as M20 defined; the *file* gets a real `/PageLabels` tree.
- **Extraction** to a new tab, to one file, or to one file per page with a naming pattern —
  with or without comments, and optionally deleting the pages afterwards in the same breath.
- **Progress that only appears when it is wanted**: after 400 ms for a small job, immediately for
  one over twenty pages, and cancellable throughout.

### Decisions worth knowing about

- **`PdfEngine.createDocument()` (ADR 0016)** is the module's one contract addition. Extract needs
  an empty document to import into, and the alternatives were a blank page created through M91 and
  then deleted, or a second page-copying implementation in pdf-lib — the thing ADR 0010 refused to
  do for the writer, for the same reason. M41 needs the same call for split and merge.
- **The numbering moved to `src/engine/pageLabels.ts`.** M21's writer and M40's dialog have to
  agree exactly on what "iii" is, and two implementations of a roman numeral are two chances to
  disagree. The writer's `pageLabelNums` is re-exported from its old home so M21's tests still
  import it from there.
- **Dragging pages "between two documents" lands on a tab.** Foxit shows two documents side by
  side and drags between their thumbnail panels; this shell has one navigation pane and no split
  view, so there is no second panel to drop on. Dropping on another document's **tab** copies the
  pages into it, and `organize.copyToDocument` does the same from the palette. When a split view
  exists the same controller gains a second drop target and nothing else changes.
- **A plain reorder deliberately records no `outline` write intent.** The writer reorders the same
  `PDFRef`s, so a bookmark's `/Dest [ref /XYZ …]` still names the page object it always named —
  rebuilding the outline would risk losing what the model never read, to fix something that is not
  broken. The acceptance test proves it by reopening the saved file and checking every bookmark.
- **Deleting a page takes its dangling bookmarks with it**, which is this brief's requirement and
  a deliberate difference from M21's build log, where the heading was left in place. The setting
  `organise.pruneBookmarksOnDelete` gives M21's behaviour back; either way the writer still prunes
  the dead `/Dest` on the way out.
- **M20's Rotate group left the Organize tab.** It was scaffolding "until M40 lands", and it acts
  on a page named by argument, defaulting to the first — so a reader who selected page 4 and
  pressed Rotate on the ribbon turned page 1. M40's rotate commands act on the selection and are
  what the tab carries now. M20's commands themselves stay: M11 and its own e2e suite call them
  by id.

### Bugs found while building, all real

- **A synchronous engine throw skipped every `.catch()`.** The in-memory engine validates its
  arguments before returning a promise, and so does the PDFium adapter for a bad handle — so
  `engine.close(x).catch(() => undefined)` in a `finally` could itself throw and replace the
  failure that got us there with a useless one about a handle. There is a `quietly()` helper now
  and every cleanup path goes through it.
- **A page label of "Cover" was written into the file as a numbering.** The greedy split read it
  as the prefix "Cove" numbered "r" — the eighteenth letter. It reproduces the string, so nothing
  visibly broke, but a title page is not numbered and an insert in another application would have
  carried the numbering on into nonsense. A prefix may no longer end in a letter, and "007" is
  refused for the same reason on the digit side.
- **A run of letters silently split into three ranges** at c, d, i, l, m, v and x, because "c" is
  roman 100 as readily as it is the third letter. A run is now continued by asking "what would
  this label be *in the style this run is already in?*" rather than by best guess.
- **"One file per page" could overwrite twenty files with the twentieth.** A naming pattern that
  mentioned neither `{page}` nor `{label}` produced one name for every page. The page number is
  appended when the pattern does not name it — before the extension, so a pattern ending in `.pdf`
  does not produce `Report.pdf 3.pdf`.
- **Moving pages did not carry the selection with them**, so pressing "move down" twice moved two
  *different* pages: the second press acted on whichever page had arrived at the index the first
  one left. Every move reselects what it moved now.
- **The status bar showed the page's position and never its number.** They are different things
  once a document is numbered — "A-1" is what is printed on the paper and what a colleague means
  on the telephone. A "Numbered A-1" field sits beside the shell's "Page 3 of 6", and hides itself
  for a document that has no numbering rather than saying "Numbered 3".

### A review pass over the finished branch, and what it found

Nine more, all real, all fixed here and all with a test:

- **Extract → “Open in a new tab” with “delete afterwards” deleted from the wrong document —
  and could never succeed.** Opening the extract *activates* its tab, so the delete step asked
  for the active document and got the extract, which holds exactly those pages; the guard then
  refused it as “a document must keep at least one page” while the source kept them all and the
  command reported success. Those are the dialog’s default settings, so it fired every time.
  `deletePages` now takes the document it is to act on.
- **Escape closed the progress dialog and the work carried on.** `onCancel` only fires for the
  Cancel *button*; Escape goes another way entirely. A reader who pressed Escape on a 500-page
  extract watched the dialog vanish and then got a Save dialog for a file they had abandoned.
  Any close that is not ours now aborts.
- **Cancelling produced a red error toast** saying “The operation was cancelled”. Pressing Cancel
  and being argued with about it is not an error; `cancellable()` turns it into nothing happening.
- **Choosing several files at once inserted them back to front**, because the insertion point was
  recomputed from a stale target each time round the loop. It advances by what the last file
  actually inserted now.
- **`range` was doing two jobs in Insert-from-file**: it means “where in *this* document”
  everywhere else, but its mere presence also skipped the page picker and brought in every page
  of the file. Only `sourcePages` chooses the source’s pages now.
- **Any string was accepted as a numbering style**, and an unknown one made `numeral()` return
  `undefined`, so `roman` instead of `romanLower` labelled every page in the range with the
  literal word “undefined” — as a real, undoable change. It is checked against the list.
- **Any pointer’s release ended a drag.** A second finger touching and lifting, or the right
  mouse button, dropped the pages wherever *that* pointer was. Only the pointer that started the
  drag ends it; the `pointerId` the controller was already storing is finally read.
- **Auto-scroll never re-aimed.** Holding the pointer still at the edge scrolled a hundred pages
  past while the insertion marker stayed with cells that had left the screen, so the reader had
  no idea where the drop would land — the one case pointer events were chosen to support.
- **A dispose-then-activate cycle left the module half-dead**: the commands kept working, because
  they resolve the service by name, while the drag and the status field silently did not.
  Re-activation re-binds instead of bailing out.

### Shared files touched (PLAN.md §12.3)

- `src/engine/PdfEngine.ts` — additive: `createDocument()`, the name in `ENGINE_METHODS`, and the
  method on `NotImplementedEngine` (ADR 0016).
- `src/engine/pdfium/PdfiumEngine.ts` — the implementation (`FPDF_CreateNewDocument`).
- `src/engine/pageLabels.ts` — **new**: the `/PageLabels` numbering, shared by M21's writer and
  M40's dialog. `src/engine/writers/FullRewriteWriter.ts` re-exports `pageLabelNums` from it and
  its own copy is gone.
- `src/renderer/modules/M20-document-model/manifest.ts` — the `organize.rotate` ribbon group
  removed, with a comment saying where it went. Its commands are untouched.
- `src/renderer/main.ts`, `src/renderer/index.html` — registers the M40 manifest and its CSS.
- `resources/credits.json` — **new**, per the operator's 2026-09-09 rule: the icon sets and fonts
  the app ships, with source, author and licence. M131 renders it as the acknowledgements page.
- `vitest.config.ts` — coverage gates for M40's pure half; its DOM half excluded as every other
  module's is, and proved by Playwright.
- `test/unit/core/fakeEngine.ts` — `createDocument` on the in-memory engine.
- `test/unit/writer/sections.test.ts` — one assertion updated: a roman run is a numbering now.

### Tests

2 438 unit tests and 251 e2e tests. The four acceptance tests:

- **Reorder 50 pages by drag → undo → redo.** A five-page fixture grown to fifty, one page dragged
  from the front to position 40 through the same call the pointer controller makes, then undone
  and redone; then a three-page drag, to prove a multi-selection keeps its own order. The saved
  file is reopened from disk. A second test reverses a document with a nested outline, saves,
  reopens, and checks that **every bookmark still targets the page it targeted**.
- **Insert 3 pages from fixture B into A at position 2 with bookmarks.** Page count, the sizes of
  the pages that were already there, the ids either side of the join, and the grafted outline
  entries pointing into the inserted range — then undo, which takes the pages and their bookmarks
  away together and leaves no validation issue. A second test inserts a JPEG, because a non-PDF
  goes through M91's converters on the same path.
- **Extract pages 2-4 with comments.** The written file is *reopened* and asked for its page count
  and its annotations, rather than trusted. Twelve more tests against real PDFium prove the slice
  keeps content, size, rotation and annotations, removes the markup and keeps the links when asked,
  and leaves the source document untouched.
- **Page labels "A-1…" show in the status bar and the thumbnails, and `/PageLabels` is written.**
  The status field, the thumbnail labels, the pages outside the range left alone, and the file
  reopened from disk with its numbering intact. A second test does the same for roman numbering,
  which is the case that used to be written as literals.

### Deferred, and why

- **Insert from a scanner** is out, as the brief says: the app has no scanner support anywhere yet.
- **Page transitions** are out, as the brief says.
- **Side-by-side thumbnail panels** need a split navigation pane M02 does not have. The
  cross-document drag lands on a tab instead (above), which is the reachable equivalent and not a
  fork: the same controller gains a second drop target when the pane exists.
- **Dangling *links* are left to the writer.** Finding every link that pointed at a deleted page
  would mean loading every page's annotations, and M21's writer already prunes them on the way
  out. Only the bookmarks, which the reader can see in a panel, are pruned in the model.
- **Split, merge, crop and flatten are M41's**, as the brief says. `createDocument` and
  `slicePages` are the two things M41 will want from here, and both are already contracts rather
  than private helpers.
