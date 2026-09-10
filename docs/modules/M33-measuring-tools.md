# M33 — Measuring tools — distance, perimeter, area, calibration

| | |
|---|---|
| **Module id** | `M33` — folder `src/renderer/modules/M33-measuring-tools/`, branch `mod/M33-measuring-tools` |
| **Earliest wave** | 5 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M31 |
| **Unlocks** | — |

## Your task — the prompt for this conversation

You are building **M33 — Measuring tools — distance, perimeter, area, calibration** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M31 Annotations — shapes, ink & eraser, stamps, file attachments](./M31-shapes-ink-stamps.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M33-measuring-tools` from `main` in a new git worktree and
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

Foxit's Measure group: distance, perimeter and area tools with scale
calibration, snapping, units and measurement annotations carrying their
values.

## Foxit 14 reference — what to emulate

Foxit Comment → Measure: Distance, Perimeter, Area; Measurement panel
(scale ratio e.g. 1 pt = 1 mm, precision, units), snap to paths/endpoints/
midpoints/intersections, show result label, caption style, cumulative
measurements, export results.

## Scope — build all of this

- Distance/perimeter/area tools drawing Line/PolyLine/Polygon annotations
  with `/IT /LineDimension|PolyLineDimension|PolygonDimension`, `/Measure`
  dictionary (RectilinearMeasure with X/Y/D/A/T number formats), leader
  lines and caption placement as Foxit.
- Calibration dialog: draw a known line → enter real length + unit →
  stores scale per page (or per document), precision.
- Snapping: to page-object path vertices/midpoints/intersections using
  M50's geometry if merged, else `pageObjects` paths directly; visual snap
  indicator (opaque marker) and toggles.
- Results panel: live value while drawing, cumulative list, copy/export
  CSV.
- Properties: label position, colour, line ends, units.

## Out of scope

3D measurement (Parked).

## Design notes & constraints

- Geometry utils (`modules/M33/geometry.ts`): segment intersection,
  polygon area (shoelace), point-to-segment distance — pure, tested.
- `/Measure` output must be readable by Acrobat (reference the PDF 2.0
  spec §12.9).

## Files you will create or touch

`src/renderer/modules/M33-measuring-tools/**`,
`src/engine/appearance/measure.ts`, tests.

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

- A 100 mm line in a synthetic fixture (A4, 1 pt = 1 pt) measures 100.0 mm
  ±0.1 after calibration; area of a 50×20 mm rect = 1000 mm².
- Snap picks the nearest vertex within tolerance (unit).
- Saved measurement annotation carries `/Measure` and reopens with the
  same value.

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

- **A measurement is one of M31's shapes carrying a `/Measure` dictionary, not a family of its
  own.** Distance is a `Line` with `/IT /LineDimension`, perimeter a `PolyLine` with
  `/IT /PolyLineDimension`, area a `Polygon` with `/IT /PolygonDimension` — what Acrobat and Foxit
  write, so ours reopen in either as measurements rather than as plain shapes. The model already
  has the `shape` family, so nothing new is added to it: M33 registers a second
  `AnnotationProvider` (ADR 0015) and takes those three intents back off M31's.
- **A provider says how badly it wants an annotation.** `providerFor` used to take the first
  provider that claimed one, and M31's claims every shape — so M33's would never have been asked.
  `AnnotationProvider.priority` (default 0, higher first) is the whole fix; M33 registers at 10
  and M31 keeps every shape that is not a measurement (ADR 0018).
- **The scale is a value, and it deliberately lives in three places.** `MeasureScale` — *n* of a
  page unit = *m* of a real unit, plus the precision and an optional fraction denominator — is the
  unit of currency. **Every annotation carries its own**, as `/Measure`, which is what makes a
  saved measurement reopen with the value it had whatever the document's scale is now. **The
  document** keeps the working scale in `Document.custom['M33.measure']`, per page and per
  document, written by a `SetCustomCommand` so a calibration is undoable, journalled and in the
  recovery file. **The settings** keep the scale a new document starts with. A page's scale wins
  over the document's, as Foxit's per-page calibration does.
- **`/Measure` is data in `dict.ts`, like every other entry we write.** Adding `measure` →
  `/Measure` there teaches the plan, the writer and the raw reader at once; the same table gains
  `/LL`, `/LLE`, `/LLO`, `/Cap`, `/CP` and `/CO`, which M31 deferred to here. It needed two new
  `DictValue` kinds — `bool` for `/Cap` and `array` for a `/Measure` number-format array, which is
  an array *of dictionaries* and the first thing in this app that is (ADR 0018).
- **Number formats are written the long way round, so Acrobat reads them.** One
  `/Type /NumberFormat` per axis (`/X`, `/Y`, `/D`, `/A`, `/T`), each with `/U`, `/C`, `/F`, `/D`,
  `/RD`, `/RT` and `/O`, and `/R` as the ratio in words. `/C` converts a value in *default user
  space* — points — to the format's unit, so it is `to / (from × pointsPer(fromUnit))`; the area
  format's factor is that squared and its label carries the `²`. Read back the same way, so a file
  written by Acrobat measures the same here.
- **Snapping needs real paths, so the engine grew one additive method.** `pageObjectPaths(doc,
  page)` returns each page object's subpaths flattened to polylines in page space (PDFium's
  `FPDFPath_*`, Béziers subdivided, form objects walked one level with their matrices composed).
  It is **optional** on `PdfEngine` and guarded by `ffi.has`, so a wasm build without those
  exports — and the fake engine in the model tests — simply have no paths; snapping then falls
  back to page-object bounding boxes, which still gives corners and edge midpoints (ADR 0018).
- **A page's own geometry is cached for the life of the document; the annotations are not.** Endpoints,
  segment midpoints, segment/segment intersections and the nearest point on a path, each with its
  own toggle. Drawing bumps the document's revision on every gesture, and re-reading a CAD page's
  few thousand paths between two pointer moves is exactly the wrong moment — while the page's
  *content*, which is what the engine call reads, has not changed at all. The annotations on the
  page are gathered fresh on every look instead (a walk over one page's model list), so a second
  distance can start exactly where the first one ended. Intersections are the expensive kind, so
  they are computed only for segments within a window of the pointer. The
  indicator is a fully opaque marker in the annotation layer — a square for an endpoint, a
  triangle for a midpoint, a cross for an intersection, a circle for a point on a path — and the
  status line says which in words, because four shapes alone are not enough to tell them apart.
- **Geometry is pure and lives in `geometry.ts`:** shoelace area, segment intersection,
  point-to-segment distance, polyline length. Everything the tools, the panel and the writer
  measure goes through those four functions, so there is one answer per question.
- **Leaders and the caption are drawn by the same list of drawings the writer bakes.** `/LL`
  offsets the line proper perpendicular to the measured points (clockwise for a positive value, as
  the spec has it), `/LLO` leaves a gap at each end and `/LLE` extends past it; `/Cap` puts the
  value on the line, `/CP /Inline` breaking it for the text and `/Top` sitting above it, `/CO`
  nudging it. `src/engine/appearance/measure.ts` produces the paths and the text, `overlay.ts`
  paints them and `measureAppearance` bakes them, so the screen and the file agree.
- **The value is in `/Contents` as well as in the appearance.** A viewer with neither our `/AP`
  nor a measurement of its own still shows the number in the annotation's pop-up, and M32's
  comments panel lists it without knowing what a measurement is. The provider rewrites it whenever
  the geometry or the scale changes — and only when the text actually differs, or `afterChange`
  would call itself for ever.
- **Calibration is a tool, not a mode.** Draw a line over something whose real length is known,
  type the length and its unit, and the scale that makes those two agree is stored for the page or
  the document. The line itself is not kept — Foxit does not keep it either — but every
  measurement already on that page is re-measured, since their captions would otherwise disagree
  with the ruler they were made with.
- **The results panel is a panel, not a dialog**, so it can stay open while measuring: the live
  value at the top while a tool is drawing, then every measurement in the document by page, with
  running totals for length and for area, and Copy and Export CSV. The CSV is RFC 4180 with a BOM,
  the same shape M13's search export uses.
- **`/LE` goes on the line proper, and the unit goes on the measurement.** A dimension's ends are
  the ends of the *drawn* line, which `/LL` has already moved across, so the heads are drawn there
  rather than at the measured points — the same `lineEndingDrawing` M31's arrows use, so an arrow
  on a measurement and an arrow on a plain line are the same head. The unit and the precision in
  the properties panel rewrite that annotation's own `/Measure` rather than the page's scale:
  showing one run in metres while the rest of the page is in millimetres is a display choice about
  that measurement, and a reader who meant the whole page would recalibrate it. `convertScaleTo`
  restates the ratio rather than recomputing it, so nothing is lost to rounding on the way through.
- **The caption has a handle of its own, and it is beside the text rather than on it.** A
  measurement's label is not one of the points it measures, so moving it must not be able to
  change the value — a separate handle says that, where a ninth box handle would not.
  `AnnotationLayer.extraHandles` (additive) lets a provider name handles of its own beside the set
  it asks for; M33 uses one, `caption`, and it is drawn round where every other handle is square,
  because the operator cannot tell two handles apart by colour. It sits just past the end of the
  text: nine pixels of opaque chrome on top of the number the reader came for would hide a digit.
  `/CO` is a *nudge*, and its frame differs by kind — along a distance's own line and across it,
  plain page space for a polygon — so the offset is worked out by asking where the caption would
  sit with no offset at all and measuring from there, which needs no inverse of the placement
  arithmetic and is exact in either frame.
- **Provenance.** `/Measure`, `/NumberFormat`, the `RL` subtype, `/IT` dimension intents, `/LL`,
  `/LLE`, `/LLO`, `/Cap`, `/CP` and `/CO` are ISO 32000-1 §12.9 and tables 172, 266 and 267 (PDF
  2.0 numbers them the same). The tool gestures (drag for a distance, click the corners for a
  perimeter or an area, Enter to finish), the calibration flow, the scale-ratio wording and the
  idea of a results list with cumulative totals are the conventions every measuring tool shares,
  learned from public documentation and from using such tools as a reader. Nothing was copied from
  any product's artwork, strings or files.

## Build log (fill in at merge)

**Built 2026-09-10 on `mod/M33-measuring-tools` (worktree `../ynotPDF-M33`).**

### What shipped

- **Three measuring tools** — Distance (drag; Shift keeps it to 45°), Perimeter and Area (a click
  per corner, `Enter` or the first corner to finish, `Backspace` to take one back, `Escape` to
  abandon) — writing a `Line`, a `PolyLine` and a `Polygon` with `/IT /LineDimension`,
  `/PolyLineDimension` and `/PolygonDimension`, a full `/Measure` dictionary each, `/LL`, `/LLE`,
  `/LLO`, `/Cap`, `/CP` and `/CO` on a dimension line, and the value in `/Contents` as well as on
  the page. The gesture shows its value beside the pointer as it is drawn.
- **`/Measure` as Acrobat reads it** — RectilinearMeasure, `/R` in words, a `/Type /NumberFormat`
  on all five axes written in full (`/U`, `/C`, `/F`, `/D`, `/FD`, `/RD`, `/RT`, `/PS`, `/SS`,
  `/O`), the area format's factor squared and its label carrying the `²`. Read back the same way,
  so a file written by Acrobat measures the same here.
- **Ten units** (pt, pc, in, ft, yd, mi, mm, cm, m, km), decimals to six places or fractions to
  halves, quarters, eighths and sixteenths, formatted through `Intl` at en-GB.
- **Calibration** — draw a line whose real length is known, type it, and the scale is stored for
  the page or the document as an undoable `SetCustomCommand`; the same dialog with no line sets the
  ratio by hand. Every measurement the calibration covers is re-measured, its `/Measure` replaced
  and its caption rewritten.
- **Snapping** to endpoints, midpoints, intersections and any point on a path, each with its own
  toggle and a tolerance in screen pixels; an opaque marker whose _shape_ says which kind and whose
  accessible name says it in words. The geometry comes from a new engine method (below) and is
  cached per page and document revision.
- **The Measurements panel** — the live value while a tool draws, every measurement in the document
  by page as a button that selects it and goes there, totals kept apart by kind and by unit, and
  Copy (tab-separated) and Export CSV (RFC 4180, CRLF, BOM).
- **The caption can be dragged** by a round handle just past it, and put back from the panel; the
  measurement underneath never changes, whatever is done to its label.
- **The properties sections** — the value and the ruler it was measured with; the unit and the
  precision *this* measurement is shown in (its own `/Measure` restated, not the page's scale); the
  line colour, width and dash; `/LE` at each end, the same ten endings M31's arrows offer; the
  three leader entries; and whether the value is drawn, where and how big.
- **`src/engine/appearance/measure.ts`** — one list of drawings per measurement that the overlay
  paints and the writer bakes, so the screen and the file cannot drift apart.

### The things that were not as expected

- **`providerFor` took the _first_ provider that claimed an annotation**, and M31's claims every
  shape — so M33's would never have been asked about a measurement. `AnnotationProvider.priority`
  (ADR 0018) is the whole fix; M33 registers at 10.
- **`/Measure` is an array of dictionaries**, which `DictValue` could not say, and `/Cap` is a
  boolean, which it could not say either. Two new kinds, `array` and `bool`, close the last gaps in
  the table: everything PDF's object model has except streams and references can now be planned.
- **The baked appearance was drawn slightly smaller than the overlay.** Found by screenshotting a
  real page before and after a save: a viewer maps an appearance's `/BBox` on to the annotation's
  `/Rect` (PDF 12.5.5), and ours differed by the stroke padding — invisible on an outline, a
  caption that has moved by two points. A measurement's rect is now _exactly_ its bbox, computed
  once by `measureBounds` for both, and a test pins it for all four shapes.
- **`PdfEngine` gained its first optional method.** `pageObjectPaths` needs PDFium's `FPDFPath_*`
  exports, which a wasm build need not have, and the in-memory `FakeEngine` the model tests use has
  no path data at all. Making it optional meant `Parameters<PdfEngine[M]>` in `EngineClient` no
  longer compiled (a union with `undefined` in it), so the proxy narrows with `NonNullable`, and
  the Worker now answers `not-implemented` rather than failing three frames deep.
- **A boolean mapping did not need an `encode`.** `dictEntries` only treats `null`, `''` and an
  `empty()` value as removals, so `false` reaches the coercion intact — which is what "a caption
  turned off has to be _said_" requires. The encode was deleted as duplication.
- **Caching the snap geometry by the document's revision was the wrong key.** Every measurement
  drawn bumps it, so the next pointer move re-read the whole page from the engine — on a drawing
  with thousands of paths, mid-gesture. The page's content is now cached for the life of the open
  document and the annotations are gathered on each look, which is both faster and more correct.
- **`Intl` will happily print `-0.0`.** A tiny negative rounded to the shown precision reads as a
  mistake; `formatMeasureNumber` snaps anything under half the last digit to zero.

### Shared files touched (PLAN.md §12.3, all additive except where noted)

- `src/engine/PdfEngine.ts` — `PageObjectPath`, the optional `pageObjectPaths`, its entry in
  `ENGINE_METHODS`, and a stub on `NotImplementedEngine`.
- `src/engine/EngineClient.ts` — the `EngineFn<M>` alias, so an optional method still types.
- `src/engine/worker.ts` — **one behaviour change:** a method the backend does not implement is
  answered with `not-implemented` instead of throwing.
- `src/engine/pdfium/{PdfiumEngine,rawdoc}.ts` — `pageObjectPaths` and its path flattening; the raw
  pass reads `/Measure`, `/LL`, `/LLE`, `/LLO`, `/Cap`, `/CP` and `/CO`.
- `src/engine/appearance/{dict,index}.ts` — two `DictValue` kinds, seven mappings, the exports, and
  `Line`/`Polygon`/`PolyLine` registered through `measureAware` so a file's captions survive a save
  made by a build without this module in it.
- `src/engine/writers/FullRewriteWriter.ts` — `dictValue` handles `bool`, `array` and a nested
  `dict`; an array member that can only resolve at the top level is skipped.
- `src/renderer/modules/M30-markup-annotations/AnnotationService.ts` —
  `AnnotationProvider.priority` and the highest-wins `providerFor`.
- `src/renderer/view/AnnotationLayer.ts` — `LayerAnnotation.extraHandles`, a `HandleId` that
  admits a provider's own ids, and both in the repaint signature; `AnnotationController.ts` narrows
  `tip`/`knee` one at a time now that a handle id may be any string.
- `src/renderer/main.ts`, `src/renderer/index.html`, `vitest.config.ts`, `scripts/make-fixtures.ts`
  (`measure.pdf`), `test/fixtures/{manifest.json,hashes/*.json}`,
  `resources/annotations/colours.json` (four tool colours), `docs/shortcuts.md`, `PLAN.md` §0, and
  `test/unit/annotations/appearance.test.ts` (the closed key list grew by seven).

### Tests

Green on Windows locally: lint (eslint, prettier, the colour/opacity rules, `tsc` on both
projects), the unit suite with the coverage gates (11 new files, 172 tests in
`test/unit/measure/`), and the Playwright suite (`test/e2e/measure.spec.ts`, 18 tests, one per
acceptance line, plus every earlier module's spec).

**The hands-on check the conventions ask for, recorded.** `test/unit/measure/real-files.test.ts`
measures a distance, a perimeter and an area on the first page of each of the operator's own files
in `test/fixtures/local/`, saves through the real pipeline and reopens, and separately asks the
snapper to land on the real geometry of each; it skips itself on any machine without them. All six
files round-trip with every measurement inside the page's crop box, carrying its own `/Measure` and
an appearance stream, and measuring the same value it was made with. Nothing about their contents
is read, quoted or asserted. Two screenshots of a boarding pass — one of the overlay, one after a
save and reopen, so PDFium is drawing our own streams — are what found the `/BBox` bug above; at a
pinned zoom they are now pixel-identical.

### Deferred, and why

- **3D measurement** is Parked by the brief and by PLAN.md §1.
- **An angle tool.** `/Measure` carries a `/T` angle format and this module writes one, so the file
  is ready for it, but neither the brief nor Foxit's Measure group has an angle tool and inventing
  one would be scope of my own.
- **Cumulative measuring as a fourth gesture.** The brief lists it among the Measurement panel's
  features, and that is where it is: the panel keeps every measurement and totals them by kind and
  unit. The Perimeter tool is the running-distance gesture, with the total shown as it is drawn.
  A fourth tool that produced the same numbers without leaving an annotation behind would be a
  second way to do one thing — but if it turns out that Perimeter is not the obvious place to look
  for it, the answer is a better name or a menu entry, not a new tool.

### Added after the merge (2026-09-10)

Three of the items above were reconsidered on the operator's reading and are now done, on
`fix/M33-caption-and-nesting`:

- **The caption is draggable.** `AnnotationLayer.extraHandles` is the additive layer change that
  made it possible without a new `HandleSet`; the panel gained "Put the value back", because a
  `/CO` of a point and a half is not something anyone can see they typed.
- **Nesting is no longer capped at two forms.** The depth cut-off is gone. How deeply a file nests
  is the file's business — a placed drawing inside a stamp inside an imported page is three deep
  and perfectly ordinary — and what actually needed bounding was the *work*, since the walk runs
  on the first pointer move over a page. It is a budget of 20 000 objects now, with a depth guard
  of 12 left only to stop a form that contains itself. A three-deep fixture built in the test
  proves it, and fails against the old limit.
- **No claim is made about what other editors do here.** Neither Adobe's, Foxit's nor Tungsten's
  public documentation states a nesting limit for snapping, and this project may not inspect their
  builds to find out (CLAUDE.md). The old limit was mine, not theirs, and it is gone on its own
  merits.
