# M02 — Application shell (ribbon, panes, tabs, status bar, dialogs)

| | |
|---|---|
| **Module id** | `M02` — folder `src/renderer/modules/M02-app-shell/`, branch `mod/M02-app-shell` |
| **Earliest wave** | 1 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M00, M01 |
| **Unlocks** | [M11 Viewer — rendering, navigation, zoom, layouts](./M11-viewer.md), [M130 Preferences, keyboard shortcuts editor, ribbon/QAT customisation, UI scale, i18n framework](./M130-preferences.md) |

## Your task — the prompt for this conversation

You are building **M02 — Application shell (ribbon, panes, tabs, status bar, dialogs)** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M00 Scaffold, CI & packaging smoke](./M00-scaffold.md), [M01 Theme system (four themes)](./M01-theme-system.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M02-app-shell` from `main` in a new git worktree and
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

Build the Foxit-style chrome that every feature module plugs into: a
data-driven ribbon, quick-access toolbar, left navigation pane, right
properties pane, document tabs, status bar, dialog/popup system, command
palette and the keyboard focus model. All driven from `ModuleManifest`s —
the shell knows no features.

## Foxit 14 reference — what to emulate

Foxit 14 window layout: File backstage, ribbon tabs Home/Edit/Comment/View/
Form/Protect/Organize/Convert/Accessibility/Help with grouped large/small
buttons and drop-downs; collapsible navigation panel with icon strip;
right-hand properties panel; document tabs; status bar with page number,
zoom slider and layout buttons; Ctrl+F find bar; customisable quick-access
toolbar; keyboard tips.

## Scope — build all of this

- Ribbon (`app/ribbon/`): tabs from manifests (`ribbon.tab`, `ribbon.group`,
  order keys), button kinds: large, small, split, dropdown, toggle, gallery,
  colour picker, input; collapsed/minimised state; overflow when narrow;
  contextual tabs (e.g. "Ink Tools") shown when a `when()` predicate is true;
  keyboard navigation (Alt shows key tips, arrows move, Enter activates).
- Quick-access toolbar above the ribbon; items persisted.
- **File backstage** (full-window panel): Open, Recent (with pin), New (from
  registered creators), Save/Save As (registered by M21), Print, Properties,
  Preferences, Exit — each a slot modules fill.
- Left nav pane: icon strip + panel host; panels from manifests (`panel.side
  = 'left'`), resizable, collapsible, remembers width and last-open panel.
- Right properties pane: hosts `panel.side = 'right'`; shows the panel whose
  `when()` matches the current selection; hidden when nothing matches.
- Document tabs (`app/tabs/`): `DocumentTab` per open `Document`, dirty dot
  + word "Modified" in tooltip, middle-click close, drag reorder, drag out →
  new window via IPC, Ctrl+Tab switching, close-with-unsaved prompt hook.
- Status bar: slots (left/centre/right) modules fill; default shows page
  x of y (editable), zoom (editable + slider), layout buttons, theme switch.
- Dialog system (`app/dialogs/`): modal + non-modal, fully opaque, focus
  trap, Esc/Enter, standard footer buttons, form helpers (label above
  input, hint below, aligned grid), progress dialog with cancel, message box
  (info/warn/error with icon + word), toast/notification area (opaque).
- Command palette: fuzzy search over all registered commands, shows
  shortcut and category, runs on Enter.
- Shortcut manager: registers manifest shortcuts, resolves conflicts (last
  wins + warning in dev), platform mapping (Cmd on mac).
- Focus model: roving tabindex in toolbars, F6 cycles regions (ribbon →
  document → left pane → right pane → status), visible focus everywhere.
- Context-menu service (right-click) modules append to, keyboard-openable.
- Window: remember size/position/maximised per display; multi-window aware.
- Empty state (no document): large "Open" / "Recent" / "Create" tiles.

## Out of scope

Any PDF behaviour. Preferences dialog content (M130). Real panels (later
modules) — M02 ships a demo manifest used only by tests.

## Design notes & constraints

- Ribbon and panels are pure functions of manifests + a `UiState` in the
  store; re-render is granular (per group), not whole-ribbon.
- All popups (dropdowns, menus, palettes) are positioned DOM with opaque
  backgrounds and `--border-strong`; no portals to other windows.
- Sizes in `rem` so `--ui-scale` works.
- Provide a `DemoModule` manifest under `test/e2e/demo-module/` that
  exercises every widget kind; delete nothing from it later — it is the
  regression suite for the shell.

## Files you will create or touch

`src/renderer/app/**`, additive registration hooks in `core/Registry.ts`,
`test/e2e/shell.spec.ts`, `test/e2e/demo-module/`.

## Libraries

None new (Lucide icons via a small `icon()` helper that inlines SVG).

## Acceptance tests — the module is done when these pass on all three OSes

- Playwright: demo module's ribbon tab, groups and every button kind
  render; dropdown opens/closes by mouse and keyboard; contextual tab
  appears when its `when()` flips; key tips work.
- Nav pane opens each demo panel; widths persist across restart.
- Tabs: open three demo documents, reorder by drag, Ctrl+Tab cycles,
  close prompts when dirty.
- Palette finds and runs a demo command; F6 cycles regions; every
  interactive element has a visible focus ring (axe-core run reports no
  focus/contrast violations in all four themes).
- No element in the DOM has computed `opacity < 1` or an `rgba` background
  with alpha < 1 (a test walks the tree).

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
