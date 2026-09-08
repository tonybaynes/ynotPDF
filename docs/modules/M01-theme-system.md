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

- **Themes are attribute-scoped, not swapped stylesheets.** All four CSS files are linked at
  once and every rule is scoped to `[data-theme="<name>"]`, so switching is one attribute write
  on `<html>`. No stylesheet load, no flash, no reload — the e2e test proves the window is not
  reloaded by leaving a value on `window` across a switch.
- **One source of truth per concern.** `themes.ts` lists the four themes (name, label,
  `color-scheme`, file); `tokens.css` documents every token in a comment block; `pairs.ts` says
  which token sits on which. The tests, the gallery and the ThemeManager all read those three,
  so a palette change cannot drift from its documentation.
- **The contrast test parses the CSS itself** (`parse.ts`, a 40-line regex reader) instead of
  trusting a duplicated table of values. Themes must therefore use plain hex — the test asserts
  that too, which also rules out `rgba()`/`hsla()` by construction.
- **Status separation is "ΔL\* ≥ 20 **or** Δb\* ≥ 45", never red↔green alone.** The brief's flat
  ΔL\* ≥ 20 for all four statuses is arithmetically impossible next to the 4.5:1 text floor:
  on black every status must sit above L\* 48.9, leaving 51 points of range where four colours
  20 apart need 60. Blue↔yellow is the axis both red-green deficiencies keep, so it carries the
  pairs lightness cannot. See [ADR 0002](../adr/0002-status-colour-separation.md).
- **Palette layout that makes that work.** Each theme puts one warm and one cool status at each
  end of its usable lightness band: same-family pairs (danger/warning, success/info) separate by
  lightness, cross-family pairs by blue↔yellow. On Daylight that means a bright orange-red
  danger with a dark amber warning, and a mid teal success with a dark navy info — every status
  is dark because text on white cannot exceed L\* 49.9.
- **The focus ring is two solid rings**, `--focus` (outer, offset onto the surface) and
  `--focus-contrast` (inner, hugging the control). One colour cannot be ≥ 3:1 against both a
  white panel and a dark accent button; two can, and both are solid with no alpha.
- **Settings go through the typed IPC**, not `localStorage`: `settings:get` / `settings:set`
  plus `theme:setNative` so the OS chrome follows the theme. Main also reads the saved theme
  before the window opens so the title bar is right on the first frame.
  See [ADR 0003](../adr/0003-settings-ipc.md).
- **`--ui-scale` drives `html { font-size }`** and the whole type and spacing scale is in `rem`,
  so 100–200 % scales everything including icons. `--font-base` (14 px) is the anchor.
- **Nothing here is a `Command`.** Theme and UI scale are view preferences, not document
  changes, so there is nothing to undo. Every action is still a registered command with a
  palette entry, so the palette, shortcuts and the e2e harness all drive the same code.
- **Every theme declares `color-scheme: <scheme> only`, never a bare `light`/`dark`.** The
  `only` keyword forbids the browser substituting a scheme of its own. Without it, Chrome's
  "Auto Dark Mode for Web Contents" (`chrome://flags`, which the operator runs) repaints any
  subtree declaring `color-scheme: light` — so the Daylight column of the gallery rendered
  dark and the palette under review was not the palette that ships. Probed in the operator's
  own Chrome: a bare `light` is repainted, `light only` is not. The contrast and e2e tests
  both assert the keyword so it cannot regress.
- **Night Mode is a separate toggle, not a property of the dark themes** (operator decision,
  2026-09-07). A theme colours the *interface*; a PDF page is the *document* and renders as its
  author made it, which is nearly always white paper. Foxit puts Night Mode under View and so do
  we: `view.nightMode.toggle` (`Mod+Alt+N`), off by default in every theme, persisted like the
  theme itself. ThemeManager writes `data-night-mode` on `<html>` and the token layer swaps the
  page pair; M11 applies the matching inversion to the rendered page raster.
- **Night Mode swaps the annotation colours too.** Inverting only the paper is not enough: a
  daylight highlight is a pale yellow that near-white ink cannot sit on (1.06:1 measured), and a
  dark blue ink stroke drops to 2.88:1 against dark paper. Each annotation colour therefore has
  a `-night` partner, and the pair table asserts them against the darkened page.
- **No white at all in the Daylight chrome, and black text** (operator, 2026-09-07). A
  full-screen `#ffffff` reads as glare, and so does a white input field. Grey throughout:
  panels `#e0e0e8`, app `#d8d8e2`, inputs `#dcdce6`, ribbon `#d5d5de`, page backdrop `#a9a9b8`.
  `--fg` and `--icon` are `#000000`. The only white left is `--page-paper`, which is the
  document.
- **How dark Daylight can go is capped by the status colours, not by taste.** Every status must
  clear 4.5:1 on the darkest surface that carries text, which caps its lightness; the four then
  have to stay distinguishable to a dichromat inside the remaining band. A search of the colour
  space under semantic hue constraints puts the hard floor at a text-bearing surface of about
  `#ccccd8`. At the current `#d2d2dc` the band already forces a choice, verified by exhaustive
  search: you can have a vivid red-orange `--danger` (chroma ≥ 55) **or** all four statuses
  clearly lighter than body text, but not both. This theme takes the second — `--danger` is a
  burnt orange `#884810`, and nothing is near-black. Discrimination is what the operator needs;
  how red the red looks is not a channel available to him. An earlier note here claimed no set
  existed below `#d0d0db`; that was an artefact of a search constrained to fixed lightness
  bands, and is wrong.
