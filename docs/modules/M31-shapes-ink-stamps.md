# M31 — Annotations — shapes, ink & eraser, stamps, file attachments

| | |
|---|---|
| **Module id** | `M31` — folder `src/renderer/modules/M31-shapes-ink-stamps/`, branch `mod/M31-shapes-ink-stamps` |
| **Earliest wave** | 4 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M30 |
| **Unlocks** | [M33 Measuring tools — distance, perimeter, area, calibration](./M33-measuring-tools.md) |

## Your task — the prompt for this conversation

You are building **M31 — Annotations — shapes, ink & eraser, stamps, file attachments** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M30 Annotations — text markup, notes, typewriter, text box, callout](./M30-markup-annotations.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M31-shapes-ink-stamps` from `main` in a new git worktree and
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

Drawing tools and stamps: geometric shapes with full styling, pencil ink
with smoothing and an eraser, the standard/dynamic/custom stamp system,
and file-attachment annotations.

## Foxit 14 reference — what to emulate

Foxit Comment tab: Rectangle, Oval, Line, Arrow, Polygon, Polyline, Cloud,
Pencil, Eraser (Foxit's ink eraser), Area Highlight; Stamps gallery
(Standard Business, Sign Here, Dynamic with name/date/time, Custom from
image/PDF/clipboard, Favourites, manage stamps); Attach File; Distance/
Perimeter/Area (M33).

## Scope — build all of this

- Shape tools: rect, ellipse, line, arrow (start/end styles: none, open
  arrow, closed arrow, circle, square, diamond, slash, butt), polygon,
  polyline, cloud (cloudy border intensity), area highlight (rect with
  highlight blend — solid alternative for our own colours); stroke width/
  colour/dash, fill colour, corner handles, shift-constrain, snap to grid
  (M11 flag), vertex editing for polygon/polyline.
- Pencil: pointer-pressure aware, smoothing (Catmull-Rom → Bézier), width/
  colour, one ink annotation per stroke group (setting), eraser removes
  whole strokes or splits them (setting).
- Stamps: catalogue in `resources/stamps/catalogue.json` + vector PDF
  files per stamp (draw the Foxit-equivalent set in-house: Approved,
  Confidential, Draft, Final, For Comment, Sign Here, Void, Completed,
  Reviewed, Received, Revised, Void…); dynamic stamps with tokens
  (`{name}`, `{date}`, `{time}`, `{initials}`), custom stamps from image/
  PDF page/clipboard with cropping, favourites, categories, stamp palette
  panel with preview, stamp placement with rotation/scale, "Set as default".
- File attachment annotation: pick file, icon, description; opens/saves via
  M12's attachment service.
- Appearance streams for all of the above; properties panel sections.

## Out of scope

Measurements (M33). Comment panel (M32).

## Design notes & constraints

- Shape geometry in page points; convert once via `PageGeometry`.
- Stamps are Form XObjects embedded once per document and referenced.
- Ink smoothing is deterministic (unit-testable) and stored as the original
  points too (`custom.rawPoints`) so the eraser can operate precisely.

## Files you will create or touch

`src/renderer/modules/M31-shapes-ink-stamps/**`, `resources/stamps/**`,
`src/engine/appearance/{shapes,ink,stamp}.ts`, tests.

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

- Each shape/ink/stamp round-trips and renders identically in PDFium and
  Chrome.
- Arrow end styles render at the correct angle after rotate/resize.
- Eraser split of a stroke yields two ink annotations with the expected
  point counts.
- Custom stamp from a PNG is embedded once for 10 placements (object count
  check via qpdf --show-npages/`--json`).

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

- **One overlay, one selection, one controller — M31 plugs into M30's.** A second `AnnotationLayer`
  on the same page would fight the first for the SVG element, and a second controller would fight it
  for the pointer. So `AnnotationService` gains one additive hook, `registerProvider()`: a provider
  says which annotations it owns, what the overlay draws for them, how a move, a resize and a handle
  drag patch their geometry, and what the properties panel shows. M30 keeps its families; M31 owns
  `shape`, `ink`, `stamp` and `fileAttachment`, plus a `Highlight` whose `/IT` is `AreaHighlight`.
- **Shapes PDFium can create get our appearance pushed into the live page; the rest are inserted by
  the writer.** Square, Circle and Ink are among PDFium's ten, so the raster carries them — but its
  own `/AP` knows nothing of clouds, dashes or Bézier-smoothed ink, so the same generator that will
  write the file hands PDFium the stream through `setAnnotationAppearance` (ADR 0013), which works
  because every shape is pure vector. Line, Polygon, PolyLine, Stamp and FileAttachment are drawn
  by the overlay until a save bakes them (Stamp is creatable but PDFium never draws one).
- **A stamp is a Form XObject embedded once per document.** `AppearanceResources.xobjects` names a
  shared XObject by key; `WritePlan.xobjects` carries each key's source — a content stream for a
  catalogue stamp, PNG/JPEG bytes for a custom image, a PDF page for a custom page — and
  `FullRewriteWriter` embeds each key once per write and references it from every annotation's
  `/AP` (`/Fm1 Do` under a rotation matrix). Sources live in `Document.custom['xobjects']`, written
  by a `SetCustomCommand`, so they are undoable, journalled and in the recovery file (ADR 0015).
- **The catalogue is data, the drawings are generated.** `resources/stamps/catalogue.json` describes
  each standard stamp (text, colour, category, dynamic tokens); `engine/appearance/stamp.ts` draws
  the rounded-box-and-bold-text Foxit style from it deterministically, and `scripts/make-stamps.ts`
  renders the same drawings to `resources/stamps/<id>.pdf` so the vector files the brief asks for
  exist and stay in step. Dynamic tokens (`{name}`, `{date}`, `{time}`, `{initials}`) resolve at
  placement from M30's identity; the resolved text is baked into the appearance.
- **A stamp's `/AP` survives a move.** `writeAnnotation` used to drop the appearance on every edit,
  because `FPDFAnnot_SetColor` refuses beside one. A stamp's appearance *is* its content, so for a
  Stamp or a FileAttachment a patch that carries only geometry, flags and strings keeps it: PDF
  maps `/BBox` to `/Rect`, so a moved or resized stamp still renders. A custom stamp from a file
  opened in this session can therefore be moved and resized, but not turned — its source is not in
  the model. The panel says so.
- **Ink stores raw points in `/InkList`; smoothing is derived, deterministic and never stored.** The
  appearance is Catmull-Rom converted to cubic Béziers over exactly those points, so every viewer
  without our `/AP` draws the same stroke as a polyline and ours draws it smooth. Pressure, when a
  pen reports it, is kept per point in `extra.pressures` (not written to the file — PDF ink has no
  width per point) and widens the stroke in the appearance. The eraser works on the raw points,
  which is why they are the ones that are stored.
- **The eraser splits into annotations, not paths.** In split mode the fragment before the erased
  span stays in the original annotation and each later fragment becomes a new Ink annotation with
  the same properties — one composite command. Stroke mode removes the whole path; an annotation
  with no paths left is deleted.
- **Arrows are Lines with `/LE`; clouds are Polygons with `/BE`; area highlight is a Highlight.**
  Exactly as Acrobat and Foxit write them, so another editor reads ours back as the tool that made
  them. `/LE` (two names) and `/BE` (a dictionary) are new kinds in `dict.ts`'s closed list; `/FS`
  for a file attachment is a reference the writer resolves to the embedded file by name.
- **A file attachment is embedded through the engine and moved into the annotation by the writer.**
  `engine.addAttachment` puts the bytes in the `/EmbeddedFiles` name tree, which is what gives M12's
  panel "open" and "save as" for free; the plan then names the file on the annotation, and the writer
  sets `/FS` to that specification and removes the name-tree entry so it is listed once.
- **Constrain and snap are the tools', not the model's.** Shift makes a rectangle square, an ellipse
  round, a line horizontal/vertical/45°, and a polygon edge axis-aligned; `Viewer.snap()` (M11's
  grid flag) is applied to every point a tool takes before it reaches a command.
- **Vertex handles are a layer feature.** `LayerAnnotation.vertices` plus `HandleSet 'vertices'`
  give a polygon or a polyline one handle per point (`v0…vN`); `ShapeImage` lets the layer draw a
  custom stamp's picture. Both are additive to `AnnotationLayer`, which is in `view/` for this.
- **The PDFium adapter installs the app's own appearance for a Square, a Circle or an Ink as it
  writes them** (found while testing, see the build log): PDFium would otherwise build one as the
  page reloads and, for an Ink, inflate `/Rect` by half the border width every time — so after a
  few edits the engine's rect and the model's disagreed and the writer refused to touch it.
  Installing ours first means PDFium finds an `/AP` and generates nothing.
- **Every custom stamp is a PNG** (operator, 2026-09-09): a picture file is re-encoded, a clipboard
  image already is one, a PDF page is rendered by the engine at about 1 200 px on its longer side.
  One stored format, and the "treat white as transparent" import option works for all of them.
- **A creation tool owns the keyboard as it owns the pointer.** M30's controller opens or clears
  the selection on Enter and Escape; while one of M31's tools is active those keys go to the tool
  instead, through the viewer's own routing — the stroke the pencil just drew is selected, and
  Enter has to finish the polygon, not open the stroke's popup.
- **Provenance.** Line endings, `/BE` clouds, `/IT` intents, the standard stamp names and the
  `/InkList`/`/AP` split are ISO 32000-1 (12.5.6.7–12.5.6.13, table 181). The tool gestures
  (drag a box, click the corners, Enter to close, Shift to constrain), the stamp look (a rounded
  box with bold upper-case text), the "keep tool selected" behaviour and the eraser's two modes
  are the conventions every PDF editor shares, learned from public documentation and from using
  editors as a reader would. Nothing was copied from any product's artwork, strings or files.

## Build log (fill in at merge)

**Built 2026-09-09 on `mod/M31-shapes-ink-stamps` (worktree `../ynotPDF-M31`).**

### What shipped

- **Shapes** — rectangle, oval, line, arrow (ten `/LE` endings at either end, closed heads filled
  with `/IC`), polygon, polyline and cloud (`/BE` intensity), plus area highlight as a `Highlight`
  over a rectangle; stroke colour, width and dash, fill, Shift constraints, M11's grid snap,
  eight box handles or one handle per vertex, and the rect that follows what a shape draws.
- **Pencil and eraser** — raw points in `/InkList`, Catmull-Rom → Bézier smoothing in the
  appearance, a pen's pressure kept per point and widening the stroke, strokes drawn close together
  grouped into one annotation (setting), and an eraser that cuts a stroke into annotations or takes
  it whole (setting), one composite command per pass.
- **Stamps** — a 31-entry catalogue in `resources/stamps/catalogue.json` (standard business, sign
  here, and dynamic stamps with `{name}`, `{initials}`, `{date}`, `{time}`), each also written as a
  vector PDF by `npm run stamps`; a left-dock palette with previews, categories and favourites; a
  custom-stamp dialog (picture file, clipboard or a PDF page → PNG, cropped by dragging, white made
  transparent on request); placement by click or by drag, rotation, "Set as default"; and every
  picture embedded **once** per document as a shared Form XObject (ADR 0015).
- **File attachments** — a file pinned to a page with a choice of icon and a description, embedded
  through the engine so M12's panel opens and saves it, and moved on to the annotation's `/FS` by
  the writer so it is listed once.
- **`src/engine/appearance/{shapes,ink,stamp}.ts`** — one list of drawings per annotation that the
  overlay paints and the writer bakes; `dict.ts` gained `/LE`, `/BE`, `/BS /D` and `/FS`.
- **The properties panel** — stroke, fill, dash, cloud, endings, stamp rotation, attachment icon and
  its open/save buttons, as sections inside M30's panel through the provider hook.

### The things that were not as expected

- **PDFium inflates an Ink's `/Rect` every time it regenerates the appearance.** By half the border
  width, on every reload after an edit, and the model never hears of it — so after a few edits the
  writer, which checks the rect before writing, refused the annotation ("moved in the file"). The
  adapter now installs our own appearance for Square, Circle and Ink as it writes them, so PDFium
  generates nothing and the rect stays what the model said. The live page shows the cloud and the
  smoothing straight away as a bonus.
- **A PNG with alpha is two image objects in the file**: the picture and its soft mask. "Embedded
  once" is checked as pictures-minus-masks, by pdf-lib and by qpdf's `--json`.
- **PDFium reads an annotation's attached-file description from `/Params`**, not from the file
  specification where the spec puts it. The writer now *copies* `/Desc` and the type on to the
  specification rather than moving them, so the app reopening its own file keeps the description.
- **pdf-lib's typed `lookupMaybe` throws on the wrong type.** Reading a callout's single-name `/LE`
  as an array threw inside the raw pass and silently lost the colours of every annotation after it
  on the page. Everything M31 reads goes through `lookup` and `instanceof` instead.
- **Ending a pencil group put the pencil away, which ended the group, which put the pencil
  away…** — a stack overflow the e2e found. The group is cleared before anything else runs.
- **Enter finished nothing.** With the stroke just drawn still selected, M30's controller took the
  key for the selection; and a consumed pointerdown never moves the focus, so the scroller that
  routes keys to a tool never had it. A creation tool now owns the keyboard while active, and every
  press focuses the page area.
- **Node resolves `./content`, not `./content.ts`**, so a script under `scripts/` could not import
  the engine's own code; `scripts/lib/register-ts.mjs` is a ten-line resolve hook that tries the
  extension, used by `npm run stamps`.

### Shared files touched (PLAN.md §12.3, all additive except where noted)

- `src/engine/appearance/{types,content,dict,generators,index}.ts` — `xobjects` in the resources,
  `PathOp` and `drawXObject`, three `DictValue` kinds and `encode`/`empty`, the attachment icons.
- `src/engine/Writer.ts`, `src/engine/writers/FullRewriteWriter.ts` — `WritePlan.xobjects`,
  shared XObjects embedded once, name arrays, dictionary merges, `/FS` resolution.
- `src/engine/pdfium/{PdfiumEngine,mutations,rawdoc}.ts` — **two behaviour changes:** a Stamp or
  FileAttachment keeps its `/AP` through a geometry-only patch, and Square/Circle/Ink get the
  app's own appearance as they are written; the raw pass reads `/LE`, `/BE` and `/BS /D`.
- `src/renderer/view/AnnotationLayer.ts` — `ShapeImage`, vertex handles.
- `src/renderer/modules/M30-markup-annotations/{AnnotationService,AnnotationController,PropertiesPanel}.ts`
  — the provider hook; **one behaviour change:** keys go to an active creation tool.
- `src/renderer/modules/M21-save/plan.ts` — `xobjects` from `custom.xobjects`.
- `src/renderer/core/Document.ts` — **one behaviour change:** `rebindAttachments` pairs by engine key.
- `src/renderer/main.ts`, `src/renderer/index.html`, `vitest.config.ts`, `package.json` (`stamps`
  script), `resources/annotations/colours.json` (tool defaults), `docs/shortcuts.md`,
  `resources/README.md`, `test/unit/{annotations,writer}/appearance.test.ts` (two assertions
  updated for the new key list and the path-based rectangle), `PLAN.md` §0.

### Tests

Green on Windows locally: lint (eslint, prettier, the colour/opacity rules, `tsc` on both
projects), the unit suite with the coverage gates (13 new files, 133 tests in `test/unit/drawing/`),
and the Playwright suite (`test/e2e/drawing.spec.ts`, 13 tests, one per acceptance line, plus every
earlier module's spec).

**The hands-on check the conventions ask for, recorded.** `test/unit/drawing/real-files.test.ts`
draws a cloudy rectangle, an arrow, a pencil stroke, a turned stamp and a pinned file on the first
page of each of the operator's own files in `test/fixtures/local/`, saves through the real pipeline
and reopens; it skips itself on any machine without them. All four files round-trip with every
annotation inside the page's crop box and carrying an appearance stream. Nothing about their
contents is read, quoted or asserted.

### Deferred, and why

- **Turning a custom stamp reopened from a file.** Its picture is in the file's `/AP`, not in the
  model, so it can be moved and resized (the appearance is kept and mapped to the new rect) but not
  turned; the panel says so in words. Reading the XObject back out of the file is a job for the
  incremental writer's era (M80), when the file rather than the journal is the source.
- **A dynamic stamp reopened from a file** is in the same position: the resolved date is only in
  its appearance.
- **Line leaders (`/LL`, `/LLE`) and a line's caption (`/Cap`)** are M33's, where a dimension line
  needs them; the `/LE` machinery they share is here.
- **Pressure is appearance-only.** PDF ink has no width per point; `extra.pressures` never reaches
  the file, so a reopened stroke is drawn at one width.
