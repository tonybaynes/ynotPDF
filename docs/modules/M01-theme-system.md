# M01 — Theme system (four themes)

| | |
|---|---|
| **Module id** | `M01` — folder `src/renderer/modules/M01-theme-system/`, branch `mod/M01-theme-system` |
| **Earliest wave** | 1 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M00 |
| **Unlocks** | [M02 Application shell (ribbon, panes, tabs, status bar, dialogs)](./M02-app-shell.md), [M130 Preferences, keyboard shortcuts editor, ribbon/QAT customisation, UI scale, i18n framework](./M130-preferences.md) |

## Your task — the prompt for this conversation

You are building **M01 — Theme system (four themes)** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M00 Scaffold, CI & packaging smoke](./M00-scaffold.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M01-theme-system` from `main` in a new git worktree and
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

Define the semantic colour/typography/spacing tokens, the four themes,
live switching, persistence, `color-scheme`, and the automated contrast test
that fails the build if any theme breaks the accessibility rules.

## Foxit 14 reference — what to emulate

Foxit's *Skins* (Classic/Dark/…) under File → Preferences → General, plus
its View → Night Mode. Ours are proper themes, applied to every surface.

## Scope — build all of this

- `src/renderer/theme/tokens.css` — the complete token list with comments:
  surfaces (`--bg-app`, `--bg-panel`, `--bg-ribbon`, `--bg-input`,
  `--bg-hover`, `--bg-active`, `--bg-selected`, `--bg-modal`), text (`--fg`,
  `--fg-muted`, `--fg-on-accent`, `--fg-placeholder`), `--icon`,
  `--icon-disabled`, `--accent`, `--accent-hover`, `--border`,
  `--border-strong`, `--focus`, `--selection` (text selection on page),
  status (`--danger`, `--warning`, `--success`, `--info` each with `-fg`
  pair), page canvas backdrop (`--bg-canvas`), annotation default colours
  (`--annot-highlight`, `--annot-note`, …), shadows (solid offset borders,
  **not** translucent shadows), typography scale (`--font-ui`, `--fs-1…6`,
  `--lh`), spacing scale, radius, `--ui-scale`.
- Four theme files: `graphite.css` (default), `midnight.css`, `daylight.css`,
  `high-contrast.css` — values per `PLAN.md` §3.2. Each sets
  `color-scheme: dark|light`.
- `ThemeManager` (`theme/ThemeManager.ts`): apply by name (swap a `<link>`
  or `data-theme` attribute on `<html>`), persist via settings IPC, expose
  `current`, `list`, `onChange`; keyboard shortcut to cycle; status-bar
  quick-switch registered as a command (`view.theme.next`,
  `view.theme.set`).
- UI scale: `--ui-scale` applied to `html { font-size }`, 100–200 %.
- **Contrast test** (`test/unit/theme-contrast.test.ts`): parse each theme
  file, compute WCAG contrast for every documented foreground/background
  pair (a table in `theme/pairs.ts` lists which tokens sit on which), assert
  text ≥ 4.5, icons/borders ≥ 3.0, `--fg-muted` ≥ 4.5. Also assert no
  `rgba(`/`hsla(` with alpha < 1 and no `opacity` in theme files.
- **Colour-vision test**: simulate protanopia/deuteranopia (Machado 2009
  matrices) on `--danger`/`--success`/`--warning`/`--info` and assert they
  remain pairwise distinguishable by lightness (ΔL* ≥ 20).
- Storybook-free **theme gallery page** (`theme/gallery.html`, dev only):
  every token rendered as a swatch with its contrast number, all four themes
  side by side — the operator will use this to approve palettes.

## Out of scope

Ribbon/panel components (M02). Preferences UI (M130) — M01 only exposes the
API and a status-bar switcher.

## Design notes & constraints

- Status colours must separate on blue↔yellow + lightness, never red↔green:
  e.g. danger = bright orange-red *with* an icon, success = light blue-green
  with icon; the test enforces ΔL*. Red on black is forbidden in every theme.
- Focus ring: 2 px solid `--focus`, offset 2 px, ≥ 3:1 against both the
  control and its surface.
- Shadows are solid 1 px `--border-strong` + offset borders; no blur or
  alpha.

## Files you will create or touch

`src/renderer/theme/**`, `test/unit/theme-*.test.ts`, small additive hook
in `src/renderer/main.ts` to boot `ThemeManager`.

## Libraries

None beyond M00. Contrast maths written in-house (tiny).

## Acceptance tests — the module is done when these pass on all three OSes

- Contrast test passes for all four themes; deliberately breaking a token
  fails it.
- Colour-vision test passes.
- Playwright: `view.theme.set graphite|midnight|daylight|high-contrast`
  changes `data-theme`, computed background of `body` matches the token,
  no reload; choice survives restart.
- Gallery page renders all tokens for all themes.

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
