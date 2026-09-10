# M04 — UI-journey and layout test harness

| | |
|---|---|
| **Module id** | `M04` — branch `mod/M04-ui-journey-tests`; test code only, no `src/renderer/modules/` folder |
| **Earliest wave** | 4 (see `PLAN.md` §0/§12) |
| **Tier** | Core — the operator found five real defects by hand in three days that 4,000 automated tests had passed over |
| **Depends on** | M02, M11, M12, M13, M30 |
| **Unlocks** | nothing blocks on it; every later module gains the helpers and must use them |

## Your task — the prompt for this conversation

You are building **M04 — UI-journey and layout test harness** of ynotPDF.
Carry this brief out end to end without waiting to be asked:

1. Read this file, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12, and
   `test/README.md`. Read the five defects in **Why this exists** and find
   each one's fix in `git log` — you are generalising from them.
2. Create branch `mod/M04-ui-journey-tests` from `main` in a new worktree.
3. Fill in **Design decisions**; the helpers are a shared contract, so write
   `docs/adr/00NN-ui-journey-harness.md` first.
4. Implement the **Scope** section — all of it.
5. `npm run lint`, `npm test`, `npm run build`, `npx playwright test`; push;
   CI green on all three OSes.
6. Merge to `main`, tick M04 ☑ in `PLAN.md` §0, fill in the **Build log**.
7. Report back in a few plain lines, naming any defect the new tests found.

---

## Why this exists — five defects, one shape

Between 2026-09-08 and 2026-09-10 the operator opened the installed app and
found, by clicking:

1. The start page laid out in the bottom half of the window behind a dead
   black band, its top unreachable. Tests asserted `#empty-state` was
   **visible** — true of a half-clipped element pushed into a corner.
2. The Pages panel permanently showing "the navigation panels are not
   available", so no thumbnail ever appeared. Under `YNOT_E2E` a demo module
   registers a panel that a fresh profile opens instead, so **the real
   startup path was never taken**.
3. The right pane clipping its contents at the reader's UI scale. Every test
   ran at **100%**.
4. Two rows of tabs, because Electron drew its application menu above the
   ribbon. **Nothing looked at the window chrome.**
5. A stamp the reader made would not go on the page. Every stamp test drove
   `draw.stamp` **with coordinates**; nothing clicked a tile and then a page.

One shape: *the suite drives the app through its command API and asserts that
things exist; the operator drives it through the UI and sees where things are.*
This module closes that gap. It adds no product code beyond a launch flag.

## Scope — build all of this

### 1. Layout assertions (`test/e2e/layout.ts`)

Helpers, used by every spec:

- `expectNothingClipped(scope)` — no descendant has `scrollWidth >
  clientWidth` or `scrollHeight > clientHeight` unless it is a deliberate
  scroll container (`overflow: auto|scroll`), which must then be *reachable*:
  assert `scrollTop` can return to 0 and that the first child's top is not
  above the container's (the bug in defect 1 — `justify-content: center`
  makes the top unreachable). Report the offending selector and both sizes.
- `expectInsideWindow(scope)` — every visible element's rect lies within the
  viewport, and the body never scrolls horizontally.
- `expectNoOverlap(a, b)` — two regions do not overlap (chrome vs content).
- `expectReadable(scope)` — computed text/background contrast ≥ 4.5:1, and no
  `opacity < 1`, `rgba()` alpha or `backdrop-filter` anywhere (the modal rule
  in `CLAUDE.md`); extend the existing style check rather than duplicating it.

### 2. UI-journey helpers (`test/e2e/journey.ts`)

- `clickRibbon(tab, label)` — select a ribbon tab and press a button **by its
  visible label**, not a command id.
- `clickPanelTile(panel, selector)`, `openPanel(id)`.
- `clickPage(point)` / `dragOnPage(from, to)` in page coordinates.
- `answerIdentityIfAsked(name)` — the first annotation opens the identity
  dialog; a journey must handle it rather than hang.
