# M11 — Viewer — rendering, navigation, zoom, layouts

| | |
|---|---|
| **Module id** | `M11` — folder `src/renderer/modules/M11-viewer/`, branch `mod/M11-viewer` |
| **Earliest wave** | 2 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M02, M10 |
| **Unlocks** | [M12 Navigation panels — thumbnails, bookmarks, layers, attachments, destinations](./M12-navigation-panels.md), [M13 Text selection, find, copy, snapshot & print](./M13-select-find-print.md), [M30 Annotations — text markup, notes, typewriter, text box, callout](./M30-markup-annotations.md), [M40 Organise pages — insert, delete, extract, replace, rotate, move, labels](./M40-organise-pages.md), [M50 Page-object model — select, move, resize, align, arrange](./M50-object-model.md), [M92 Export to images, text, HTML & RTF](./M92-export.md), [M110 Compare documents](./M110-compare.md) |

## Your task — the prompt for this conversation

You are building **M11 — Viewer — rendering, navigation, zoom, layouts** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M02 Application shell (ribbon, panes, tabs, status bar, dialogs)](./M02-app-shell.md), [M10 PDF engine layer & PDFium adapter](./M10-engine-layer.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M11-viewer` from `main` in a new git worktree and
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

The page view: tiled progressive rendering, scrolling, zoom modes, page
layouts, rotation, rulers/grids/guides, split view, full-screen and reading
modes, opened documents in tabs — the surface every editing tool draws on.

## Foxit 14 reference — what to emulate

Foxit View tab: Zoom In/Out, Fit Page/Width/Visible/Actual Size, Marquee
zoom, Loupe, Magnifier, Rotate View, Single Page / Continuous / Facing /
Continuous Facing / Book (cover page option), Auto-Scroll, Rulers, Grid,
Guides, Line Weights, Split (vertical/horizontal/spreadsheet), Full Screen,
Reading Mode, Navigation panels toggle, Page Transitions (skip).

## Scope — build all of this

- `Viewport` + `PageView` per page with the six overlay layers (only
  raster + text layers populated here; others are empty hosts).
- Tile renderer: 512 px tiles × DPR, LRU cache bounded by MB (setting),
  low-res whole-page placeholder first, viewport-priority queue, cancel on
  scroll, requestIdleCallback prefetch of neighbours; correct for `/Rotate`
  and CropBox via `PageGeometry`.
- Layouts: single, continuous, facing, continuous-facing, book (first page
  alone); page gap and canvas backdrop from tokens; virtualised — only pages
  near the viewport have DOM.
- Zoom: 1–6400 %, keyboard/ctrl+wheel/pinch, zoom to cursor, fit page /
  width / visible, marquee zoom tool, loupe tool (opaque floating window),
  zoom presets in status bar (editable field + slider).
- Navigation: page field, first/prev/next/last, Home/End/PgUp/PgDn,
  go-to-page dialog, back/forward history (Alt+←/→), scroll position per
  document restored on reopen (settings).
- Rotate view 90° steps (view-only, not a document change).
- Rulers (units: pt/mm/cm/in, setting), grid (spacing setting, snap flag
  exposed for tools), guides dragged from rulers, line-weights toggle
  (render flag), rendering options: smooth text/images/line art, greyscale,
  page thumbnails backdrop colour per theme.
- Split view: two viewports on the same document (vertical/horizontal),
  independent zoom/scroll, synced-scroll toggle.
- Full screen (F11) and reading mode (hide chrome, keep a minimal floating
  bar — opaque), Esc exits. Auto-scroll with speed keys.
- Multi-document: each tab owns a `Viewport`; open via backstage, dialog,
  drag-drop onto window, OS file association (IPC from main), CLI arg;
  password prompt on encrypted files (opaque dialog, retry, show/hide).
- Hand tool (default) and Select-text tool stub (M13 completes it).
- Performance HUD (dev only): tiles/s, cache hit rate, worker queue depth.

## Out of scope

Text selection, find, print (M13). Thumbnails/bookmarks (M12).
Annotation rendering beyond what PDFium bakes into the raster.

## Design notes & constraints

- The scroll container is one element; pages are absolutely positioned
  with a computed layout table (`LayoutEngine.layout(pages, mode, zoom) →
  rects`). All coordinates in CSS px; conversion to PDF points only in
  `PageGeometry`.
- Never re-render on scroll — move DOM, fill tiles.
- All view state (zoom, layout, page, rotation, split) in the store so the
  status bar, ribbon toggles and tests read one source.
- Keyboard: complete Foxit shortcut set for view (document it in
  `docs/shortcuts.md`, started here, extended by later modules).

## Files you will create or touch

`src/renderer/view/**`, `src/renderer/modules/M11-viewer/**`,
`test/e2e/viewer.spec.ts`, `test/unit/view/layout.test.ts`,
`docs/shortcuts.md`.

## Libraries

None new.

## Acceptance tests — the module is done when these pass on all three OSes

- Open the 500-page fixture; scroll end-to-end with the perf HUD showing
  ≥ 55 fps average and memory bounded by the cache setting (Playwright
  metrics).
- Each layout mode produces the expected page rects for 1, 2, 3, 7 pages
  (unit table test) including book mode.
- Zoom to cursor keeps the point under the cursor stationary (±1 px).
- Rotated and CropBox fixtures render the visible region correctly
  (hash compare against engine full-page render).
- Encrypted fixture prompts for password; wrong password re-prompts with a
  worded error; Esc cancels cleanly.
- Split view scrolls independently and in sync; full screen and reading
  mode enter/exit by shortcut; guides persist per document session.

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
