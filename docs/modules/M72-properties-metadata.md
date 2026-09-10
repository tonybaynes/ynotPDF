# M72 — Document properties, metadata & XMP, initial view

| | |
|---|---|
| **Module id** | `M72` — folder `src/renderer/modules/M72-properties-metadata/`, branch `mod/M72-properties-metadata` |
| **Earliest wave** | 4 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M21 |
| **Unlocks** | — |

## Your task — the prompt for this conversation

You are building **M72 — Document properties, metadata & XMP, initial view** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M21 Save, Save As, autosave & recovery](./M21-save.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M72-properties-metadata` from `main` in a new git worktree and
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

The Document Properties dialog: description (Info dictionary + XMP in
sync), custom properties, security summary, fonts list, initial view
settings, advanced (PDF version, page size, fast web view, tagged).

## Foxit 14 reference — what to emulate

Foxit File → Properties: Description (title/subject/author/keywords/
created/modified/application/producer/version/size/pages/tagged/fast web
view), Custom, Security (summary + button to M70), Fonts (embedded/subset/
type), Initial View (navigation tab, page layout, magnification, open to
page, window options, UI options), Advanced (base URL, trapped, print
scaling, reading direction, language).

## Scope — build all of this

- Tabbed opaque dialog (Ctrl+D) with the sections above.
- Metadata Command: writes Info dict and regenerates/patches XMP
  (`dc:title`, `dc:creator`, `dc:description`, `pdf:Keywords`,
  `xmp:CreateDate`, `xmp:ModifyDate`, `pdf:Producer`, custom namespace
  for custom props) keeping other XMP packets intact.
- Fonts tab from engine (`fonts()` additive engine method: name, type,
  embedded, subset, encoding).
- Initial view: `/PageMode`, `/PageLayout`, `/OpenAction`, `/ViewerPreferences`
  (hide toolbar/menubar/window UI, fit window, centre, display doc title,
  print scaling, direction) — applied by M11 on open too.
- Language (`/Lang`), base URL, trapped.
- Read-only display of security and signatures with links to their
  modules.

## Out of scope

Editing security (M70). Full XMP editor (Parked — raw XMP view/edit is
enough).

## Design notes & constraints

- XMP handled with a small namespace-aware serialiser in
  `src/engine/xmp/`; unit tests against Acrobat-produced XMP.

## Files you will create or touch

`src/renderer/modules/M72-properties-metadata/**`, `src/engine/xmp/**`,
additive engine `fonts()`, tests.

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

fast-xml-parser.

## Acceptance tests — the module is done when these pass on all three OSes

- Set title/author/keywords/custom → save → reopen: Info and XMP agree;
  `pdfinfo`-style check via engine metadata.
- Initial view set to "Fit Page, Bookmarks panel, page 3" → reopen applies
  it.
- Fonts tab lists the embedded/subset status matching `pdffonts` for the
  fixture (expected list in fixture manifest).

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
  (2026-09-11). Older text across this repository still says "the operator";
  that is history and is not being rewritten, but new writing uses his name.
- Replies to Tony: short and plain (eyesight). Never leave him a to-do you
  could do yourself.

---

## Design decisions (fill in before coding; keep current)

- **The Info dictionary and XMP are one edit, never two.** Foxit, Acrobat and the XMP
  specification all treat them as two views of the same facts, and a file where they disagree is
  a file whose title depends on which reader opened it. So one command
  (`SetPropertiesCommand`) writes the model's metadata *and* re-derives the XMP packet from it,
  and the dialog has no way to set one without the other. The raw-XMP view on the Advanced tab is
  read-only for the same reason — a free-text XMP editor is the Parked half of this brief.
- **XMP is patched, never regenerated.** `src/engine/xmp/` parses the existing packet with
  fast-xml-parser (MIT) in `preserveOrder` mode, replaces only the properties we own, and writes
  the rest back byte-for-byte in its original order — so a PDF/A `pdfaid:part`, an
  `xmpMM:DocumentID`, an Illustrator packet or a rights-management block survives a title change.
  A file with no packet gets a minimal one containing only what we know.
- **Custom properties live in `pdfx:`** (`http://ns.adobe.com/pdfx/1.3/`), which is where the XMP
  specification puts Info-dictionary keys that have no standard XMP property, and where Acrobat,
  Foxit and Ghostscript-produced files all look for them. Inventing a `ynot:` namespace would
  make our custom properties invisible to every other tool. Provenance: XMP Specification Part 2
  and ISO 32000-1 §14.3.3; nothing was taken from a Foxit product.
- **The engine gains two reads and nothing else.** `fonts()` and `initialView()`, both additive,
  both implemented in the pdf-lib raw-document reader M10 already uses for layers and XMP —
  PDFium exposes neither. `Metadata` gains four optional fields (`custom`, `trapped`, `lang`,
  `baseUrl`). ADR 0017.
- **Fonts are read from the font dictionaries, not from PDFium.** A font's name, type, embedding
  and encoding are all in `/Font` resource dictionaries, and reading them is exact; PDFium's text
  API can only tell us about fonts that actually drew a glyph. Subsetting is the six-uppercase
  prefix ISO 32000-1 §9.6.4 defines, not a guess. Resources are walked page by page including
  nested form XObjects, and the same font object seen twice is one row.
- **Initial view is model state, not a module's private bag.** M20 already declared
  `ViewSettings` ("How the file asks to be opened") and left it at defaults because nothing read
  it. M72 fills it: the engine reads `/PageMode`, `/PageLayout`, `/OpenAction` and
  `/ViewerPreferences` on open, `Document` carries them, `SetInitialViewCommand` changes them,
  and M21's writer writes them back. That is one home for the setting rather than one per module.
- **M72 applies the initial view itself, from the model.** The brief says M11 applies it on open;
  doing that inside M11 would mean editing another module's folder, so M72 subscribes to
  `Documents.onAttached` — the signal M21 already uses — and applies the layout, the magnification
  and the opening page through M11's `ViewerService` when the viewer for a tab appears. A setting
  (`properties.applyInitialView`, on) turns it off for a reader who would rather keep their own
  view.
- **The one thing it does not apply is `/PageMode`, and that is the operator's own rule.** M12
  records it three times: the left pane opens on whatever `ui.leftPaneOnOpen` says, and
  "bookmarks-on-open never overrides it, even for documents whose `/PageMode` is `/UseOutlines`".
  This brief's acceptance test asks for the opposite ("Bookmarks panel" applied on open), and
  where two briefs disagree the operator's stated requirement wins. So the page mode is read,
  shown in the dialog, written back to the file exactly as set, and reported in words — "the
  document asks to open with the bookmarks panel; which panel opens is your own setting" — and
  the pane is left alone. The acceptance test checks the other two thirds (fit page, page 3) and
  that the panel request survived the save.
- **The window options are honoured as far as an app with tabs honestly can.** Hide toolbar, hide
  menu bar and hide window UI are stored, shown and written back exactly as the file asks, and
  applied to the ribbon and the panes; "fit window", "centre window" and "display document title"
  are stored and written but not obeyed, because a tabbed multi-document window cannot resize
  itself around one of its documents without throwing the others' layout away. The dialog says so
  in words rather than pretending.
- **Security and signatures are shown, not edited.** The Security tab mounts M70's own
  `securityPropertiesPanel` — the element that module already exports for exactly this — with a
  button that runs `protect.security`; the signature list is read from the model with a button
  that opens the Signatures panel. When M70 is not in the build the tab says what the file itself
  reports and nothing more.
- **The plan gains one section, and it is sparse like the rest.** `WritePlan.view` carries page
  mode, layout, open action, viewer preferences, `/Lang` and the base URL, and is non-null only
  when the document carries the new `view` write intent; `PlannedMetadata` gains `custom` and
  `trapped`. A document nobody has retitled still plans nothing at all. ADR 0017.
- **A properties edit normalises the two dates to UTC.** The writer's `isoToPdfDate` writes
  `D:…Z00'00'`, so a file whose `/CreationDate` said `+01:00` comes back saying `Z` — the same
  instant, one hour different on the clock face and not at all in what a reader is shown, because
  the dialog formats from the instant. Checked against the operator's own files, where it is the
  only difference a title change makes besides the title.
- **Dates are shown in the reader's locale and stored in UTC.** Created and modified are
  `Intl.DateTimeFormat` in en-GB by default (PLAN §9); what goes into `/CreationDate` and
  `xmp:CreateDate` is ISO 8601. Modified is set by the save, not by the dialog, so a reader who
  opens Properties and presses Cancel changes nothing.
- **Nothing in the dialog is colour-coded.** Every status is a word: "Embedded", "Embedded
  subset", "Not embedded"; "Yes"/"No" for tagged and fast web view; "Protected"/"Not protected".
  The tab strip is a real ARIA tablist with arrow-key movement, the tab panels are reachable by
  Tab, and the whole dialog is opaque like every other.

## Build log (fill in at merge)

**Built 2026-09-09 on `mod/M72-properties-metadata` (worktree `../ynotPDF-M72`).**

### What shipped

- **The Document Properties dialog** (`Ctrl+D`, the Properties slot in the File backstage — which
  nothing had filled — the View and Protect ribbons, and the document's right-click menu). Six
  tabs: Description, Custom, Security, Fonts, Initial View, Advanced. A real ARIA tablist with
  arrow-key movement, every status a word beside an icon, nothing transparent, no colour literal.
- **`src/engine/xmp/`** — a namespace-aware XMP reader and patcher. It resolves every tag through
  the `xmlns:` declarations in scope rather than trusting a prefix, replaces both the element and
  the compact attribute form of a property, and writes every other node back exactly as it was
  read. A PDF/A identification block, an `xmpMM` history, an Illustrator packet, a rights
  statement: all survive a title change, and patching the same packet twice produces the same
  bytes. Parsed with fast-xml-parser (MIT) in `preserveOrder` mode; serialised by hand, because
  that library's builder is deprecated in version 5 and re-indents what it writes.
- **The information dictionary and XMP as one edit.** `SetPropertiesCommand` applies the patch to
  the model and re-derives the packet from the result, so a file cannot be saved with the two
  disagreeing. Custom properties are mirrored into `pdfx:`, where the XMP specification puts
  information-dictionary entries and where Acrobat, Foxit and Ghostscript-produced files look
  for them.
- **`PdfEngine.fonts()`** — the fonts a document's page resources name, read from the `/Font`
  dictionaries (including nested form XObjects and Type 3 glyph resources), with type, embedding,
  the six-letter subset prefix, encoding and first page. Read from dictionaries rather than from
  drawn glyphs, so a font the file declares and never uses is still listed.
- **`PdfEngine.initialView()`** — `/PageMode`, `/PageLayout`, `/OpenAction` (resolved through a
  `/GoTo` action or a named destination) and the `/ViewerPreferences` a reader can see.
  `Metadata` gains custom entries, `/Trapped`, `/Lang` and the base URL. Both live in the pdf-lib
  raw reader M10 already uses for layers and XMP, because PDFium exposes none of them.
- **`ViewSettings` filled in at last.** M20 declared it — "how the file asks to be opened" — and
  left it at defaults because nothing read it. It now comes from the engine on open, changes
  through `SetInitialViewCommand`, and goes back to the file through the writer's new `view`
  plan section (`/PageMode`, `/PageLayout`, `/OpenAction`, `/ViewerPreferences`, `/Lang`,
  `/URI /Base`), which is nullable and sparse like every other section.
- **Applying it on open** — layout, magnification and opening page, through M11's viewer, hung
  off `Documents.onAttached`. Three settings govern it (`properties.applyInitialView`, on;
  `applyWindowOptions`, off; `applyDisplayDocTitle`, on), and what the application will not do is
  said in words rather than silently skipped.
- **Two fixtures**, both small and generated: `fonts.pdf` (standard-14, a missing TrueType, an
  embedded one, an embedded subset, a Type 0 over CIDFontType2 and a Type 3 — sharing one 1 KB
  TrueType font built table by table in `make-fixtures.ts`, so nothing depends on the fetched
  DejaVu faces) and `initial-view.pdf`.
- **The round-trip harness gains `initialView` and `fonts`**, so from now on every module's save
  is checked for keeping them, whether or not it has heard of M72.

### Decisions worth knowing about

- **`/PageMode` is stored, shown and written back — and never obeyed.** M12 carries the operator's
  requirement, stated three times, that `ui.leftPaneOnOpen` decides which navigation panel opens
  "even for documents whose `/PageMode` is `/UseOutlines`". This brief's acceptance test asks for
  the opposite. Where two briefs disagree the operator's stated requirement wins, so the file's
  request is read, written back exactly as set, and reported in words — "the document asks to open
  with the bookmarks panel; which panel opens is your own setting" — while the pane is left alone.
- **The XMP packet is patched, never regenerated**, and a superseded packet is now removed from
  the file rather than left behind as an unreferenced object. It used to be left: a rewrite
  registered a new stream and the old one still went out with the rest of the context, where any
  reader scanning bytes for `<?xpacket` — which is how XMP is meant to be findable — could find
  the stale one first. `rawdoc` now prefers the catalogue's `/Metadata` over its byte scan for the
  same reason.
- **Custom properties are a complete set, not a patch.** The model reads every custom entry the
  file has, so replacing the set wholesale is exact — except that the writer refuses to delete an
  entry whose value is not text, because the model never showed it and so cannot have been asked.
- **A properties edit normalises the two dates to UTC.** `+01:00` comes back as `Z`: the same
  instant, and the dialog formats from the instant, so nothing a reader sees changes. Checked
  against the operator's own files, where it is the only difference a title change makes besides
  the title itself.
- **The window options are honest about what they do.** Hide toolbar, hide menu bar and hide
  window UI are stored, written and applied when the reader allows it; fit window and centre
  window are stored and written but not obeyed, because a window with several tabs in it belongs
  to all of them. The dialog says so.

### Fixed on the way past

- **M70's stylesheet had never been linked** from `index.html`, so its Protect dialog and its
  security panel have been drawing unstyled since that module landed. M72 shows the same panel on
  its Security tab, which is how it came to light. One line.
- **CI's Linux job was dying at its third step** — on `main` as well as this branch — because the
  runner image carries Google's Chrome apt repository and that repository intermittently serves an
  index whose hash does not match its own Release file. Every source file mentioning
  `dl.google.com` is now removed before `apt-get update`, found by content because the image has
  used both the `.list` and the deb822 `.sources` form.

### Deferred, and why

- **Editing XMP by hand.** The raw packet is on the Advanced tab, read-only. A free-text editor is
  the Parked half of this brief, and an editable box beside fields that re-derive the packet would
  be two ways to set one thing.
- **Obeying "fit window" and "centre window".** See above: not a limitation, a decision.
- **A signature list of its own.** The Security tab says how many signatures a document carries
  and offers the Signatures panel when one exists; reading them properly is M81's.
