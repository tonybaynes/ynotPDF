# M50 — Page-object model — select, move, resize, align, arrange

| | |
|---|---|
| **Module id** | `M50` — folder `src/renderer/modules/M50-object-model/`, branch `mod/M50-object-model` |
| **Earliest wave** | 5 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M21, M11 |
| **Unlocks** | [M51 Text editing with reflow (spike first)](./M51-text-editing.md), [M52 Image & path object editing](./M52-image-path-editing.md), [M53 Header/footer, Bates numbering, watermark, background & links](./M53-headers-bates-watermarks-links.md), [M71 Redaction & sanitise (remove hidden information)](./M71-redaction.md) |

## Your task — the prompt for this conversation

You are building **M50 — Page-object model — select, move, resize, align, arrange** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M21 Save, Save As, autosave & recovery](./M21-save.md), [M11 Viewer — rendering, navigation, zoom, layouts](./M11-viewer.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M50-object-model` from `main` in a new git worktree and
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

Expose page content (text blocks, images, paths, form XObjects) as
selectable, transformable objects with an object-edit overlay, alignment/
distribution/z-order tools and a properties panel — the base every Edit-tab
feature stands on.

## Foxit 14 reference — what to emulate

Foxit Edit tab: Edit Object (All/Text/Image/Shape/Shading), select, move,
resize with handles, rotate, flip, align (left/centre/right/top/middle/
bottom, to page), distribute, arrange (bring to front/back, forward/
backward), group/ungroup, delete, cut/copy/paste objects (incl. across
documents), object properties (position/size, stroke/fill, opacity ✗).

## Scope — build all of this

- `PageObjects` model per page loaded lazily from the engine: id, kind,
  bbox, matrix, z-index, kind-specific props (text: runs/font/size/colour;
  image: dimensions/colourspace/mask; path: segments/stroke/fill; xobject).
  Text objects are grouped into **blocks** (paragraph heuristic shared with
  M13/M51) for selection.
- Object-edit overlay layer: hit-test (bbox then precise for paths),
  hover outline, selection handles, marquee select, filter by kind, move
  (drag/arrow keys), resize (proportional with Shift), rotate handle, flip
  H/V, snap to grid/guides/other objects (smart guides, opaque lines).
- Commands: transform (matrix), delete, cut/copy/paste (serialise object
  with resources; paste into another document embeds resources), duplicate,
  align/distribute (to selection or page), z-order (rewrite content-stream
  order), group/ungroup (model-level grouping persisted in `custom`).
- Engine mutation additions: `setObjectMatrix`, `removeObject`,
  `insertObject`, `reorderObjects`, `objectAsPdf` (for copy) implemented via
  PDFium page-object API where possible; content-stream rewriting fallback
  in the writer.
- Properties panel: numeric position/size/rotation, stroke/fill colours,
  line width/dash for paths, image info; live apply.

## Out of scope

Editing the *content* of text (M51) or images/paths (M52).

## Design notes & constraints

- Content streams with nested `q/Q`, form XObjects and clipping must
  transform correctly — build the `ContentStream` parser/serialiser in
  `src/engine/content/` with unit tests; it is shared with M51/M52/M71.
- Never lose unknown operators; round-trip a parsed stream byte-for-byte
  when nothing changed.

## Files you will create or touch

`src/renderer/modules/M50-object-model/**`,
`src/renderer/view/ObjectLayer.ts`, `src/engine/content/**`, additive
engine object mutations, tests.

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

- Content-stream parser round-trips every fixture page byte-identical
  when unchanged.
- Move an image 10 pt; save; reopen ⇒ bbox moved 10 pt; render diff only in
  that region.
- Z-order change of two overlapping rects ⇒ render shows the expected one
  on top.
- Copy a path object to another document ⇒ renders identically there.
- Align/distribute six objects ⇒ positions match computed expectations.

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

Provenance key: **spec** = ISO 32000-1, **Foxit** = observed in the running app or its
public help, **ours** = our own choice.

1. **Two paths to the file, one per page (ADR 0018).** PDFium's page-object API drives
   the *live view*, and every mutation regenerates the page's content so the edit
   survives the page reloads M20's annotation methods do. Because that regeneration
   renames every resource and drops every operator PDFium does not model, the first
   edit on a page captures its **original content stream and `/Resources`**
   (`PdfEngine.pageContent`) into `Document.custom('M50')`, and the writer puts both
   back and replays the edits onto the original operators with our own parser.
   Unknown operators therefore survive a move, a resize, a rotate, a flip, a restyle,
   a paste and a delete. Z-order is the exception: it needs each moved object's whole
   graphics state re-established, so a page whose order is still rewritten keeps
   PDFium's stream and the writer plans nothing for it; undo the reorder and the page
   is back on the preserving path. One page never takes both paths. *(ours; forced by
   the "never lose unknown operators" constraint in this brief. That PDFium renames
   resources was found by the acceptance test, not the documentation.)*
2. **`src/engine/content/` is byte-preserving by construction.** Op spans tile the
   source with no gaps, so an untouched op is copied rather than reformatted and a
   stream nothing changed round-trips byte-identical. Only edited or inserted ops are
   ever formatted. *(ours.)*
3. **A transform is conjugated into the object's own frame.** To move an object by `D`
   in page space when it sits under a CTM `C`, we wrap its span in
   `q  C⁻¹·D·C cm  …  Q`. That is what makes a nested `q/Q`, a rotated form XObject and
   a scaled image all move by the same 10 pt on the paper. *(spec, 8.4.4.)*
4. **A clip set outside the object does not move with it.** Wrapping only the object's
   own operators leaves an enclosing clip where it was, which is the spec's semantic
   and what PDFium and Foxit both do. *(spec + Foxit.)*
5. **Object identity is `page index + content index`, re-bound on every reload.** The
   engine's object list is positional, so the module keeps a `PageObjects` snapshot per
   page and re-reads it after any change; selections are held as content indexes and
   validated against the snapshot before use. Groups, which have no PDF representation,
   are stored in `Document.custom('M50')` and so are journalled, undoable and recovered.
   *(ours; `custom` is the sanctioned home per M20/ADR 0007.)*
6. **Text objects are selected as blocks.** The engine's text objects are one per
   show-text operator, which is far too fine to click on. `blocks.ts` groups them with
   M13's own paragraph heuristic (`buildPageText` → `paragraphs`, mapped back through
   `TextRun.objectIndex`), so the same grouping serves selection here, copy in M13 and
   reflow in M51. A block transform is the transform applied to every member object.
   *(ours; heuristic shared with M13.)*
7. **Copy carries its resources as a one-page PDF.** `objectAsPdf` imports the page
   into a scratch document and destroys every object but one, so fonts, images and
   colour spaces come with it. Pasting into another document embeds that PDF as a form
   XObject — in the live view through `FPDF_NewXObjectFromPage`, in the file through
   pdf-lib's `embedPdf`. Both produce the same thing, which is why the render matches
   before and after a save. *(ours; the alternative — copying resource dictionaries by
   hand — is what makes cross-document paste fragile in other editors.)*
8. **Resize means scale about the opposite handle; rotation is a matrix, not a
   property.** Every geometric change is one `PdfMatrix` premultiplied onto the object,
   so move, resize, rotate and flip are the same command with different maths and merge
   into a single undo entry during a drag. *(ours; Foxit exposes the same four as
   separate gestures on one selection.)*
9. **Snapping is opaque lines, never colour alone.** Smart guides draw as solid
   `--accent` lines with a 2 px core; the status bar names what was snapped to
   ("Left edges", "Page centre") in words. Grid, guides and object snapping are three
   independent toggles, each a command. *(operator accessibility rules in CLAUDE.md.)*
10. **Align and distribute have two references: the selection, or the page.** With two
    or more objects selected, "align left" moves them to the selection's left edge;
    with the page reference chosen it uses the CropBox. Distribute needs three and
    spaces centres evenly. *(Foxit, Edit ▸ Arrange.)*
11. **Opacity is not editable.** The brief marks it ✗ and CLAUDE.md forbids
    translucent chrome; the panel *reports* a fill/stroke alpha the file carries but
    offers no control. *(operator rule.)*
12. **Everything is a command.** `object.*` ids, all in the palette, with the shortcuts
    Foxit uses where they do not collide: arrows nudge (Shift ×10), `Mod+Shift+O`
    picks up the tool, `Mod+Shift+G`/`Mod+Shift+U` group and ungroup, `Mod+[`/`Mod+]`
    send backward/bring forward and `Mod+Shift+[`/`Mod+Shift+]` to back/front,
    `Mod+D` duplicate, Delete deletes. `Mod+G` was already Find Next. Conflicts are
    checked by `test/unit/shortcut-conflicts.test.ts`. *(ours + Foxit.)*
13. **Text objects are never restyled here.** The panel offers stroke, fill, width and
    dash for paths only — the content applier can wrap a path in its own `q … Q`, but a
    colour operator inside `BT … ET` would leak into the show operators after it, and
    text colour belongs to M51's text editing anyway. *(ours; spec 8.4.)*

## Build log (fill in at merge)

_Not started._
