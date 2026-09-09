# M12 — Navigation panels — thumbnails, bookmarks, layers, attachments, destinations

| | |
|---|---|
| **Module id** | `M12` — folder `src/renderer/modules/M12-navigation-panels/`, branch `mod/M12-navigation-panels` |
| **Earliest wave** | 3 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M11, M20 |
| **Unlocks** | [M40 Organise pages — insert, delete, extract, replace, rotate, move, labels](./M40-organise-pages.md) |

## Your task — the prompt for this conversation

You are building **M12 — Navigation panels — thumbnails, bookmarks, layers, attachments, destinations** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M11 Viewer — rendering, navigation, zoom, layouts](./M11-viewer.md), [M20 Document model, commands & undo stack](./M20-document-model.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M12-navigation-panels` from `main` in a new git worktree and
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

The left-pane panels that navigate and structure a document: virtualised
page thumbnails, an editable bookmark (outline) tree, layer (OCG)
visibility, embedded attachments, and named destinations.

## Foxit 14 reference — what to emulate

Foxit navigation panels: Pages (thumbnails with size slider, right-click
menu — many actions come in M40), Bookmarks (add/rename/nest/delete, set
destination, actions, expand levels, wrap long titles), Layers (toggle,
reset to initial), Attachments (open, save, add, delete, description),
Destinations, plus Fields/Signatures/Comments panels that later modules add.

## Scope — build all of this

- **Pages (thumbnails) is the default panel — operator requirement.** On
  launch and on every document open the left pane is open showing Pages,
  unless the setting `ui.leftPaneOnOpen` says otherwise. Values: `pages`
  (default) · `bookmarks` · `last-used` (M02's current behaviour) ·
  `closed`. Store it through `settings:get`/`settings:set`; expose it in
  this module as a right-click option on the pane tab strip ("Open this
  panel by default") and register it for the Preferences dialog (M130,
  View page). Bookmarks-on-open never overrides it, even for documents
  whose `/PageMode` is `/UseOutlines` — the user's choice wins.
- Thumbnails panel — layout rules (operator requirement, exact):
  - **Opens as a single column** of thumbnails at the default size; the
    panel's initial width is whatever one thumbnail plus margins needs.
  - **`+` and `−` buttons at the top of the panel** step the thumbnail
    size (e.g. 80 → 120 → 160 → 220 → 300 px wide; persisted as
    `ui.thumbnailSize`). Stepping **auto-resizes the panel width** to fit
    the new single-column size (wider on `+`, narrower on `−`) — the user
    never has to drag the splitter after zooming. Ctrl+wheel over the grid
    does the same; the buttons carry tooltips with words ("Larger
    thumbnails").
  - **Dragging the splitter wider adds columns**: the grid reflows to as
    many columns as fit at the current thumbnail size (2, 3, …); dragging
    narrower drops back to one. Column count is derived, never stored.
  - After a `+`/`−` step the grid keeps the current page in view.
  - Everything else: virtualised grid, current page highlighted with a
    word tooltip, click navigates, keyboard navigation, multi-select
    (Ctrl/Shift) exposed for M40, renders via engine at thumbnail scale
    with its own small cache; page labels shown under each thumb.
- Bookmarks panel: tree from `outline()`; expand/collapse, expand-to-level,
  click → destination (page + zoom mode/rect), keyboard navigation; **edit
  as Commands**: add (from current view), rename inline, delete, nest/
  un-nest, reorder by drag, set destination to current view, action editor
  (go to page / open URL / open file), colour/bold/italic style, wrap long
  titles setting. Persisted through M21's save.
- Layers panel: OCG tree with checkboxes (word "Visible"), toggle re-renders
  affected pages (engine flag), "reset to initial visibility", lock state
  shown; import/export of visibility as a view state (not a document
  change unless "Apply as default" — a Command).
- Attachments panel: list with name/size/description/modified; open (temp
  file via IPC → OS default app), save as, add file(s), delete, edit
  description — all Commands. Also lists file-attachment *annotations*
  (read-only here; M31 creates them).
- **PDF Portfolios open properly (operator requirement).** A file with a
  `/Collection` dictionary is a portfolio: show its cover sheet as the
  page, open the Attachments panel automatically listing the embedded
  files, and let an embedded PDF open **in a new tab** (double-click /
  "Open") as a read-only-until-saved-as document; other types open in the
  OS default app. Show the collection's schema columns if present. Sample:
  `test/fixtures/local/Sample Portfolio.pdf` (Foxit-made, three PDFs).
  Creating/editing portfolios is **M42** (wave 4), which extends your
  attachments code — keep it extensible, not forked.
- Destinations panel: named destinations list, click navigates, rename/
  delete as Commands, "create from current view".
- Panel toggles in View ribbon and shortcuts (F4 style) as Foxit.

## Out of scope

Page manipulation from the thumbnail context menu (M40 adds the menu
items). Comments/Fields/Signatures panels (M32/M60/M81).

## Design notes & constraints

- Outline edits mutate `Document.outline` (model) and are journaled; the
  writer (M21) rebuilds the /Outlines tree on save.
- Thumbnail renders are low priority in the engine queue so they never
  starve the main view.
- Destination model: `{ page, kind: 'XYZ'|'Fit'|'FitH'|'FitV'|'FitR', args }`
  shared with M53 links and M61 actions.

## Files you will create or touch

`src/renderer/modules/M12-navigation-panels/**` (one sub-folder per
panel), additive `Document` fields for outline/destinations/attachments
edits, `test/e2e/panels.spec.ts`, `test/unit/outline-commands.test.ts`.

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

- Outline fixture: click every bookmark → correct page/zoom; add/rename/
  nest/delete/reorder then undo all → tree equals original (unit).
- Layers fixture: toggling a layer changes the render hash of the page and
  back.
- Attachments fixture: add a file, save (M21), reopen → attachment present
  with description.
- Fresh profile: launch, open any PDF ⇒ left pane is open on Pages with
  thumbnails rendered. Set `ui.leftPaneOnOpen = 'closed'`, reopen ⇒ pane
  closed; set `'pages'` again ⇒ back, including for a `/PageMode
  /UseOutlines` fixture.
- `Sample Portfolio.pdf` (local, skip if absent): opens on its cover sheet,
  Attachments panel lists three PDFs, double-click opens one in a new tab.
- Fresh profile: Pages panel shows exactly one column; press `+` twice ⇒
  thumbnails larger, panel visibly wider, still one column, current page
  still in view; press `−` ⇒ narrower again. Drag the splitter to ~2.5×
  the width ⇒ two columns; back ⇒ one.
- Thumbnails: 500-page fixture scrolls the grid at ≥ 55 fps; current page
  follows the viewport.

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

- **One service, five panels.** `NavigationService` (service `"navigation"`) owns what the
  panels share: the settings, the thumbnail renderer, the per-tab panel memory and the
  portfolio handling. Each panel is a small mount function that reads the active
  `Document` and the service, so a panel can be opened, closed and reopened without losing
  anything.
- **Pages is the default panel through `ui.leftPaneOnOpen`.** A single setting with four
  values (`pages` · `bookmarks` · `last-used` · `closed`) decides what the left pane shows
  when a document opens. It is applied on every open, so a `/PageMode /UseOutlines` file
  never overrides the user's choice — the model carries `view.pageMode`, and this module
  deliberately ignores it. Right-clicking the pane tab strip offers "Open this panel by
  default"; the same key is declared in the settings schema for M130's View page.
- **Thumbnail size is a ladder, the column count is derived.** Sizes are 80 · 120 · 160 ·
  220 · 300 px wide (`ui.thumbnailSize`, persisted). `+` / `−` and Ctrl+wheel step the
  ladder and *also* set the pane width to exactly one column at the new size, which is what
  makes "the user never drags the splitter after zooming" true. Dragging the splitter is
  left alone: the grid divides the width it is given by the column pitch, so 2, 3 … columns
  appear on their own and drop back to one. Nothing about columns is ever stored.
- **The thumbnail grid is virtualised on rows, not on pages.** Row height is fixed for a
  given size (thumb + label + gap), so the first and last visible rows are arithmetic, and
  only those rows have DOM. A 500-page document therefore costs the same as a 5-page one.
- **Thumbnails render through their own low-priority renderer**, not M11's `TileRenderer`:
  the tile cache is keyed by zoom bucket and would evict page tiles to hold thumbnails.
  `ThumbnailRenderer` keeps one engine request in flight, holds back while the viewer's
  renderer has work outstanding (`stats().queued + inFlight > 0`), and cancels a request
  whose row has scrolled away — so a thumbnail never delays the page the reader is looking
  at. Its cache is an LRU of decoded bitmaps bounded by count, keyed by
  (tab, page id, size, render revision).
- **Bookmark edits are `Command`s on the model's outline array.** The engine has no outline
  writer, so every edit records the `outline` write intent and M21's writer rebuilds
  `/Outlines` on save (its planner already does this). The tree operations — insert, move,
  nest, un-nest, reorder, delete-with-descendants — are pure functions over the flat
  `ModelOutlineItem[]` in `bookmarks/tree.ts`, unit-tested; the commands are the only thing
  that touches the document.
- **Named destinations become editable, so they need a write intent of their own.**
  `destinations` is added to `WriteIntent`; M21's planner already knows how to write
  `/Names /Dests` and simply had nothing to fill it from ("read-only until M12 edits them").
- **Layer visibility is a real render change.** `PdfEngine.setLayerVisible` existed but no
  adapter implemented it. PDFium has no OCG API, so the adapter walks every page's objects,
  matches each object's `/OC` marked-content name to the group, and calls
  `FPDFPageObj_SetIsActive` — render-time only, `FPDFPage_GenerateContent` is never called,
  so the file on disk is untouched and undo is exact. The command also records the `layers`
  intent so a save writes `/OCProperties /D /OFF`. Toggling drops the tab's cached tiles and
  repaints.
- **View state vs document change, for layers.** Toggling a layer in the panel is a
  `Command` (Foxit's is undoable too and it is what the save writes). Import/export of a
  visibility set is a view state — a JSON file of name → boolean — applied without a command
  unless "Apply as default" is ticked, which runs the same commands in one undo entry.
- **Attachments are engine-backed.** PDFium can add, delete and re-describe embedded files
  (`FPDFDoc_AddAttachment`, `FPDFDoc_DeleteAttachment`, `FPDFAttachment_SetFile`,
  `FPDFAttachment_SetStringValue`), so the attachment commands mutate the engine and undo
  exactly, with no write intent. Attachment ids are positional (`att.<n>`), so the id table
  is repaired by index arithmetic after every add and delete — the same trick M20 needed for
  annotations.
- **A portfolio is a document whose catalogue has `/Collection`.** New engine read
  `collection(doc)` returns the schema (field key, label, kind, order, visibility) and the
  view mode; `attachments()` gains the per-file collection values from each file
  specification's `/CI` plus `/CreationDate`. The Attachments panel renders those as columns
  when the document is a portfolio, opens the pane on itself, and shows the cover sheet as
  the page — which needs no special case, because a portfolio's cover *is* its page 1.
  Double-click on an embedded PDF opens it in a new tab through `DocumentService.open` with
  no path, so it is unsaved-until-Save-As; anything else goes to the OS through a new IPC
  channel that writes a temp file and calls `shell.openPath`. M42 extends this; nothing here
  forks.
- **Destinations navigate through one function.** `destinationScroll()` (pure) turns a
  `ModelDestination` plus the page rect and zoom into a scroll offset and an optional zoom,
  so bookmarks, the destinations panel and (later) links all land in the same place. `XYZ`
  with a null zoom keeps the current zoom, as the spec says.
- **Every panel is keyboard-first.** Each is a `role="tree"` or `role="listbox"` with roving
  tabindex, Home/End/arrows/Enter, and a context menu on the menu key. Selection state that
  M40 needs (multi-select of thumbnails with Ctrl/Shift) lives in the shell's `Selection`
  service under the `pages` kind, so M40 reads it without knowing about this module.
- **No colour-only signals.** A hidden layer says "Hidden" beside its checkbox, the current
  page's thumbnail carries the word "Current page" in its tooltip and an `aria-current`, and
  a portfolio row's type is a word, never an icon alone.

## Build log (fill in at merge)

**Built 2026-09-08 on `mod/M12-navigation-panels` (worktree `../ynotPDF-M12`).** Green locally on
Windows: lint (eslint, prettier, the colour/opacity rules, `tsc` on both projects), 1 638 unit
tests with the coverage gates, 146 Playwright tests.

### What shipped

- **Five panels, in `src/renderer/modules/M12-navigation-panels/`.** **Pages** — a virtualised
  grid whose rows, not pages, are what exists in the DOM, so a 1 000-page document costs what a
  five-page one does. **Bookmarks** — the outline as an editable tree: expand-to-level, inline
  rename, drag to reorder with before / into / after zones, indent and outdent, colour, bold,
  italic, and a destination or a URI action. **Layers** — a checkbox and the word "Visible" or
  "Hidden" each, reset to the visibility the document opened with, and import/export of a
  visibility set as a view or as the document's own default. **Attachments** — the embedded
  files, a portfolio's own schema columns, open, save as, add, delete, describe, and the
  file-attachment annotations listed read-only for M31. **Destinations** — the named
  destinations, click to go, rename in place, re-aim at the current view, delete, create from
  the current view.
- **Pages is the default panel** (`ui.leftPaneOnOpen`, values `pages` · `bookmarks` ·
  `last-used` · `closed`), applied on every document open, offered on the pane tab strip's
  right-click menu and declared in the settings schema for M130. A file whose `/PageMode` asks
  for `/UseOutlines` does not override it — `outline.pdf` is exactly such a file and there is a
  test that opens it.
- **The thumbnail layout rules, exactly as asked.** One column at the current size; `+`, `−` and
  Ctrl+wheel step the ladder (80 · 120 · 160 · 220 · 300) and re-set the pane to one column at
  the new size, keeping the current page in view; dragging the splitter divides more columns out
  of the width it is given, and the column count is stored nowhere.
- **Thumbnails never delay the page you are reading.** `ThumbnailRenderer` keeps its own small
  LRU of bitmaps (out of M11's tile cache on purpose), holds every request back while the
  viewer's renderer has work outstanding, keeps one render in flight, and cancels what has
  scrolled away.
- **Thirteen document commands** with journal codecs, and forty-odd registered commands — every
  one in the palette, five panel shortcuts (`Mod+Shift+1`–`5`), `Mod+B` for a bookmark, three
  View ribbon groups and five context menus.
- **PDF Portfolios open properly.** New engine read `collection()` returns the `/Collection`
  schema; the Attachments panel opens by itself, shows the portfolio's own columns, and an
  embedded PDF opens in a new tab. Verified against the operator's `Sample Portfolio.pdf`: all
  three files open in tabs.
- **Engine and writer work (ADR 0011).** `setLayerVisible` is implemented in the PDFium adapter
  by deactivating the page objects marked with the group — render-time only, so the bytes are
  untouched and undo is exact. `addAttachment` / `updateAttachment` / `deleteAttachment` make
  embedded files editable. Two IPC channels: pick any files, and hand bytes to the OS through a
  temp file. `WriteIntent` gains `destinations` and `attachments`, and the writer gains the
  section that puts an embedded file's description and type where a reader looks for them.

### Bugs the tests and the operator found, all real

- **An attached file's bytes were gone by the time the journal wanted them.** The engine
  *transfers* a `Uint8Array` into its worker, which detaches the buffer on this side, so
  `toJSON()` — and a redo — read an empty array. The command keeps its own copy now.
- **The Pages panel opened at the shell's generic 260 px pane width**, so `+` made the pane
  *narrower*. It sizes the pane to one column when it first opens instead — and then did it
  wrong a second time, by treating `ui.leftPane.width` as the panel's width when it is the
  pane's, icon strip included. A single column had a horizontal scrollbar under it until that
  was fixed.
- **The `+` / `−` buttons went round the service rather than the command**, so the palette, the
  ribbon and the wheel could have drifted apart. They all run `view.thumbnails.larger` now.
- **A bookmark nested under a collapsed parent vanished.** The panel opens whatever is hiding
  the selected bookmark.
- **A portfolio's own PDFs said they were `text/plain`.** The operator's Foxit-made portfolio
  declares `/Subtype /text#2Fplain` on all three embedded PDFs, so "open in a new tab" decided by
  MIME type handed them to the OS instead. A PDF is now decided by its name and its `%PDF-`
  bytes, and the type is believed last.
- **A debugging run opened three PDFs in Foxit on the operator's desk.** The two channels that
  hand something to the operating system now do everything except the last step under
  `YNOT_E2E`, and the temporary copies are deleted when the app quits.
- **M02's shell test asserted that the demo module owned the only two left panels.** It asserts
  that its own two are there.

### Shared files touched (PLAN.md §12.3, all per ADR 0011)

- `src/engine/PdfEngine.ts` — additive: `collection()`, `addAttachment`, `updateAttachment`,
  `deleteAttachment`, the `PdfCollection` / `CollectionField` / `NewAttachment` /
  `AttachmentPatch` types, `Attachment.created` and `Attachment.collectionFields`, the four names
  in `ENGINE_METHODS`, and the four methods on `NotImplementedEngine`.
- `src/engine/pdfium/{PdfiumEngine,rawdoc,mutations}.ts` — the implementations.
- `src/engine/Writer.ts` and `src/engine/writers/FullRewriteWriter.ts` — additive:
  `PlannedAttachment`, `WritePlan.attachments`, the `attachments` phase and `writeAttachments`.
- `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/main/files.ts`, `src/main/index.ts` —
  `file:openFilesDialog`, `shell:openTempFile`, the temp-file writer and its cleanup on quit.
- `src/renderer/core/model.ts` — additive: `destinations` and `attachments` write intents,
  `ModelAttachment.created` and `.collectionFields`.
- `src/renderer/core/events.ts` — additive: `destinations:changed`, `attachments:changed`.
- `src/renderer/core/Document.ts` — additive: the destination and attachment record helpers and
  `rebindAttachments`.
- `src/renderer/core/commands.ts` — `SetLayerVisibleCommand` always records the `layers` intent,
  because the engine's implementation is render-time only.
- `src/renderer/view/DocumentView.ts` and `src/renderer/modules/M11-viewer/Viewer.ts` — additive:
  `refresh()`.
- `src/renderer/modules/M21-save/{plan,SaveService}.ts` — the planner fills the two new sections;
  the progress dialog names the new phase.
- `src/renderer/main.ts`, `src/renderer/index.html`, `vitest.config.ts`, `PLAN.md` §0.

### Deferred, and why

- **Creating and editing portfolios is M42**, as the brief says. The reader, the schema columns
  and open-in-a-tab are here and are not forked: M42 adds a writer to `collection()` and editing
  to the same panel.
- **Page manipulation from the thumbnail context menu is M40's**, also as the brief says. The
  multi-select it needs is here, in the shell's `Selection` service under the `pages` kind.
- **A bookmark's "open file" action opens a URL, not a path.** `bookmarks.setAction` takes a web
  address; a `/Launch` action pointing at a file on disk is read and preserved, but ynotPDF will
  not follow one on a click — running what a PDF names is not something a viewer should do
  without the whole trust conversation M81 will bring.
- **Attachment ids are positional**, because PDFium's are. The id table is repaired by index
  arithmetic after every add and delete, and there is a test for it; a name-keyed engine would be
  better and is not worth an ADR of its own yet.
- **M21's `AddOutlineItemCommand` stays.** It was written as scaffolding "until M12 lands", and
  M12's own `AddBookmarkCommand` supersedes it for the UI, but four of M21's tests are built on
  it and removing it is a change to that module's suite rather than to this one's.