- Every helper asserts the thing it clicked was actually hit and not covered
  by an overlay: Playwright's "intercepts pointer events" retry currently
  ends in a pass often enough that nothing notices.

### 3. A journey per module

One test per merged module that does what a person does — **no `app.run` for
the action under test**. At minimum: open a document; annotate with each
markup tool by clicking its ribbon button then the page; place a shape, an ink
stroke and a stamp (catalogue **and** reader-made); reorder a page by dragging
a thumbnail; run a find and step through the hits; fill a form field; create a
PDF from images; open a portfolio and open a file inside it; encrypt a file and
reopen it. Each journey ends with `expectNothingClipped` on the whole window.

### 4. The scale and window matrix

A `test.describe` that runs the layout assertions at **100%, 150% and 200%**
UI scale and at three window sizes (1280×800, 1920×1080, and a deliberately
short 1280×600), over: the start page, a document with both panes open, the
ribbon on every tab, the comments panel, and the three largest dialogs.
Short-window cases are where defect 1 lived; 150% is where defect 3 lived.

### 5. Real startup paths

- A launch mode with **no demo module** (`YNOT_E2E_NO_DEMO=1` or equivalent)
  so the panel a fresh profile opens is the real one. Defect 2 hid here.
- Tests for: first launch on a fresh profile; launch with a document restored;
  launch with each `ui.leftPaneOnOpen` value; relaunch after a crash (autosave
  recovery). Assert no panel anywhere shows a "not available" or error
  fallback — grep the whole window for those strings.
- Assert `Menu.getApplicationMenu()` matches the platform rule (defect 4).

### 6. Visual regression, kept cheap

`toHaveScreenshot` over a small set of stable screens (start page, document
with panes, each of the four themes, the ribbon per tab) at one size, with a
generous `maxDiffPixelRatio`. Baselines per platform, committed. The point is
catching a layout collapse, not policing pixels — keep the set under 15.

### 7. Make the gap hard to reopen

- `test/README.md`: a section stating the rule — **a feature is not covered
  until a test reaches it the way a person does**, and that asserting
  "visible" is not asserting "usable".
- Add that rule to the shared acceptance wording every module brief carries.
- A CI step that prints a warning when a new `*.spec.ts` uses no journey
  helper at all. Advisory: warn, never block.

## Out of scope

Unit tests; the DOM-less unit environment stays as it is. Engine benchmarks.
Accessibility auditing beyond contrast — M111 owns that.

## Design notes & constraints

- These tests must be **fast**: the suite already takes six minutes. Reuse one
  app instance per describe; only the scale/window matrix needs relaunches.
- A helper reporting "something is clipped" must name the element and both
  numbers, or the next reader cannot act on it.
- Do not weaken an assertion to make a test pass. If a journey finds a real
  defect, **fix it** (product code) in the same branch and say so in the Build
  log — that is the point of this module.

## Files you will create or touch

`test/e2e/layout.ts`, `test/e2e/journey.ts`, `test/e2e/journeys/*.spec.ts`,
`test/e2e/startup.spec.ts`, `test/e2e/scale-matrix.spec.ts`,
`test/e2e/visual.spec.ts` + baselines, `test/e2e/harness.ts` (no-demo launch
mode), `src/renderer/main.ts` (honour the flag — the only product change),
`test/README.md`, `.github/workflows/ci.yml`, `docs/adr/00NN-*.md`.

## Libraries

None new. Playwright's own screenshot comparison.

## Acceptance tests — the module is done when these pass

- Each of the five defects above has a test that **fails against the commit
  before its fix** and passes after. Record the five commit SHAs in the Build
  log — that is this module's proof, not a formality.
- Every merged module has at least one journey test that uses no `app.run`
  for the action under test.
- The scale/window matrix passes at 100/150/200% and all three window sizes.
- The suite still finishes inside ten minutes on CI.

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

_None yet._

## Build log (fill in at merge)

_Not started._
