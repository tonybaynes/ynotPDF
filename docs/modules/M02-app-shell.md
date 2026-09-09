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
targeting the feature set of **Foxit PDF Editor 14** — *feature set only*:
**never copy Foxit's icons, artwork, wording, help text or documentation.**
Icons come from Lucide or are drawn by us; they may be similar in idea (a
magnifier for zoom) or better, never traced or pixel-copied. Help and
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

- **Contract additions are additive and recorded in [ADR 0004](../adr/0004-shell-contribution-points.md).**
  New optional manifest keys: `ribbonTabs` (contextual tabs with a `when()`), `statusBar`
  (left/centre/right slots), `backstage` (File-menu slots), `contextMenus`. `RibbonGroupSpec.items`
  accepts rich `RibbonItemSpec` objects (split, dropdown, toggle, gallery, colour, input) beside the
  plain command-id strings M00 defined; `RibbonGroupSpec.tab` may name a contextual tab;
  `PanelSpec.when` picks the properties panel; `CommandSpec.keyTip` overrides the generated key tip;
  `RecentFile.pinned` backs the backstage pin. M00's and M01's manifests compile and render
  unchanged.
- **The shell is a pure function of manifests + one `UiState` store** (`app/ui/UiState.ts`).
  Every region subscribes to its own slice. `when()` predicates are re-evaluated only on an explicit
  `ui.invalidate()` (fired by selection, tab, registry and document changes), and each ribbon group
  computes a small signature (visible / enabled / pressed / value per item) and patches only when
  it changes — never a whole-ribbon re-render.
- **Persistence goes through `settings:get` / `settings:set`** (ADR 0003) under `ui.*` keys,
  debounced: pane widths, collapsed state, last-open panel, QAT items, ribbon minimised, layout.
  Window bounds are saved by *main* (`window.bounds.<displayKey>`) because it needs them before
  the renderer exists; they are keyed by the display's id + size so a laptop docked to a monitor
  keeps two remembered positions.
- **One popup primitive, positioned DOM in the same document** (`app/popup.ts`): anchor rect →
  placement with flip and clamp, opaque `--bg-panel` with `--border-strong` and the solid
  `--elevation`, closes on Esc / outside click / focus loss, returns focus to its anchor.
  Dropdowns, split menus, galleries, colour pickers, context menus, key tips and the palette all
  build on it. Modal dialogs are native `<dialog>` (browser focus trap, `::backdrop` painted solid
  `--shadow`); non-modal ones are the same element opened with `show()`.
- **Documents are tab entries, not `Document`s yet** (`app/tabs/Documents.ts`): `{ id, title,
  path, dirty }` plus a `beforeClose` hook that M21's Save/Don't save/Cancel plugs into. M00's
  `file.openBytes` now opens a tab; M20/M11 attach the real `Document` and `Viewport` by tab id.
- **Drag is pointer events with capture, not HTML5 drag-and-drop.** HTML5 DnD is unreliable under
  Playwright on Linux; pointer drags are deterministic on all three OSes. Releasing a tab outside
  the window sends `window:new` over IPC, which detaches it into a second window.
- **Icons come from the `lucide` package (ISC) as a devDependency**, bundled by Vite, never fetched
  at runtime. `app/icons.ts` maps kebab-case names to an explicit set of icon nodes (tree-shaken)
  and renders inline `<svg>` with `currentColor`; `registerIcon()` lets modules add theirs. An
  unknown name renders a labelled placeholder glyph, never nothing.
- **Key tips are assigned by a pure function** (`ribbon/keytips.ts`): first letter, then first two
  letters, then digits, unique per level — unit-tested. Alt shows them, letters navigate, Esc backs
  out.
- **Shortcut conflicts: last binding wins and dev builds warn** with both command ids;
  `ShortcutManager.conflicts()` exposes the list for M130's editor. `Mod` is Cmd on macOS, Ctrl
  elsewhere, resolved once from the preload's `platform`.
