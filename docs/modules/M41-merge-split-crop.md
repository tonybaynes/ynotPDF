# M41 — Merge, split, extract to files, crop, deskew & flatten

| | |
|---|---|
| **Module id** | `M41` — folder `src/renderer/modules/M41-merge-split-crop/`, branch `mod/M41-merge-split-crop` |
| **Earliest wave** | 4 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M40 |
| **Unlocks** | [M120 Batch processing & action wizard](./M120-batch-actions.md) |

## Your task — the prompt for this conversation

You are building **M41 — Merge, split, extract to files, crop & flatten** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M40 Organise pages — insert, delete, extract, replace, rotate, move, labels](./M40-organise-pages.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M41-merge-split-crop` from `main` in a new git worktree and
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

Whole-document operations: combine files (with per-source bookmarks),
split by count/size/bookmark/page ranges, crop pages with box control, and
flatten annotations/forms.

## Foxit 14 reference — what to emulate

Foxit Convert → Combine Files (add files/folders, reorder, page ranges,
bookmark per file, options); Organize → Split (by page count, file size,
top-level bookmarks, page ranges; output naming); Crop Pages (drag rect or
margins, apply to range, CropBox/TrimBox/BleedBox/ArtBox, remove white
margins, page size change); Flatten (annotations, forms, "remove
annotations" option).

## Scope — build all of this

- **Deskew — straighten scanned pages (operator requirement, 2026-09-09:
  "a lot of the files we work with are scanned and need to be
  straightened slightly").**
  - *Detect:* estimate each page's skew angle from a downsampled,
    binarised render (projection-profile variance or Hough over ±15°,
    0.1° resolution; ignore pages whose confidence is low — e.g. mostly
    blank or pictures — and say so in words). Run in a worker; 100 pages
    of A4 scans in under 20 s.
  - *Apply:* rotate the **page content** about the page centre by wrapping
    the content stream in `q cos sin −sin cos tx ty cm … Q` — no image
    re-encoding, an existing OCR text layer and annotations rotate with it
    (annotations via their `/Rect`/`/QuadPoints`; links included). Fill
    the exposed corner wedges with white (or the detected page background)
    behind the content; optionally shrink the CropBox by the wedge amount
    ("trim edges" checkbox, default off). One undoable `Command` per run.
    Re-running detection on a straightened page must return ≈ 0°.
  - *UI:* Organise/Page tab → **Deskew** button and page-thumbnail context
    menu (M12/M40). Dialog: scope (this page / selected / all / range);
    per-page table with detected angle, confidence in words, checkbox;
    **live before/after preview** of the current page with a **fine-tune
    slider ±5° in 0.1° steps** and a numeric field; "Apply". Also a
    one-click **Auto-deskew all** that skips low-confidence pages and
    reports what it skipped.
  - *Preference (M130):* "Straighten scanned pages automatically when
    importing images / creating PDF from scanner" — default off; M91's
    from-images path calls this when on.
  - *Batch:* register `deskew` as a batchable op for M120; M90 OCR calls
    it before recognition (default on in the OCR dialog).
- Combine dialog (opaque, resizable): list of files/folders (drag-drop,
  add, remove, reorder, page-range per file, preview thumbnails), options
  (bookmark per file from filename, keep existing bookmarks, page size
  normalise), output → new tab or file; runs in a worker with progress and
  cancel; non-PDF inputs routed to M91/M93 converters when present.
- Split dialog: by page count, by max file size (iterative estimate), by
  top-level bookmarks, by explicit ranges; output folder + name pattern
  (`{name}_{index}_{range}`), option to keep bookmarks/comments/forms.
- Crop tool: drag rect on page (handles, numeric margins in units),
  constrain to ratio, apply to range, choose box (Crop/Trim/Bleed/Art),
  "remove white margins" (auto-detect via rendered bitmap), optional
  "change page size" (set MediaBox) — Commands.
- Flatten: annotations (bake appearance streams into content), forms (M61
  provides field appearance → M41 calls it), option to remove; range-aware.
- Batch hooks for M120.

## Out of scope

Page-level ops (M40). Office inputs (M93).

## Design notes & constraints

- Combine/split are writer-level operations (`src/engine/ops/`) pure over
  bytes, reused by CLI and batch.
- Crop only changes boxes — never re-encodes content.

## Files you will create or touch

`src/renderer/modules/M41-merge-split-crop/**`, `src/engine/ops/{combine,
split,crop,flatten}.ts`, tests.

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

None new.

## Acceptance tests — the module is done when these pass on all three OSes

- Deskew: synthetic fixture `skewed.pdf` (scanned-looking text page rotated
  by +2.3°, −1.1°, +7.5° and a blank page, built in `make-fixtures.ts`)
  ⇒ detection within ±0.2° of each known angle, blank page reported
  "skipped — not enough content"; apply ⇒ re-detect gives |angle| ≤ 0.2°;
  the image XObject bytes are unchanged (no re-encoding); an annotation
  on the page stays over the same word; undo restores the original stream.
- Deskew on a real local scan (`test/fixtures/local/`, skip if absent):
  operator judges the before/after preview straight — record in Build log.
- Combine the whole fixture corpus → page count equals sum; bookmarks per
  file present; split back by bookmark ⇒ per-file page counts match
  originals.
- Split by size 1 MB produces files each ≤ 1 MB (except single pages
  larger).
- Crop to a rect ⇒ CropBox equals rect (±0.01 pt); undo restores.
- Flatten a form fixture ⇒ no fields, render hash equals pre-flatten.

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

**Where the work happens.** Combine, split, crop-for-batch, flatten and deskew are
pure functions over bytes in `src/engine/ops/`, built on pdf-lib. Nothing in
there knows about a `Document`, a tab or a dialog, so M120's batch runner and
M121's CLI get the same code the dialogs use. The renderer talks to them
through `OpsClient`, which runs them in this module's own Worker
(`ops.worker.ts`) — the same shape M21 uses for the writer and M91 for the
converters — and falls back to running them in-process when there is no
`Worker` (unit tests in Node), so what the tests exercise is what ships.

**Why pdf-lib and not PDFium for the ops.** ADR 0010 already settled that
writing is pdf-lib's job. Combine has to graft one outline per source file,
split has to weigh a document repeatedly, and flatten has to lift an
appearance stream into a page's resources: all three are object-graph surgery
that PDFium's public API does not offer. PDFium stays the engine for
rendering and for reading, which is what the detection halves of crop and
deskew use.

**Crop is boxes only.** `SetPageBoxCommand` (M20) already writes CropBox
through the engine and the other four through the write plan, so the crop tool
mints one of those per page and gets undo for nothing. The only gap was
*reading* Trim/Bleed/Art — the model records them as `null` because
`PdfEngine.pageSize` never returned them — so this module adds one additive
engine method, `pageBoxes(doc, page)` (ADR 0018). Nothing re-encodes; a
cropped page is the same content in a smaller window.

**"Remove white margins"** renders the page at 100 dpi, walks the rows and
columns inwards while they stay within a tolerance of the page's own
background colour, and offers the result as a rectangle the reader can still
adjust. The scan itself (`inkBounds`) is a pure function over RGBA, so it is
unit-tested without a PDF.

**Deskew detection** is the projection-profile method (Postl): render the page
grayscale at ~110 dpi, downsample so the long edge is ~700 px, binarise
against Otsu's threshold, keep the coordinates of the dark pixels only, and
for each candidate angle bucket `y·cosθ + x·sinθ` into 1-px rows. Coarse pass
±15° at 0.5°, then a fine pass ±0.6° at 0.02° around the winner. Working from
the dark *coordinates* rather than the image is what makes 100 pages in well
under 20 s possible: a text page is ~5 % ink, so each angle costs tens of
thousands of adds rather than half a million.

The profile is scored by the **sum of squared differences between adjacent
rows**, not by its variance. The textbook criterion is the variance — the sum
of the squared bucket counts — and it fails on the operator's own files: a
boarding pass carries a barcode, a block of bars is a denser thing to
concentrate than a page of writing, and the variance therefore peaks wherever
the bars line up and declares a perfectly straight pass to lean by fifteen
degrees. The difference criterion measures how *abruptly* the profile rises
and falls, which is what a line of text is and what a solid block is not; on
those files it is the whole difference between "0.00°" and "−14.98°", and on
a page of text the two agree. A peak sitting against the end of the sweep is
distrusted whichever criterion found it, because the real answer is then
somewhere the sweep never looked.

Confidence is the peak's height over the profile's own spread, reported in
words ("clear" / "uncertain" / "not enough content") — never a bare number and
never a colour. Source: the method is textbook (H. S. Baird 1987, W. Postl
1986); no product was consulted.

**Deskew and flatten replace their pages rather than mutate them.** Both change
page *content*, and PDFium can neither wrap a content stream nor un-flatten a
page, so an in-place engine mutation would not be undoable. Instead each runs
its pure op over the sliced-out pages and puts the result back:
`slicePages` → op → `ImportPagesCommand` at the same index →
`DeletePagesCommand` on the originals → `RepointDestinationsCommand`, all in
one `doc.batch`, so Edit ▸ Undo shows one entry and restores the pages exactly
as they were, annotations included. The cost is that a deskewed page is a new
model page with a new id; bookmarks and named destinations survive because
`RepointDestinationsCommand` aims them at the replacement.

**Deskew apply** wraps the page's existing content in
`q  cosθ sinθ −sinθ cosθ tx ty  cm … Q` by adding two small streams around the
`/Contents` array — the existing streams are neither decoded nor re-encoded, so
image XObjects come through byte-identical — and paints a page-sized rectangle
in the page's own background colour underneath, which is what fills the corner
wedges. Annotation `/Rect` and `/QuadPoints` (links included) are rotated with
the same matrix, `/Rect` as the bounding box of its rotated corners. "Trim
edges" shrinks the CropBox by the wedge width; off by default.

**Split by size** cannot be solved analytically — shared resources mean two
pages together are smaller than the two apart — so it bisects: take pages
greedily, serialise, and if the result is over budget drop pages and try
again, remembering the ratio so the second guess is close. A single page that
is over budget on its own goes out on its own with a warning rather than
failing, which is the only honest answer.

**Flatten** copies each annotation's `/AP /N` form XObject into the page's
resources and appends `q <matrix> cm /Fmn Do Q`, using PDF 12.5.5's algorithm
to map the appearance's `/BBox` through its `/Matrix` onto the annotation's
`/Rect`, then drops the annotation. Widgets are flattened the same way and
`/AcroForm` goes with them, so a flattened form has no fields and renders
identically. Hidden and NoView annotations are dropped rather than drawn.
When M61 lands it will regenerate widget appearances first; the hook is
`FlattenOptions.appearances`.

**Combine** writes its own `/Outlines` tree (`ops/outline.ts`) rather than
reusing the writer's, which is welded to the write plan. One bookmark per
source file, named from the file, with that file's own outline nested under it
when "keep existing bookmarks" is on.

**Units and ratios.** The crop dialog's numeric margins use the viewer's
current unit (M11's `units.ts`), so the ruler and the dialog never disagree.

**No new dependencies.** pdf-lib, PDFium and the shell are all this module
needs.

## Build log (fill in at merge)

_Not started._
