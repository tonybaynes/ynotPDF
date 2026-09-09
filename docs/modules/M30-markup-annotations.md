# M30 — Annotations — text markup, notes, typewriter, text box, callout

| | |
|---|---|
| **Module id** | `M30` — folder `src/renderer/modules/M30-markup-annotations/`, branch `mod/M30-markup-annotations` |
| **Earliest wave** | 3 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M21, M11, M13 |
| **Unlocks** | [M31 Annotations — shapes, ink & eraser, stamps, file attachments](./M31-shapes-ink-stamps.md), [M32 Comments panel, replies & status, FDF/XFDF, summarise](./M32-comments-panel.md), [M60 Form fill & AcroForm field designer](./M60-forms.md), [M82 Handwritten signatures & initials](./M82-handwritten-signatures.md) |

## Your task — the prompt for this conversation

You are building **M30 — Annotations — text markup, notes, typewriter, text box, callout** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M21 Save, Save As, autosave & recovery](./M21-save.md), [M11 Viewer — rendering, navigation, zoom, layouts](./M11-viewer.md), [M13 Text selection, find, copy, snapshot & print](./M13-select-find-print.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M30-markup-annotations` from `main` in a new git worktree and
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

The first editing tools: text-markup annotations tied to the text layer,
sticky notes, free-text (typewriter, text box, callout) with rich
properties, appearance streams, the annotation overlay layer with
selection/move/resize, and the right-pane properties panel for
annotations.

## Foxit 14 reference — what to emulate

Foxit Comment tab: Highlight, Underline, Squiggly, Strikeout, Replace
Text, Insert Text (caret), Note (icon picker), Typewriter, Callout, Text
Box; properties (colour, opacity → we use solid colours only, line style,
font, size, alignment, author, subject); Keep Tool Selected; default
properties per tool; popup notes.

## Scope — build all of this

- Annotation overlay layer (SVG per page): draws annotations the engine
  does not rasterise while editing, selection handles, hit-testing, drag/
  resize/rotate where the type allows, multi-select, arrow-key nudge,
  Delete, copy/paste (within and across documents), context menu.
- Text markup tools: highlight, underline, squiggly, strikeout, replace,
  insert — QuadPoints from the text selection (multi-line, rotated pages);
  colour presets from tokens + custom (solid only — the app never writes
  `/CA` < 1 for its own annotations; existing translucent ones are
  rendered as-is).
- Note tool: icon set (Comment, Key, Note, Help, Paragraph, NewParagraph,
  Insert, Check, Circle, Cross, Star…), popup with rich-ish text (bold/
  italic/underline/colour) shown as an opaque panel anchored to the note.
- Typewriter (click-to-type free text without border), Text Box (border
  + fill), Callout (leader line with knee, arrow head); font family (bundled
  + system list via IPC), size, colour, alignment, line spacing, border
  width/style/colour, fill colour, rotation; in-place editing with a
  contenteditable overlay, `/DA` and `/DS` written, appearance stream
  generated via `engine/appearance/`.
- Properties panel (right pane) bound to the selection with live preview;
  "Set as default" per tool; "Keep tool selected" toggle.
- Author from settings (identity: name, initials, email — asked on first
  annotation), creation/modification dates, subject.
- Reply/status **data** on the model (UI in M32).
- Ribbon Comment tab groups, shortcuts, key tips; Esc returns to Hand.

## Out of scope

Shapes/ink/stamps (M31). Comments panel & import/export (M32).

## Design notes & constraints

- Annotation model = PDF semantics (subtype, rect, quadpoints, contents,
  /DA, /IT, /Popup, /IRT). Anything Foxit-specific is a `custom` bag.
- Appearance generation is mandatory: every annotation we write must render
  identically in PDFium and Chrome (test).
- Text editing overlay reuses M13's text-layer font metrics for WYSIWYG.

## Files you will create or touch

`src/renderer/modules/M30-markup-annotations/**`,
`src/renderer/view/AnnotationLayer.ts`, `src/engine/appearance/{markup,
freetext,note}.ts`, tests.

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

- Each tool creates its annotation via e2e; save; reopen; annotation list
  equal; render hash of the page in PDFium == our overlay-free render ==
  Chrome viewer render (perceptual tolerance).
- Highlight across a line break on a rotated page yields correct
  QuadPoints (unit).
- Move/resize/delete/undo/redo for every type; copy/paste between two
  documents.
- Properties changes update the appearance stream and undo as one step.
- No overlay element has alpha < 1 (DOM walk).

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

- **The overlay draws what the raster cannot, and nothing else.** PDFium synthesises an `/AP` for
  Highlight, Underline, Squiggly, StrikeOut and Text as it loads a page, so those are already in
  the tile raster and the SVG layer only draws their selection handles. FreeText and Caret get no
  `/AP` from PDFium, so the layer draws them — until the file is saved and reopened, when M21's
  writer has baked one and `extra.hasAP` says so. An annotation this session created or edited is
  always drawn by the layer, because an edit makes PDFium drop the appearance it had.
- **Note icons are pushed into the engine as a real appearance stream.** PDFium's own Text
  appearance is one fixed yellow square whatever `/Name` says — and it rewrites `/Rect` to 20×20
  while it is at it. A note icon is pure vector with no font resource, so
  `PdfEngine.setAnnotationAppearance` (new, optional, ADR 0013) hands PDFium the stream our own
  generator built. The live raster then shows the icon the reader picked, and the saved file
  carries the same stream.
- **`AnnotationLayer` lives in `view/`, like `TextLayer`.** M31's shapes and ink, M33's
  measurements, M50's objects and M82's signatures all need the same hit-testing, handles,
  marquee and nudge; putting it in M30's folder would mean four copies or four cross-module
  imports. It knows about `ModelAnnotation` and `PageView`, not about tools or commands.
- **Every geometry change is one `UpdateAnnotationCommand`, merged.** A drag emits an update per
  frame; `UpdateAnnotationCommand.merge` collapses them, so one drag is one undo step and the
  "properties change and its appearance are one undo step" acceptance falls out of the same
  mechanism. `document.batch()` groups a multi-select move into one composite.
- **QuadPoints come from the line's own axes, not from a bounding box.** `quadsForSpan` projects
  each character box onto the line's direction and normal (M13's `TextLine.angle`), so a
  highlight over rotated text is a rotated quad rather than the axis-aligned box that contains
  it. A page with `/Rotate` needs no special case at all: text runs are already in unrotated user
  space, which is the space `/QuadPoints` is written in.
- **Solid colours only, and the rule is enforced twice.** The app never writes `/CA` for its own
  annotations (the model's `opacity` stays null), and a DOM walk in the e2e suite asserts no
  overlay element carries alpha below 1. Highlight still reads because its appearance stream uses
  the `Multiply` blend mode — opaque paint that darkens the paper and leaves the ink, the same
  trick M13's selection rectangles use.
- **Annotation colours are content, not chrome.** A theme token colours the interface; a
  highlight colour is written into the file and must survive a theme change, so the presets are
  `0xRRGGBB` values in `resources/annotations/colours.json` and the swatch buttons carry them as
  inline styles behind `ynot-allow-color`. The named presets are chosen so no two of them differ
  only in red↔green, and each carries its name as text, not colour alone.
- **`/DA` and `/DS` are built and parsed by one pure module.** `freetext.ts` owns the whole
  round trip — font, size, colour, alignment, line spacing, border and fill — so the properties
  panel, the inline editor and the appearance generator cannot disagree about what a free-text
  annotation says.
- **Free text is edited in a contenteditable overlay positioned by the same transform the layer
  uses**, with M13's font metrics for the wrap, so what is typed is where it lands. Committing
  writes `/Contents`, `/DA`, `/DS` and the appearance stream in one command.
- **A callout is a FreeText with `/IT /FreeTextCallout` and `/CL`**, exactly as the PDF spec has
  it: three points (tip, knee, shoulder) plus `/RD` marking the text box inside `/Rect`. The
  leader line and its arrow head are part of the appearance stream, not a second annotation.
- **Fonts: the base 14 are offered first; the system list is real but never embedded.** There is
  no font subsetter in this repo before M51, so a system family is written to `/DA` and into a
  non-embedded font dictionary, laid out with the metrics of the standard face it maps to. Both
  PDFium and Chrome are PDFium, and both substitute through the same bundled Liberation/DejaVu
  faces, so the two agree — the properties panel says in words that another editor may not.
- **The dictionary entries PDFium cannot write go through the plan.** `FPDFAnnot_SetStringValue`
  covers `/Name`, `/DA`, `/DS`, `/RC` and `/IT`; `/CL`, `/Q`, `/Rotate` and `/RD` are numbers and
  arrays PDFium's annotation API has no setter for, so `PlannedAnnotationProperties.entries`
  carries them to M21's writer (ADR 0013). One pure mapper, `engine/appearance/dict.ts`, is the
  only place that knows which model key is which PDF key.
- **Copy/paste is JSON on the system clipboard**, under a `text/plain` payload beginning with a
  marker line, so a paste into another window of the app rebuilds the annotations and a paste
  into a text editor at least says what it was. Pasting places the annotations on the current
  page, offset when the source page is the target page.
- **Identity is asked for once, in an opaque dialog, on the first annotation** — name, initials
  and email, stored under `identity.*`. Every annotation carries `/T`, `/CreationDate` and `/M`
  from it; `/Subj` defaults to the tool's own name, as Foxit does.
- **Reply and status are model data only.** `/IRT`, `/State` and `/StateModel` are read, written
  and preserved, and `AnnotationService.replies(id)` returns the thread — M32 builds the panel on
  top without changing anything here.

## Build log (fill in at merge)

**Built 2026-09-08 on `mod/M30-markup-annotations` (worktree `../ynotPDF-M30`).**

### What shipped

- **`src/renderer/view/AnnotationLayer.ts`** — the SVG overlay M00 reserved: paths and text in
  page space, selection outlines, eight box handles plus a callout's tip and knee, hit testing
  through an annotation's quads rather than its rect, a marquee, and a per-page signature so an
  unchanged page is not rebuilt. In `view/` on purpose — M31's shapes and ink, M33's measurements
  and M82's signatures all need the same thing.
- **Text markup** — Highlight, Underline, Squiggly, Strikeout, Replace Text and Insert Text, from
  M13's text selection. One annotation per page the selection touches, `/QuadPoints` built in each
  line's own axes, and colour presets that are named as well as coloured.
- **Notes** — a 14-icon catalogue drawn as vector paths, a 20 × 20 rect where the page was clicked,
  and an opaque popup with bold/italic/underline/colour stored as `/RC` beside plain `/Contents`.
- **Free text** — typewriter, text box and callout, told apart by `/IT`; `/DA` and `/DS` built and
  parsed by one module; alignment, line spacing, border width and style, fill, and `/Rotate` in
  the four right angles; a `contenteditable` overlay for typing in place that grows the box as the
  words outgrow it and removes one nothing was typed into.
- **Selection and geometry** — click, Shift-click, a marquee under the Select Annotation tool,
  Select All on the page; drag to move, handles to resize, a callout's tip and knee to drag;
  arrow-key nudge (Shift × 10); Delete; copy, cut and paste, between two documents.
- **The properties panel** — the right pane, bound to the selection, writing straight through so
  the page updates as a control moves; "Set as default" per tool; "Keep tool selected".
- **Identity** — name, initials and email, asked once in an opaque dialog before the first
  annotation, and declinable. Every annotation carries `/T`, `/CreationDate`, `/M` and `/Subj`.
- **Replies and status as data** — `/IRT`, `/State` and `/StateModel` read, written and preserved,
  with `replies(id)` and `setState(id, …)` for M32 to build a panel on.
- **`src/engine/appearance/`** — `markup.ts` (quad-aware highlight, underline, strikeout, squiggly
  and the caret), `freetext.ts` (`/DA`, `/DS`, layout, alignment, rotation, the callout's leader
  and arrow head), `note.ts` (the icon catalogue), `dict.ts` (model key ↔ PDF key).
- **`src/main/fonts.ts`** — the system font list, read from the OS font directories by parsing each
  file's sfnt `name` table. No new libraries.

### The four things that were not as expected

- **PDFium creates ten annotation subtypes and refuses the rest.** `FPDFPage_CreateAnnot` accepts
  Circle, Highlight, Ink, Popup, Square, Squiggly, Stamp, StrikeOut, Text and Underline. FreeText
  and Caret — the typewriter, the text box, the callout and both proof-reading marks — are refused
  outright, and so are Line, Polygon and PolyLine, which M31 will want. The adapter now reports
  that as `not-implemented` rather than an internal error, and M21's write plan gained an `insert`
  flag so the writer adds such an annotation to the file itself (ADR 0013). M31 inherits the path.
- **`FPDFAnnot_SetColor` refuses while an annotation has an `/AP`** — and PDFium builds one itself
  for most markup subtypes as a page loads. So _every_ recolouring of a highlight was silently
  dropped: the model changed and the file did not. Two fixes: `writeAnnotation` drops the
  appearance stream first rather than last, and a changed annotation is now planned in **full**
  rather than only for the values that went away.
- **PDFium's `Text` appearance is one fixed yellow square**, whatever `/Name` says, and it rewrites
  `/Rect` to 20 × 20 on the way past. `PdfEngine.setAnnotationAppearance` (new, ADR 0013) hands it
  our own stream instead, which works because a note icon needs no font resource. It is also why a
  note offers no resize handle: PDFium would undo the resize on the next page load.
- **`/Name` came back as a string, not a name.** `FPDFAnnot_SetStringValue` is PDFium's only
  generic setter, so `/Name`, and the number and array entries `/CL`, `/Q`, `/Rotate` and `/RD`,
  now go through the write plan as typed values.

### Bugs the tests found, all real

- **A second highlight over the first one was impossible.** The annotation controller took every
  press that landed on an annotation, so with the Select Text tool active the drag never started.
  It now stands aside for Select Text, Snapshot and Marquee Zoom — which is what Foxit does, and
  the e2e that marks the same words four times is what caught it.
- **A settings write made in the same tick as the first settings _read_ was undone by it.** The
  service loads its settings without blocking the app, which is right; a command that ran before
  that finished had its value quietly replaced by the stored one. Every write now waits for the
  first read.
- **`Mod+Alt+N` and `Mod+Alt+T` were already taken** by Night Mode and the theme switcher, and the
  Registry's rule is last-binding-wins — so binding them here would have stolen two keys the
  operator uses daily. The comment tools use `Mod+Alt+M` and `Mod+Alt+W`, and a unit test now
  checks the whole app's bindings for a clash.
- **A quad over text at 30° was half again too large.** The engine reports each character as an
  axis-aligned box, which for rotated text contains the glyph rather than being it. The two are
  related exactly, so the glyph box is recovered by solving the pair — and at 45°, where the system
  is singular, the box is used and the test says so.
- **The properties panel never appeared.** M02 shows the first right-dock panel by order whose
  `when` passes, and the e2e demo module has a document-wide panel at order 2 that is always true.
  A panel bound to the **selection** has to outrank one bound to the document, so this one is
  order 0 — which M72's document properties will meet the same way.
- **An empty typewriter draws nothing at all**, because it is words on the page and nothing else.
  That is correct, and it is why the inline editor removes a box nothing was typed into; the
  acceptance test states it rather than papering over it.
- **The font list froze the main process for half a minute.** It read every font file whole to
  find a name that lives in a few hundred bytes, and timed out at thirty seconds on a Windows CI
  runner — which in the app is a window that does not repaint. It now reads the table directory and
  then just the `name` table, through a file descriptor, with a wall-clock budget behind it. The
  same walk takes about 80 ms, and the test times it rather than only checking its answer.
- **`navigator.clipboard` reports success and reaches nothing.** Copy and paste went through the
  renderer's async clipboard API; in Electron a write from a command resolves and lands nowhere,
  and `readText()` resolves to an empty string because `clipboard-read` is a permission the app
  never granted itself. They go through main now — the same two channels M13 uses — and a copy the
  OS refuses returns 0 and says so, rather than reporting the count and leaving the reader to find
  out at the paste.
- **Two screenshots of one file are alike without being identical.** The Chrome acceptance compared
  PNG bytes, and a macOS runner disagreed: a toolbar fades, a focus ring blinks, a scrollbar settles
  a frame late. The pixels are counted now, in a Chromium — a channel has to move by more than
  8/255 to count — with a tolerance far below the difference an annotation makes.
- **A page can be pushed under the chrome.** Choosing the Comment tab makes the ribbon taller and
  selecting an annotation opens the right pane, and either can move the part of a page a test was
  clicking at behind them. The e2e clicks pages through their own coordinates now, which is also
  how a reader reaches them.

### Shared files touched (PLAN.md §12.3, all additive except where noted)

- `src/engine/PdfEngine.ts` — `setAnnotationAppearance` (ADR 0013).
- `src/engine/pdfium/{PdfiumEngine,mutations,rawdoc}.ts` — implements it; writes the string-valued
  `extra` keys; exposes `extra.hasAP`, `/DA`, `/IT`, `/DS`, `/LE`, and reads `/CL`, `/RD`, `/Q` and
  `/Rotate` through the raw-catalogue pass PDFium has no getter for. **One behaviour change:**
  `writeAnnotation` drops the appearance stream first, not last.
- `src/engine/Writer.ts`, `src/engine/writers/FullRewriteWriter.ts` — `PlannedAnnotation.insert`,
  `PlannedAnnotationProperties.{flags,created,modified,entries}`, non-embedded fonts in an
  appearance stream's resources.
- `src/engine/appearance/{types,content,index,generators}.ts` — the font union, `textLinesAt`, and
  the newer generators registered in place of the plainer ones M21 shipped. `generators.ts` keeps
  the shapes and the file-attachment pin; its text-markup, free-text and caret generators moved.
- `src/renderer/modules/M21-save/plan.ts` — **one behaviour change:** a changed annotation is
  planned in full (see above), and one with no engine binding is planned as an insert.
- `src/shared/ipc.ts`, `src/main/ipc.ts` — `fonts:list`.
- `src/renderer/main.ts`, `src/renderer/index.html` — registers the M30 manifest and its CSS.
- `vitest.config.ts` — coverage include, exclude and gates for the new files.
- `docs/shortcuts.md`, `resources/README.md`, `src/renderer/view/README.md`, `PLAN.md` §0.
- `test/unit/core/fakeEngine.ts` — the new engine method; `test/unit/save/plan.test.ts` — the
  full-properties rule, with the reason written beside it.

### Tests

Green on Windows locally: lint (eslint, prettier, the colour/opacity rules, `tsc` on both
projects), **2 198 unit tests** with the coverage gates, and **210 Playwright tests**.

Unit: 9 files, 156 tests in `test/unit/annotations/` — the quads (including the acceptance line
about a rotated page), the appearance streams and the style strings, what the overlay draws and
lets you grab, the settings and the clipboard, the manifest and the shortcut document, the sfnt
reader, and a **full save-and-reopen round trip** through the real engine, M21's planner and
`FullRewriteWriter`.

E2E: `test/e2e/annotations.spec.ts`, 23 tests, one per acceptance line, in the built app.

**The hands-on check the conventions ask for, recorded.** `test/unit/annotations/real-files.test.ts`
runs the module against the operator's own files in `test/fixtures/local/` — three boarding passes
from three different producers (our own pdf-lib writer, an unknown one, and Edge's Skia
print-to-PDF, which is tagged) and the Foxit portfolio — and skips itself on any machine without
them, as CLAUDE.md requires. For each: a highlight over the page's *own* first line of text, so the
quads come from whatever `textRuns` really reports for that producer and are asserted to land
inside the crop box; a note with a Key icon; and a typewriter, which is the one PDFium refuses to
create and the writer has to insert. All four files round-trip with the annotations intact and an
appearance stream on each. Nothing about their contents is read, quoted or asserted.

### Deferred, and why

- **A cross-renderer pixel hash.** "PDFium == our overlay-free render == Chrome" is checked as the
  two claims that can be made honestly without cropping Chrome's plugin surface: after a reopen the
  overlay draws _nothing_, so our render **is** PDFium's; and Chrome's own viewer on the same file,
  at the same size, differs from the file without our annotations and is identical to itself.
  Chrome's PDF viewer draws into a plugin whose bounds are not addressable from the page, so a
  dHash of the two renderers' pixels would have compared a page against a page-plus-toolbar.
- **Embedding a system font.** There is no subsetter here before M51 brings fontkit. A family
  outside the base 14 is named in `/DA` and in a non-embedded font dictionary, laid out with the
  metrics of the standard face it maps to; the panel says so in words.
- **Rich text is bold/italic/underline/colour**, stored as `/RC`. Lists, indents and mixed sizes
  are not offered — the popup is a note, not a word processor.
- **The comments panel, replies UI, FDF/XFDF and "summarise" are M32's**, explicitly out of scope.
  The data they need — `/IRT`, `/State`, `/StateModel` — is written and read here.
- **Shapes, ink, the eraser, stamps and file attachments are M31's.** `AnnotationLayer`,
  `PlannedAnnotation.insert` and the appearance registry are all in place for them.
- **One pre-existing shortcut clash is recorded, not fixed:** `Mod+G` is bound by M11 to
  `view.page.goTo` and by M13 to `edit.findNext`, and last-binding-wins makes it Find Next — which
  is what Foxit does with the key, so the behaviour is right and the M11 binding is redundant.
  `test/unit/annotations/manifest.test.ts` pins it so the next change to either module does not
  think it introduced it; M130's shortcut editor is where it belongs.
