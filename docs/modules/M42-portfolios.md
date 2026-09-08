# M42 — PDF Portfolios — create, edit, cover sheet, extract

| | |
|---|---|
| **Module id** | `M42` — branch `mod/M42-portfolios`, module folder `src/renderer/modules/portfolio/` |
| **Earliest wave** | 4 (see `PLAN.md` §0/§12) |
| **Tier** | Core (operator un-parked it 2026-09-08 — portfolios are part of the daily workflow) |
| **Depends on** | M12, M21 |
| **Unlocks** | M120 registers "Build portfolio from files" as a batch op |

## Your task — the prompt for this conversation

You are building **M42 — PDF Portfolios** of ynotPDF. Carry this brief out
end to end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M12 Navigation
   panels](./M12-navigation-panels.md) (its Attachments panel and
   portfolio *opening* are yours to build on — do not duplicate them),
   [M21 Save](./M21-save.md). Confirm both are ☑ in `PLAN.md` §0.
2. Create branch `mod/M42-portfolios` from `main` in a new git worktree and
   work there.
3. Fill in **Design decisions** below before coding; the portfolio file
   model is a shared contract (`src/shared/`), so write
   `docs/adr/00NN-portfolio-model.md` as its own PR first.
4. Implement the **Scope** section — all of it.
5. `npm run lint`, `npm test`, `npm run build`; push; CI green on all three
   OSes.
6. Merge to `main`, tick M42 ☑ in `PLAN.md` §0 in the same merge, fill in
   the **Build log** below.
7. Report back in a few plain lines.

---

## Purpose

Foxit's Portfolio feature, in full: make a new portfolio, put files and
folders in it, order and describe them, give it a cover sheet, take files
out again, and save it so Foxit/Acrobat open it as a portfolio. The
operator builds document packs this way every day (a signed instruction
PDF plus supporting files), so **round-trip fidelity is the headline
requirement**: opening `Sample Portfolio.pdf`, changing one description
and saving must leave every embedded file byte-identical — a digitally
signed embedded PDF must still verify afterwards.

## Scope — build all of this

- **Model** (`src/shared/portfolio.ts`, ADR): a portfolio = `/Collection`
  in the catalog + `/EmbeddedFiles` name tree (+ `/Folders` for nested
  folders, PDF 2.0 / Acrobat 9 style, which Foxit writes and reads).
  Fields per entry: name, description, size, created/modified, MIME, a
  stable id, folder path, order; collection-level: schema columns
  (`/Schema`), sort (`/Sort`), initial view (`/View`: details / tile /
  hidden), initial document (`/D`), cover sheet.
- **Read** through the M12 attachments code (extend, don't fork): schema
  columns, folders, sort order, the `/D` initial file.
- **Create**: *File → New → Portfolio* (empty), *New portfolio from
  files…* (multi-select or a folder — recursively, folder structure kept),
  and *drag files/folders from Explorer/Finder onto the portfolio view*.
- **Edit** (all `Command`s, undoable, through M20's document model):
  add file(s)/folder, remove, rename, edit description, move between
  folders, reorder (drag or move up/down), set sort column/direction, set
  initial view and initial file, add/remove **custom schema columns**
  (text/date/number) and fill them per file, replace a file's content
  keeping its metadata, extract one / selected / **extract all** to a
  folder (names and folder structure preserved).
- **Cover sheet**: generated one-page PDF (title, optional subtitle, date,
  table of contents listing the files with descriptions and sizes) built
  from an operator-editable template in `resources/portfolio/`; or "use
  this PDF as cover"; or none. Regenerate on demand; never silently.
- **Portfolio view** (`src/renderer/modules/portfolio/`): when the open
  document is a portfolio, the document area shows the **file grid** —
  details (table with the schema columns, sortable) or tiles (with
  first-page thumbnails for PDFs, OS icons otherwise) — with the cover
  sheet available as a tab/toggle. Double-click opens an embedded PDF in
  a new document tab (M12 already does this) with a "Save back into
  portfolio" command when it has been edited.
- **Save**: through M21 (`documents:save`); the writer (pdf-lib now, M80
  later) must write embedded streams **unchanged** — no re-encoding,
  filters kept, `/Params` (size, dates, checksum) preserved or correctly
  recomputed. Save As "Convert to single PDF" merges the PDFs in order
  (uses M41 if merged; otherwise a plain pdf-lib copy).
- Ribbon: a **Portfolio** tab appears only when a portfolio is open, plus
  *File → New → Portfolio*; register the batch op for M120.
- Preferences hook for M130: default view (details/tiles), default cover
  sheet on/off.

## Out of scope

Rich-media/Flash navigators (dead format). Full-text search inside
embedded files (M13 finds in the open document only). Signing the
portfolio itself (M81 — but it must not break when M81 lands: keep the
writer incremental-friendly).

## Design notes & constraints

- **Byte-identical embedded files** is the acceptance test that matters;
  build the writer test first. Signed PDFs embedded as attachments stay
  valid because their bytes are never touched — the operator proved this
  with pikepdf/qpdf; match it with pdf-lib.
- Foxit and Acrobat read `/Folders`; pdf-lib has no API for it — write the
  dictionaries yourself in the writer layer, unit-tested against
  `Sample Portfolio.pdf`'s structure (local fixture: skip if absent, but
  also build a synthetic portfolio fixture in `scripts/make-fixtures.ts`
  so CI covers it).
- Large files: embedding is streamed (no full read into a JS string);
  progress in the status bar; 1 GB portfolio must not freeze the UI.
- Grid and dialogs obey the theme tokens; column headers stay fixed; every
  state shown in words (a "Modified" pill, not a colour).

## Files you will create or touch

`src/shared/portfolio.ts`, `src/engine/` (portfolio read/write helpers),
`src/renderer/modules/portfolio/**`, `src/renderer/modules/navigation/`
(attachments panel extensions — coordinate with M12's code, don't fork it),
`resources/portfolio/cover-template.*`, `scripts/make-fixtures.ts`
(synthetic `portfolio.pdf`), `test/unit/portfolio/**`,
`test/e2e/portfolio.spec.ts`, `docs/adr/00NN-portfolio-model.md`.

## Libraries

pdf-lib (already present). Nothing new unless the ADR justifies it.

## Acceptance tests — the module is done when these pass

- Open `Sample Portfolio.pdf` (local, skip if absent): edit one
  description, save ⇒ the three embedded files are byte-identical to the
  originals (`pdfdetach`/own reader), Foxit still opens it as a portfolio
  (operator confirms once — record in Build log).
- Synthetic: new portfolio from 3 files + 1 folder with 2 files ⇒ save ⇒
  reopen ⇒ same tree, order, descriptions; extract all ⇒ same bytes and
  folder structure on disk.
- Reorder, rename, remove, custom column add/fill — each undoable, each
  survives save/reopen.
- Cover sheet generated ⇒ it is page 1 of the saved file's own content, and
  lists every file; regenerate after adding a file ⇒ list updated.
- Details view sorts by every column; tiles view shows PDF thumbnails.
- Drag two files from Explorer onto the grid ⇒ both added, status bar
  progress shown for a 200 MB file, UI stays responsive.
- Convert to single PDF ⇒ pages of all embedded PDFs in portfolio order.

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

_None yet._

## Build log (fill in at merge)

_Not started._
