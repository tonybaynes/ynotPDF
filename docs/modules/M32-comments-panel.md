# M32 — Comments panel, replies & status, FDF/XFDF, summarise

| | |
|---|---|
| **Module id** | `M32` — folder `src/renderer/modules/M32-comments-panel/`, branch `mod/M32-comments-panel` |
| **Earliest wave** | 4 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M30 |
| **Unlocks** | [M120 Batch processing & action wizard](./M120-batch-actions.md) |

## Your task — the prompt for this conversation

You are building **M32 — Comments panel, replies & status, FDF/XFDF, summarise** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M30 Annotations — text markup, notes, typewriter, text box, callout](./M30-markup-annotations.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M32-comments-panel` from `main` in a new git worktree and
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

Review workflow around annotations: the Comments panel, replies and
status, filtering/sorting, show/hide, import/export via FDF/XFDF, and a
comment summary PDF.

## Foxit 14 reference — what to emulate

Foxit Comments panel: list grouped by page/author/type/date, expand to
show replies, set status (Accepted/Rejected/Cancelled/Completed/None) and
checkmarks, reply, delete, filter by author/type/status/date, sort, search
in comments, show/hide all/by type, Import/Export comments (FDF/XFDF),
Summarize Comments (layout options), Print with comments (M13 hook).

## Scope — build all of this

- Comments panel (left pane): virtualised list, grouping/sorting, inline
  reply editor, status menu with words + icons, checkmark, jump on click,
  keyboard navigation, search field, filter popover (opaque), count badge.
- Replies (`/IRT`, `/RT`) and status annotations (`/State`, `/StateModel`)
  as PDF semantics, all as Commands.
- Show/hide comments (global, by type, by author) as view flags.
- Export: FDF and XFDF (all annotation types incl. ink paths, stamps by
  reference, replies/status, form data optionally), UTF-8, spec-conformant.
- Import: FDF/XFDF merge with conflict policy (replace by `/NM` id, or
  append), from Acrobat/Foxit exports (build a fixture set from both).
- Summarise comments: options (document + comments with connector lines,
  comments only, sequence numbers, sort order, font size, page range) →
  new PDF via pdf-lib rendering the pages through the engine.
- Hooks for M13 print-with-comments and M120 batch export.

## Out of scope

Creating annotations (M30/M31).

## Design notes & constraints

- XFDF writer/reader in `src/engine/xfdf/` — pure, unit-tested against
  fixtures exported by Acrobat and Foxit (ask the operator for a couple).
- Panel reads only the model; no engine calls.

## Files you will create or touch

`src/renderer/modules/M32-comments-panel/**`, `src/engine/xfdf/**`,
`src/engine/summary/**`, tests.

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

fast-xml-parser (MIT).

## Acceptance tests — the module is done when these pass on all three OSes

- Export XFDF from a fixture with 20 mixed annotations → import into a
  blank copy → annotation list deep-equals (minus ids).
- Foxit- and Acrobat-exported XFDF fixtures import with all fields.
- Reply/status round-trip through save.
- Summary PDF page count and text spot-checks for each layout option.

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

- **`/IRT` is written as a reference, and the plan names its target by `/NM`.** A reply is only a
  reply because `/IRT` is an *indirect reference* to the parent's dictionary (ISO 32000-1
  12.5.6.2) — a string or a name there is ignored by every other reader. `DictValue` has no way to
  say "the object of that other annotation", so it gains one kind, `annotationRef`, whose value is
  the target's `/NM` name; the writer resolves it against the page's `/Annots` after every
  insert, so a reply to an annotation added in the same save works too. Every annotation this app
  writes already carries an `/NM`, and M32 gives one to a parent that arrived without. ADR 0016.
- **`/RT` is `replyType` in the `extra` bag**, mapped in `engine/appearance/dict.ts` beside
  `stateModel`, so `/R` (a reply) and `/Group` (a grouped annotation) round-trip. A status change
  is a `Text` annotation with `/IRT`, `/State` and `/StateModel` and no `/Contents` — which is
  what Acrobat and Foxit both write, and why a status is *history*, not a field: the newest one
  wins and the older ones stay as the record of who set what.
- **The panel reads the model and nothing else.** It subscribes to `Document` and to M30's
  `AnnotationService`; it never calls the engine. Every change it makes goes out as a `Command`
  through M30's service, which is what makes the whole panel undoable for free.
- **Row building is a pure function** (`rows.ts`): annotations + filter + sort + grouping →
  a flat list of rows with depth. The virtualised list then only has to map an index to a row, and
  the grouping/sorting/filtering is unit-testable without a DOM.
- **Comment visibility is a view flag, never the file's `/F` bit.** Hiding a comment must not
  change the document, so nothing is written. Two switches do it together: M11's tile renderer
  stops drawing annotation appearance streams, and M30's overlay draws the ones that stay visible
  instead — the same generators that already draw a FreeText draw a highlight when the raster is
  not carrying it. `AnnotationProvider.toLayer` gains one option, `raster: false`, for that.
  While everything is visible the raster does the drawing exactly as before, so the common case
  costs nothing. ADR 0016.
- **XFDF is the real format; FDF is offered because Acrobat still writes it.** `engine/xfdf/` is
  pure and has no DOM: `read.ts` and `write.ts` for XFDF (fast-xml-parser, MIT), `fdf.ts` for
  FDF's PDF object syntax, and `convert.ts` for `ModelAnnotation` ↔ the neutral record in
  `types.ts`. Coordinates need no flipping — XFDF is in the same PDF user space as `/Rect` (XFDF
  3.0 §2.2) — but `page` is 0-based there and 1-based nowhere, which is the one off-by-one worth
  naming.
- **Import merges by `/NM`, and the conflict policy is the reader's.** "Replace" overwrites the
  annotation with the same `/NM`; "Add" gives every incoming annotation a fresh `/NM` so nothing
  is lost. Replies are resolved after the pass that creates the parents, by name, so an export
  whose replies come before their targets still imports.
- **Summarise renders through the engine and assembles with pdf-lib.** The engine rasterises each
  page (the only way to get PDFium's own drawing of the annotations into a new file without
  copying page trees), pdf-lib places it and draws the comment blocks, the sequence numbers and
  the connector lines beside it. `summary/layout.ts` is pure — it decides where every block and
  every line goes from sizes alone — so the page counts and the block positions are unit-tested
  without rendering anything.
- **Status is a word and an icon, and the words are ours.** Accepted, Rejected, Cancelled,
  Completed, None (the `/StateModel /Review` set of ISO 32000-1 12.5.6.4) plus the `/Marked` set's
  checkmark, each with a Lucide glyph and its name in text. No status is told apart by colour
  alone, and the two that a dichromat would otherwise confuse — Accepted and Rejected — differ in
  glyph, in word and in lightness.

## Build log (fill in at merge)

_Not started._