- **Focus model**: F6 / Shift+F6 cycle the regions ribbon → document → left pane → right pane →
  status bar (`data-region`), every toolbar is a roving-tabindex group (one tab stop, arrows move),
  and the two-ring focus style from M01 is never removed.
- **The status bar's page / zoom / layout controls are the shell's, and M11 drives them through
  the store.** M02 registers `view.page.*`, `view.zoom.*` and `view.layout.set`, which only write
  `ui.view`; M11 subscribes to that slice and applies it to the viewport, so the status bar,
  ribbon toggles and tests read one source (as M11's brief asks) and no command id is registered
  twice.
- **The demo module lives in `test/e2e/demo-module/`** and is registered by the renderer only in
  e2e mode (dynamic import behind the existing `e2e` flag). It exercises every widget kind and is
  the shell's regression suite; nothing is deleted from it later.
- **Unit tests cover the pure logic in Node** (ribbon model, key tips, fuzzy search, documents
  service, popup placement, UiState reducers, shortcut conflicts); DOM behaviour is Playwright.

## Build log (fill in at merge)

**Shipped (2026-09-07):**

- **Contracts** — [ADR 0004](../adr/0004-shell-contribution-points.md): rich `RibbonItemSpec`
  (button / split / dropdown / toggle / gallery / colour / input), contextual `ribbonTabs`,
  `PanelSpec.when`, `statusBar`, `backstage`, `creators`, `contextMenus`, `CommandSpec.keyTip`,
  `RecentFile.pinned`; IPC `recent:pin`, `recent:remove`, `window:new`, `window:getState`,
  `window:count`, event `window:stateChanged`. All additive; `Registry.ribbonTabs()` added.
- **Main**: multi-window (`window:new`, cascaded; IPC acts on the sender's window), remembered
  bounds per display arrangement (`src/main/windowBounds.ts` + `windowState.ts`), pinned recent
  files that survive `clear()`.
- **Renderer shell** (`src/renderer/app/`): `UiState` store + settings persistence; ribbon
  (`ribbon/`: pure model, widgets, key tips, QAT, minimise/peek, overflow collapse into popup
  groups, roving keyboard navigation); `popup.ts` + `menu.ts` (one opaque positioned-DOM primitive
  for dropdowns, submenus, galleries, colour pickers, context menus); `panes/` (nav pane with icon
  strip, lazy panel mounting, keyboard/pointer resizer, persisted width + last panel; properties
  pane driven by `PanelSpec.when`); `tabs/` (`Documents` service with close hooks, tab strip with
  dirty dot + word, middle-click close, pointer-drag reorder, drag-out → `window:new`); `statusbar/`
  (three slots; page field, zoom field + slider + fit, layout radio group, M01 theme switch);
  `backstage/` (nine Foxit slots, unfilled ones say "Not available yet"; Open / Recent with pin /
  New with creator tiles); `dialog/` (native `<dialog>` service: message box with icon + word,
  confirm, prompt, progress with cancel, non-modal, form helpers; opaque toasts); fuzzy command
  palette with match highlighting and recent-first ordering; `ShortcutManager` (conflict report,
  Alt tap → key tips, modal-aware); focus regions (F6 / Shift+F6) and roving tabindex; context-menu
  service; empty state with Open / Recent / Create tiles; drop-a-PDF-on-the-window.
- **Icons**: `lucide` (ISC) as a devDependency, 137 icons mapped in `app/icons.ts`, inline SVG with
  `currentColor`; unknown names render a visible placeholder glyph.
- **M02 manifest**: 50 commands (backstage, ribbon, QAT, panes, tabs, windows, recent, focus,
  context menu, tools, page / zoom / layout view state, notify / message / state for tests), View
  ribbon groups (Panes, Page layout, Zoom), Help group, three status-bar items, the shell's
  backstage pages, three context-menu contributions, a settings schema.
- **Demo module** `test/e2e/demo-module/manifest.ts` (e2e only): every widget kind, a contextual
  "Ink Tools" tab, a demo tool, left and right panels, status item, backstage page + command slot,
  a creator, context menus, dialogs / progress / toast / form commands.
- **Tests**: 9 new unit files (ribbon model, key tips, fuzzy, documents, popup placement, UiState,
  shortcut conflicts, window bounds, M02 manifest) — 858 unit tests green; `test/e2e/shell.spec.ts`
  with 29 Playwright tests covering every acceptance line (widgets, dropdown by mouse and keyboard,
  contextual tab, key tips, minimise/peek, overflow collapse, QAT, nav panels + width across
  restart, properties pane, tabs drag/cycle/dirty prompt, detach to a new window, status bar,
  backstage, empty state, dialogs, toasts, context menus, palette, F6, focus ring + axe in all four
  themes, the opacity walk). `axe-core` (MPL-2.0, dev only) drives the accessibility check.
- **Shared-file edits, all additive**: `src/shared/module.ts`, `src/shared/ipc.ts`,
  `src/renderer/core/Registry.ts` (`ribbonTabs()`), `src/main/{ipc,index,window,recent}.ts`,
  `src/renderer/main.ts`, `test/e2e/app.spec.ts` (tab count), `tsconfig.web.json` (demo module),
  M00's `file.openBytes` / `file.close` now go through the `documents` service, `package.json`
  (`lucide`, `axe-core` devDependencies).

**Changed after operator review (2026-09-07):** the operator uses Foxit daily — File is now a
normal tab with a horizontal ribbon (Open · Recent ▾ · New ▾ · Save · Save As · Print ·
Properties · Preferences · Exit) built by the shell from the backstage slots
(`app/ribbon/fileTab.ts`), and the ribbon body is Foxit's compact single row of icon buttons by
default (labels in tooltips; `app.ribbon.toggleLabels` restores labelled groups). The
full-window backstage is no longer opened by the chrome (still `app.backstage.open`). ADR 0004
amended.

**Lessons while building:**

- `[hidden]` must be `!important` in the shell CSS: a class with `display: grid` otherwise beats
  the attribute, and an invisible full-window backstage swallowed every click.
- Moving a dragged tab in the DOM mid-drag releases its pointer capture; the strip now only
  shows an insertion marker and reorders on release.
- A middle-click starts Chromium's autoscroll on Windows, which then swallows every key until it
  ends — `pointerdown` prevents it. Synthetic input never fires `auxclick`, so middle-close is on
  `pointerup`.
- Releasing a tab drag over the ribbon clicked the button underneath; the strip swallows the
  click that follows a drag.
- `BrowserWindow.getAllWindows()` is not in creation order — pick by id.

**Deferred / notes for later modules:**

- **M11** should drive `ui.view` (page, pageCount, zoom, fit, layout) through the existing
  `view.*` commands / the `ui` store rather than registering those ids again; the status bar and
  the View ribbon already read from it. `Documents.attach(id, viewport)` is where the per-tab
  viewport goes; `Documents.onClosed` disposes it.
- **M21** registers a `beforeClose` hook (`documents.onBeforeClose`) for Save / Don't save /
  Cancel; until then the shell asks "Close without saving?". Save / Save As backstage slots stay
  "Not available yet" until M21 declares `backstage: [{ slot: 'save', command: 'file.save' }]`.
- **M13** fills `print`, **M72** `properties`, **M130** `preferences`; M130's ribbon/QAT
  customisation reads `ui.qat` and `ShortcutManager.conflicts()`.
- Tab drag-out needs the pointer released outside the window; on Linux under xvfb Playwright
  cannot do that, so the e2e proves the "detaching" state and the `app.tabs.detach` command
  (which is what the gesture calls).
- Key tips cover the tab strip, QAT and the active tab's controls; the status bar and panes are
  reached with F6 instead (as in Foxit).
- The native menu (M00) still lists only M00's commands; M130's shortcut editor is the right
  place to generate it from the command table.
