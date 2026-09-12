# M90 — OCR — searchable image, image+text, editable text

| | |
|---|---|
| **Module id** | `M90` — folder `src/renderer/modules/M90-ocr/`, branch `mod/M90-ocr` |
| **Earliest wave** | 6 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M21, M41; M51 for editable-text output |
| **Unlocks** | [M62 Automatic form-field recognition](./M62-field-recognition.md), [M120 Batch processing & action wizard](./M120-batch-actions.md) |

## Your task — the prompt for this conversation

You are building **M90 — OCR — searchable image, image+text, editable text** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M21 Save, Save As, autosave & recovery](./M21-save.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M90-ocr` from `main` in a new git worktree and
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
7. Report back in a few plain lines: what works, what to try, anything 
   Tony must do by hand.

---

## Purpose

Recognise text in scanned/image pages with Tesseract, in three output
modes, with pre-processing, language packs and batch support.

## Foxit 14 reference — what to emulate

Foxit Convert → OCR (Current File / Multiple Files), options: language(s),
output Searchable Text Image / Editable Text / Image+Text, downsample,
deskew, despeckle, correct suspects UI (Find suspect results, accept/
correct).

## Scope — build all of this

- **Deskew before recognition:** call M41's `deskew` command on each
  image-only page (default on, checkbox in the OCR dialog) — straight
  input is the single biggest accuracy win for Tesseract. Do not build a
  second deskew.
- Tesseract packaging: native `tesseract` CLI + `tessdata_fast` (eng by
  default) bundled per OS by `fetch-binaries.ts`; `tesseract.js` WASM as
  fallback when the binary fails; language packs downloadable in-app to
  userData (list in `resources/ocr-languages.json`).
- Pipeline (worker/main): detect image-only pages (no text runs / below
  threshold), render at chosen DPI (300 default), pre-process (deskew via
  projection profile, despeckle, binarise — in-house or Tesseract flags),
  run OCR with hOCR/TSV output → words with boxes + confidence.
- Outputs: (1) **searchable image**: invisible text layer (`Tr 3`) with
  correct positions and the original image kept; (2) **image+text**: same
  but text also visible (rarely used — keep for parity); (3) **editable
  text**: create text objects with a substitute font via M51's writer and
  optionally drop the image (Pro; warn about fidelity). **M51 is deliberately
  scheduled after this module**: ship modes 1 and 2 now; show mode 3 in the
  dialog as "Editable output is not available yet" and register a
  follow-up task in the Build log. When M51 is ☑, a short follow-up session
  completes mode 3 using this brief. Track searchable/image output and editable
  output separately in CHECKLIST.txt; the full module remains incomplete until
  its required modes are verified. Do not put internal module numbers into
  product-facing labels.
- Suspects UI: list of low-confidence words, jump, accept/correct inline
  (edits the invisible text), confidence threshold setting.
- Ribbon: OCR current, OCR page range, OCR multiple files (M120 hook);
  auto-OCR-on-open setting for image PDFs with a banner.

## Out of scope

Handwriting recognition (Parked).

## Design notes & constraints

- **Windows on ARM (M03):** verify the provenance and target architecture of
  the pinned Tesseract distribution. Use the existing target-architecture
  helpers, not a fresh `process.arch` decision. ARM Windows must use the
  `tesseract.js` WASM engine automatically (same output, slower) unless an
  arm64 native build is pinned in `resources/binaries.json`. The OCR dialog
  shows which engine is in use (word, not colour). Never let the arm64
  installer fail OCR silently.
- Text layer mapping must use `PageGeometry` so search/selection align at
  every zoom — test by rendering selection rects over words.

## Files you will create or touch

`src/renderer/modules/M90-ocr/**`, `src/main/ocr/**`, `src/engine/ocr/**`,
`resources/ocr-languages.json`, tests.

## Libraries

_Credit rule (Tony): every open-source component this module adds
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

tesseract binaries (Apache-2.0) + tessdata_fast (Apache-2.0),
tesseract.js (Apache-2.0).

## Acceptance tests — the module is done when these pass on all three OSes

- Clean 300-dpi scan fixture ⇒ word accuracy ≥ 95 % against ground truth;
  find + selection rects align with words (visual test).
- Skewed fixture is deskewed (angle within 0.5°).
- Editable-text mode yields real text objects; extraction reads them.
- WASM fallback meets the same text-accuracy and geometry tolerances when the
  binary is absent. Pin engine and language-data versions; byte-identical
  recognition across different builds is not an unmeasured acceptance promise.
- Test mixed text/scanned pages, rotated CropBoxes, Unicode search/selection,
  cancellation and repeat OCR without duplicate text. Benchmark memory and time
  on multi-page scans. Expose offline language availability and verify downloads.

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
documentation are written from scratch for ynotPDF. *(Tony's rule,
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

**UI & accessibility rules (non-negotiable — Tony has low vision and is
colourblind: black and red read as the same colour):**
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
- **A feature is not covered until a test reaches it the way a person does**
  (M04). Asserting that something is *visible* is not asserting that it is
  *usable*: a UI test presses the button by its **visible label**, clicks the
  panel tile, clicks the page, and then asserts *where* things are —
  `test/e2e/journey.ts` and `test/e2e/layout.ts` are the helpers, and
  `test/README.md` states the rule in full. `app.run(...)` is for setup, never
  for the action under test.
- Data that can change (presets, stamp catalogues, substitution tables)
  goes in `resources/` data files, not code.
- Commits: `<Mid>: <what>` and end with
  `Co-Authored-By: Claude <noreply@anthropic.com>`. Never commit real
  customer PDFs, binaries, or secrets — fixtures are public-domain/synthetic.
- **Real sample PDFs for hands-on testing live in `test/fixtures/local/`**
  (git-ignored; Tony drops files there, so they carry personal
  data). Currently: three airline boarding passes and **`Sample
  Portfolio.pdf`, a Foxit-made PDF Portfolio (`/Collection`) containing
  those three** — use it for attachments, embedded-file and portfolio
  behaviour. Open them when you manually check
  your module against real-world files, and prefer them over synthetic
  fixtures for "does it look right" judgements. Tests may use them only
  with `it.skipIf(!existsSync(...))` — CI and other machines don't have
  them. Never copy, commit or quote their contents; `local/README.md`
  lists what is there.
- **Tony is who you are working for — call him Tony, not "the operator"**
  (2026-09-11). `CLAUDE.md`, `PLAN.md` and every module brief use his name.
  Source comments and ADRs still say "the operator" in places; that is
  history, not a style to copy. New writing uses his name.
- Replies to Tony: short and plain (eyesight). Never leave him a to-do you
  could do yourself.

---

## Design decisions (fill in before coding; keep current)

_None yet._

## Build log (fill in at merge)

_Not started._
