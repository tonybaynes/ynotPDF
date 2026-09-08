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

_Not started._