- **A placeholder hint is never the faintest text on its surface** (operator, 2026-09-07,
  twice). The brief and PLAN.md §3.2 allowed 3:1 for hints as the single low-contrast
  exception; raising them to the 4.5:1 floor was still not enough to read comfortably. The rule
  the tests now enforce is relative, not absolute: `--fg-placeholder` must reach at least the
  same ratio as `--fg-muted` on `--bg-input`. A fixed number would drift again the next time a
  surface moves; tying the hint to the theme's own secondary text cannot. The italics carry the
  "this is a hint" meaning instead of low contrast.
- **Font weight is a theme token** (`--fw-body`, `--fw-heading`), applied on `[data-theme]`
  rather than `body` so it follows the theme wherever the attribute is set — `<html>` in the
  app, each preview column in the gallery. Daylight sets 600/700 against the dark themes'
  400/600: black-on-grey reads thinner than white-on-black at the same weight, and the operator
  was losing the text (2026-09-07).
- **Annotation colours are theme-independent.** They are document content, not UI: the same
  values in all four themes, checked against the page paper rather than the app surfaces.

## Build log (fill in at merge)

**Shipped (2026-09-07):**
- `theme/tokens.css` — 41 documented colour tokens plus the type scale (`--fs-1…6`, `--lh`),
  spacing scale (`--sp-1…6`), radii, border and focus widths, `--elevation` (a solid offset
  border, never a blur), icon sizes and `--ui-scale`. Also the global `:focus-visible`,
  `::placeholder` and `::selection` rules.
- Four themes: `graphite.css` (default), `midnight.css`, `daylight.css`, `high-contrast.css`,
  each setting `color-scheme` and all 41 tokens as plain hex.
- `theme/contrast.ts` — in-house colour maths: sRGB↔linear, WCAG relative luminance and
  contrast, CIE L\* and L\*a\*b\*, and the Machado 2009 dichromacy matrices.
- `theme/separation.ts` — the status-separation rule and its thresholds (ADR 0002).
- `theme/pairs.ts` — 136 documented foreground/background pairs with their thresholds.
- `theme/parse.ts` — the theme-file reader used by the tests, the gallery and the e2e spec.
- `theme/ThemeManager.ts` — `current`, `list`, `set`, `next`, `previous`, `setScale`,
  `stepScale`, `onChange`, persistence through injectable storage.
- `modules/M01-theme-system/` — manifest (11 commands), IPC-backed storage, status-bar switcher.
  Commands: `view.theme.set`, `view.theme.set.<name>` ×4, `view.theme.next` (`Mod+Alt+T`),
  `view.theme.previous`, `view.theme.current` (hidden), `view.uiScale.increase` / `.decrease` /
  `.reset` / `.set`. Plus an Appearance group on the View ribbon tab and a settings schema.
- `theme/gallery.html` + `gallery.ts` + `gallery.css` — dev-only page (`npm run gallery`)
  showing all four themes side by side: a real UI sample, every token as a swatch with L\* and
  b\*, all 136 contrast pairs with measured ratios, and the status colours simulated under
  protanopia and deuteranopia with the separating channel named.
- Tests: 772 unit assertions (contrast ×4 themes, colour vision ×4 themes, colour maths against
  published WCAG reference values, ThemeManager, the manifest) and 7 Playwright tests (live
  switching with computed colours matching the tokens, no reload, the switcher following the
  commands, UI scale changing the root font size, the two-ring focus, survival across restart).
- Shared-file edits, all additive: three IPC channels (`settings:get`, `settings:set`,
  `theme:setNative`), `src/main/settings.ts`, the `@theme` path alias, `reuseUserData` in the
  Playwright harness, the ThemeManager boot in `renderer/main.ts`, and the switcher mounted in
  M00's status bar.

**Fixed after first merge (2026-09-07):**
- The operator reported the gallery's Daylight column rendering dark in Chrome. Cause: Chrome's
  Auto Dark Mode repaints subtrees that declare `color-scheme: light`. All four themes now use
  `color-scheme: <scheme> only`, which is the standards-defined opt-out; verified in the
  operator's own browser with the flag enabled. `gallery.html` and `index.html` also carry
  `<meta name="color-scheme" content="dark light">` so the very first paint is covered too.

**Added after review (2026-09-07):**
- **Night Mode** — `view.nightMode.toggle` (`Mod+Alt+N`) and `view.nightMode.set { on }`, a
  ribbon entry, a settings-schema flag, `--page-paper-night` / `--page-ink-night` and a `-night`
  partner for every annotation colour, persisted under `view.nightMode`. The gallery shows each
  theme's page sample twice, Night Mode off and on, so the two can be compared directly.
  **M11 must apply the same inversion to the rendered page raster** — the tokens and the
  `data-night-mode` attribute are the contract it codes against.
- **Daylight softened** at the operator's request: no pure white in the chrome.

**Deferred / notes:**
- **Palettes approved by the operator on 2026-09-07**, all four, from the gallery page
  (`CHECKLIST.txt` and PLAN.md §10 item 4 ticked). To revisit one later: `npm run gallery`,
  edit the single value in its theme file, and `npm test` says at once whether it still passes.
- Tritanopia is simulated by `contrast.ts` and unit-tested, but the status rule only asserts
  protanopia and deuteranopia, as the brief specified.
- The status-bar switcher is a plain `<select>`; M02 restyles the status bar and may replace it
  with a ribbon control. `switcher.ts` is excluded from the unit-coverage gate because it is
  pure DOM wiring covered by Playwright.
- No high-contrast *system* setting is honoured yet (`prefers-contrast`): the theme is an
  explicit choice. M130 can add "follow the OS" as a fifth option.
- Icons are not part of M01: Lucide arrives with M02, and it inherits `--icon` through
  `currentColor`.
