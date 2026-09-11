# M53 — Header/footer, Bates numbering, watermark, background & links

| | |
|---|---|
| **Module id** | `M53` — folder `src/renderer/modules/M53-headers-bates-watermarks-links/`, branch `mod/M53-headers-bates-watermarks-links` |
| **Earliest wave** | 6 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M50, M21 |
| **Unlocks** | [M120 Batch processing & action wizard](./M120-batch-actions.md) |

## Your task — the prompt for this conversation

You are building **M53 — Header/footer, Bates numbering, watermark, background & links** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M50 Page-object model — select, move, resize, align, arrange](./M50-object-model.md), [M21 Save, Save As, autosave & recovery](./M21-save.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M53-headers-bates-watermarks-links` from `main` in a new git worktree and
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

Page-decoration features with live preview and presets: headers/footers
with macros, Bates numbering, text/image watermarks, backgrounds, and the
link tool (manual and auto-detect URLs).

## Foxit 14 reference — what to emulate

Foxit Edit / Organize: Header & Footer (add/update/remove, six zones, font,
margins, page-number and date macros, range, shrink page to avoid overlap,
presets), Bates Numbering (add/remove, prefix/suffix, digits, start,
across multiple files), Watermark (text or file, rotation, opacity ✗ →
solid colours only for our own; keep existing), position, scale relative
to page, appear behind/in front, range, presets), Background (colour or
file, same options), Link tool (draw rect, visible/invisible, style, action:
go to page/URL/file/open; auto-create links from URLs), Edit/Delete links.

## Scope — build all of this

- Shared "page decoration" dialog framework: opaque dialog with preview
  pane rendered through the engine, page range, presets stored in
  `resources/presets/*.json` + user presets in settings.
- Header/footer: 6 zones, font/size/colour, margins/units, macros
  (`<<1>>`, `<<1 of n>>`, date formats, filename, Bates), underline, shrink
  page option; add/update/remove as Commands writing tagged Form XObjects
  (mark with a `/YNOT` marker so "update/remove" finds them, Foxit does the
  same with its own marker).
- Bates: prefix/suffix/digits/start, across documents in one run (batch-
  aware), remove.
- Watermark/background: text or PDF/image file, rotation, scale, position
  grid, behind/in front, range, also appears when printing option,
  remove; existing (foreign) watermarks detected by marker where possible.
- Link tool: draw rectangle, border style/colour/visibility, action editor
  shared with M12 destinations/M61 actions; auto-detect URLs/emails in text
  (regex over `textRuns`) → links with review dialog; edit/delete/list
  links; link layer rendering (dashed outline when editing).

## Out of scope

Articles (Parked).

## Design notes & constraints

- Decorations are XObjects added to each page's content with a marker so
  later edits are exact and undoable; never bake into existing streams.
- Preview uses the real writer on a copy of one page (fast path).

## Files you will create or touch

`src/renderer/modules/M53-headers-bates-watermarks-links/**`,
`src/engine/decorations/**`, `resources/presets/**`, tests.

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

None new.

## Acceptance tests — the module is done when these pass on all three OSes

- Header with `<<1 of n>>` on 100 pages ⇒ each page's extracted text ends
  with "k of 100"; remove ⇒ text gone, render equals original.
- Bates 000123… sequential and searchable.
- Watermark behind content: render diff shows watermark under text.
- Auto-detect links finds every URL in the fixture; clicking opens via
  IPC with a confirmation for external URLs.

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

Provenance key: **spec** = ISO 32000-1, **Foxit** = observed as a user or from public
help, **ours** = our own choice.

1. **One marker, and it is a PDFium content mark (ADR 0020).** Every decoration is a
   form XObject invoked inside `/YNOTDec <</Id … /Kind … /Spec …>> BDC … EMC`. That tag
   is the only marker that survives all four paths a decoration takes: PDFium's live
   object list, `FPDFPage_GenerateContent`, a save, and our own content parser. A key
   on the XObject's dictionary does not — PDFium rebuilds the XObject — and a
   `/PieceInfo` on the page cannot say *which* object. `Spec` carries the settings as
   JSON, so "Update header" opens on what the last person chose even in a file this
   application has never seen before. *(ours; Foxit marks its own decorations too, by
   some means of its own we have not looked at and must not.)*
2. **The writer restores the page and appends a stream; it never edits one.**
   `/Contents` is an array, so a decoration is a new element beside the originals — the
   page's own bytes are untouched. Before appending, the applier restores the original
   stream captured before the first decoration (undoing PDFium's regeneration) and
   strips every `/YNOTDec` span it finds, whoever wrote it. That strip is what makes
   the order of M50's edits and M53's decorations on one page irrelevant. *(ours;
   forced by the brief's "never bake into existing streams".)*
3. **The live view goes through PDFium, so a watermark can be behind the text.**
   `insertObject` at index 0 puts a decoration under the page's content and at the end
   puts it over — which an overlay layer could never do, and the acceptance test asks
   for exactly that. It also means the header's text is in `textRuns` the moment it is
   added, not only after a save. *(ours; verified against our PDFium build before the
   design was fixed.)*
4. **A decoration is described once and drawn once.** `DecorationDraw` — content-stream
   text, bbox, matrix, resources, behind/in front — is produced by pure functions in
   `src/engine/decorations/draw.ts` and consumed by both the live engine and the
   writer. There is one piece of drawing code, so the preview, the page and the saved
   file cannot disagree. *(ours.)*
5. **The model holds specs, not geometry.** `Document.custom('M53')` holds the
   decoration *settings* plus the page range; the per-page drawing is derived. Undo is
   therefore "put the previous settings back and re-apply", which is exact, cheap to
   journal and replays in a batch run. *(ours; M20/ADR 0007 sanctions `custom` for
   this.)*
6. **Six zones, three positions each side, and the macro set is data.** Header and
   footer each have left, centre and right; the macros are `<<1>>`, `<<1 of n>>`,
   `<<Bates>>`, `<<FileName>>`, `<<FullPath>>`, `<<Title>>`, `<<Author>>`,
   `<<Subject>>`, `<<Date>>`, `<<Time>>` and `<<d:…>>` for an explicit date pattern.
   Where the numbering starts is a field of the spec, not a spelling of the macro, so
   the dialog can show it. The catalogue lives in `resources/presets/macros.json` so it
   can grow without a release; a token the data names and the code has no expander for
   is left on the page as written rather than guessed at.
   *(Foxit's own header/footer offers page-number and date macros and six zones; the
   spelling and the escape rules are ours.)*
7. **Bates numbering is a decoration like any other**, with prefix, suffix, digit count
   and start, and it is the one whose number keeps counting across documents in a batch
   run: the spec carries `startAt` and the runner passes the next value on. Its text is
   real text in the page content, so a search finds `000123`. *(Foxit; spec for the
   text.)*
8. **No transparency anywhere, including on the page.** The brief marks watermark
   opacity ✗ and CLAUDE.md forbids translucent chrome. A watermark we create is a
   solid colour the reader picks; a watermark the file already carries keeps whatever
   alpha it has, because that is the document rather than the interface. *(Tony's
   rule.)*
8a. **"Appears when printing" is an optional-content group, because that is the only
    thing that means it.** A decoration whose screen and print states differ is drawn
    inside an OCG whose `/Usage` says so, listed in `/OCProperties /D /AS` so a viewer
    applies it automatically and in `/OFF` so one that ignores `/AS` still starts with
    it hidden. Nothing else in the format expresses "print but do not show".
    *(spec 8.11.)*
8b. **A link's action is stored as JSON on the annotation, under a private key.**
    PDFium creates a Link annotation but has no `/A` setter, so an action held only in
    the model is gone the next time the page is read — which every viewer does. The
    JSON goes in a string key PDFium *can* write (`/YNOTLinkAction`), so it survives
    the round trip and makes a link editable in a file reopened later, exactly as the
    decoration marker does. M21's plan turns it into the real `/A` and `/Dest`.
    *(ours; found by the journey, not by the documentation.)*
9. **Preview is the real thing, one page at a time.** The dialog renders the current
   page through the engine on a scratch copy with the decoration applied, so what the
   preview shows is what the page will be — not a CSS approximation of it. It is
   debounced and cancelled on every keystroke. *(brief's own constraint.)*
10. **Presets ship as data and the reader's own live in settings.** Built-in presets are
    `resources/presets/*.json`; saved ones are JSON in one hidden setting per family, as
    M100 does for optimise presets. *(PLAN.md §4.4.)*
11. **A link is an annotation the writer inserts.** PDFium refuses to create a Link, so
    links take M30's path (ADR 0013): the model holds it, the writer writes it.
    `PlannedAnnotation.dest` is new because a destination is a reference to a page and
    nothing in the plan could express one (ADR 0020 §5). *(spec 12.5.6.5; PDFium's
    `IsValidAnnotSubtype`.)*
12. **External links are confirmed before they open, and only `http(s)` opens at all.**
    A click on a link inside a document is the document asking to run something; the
    reader is shown the whole URL in an opaque dialog and says yes. `file:`,
    `javascript:` and everything else is refused in words, as M12 already refuses them
    for bookmarks. A "don't ask again for this session" tick is offered, not defaulted.
    *(ours; security.)*
13. **Auto-detect reads `textRuns`, and every candidate is reviewed before it is made.**
    URLs, bare `www.`, and e-mail addresses are matched over the reconstructed text of
    each run, mapped back to character boxes for the rectangle. The review dialog lists
    every hit with its page and text and lets each be unticked. Nothing is written
    until the reader presses Create. *(Foxit offers the same as one action; the review
    step is ours — an unattended pass that turns a version number into a link is worse
    than no pass.)*
14. **Everything is a command.** `decorate.*` and `link.*` ids, all in the palette;
    `Mod+Shift+H` header & footer, `Mod+Shift+W` watermark, `Mod+Shift+B` Bates,
    `Mod+Shift+K` the link tool — checked against
    `test/unit/shortcut-conflicts.test.ts`. *(ours + Foxit where free.)*
15. **The link layer is its own overlay layer.** `annot`, `object` and `widget` each
    call `replaceChildren()` on the layer they own, so links cannot share one. `link`
    sits between `annot` and `widget`, takes pointer events only on the link boxes, and
    is raised above the tool layer for the same reason M60's widget layer is. *(M00's
    layer stack; ADR 0020 §6.)*

## Build log (fill in at merge)

**Shipped (2026-09-11, branch `mod/M53-headers-bates-watermarks-links`, ADR 0020).**

- `src/engine/decorations/` — the pure half: the spec and draw types, the macro expander (its
  catalogue is `resources/presets/macros.json`) with its own date formatter so two machines say
  the same words, display-space geometry (`/Rotate` applied, so a header is at the top of the
  page a person sees), the drawing for all four families, WinAnsi encoding with a report of what
  it could not write, and the address detector.
- Engine (`src/engine/pdfium/decorations.ts`, additive to `PdfEngine`): `setDecorations` replaces
  every marked decoration on a page in one call — add, update and remove are the same call with a
  different list — and `decorations` reads them back. The marker is a PDFium **content mark**
  (`/YNOTDec`), which survives the live object list, `FPDFPage_GenerateContent`, a save and a
  reopen, and carries the settings as JSON so a file this application made is editable next year.
  `behind` inserts at index 0, which is how a watermark gets under the text.
- Writer (`src/engine/writers/decorations.ts`): restores the page's original content, strips
  every `/YNOTDec` span whoever wrote it, and **appends** a new `/Contents` element — an existing
  stream is never edited. A guard stream closes whatever `q` the producer left open. The
  print/screen option is a real optional-content group with a `/Usage` and an `/AS` entry.
  `src/engine/writers/resources.ts` is `FullRewriteWriter`'s form-XObject and `/Resources`
  building, extracted so the writer and the live engine build the same object.
- Renderer module: one `SetDecorationsCommand` for every change, so undo is the same path with
  the previous list; the shared decoration dialog with a preview that is the real engine
  rendering a real copy of the page; header/footer, Bates, watermark and background dialogs;
  presets (ours in `resources/presets/decorations.json`, the reader's in one setting); the link
  tool, the link layer (`src/renderer/view/LinkLayer.ts`, a new entry in the layer stack), the
  link properties dialog, the auto-detect review dialog and the Links panel.
- Tests: 55 unit (pure functions, the model, the command, the plan, PDFium and the writer
  end to end, plus an opt-in pass over Tony's own files) and 5 Playwright journeys that
  press the ribbon button, type in the dialog and click the page.

**Found on the way.**

- **PDFium creates a `Link` annotation but has no `/A` setter.** An action written only into the
  model was gone the next time a page was read — which every viewer does. The action is now JSON
  in `/YNOTLinkAction`, a key `FPDFAnnot_SetStringValue` *can* write; M21's plan turns it into the
  real `/A` and `/Dest`. Found by the journey, not by the documentation.
- **`Document.loadAnnotations` replaces the model's list with the engine's**, so calling it
  behind the reader's back deletes any annotation PDFium cannot create — a measurement, a caret,
  a polygon. The link service reads the model's own list for a page that has one and loads only a
  page nobody has looked at yet. Five of M33's journeys found this.
- Four large ribbon buttons made the Organize tab collapse a group on a 1500 px window, which
  `shell.spec.ts` rightly calls a defect. One large button, three small.
- The Links panel truncated what a link does with an ellipsis; `expectNothingClipped` found it.
  It wraps now — "Opens https://exam…" answers nothing.

**Deferred, and why.**

- **Bates across several files in one run** is spec-ready but not wired: the settings carry
  `startAt`, the command takes its range as an argument, and `SetDecorationsCommand` replays from
  data — so M120's runner can hand each file the next number. There is no multi-file runner in
  this module, because batch *is* M120.
- **The link action editor is M53's own**, not shared with M61: field actions do not exist yet.
  The shapes are the same (`/A` dictionaries through `engine/appearance/dict.ts`), so M61 can
  take this dialog over rather than write a second one.
- **A foreign decoration is found by its `/Watermark` annotation only.** There is no standard
  marker for one, so that is the only thing that can be said honestly; it is reported, counted
  and removable, never editable.
- **Text is the standard 14 fonts, WinAnsi.** A character outside it is written as `?` and named
  in the preview's status line. Embedding a chosen family needs M51's subsetter.
- **The preview renders one page at a time.** A "show me every page" preview is a second viewer;
  the page picker beside the preview is the honest version of it.
