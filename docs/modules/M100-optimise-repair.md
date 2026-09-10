# M100 — Optimise (reduce size), linearise, repair, remove duplicates

| | |
|---|---|
| **Module id** | `M100` — folder `src/renderer/modules/M100-optimise-repair/`, branch `mod/M100-optimise-repair` |
| **Earliest wave** | 5 (see `PLAN.md` §0/§12) |
| **Tier** | Core |
| **Depends on** | M21 |
| **Unlocks** | [M94 PDF/A conversion & basic validation](./M94-pdfa.md), [M120 Batch processing & action wizard](./M120-batch-actions.md) |

## Your task — the prompt for this conversation

You are building **M100 — Optimise (reduce size), linearise, repair, remove duplicates** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M21 Save, Save As, autosave & recovery](./M21-save.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M100-optimise-repair` from `main` in a new git worktree and
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

File-size reduction with a preview of savings, linearisation for fast web
view, repair of damaged files, and de-duplication of resources.

## Foxit 14 reference — what to emulate

Foxit File → Reduce File Size / Optimize PDF (images: downsample/compress
per colour/greyscale/mono with quality; fonts: unembed/subset; discard
objects/user data; clean up: object streams, remove unused, flatten
transparency ✗); Advanced Optimization audit of space usage; Fast Web
View; repair on open.

## Scope — build all of this

- Optimise dialog: image downsampling (target DPI per class, threshold),
  recompression (JPEG quality, JPEG2000 ✗, Flate), mono to CCITT/JBIG2 ✗
  (JBIG2 encode Parked), font subsetting/unembedding (with warnings),
  discard: thumbnails, alt images, metadata (optional), bookmarks/links/
  comments/forms (optional), embedded files; clean-up: object streams,
  remove unused objects, compress streams, merge duplicate images/fonts/
  XObjects by hash; **space audit** (pie of bytes by category, words +
  values); before/after size preview computed on a copy; presets.
- Implementation: qpdf for structural work (`--object-streams=generate`,
  `--recompress-flate`, `--remove-unreferenced-resources`, `--linearize`),
  in-house image pipeline (worker) for downsample/recompress, fontkit for
  subsetting.
- Repair: on open failure or `qpdf --check` warnings, offer "Repair"
  (qpdf reconstruct xref) and open the repaired copy; "Repair" command.
- Fast Web View flag shown in Properties; linearise on Save As option.

## Out of scope

JBIG2/JPX encoding.

## Design notes & constraints

- Optimisation must never change page count/text; render diff tolerance
  per preset (lossless presets = zero diff).

## Files you will create or touch

`src/renderer/modules/M100-optimise-repair/**`, `src/engine/optimise/**`,
tests.

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

qpdf, fontkit, jpeg-js/pngjs.

## Acceptance tests — the module is done when these pass on all three OSes

- Bloated fixture shrinks ≥ 50 % with "Standard" preset; text/page count
  identical; render diff under tolerance; `qpdf --check` clean;
  linearised file passes `qpdf --check --show-linearization`.
- Broken-xref fixture repairs and opens.

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

Written before the code, kept current as it was built. Provenance is marked: **(public docs)**
for behaviour learned from Foxit's or Adobe's published documentation as a user would,
**(ISO 32000)** for the file format itself, **(ours)** for a choice this project made.

1. **Optimising produces a file; it never rewrites the open document underneath its model.**
   The engine owns bytes and the `Document` owns intent, and `Document.handle` is `readonly`
   with every model page bound to an engine index — so swapping optimised bytes under a live
   model is not something the contract allows, and faking it would cost the reader their undo
   history without saying so. Foxit's Reduce File Size and Advanced Optimization both end in a
   Save As **(public docs)**, so this is also what the reference does. Consequence: M100 makes no
   document change and therefore registers no undoable `Command`. Writing over the document's own
   path is allowed, and reloads that tab after saying in words that undo history is lost **(ours)**.
2. **qpdf runs in the main process, reusing M70's runner** (ADR 0011): a renderer cannot host this
   build of qpdf-wasm without dying. `QpdfTasks` (`src/engine/optimise/qpdf/tasks.ts`) is the
   `Security`-shaped façade — structure, linearise, check, repair — and four additive
   `optimise:*` IPC channels mirror `security:*`. ADR 0019.
3. **Everything else is a pure function over bytes in `src/engine/optimise/`**, run in a module
   Worker exactly as M41's ops are: no Node, no Electron, no DOM. That is what lets M120's batch
   and M121's command line optimise a file with no window open.
4. **Pipeline order: discard → images → fonts → duplicates → qpdf structure → linearise.**
   Duplicates are merged *after* recompression so that two copies of one picture that arrived in
   different encodings still merge; the qpdf pass is last because object streams and
   unreferenced-object removal want the finished object graph **(ours)**.
5. **The space audit is measured, not estimated.** Every indirect object is serialised once and
   its length attributed to the category of whatever refers to it; an object several categories
   share is split between them, and what nothing claims is "document structure". The alternative —
   summing stream `/Length` values — misses object headers, xref entries and everything
   uncompressed, and would not add up to the file size, which is the one thing a space audit has
   to do **(ours)**.
6. **The audit's chart is a donut whose slices are told apart by hatch pattern, not by colour**,
   with the table of word, bytes and share beside it and the largest slice named on the chart
   itself. The brief asks for a pie of bytes by category with words and values; the operator is
   colourblind and this project forbids differentiating by colour alone, so the slices carry
   solid / diagonal / cross / dotted / horizontal / vertical fills in `--accent` on `--bg-modal`,
   separated by `--border-strong` **(ours)**.
7. **Presets are data, not code:** `resources/optimise-presets.json` holds Lossless, Standard,
   Small and Smallest; the reader's own presets are saved beside them in settings **(ours)**.
8. **Lossless presets are provably lossless.** They touch no image sample and no font program —
   only object streams, flate recompression, unreferenced objects and duplicate merging — so the
   render-diff tolerance for them is exactly zero, and the acceptance test asserts zero rather
   than "small" **(ours)**.
9. **Mono images go to CCITT Group 4, encoded here** (~200 lines, ISO 32000 §7.4.6 / ITU-T T.6)
   rather than by adding a dependency. **JBIG2 and JPEG 2000 encoding are out of scope** and the
   dialog says so in words where the option would have been, instead of hiding it **(brief)**.
10. **Font subsetting reads glyph usage from the content streams** with M50's parser (`Tf` to
    know which font is current, `Tj`/`TJ`/`'`/`"` for the codes) and cuts the font program down
    with fontkit. A font fontkit cannot rebuild — Type 3, a CID-keyed CFF whose charset we cannot
    map — is **left exactly as it was** and named in the report. A silently broken font is worse
    than a large one **(ours)**.
11. **Unembedding refuses a font a reader might not have.** Only the Standard 14 and the
    families metric-compatible with them (Arial, Helvetica, Times New Roman, Courier New and
    their bold/italic variants) may be unembedded; anything else keeps its font program and the
    reader is told why **(ISO 32000 §9.6.2.2 for the Standard 14; ours for the refusal)**.
12. **Repair is PDFium’s work, not qpdf’s, and it never overwrites the original.**
    The brief assumed a qpdf rewrite would reconstruct a broken cross-reference table. It does
    not: measured against five kinds of damage, this build of qpdf-wasm reconstructs *nothing* —
    its recovery paths are exception-driven and the WebAssembly does not catch exceptions, so the
    first throw comes out as exit 2 with no output file. PDFium does reconstruct, so repair asks
    the engine to open the bytes and writes the document back out; a file the engine refuses
    falls back to a qpdf rewrite, and a file neither will read is said to be beyond repair rather
    than quietly returned unchanged. Detection is still `qpdf --check`, which is exactly what the
    brief asks for. The repaired copy is what opens; the original is left alone.
    **(brief for the offer; measured, ADR 0019, for who does it)**
13. **Repair on open is one optional service lookup in M11's `ViewerService`**, mirroring the
    `security` hook M70 already added there: when the engine refuses a file and a `repair` service
    is registered, it is offered. Without M100 in the build nothing changes. ADR 0019.
14. **Fast Web View on save is a save-pipeline stage** (M21's `SavePipelineStage`, ADR 0012) at
    order 50, off by default. It **skips, with a worded warning, when another stage owns the
    document's protection**: M70 re-encrypts by running qpdf again, and a qpdf rewrite without
    `--linearize` is not linearised — so a file cannot come out of this pipeline both password
    protected and linearised, and saying so is better than quietly producing one of the two **(ours)**.
15. **The before/after preview is the real thing, on a copy.** The preview runs the whole pipeline
    over a copy of the document's saved bytes and reports the size it actually produced, then
    keeps those bytes so pressing Optimise does not do the work twice. Estimating would be
    cheaper and would be wrong for exactly the files where the number matters **(ours)**.

## Build log (fill in at merge)

**Built 2026-09-10 on `mod/M100-optimise-repair` (worktree `../ynotPDF-M100`).**

### What shipped

- **`src/engine/optimise/`** — the whole pipeline as pure functions over bytes, in the sense M41's
  ops established: no Node, no Electron, no DOM, so a renderer Worker, a vitest module and M120's
  batch all run the identical code. Discard → images → fonts → duplicates, then qpdf.
- **Images** — decode (flate, LZW, ASCII85/Hex, run-length, baseline JPEG; predictors undone),
  downsample by area-average against the resolution the picture is actually *drawn* at, re-encode
  as JPEG, flate or CCITT Group 4, and put back with a dictionary that matches. Soft masks are
  scaled in step with the image they mask. An image in a filter we cannot read, a CMYK image, or
  one whose re-encoding came out bigger keeps exactly the bytes it had.
- **Fonts** — glyph usage read from every content stream, form XObject and annotation appearance;
  embedded TrueType cut down by **emptying unused outlines rather than renumbering glyphs**, so no
  encoding, `/Widths` or `/CIDToGIDMap` needs rewriting; unembedding restricted to the Standard 14
  and the faces metrically identical to them.
- **Duplicates** — images, fonts and form XObjects merged by content hash *and* a byte-for-byte
  comparison, with every reference repointed and the loser deleted.
- **Space audit** — measured, not estimated: every indirect object is charged to whoever refers to
  it, shared objects split between owners, and the remainder called structure, so the slices add up
  to the file's own length.
- **The dialog** — five tabs plus the audit, and one line of plain English: "1.4 MB → 620 kB, 56 %
  smaller", produced by running the real pipeline over a copy and keeping those bytes, so pressing
  Optimise writes exactly what was promised.
- **Repair** — `qpdf --check` on demand, and quietly on open with a worded toast when it finds
  something; the repair itself goes through PDFium and falls back to qpdf.
- **Fast web view** — a save-pipeline stage at order 50, off by default, which says in words when it
  cannot run.
- **Presets** — Lossless, Standard, Small, Smallest in `resources/optimise-presets.json`, plus the
  reader's own, saved from the dialog.

### Measured, on the operator's own files (Standard preset)

| File | Before | After | Saved |
|---|---|---|---|
| `bloated.pdf` (fixture) | 420 kB | 5 kB | 99 % (66 % with Lossless) |
| `220909 Cemair AMB 4D.pdf` | 195 kB | 128 kB | 35 % (73 % with Smallest) |
| `241109 B-Pass AMB.pdf` | 89 kB | 66 kB | 26 % |
| `boarding_pass.pdf` | 162 kB | 123 kB | 24 % |
| `Sample Portfolio.pdf` | 420 kB | 301 kB | 28 % |

Page count, page sizes and text identical in every one.

### Decisions worth knowing about

- **This build of qpdf reconstructs nothing.** The brief assumed a qpdf rewrite would rebuild a
  broken cross-reference table. Measured against five kinds of damage — `startxref` past the end,
  `startxref 0`, no `startxref`, a corrupted `xref` keyword, a file truncated at 70 % — every one
  comes back as exit 2 with one line and no output file. qpdf's recovery is exception-driven and
  the WebAssembly does not catch exceptions. **PDFium does reconstruct**, so repair goes through
  the engine first and falls back to qpdf for a file PDFium refuses but qpdf can read. Detection is
  still `qpdf --check`, which is exactly what the brief asked for. ADR 0019 §1a.
- **Glyph blanking, not glyph renumbering.** Every subsetting library renumbers glyphs, and inside
  a PDF that is a trap: a simple font finds glyphs through `/Encoding`, `/Differences` and its own
  `cmap`, a CID font through `/CIDToGIDMap`, and a renumbered font needs all of them rewritten in
  step in a document whose text is already written. Get one wrong and letters swap places in a file
  that still opens. So `loca` keeps all its entries, unused glyphs get length zero, and the saving
  is the same one a renumbering subsetter gets, because it is `glyf` that is large.
- **fontkit was not used, though the brief names it.** Its subsetting renumbers, which is the trap
  above; the safe operation is 250 lines of sfnt surgery with no dependency, and it is tested by
  rendering the result through PDFium. Recorded here rather than quietly.
- **CCITT Group 4 is written here** (ITU-T T.6, ~200 lines of table and state machine) rather than
  pulled in: JBIG2 and JPX are the encodings that would have needed a library, and they are parked.
  Verified by rendering a G4 page and the same picture as raw bits through PDFium and requiring
  identical hashes.
- **A picture that grows falls back to flate at the reduced size before giving up.** A screenshot or
  an indexed palette can be smaller as 200 px of flate than as 100 px of JPEG, and the naive rule
  ("it grew, put it back") throws away a downsample that would have helped.
- **`optimise.check` does not wait for its own dialog.** A command's return value is what another
  command, the e2e harness and M120's batch read back; a checker that only answers once somebody
  has pressed OK is a checker nothing can drive. The Repair it offers is chained off the dialog.
- **The audit's chart is told apart by hatch pattern, not colour** — six SVG fills in two theme
  tokens, with the same figures in words beside it. The brief asked for a pie; the operator is
  colourblind, and a colour-keyed one would have been unreadable to him.
- **jpeg-js needs a global `Buffer`** and a renderer Worker has not got one; `installBuffer.ts` puts
  a two-method stand-in where it looks, the same trick `installPako.ts` already uses for utif.

### What was deferred, and why

- **JBIG2 and JPEG 2000 encoding** — out of scope in the brief. The dialog names them and says why
  rather than leaving them out, and an image already in either is left strictly alone.
- **PostScript-outline fonts (Type 1, CFF)** keep their full font program. Cutting a CFF charstring
  index down safely is a second implementation of a different format; such a font is named in the
  report rather than silently skipped.
- **Optimising the open document in place.** Optimising produces a file. The engine owns bytes, the
  `Document` owns intent, `Document.handle` is `readonly` and every model page is bound to an engine
  index — so swapping optimised bytes under a live model is not something the contract allows, and
  faking it would cost the reader their undo history without saying so. Foxit's Reduce File Size and
  Advanced Optimization both end in a Save As. Consequence: M100 registers no undoable `Command`,
  because it changes no document.
- **A per-save "linearise" checkbox in the Save As dialog.** The OS dialog cannot carry one, so fast
  web view is a setting (and a preset option) instead. It skips, with a worded warning, when M70 is
  re-protecting the same save: a qpdf rewrite without `--linearize` is not linearised, so a file
  cannot come out of one pipeline both password protected and linearised. ADR 0019 §3.

### One thing the operator may want to know

The **Small** preset can produce a slightly *larger* file than **Standard** on a document with
almost no images — 66 kB against 67 kB on one of the boarding passes. That is fast web view: Small
linearises and the hint tables cost a kilobyte or two. It is doing what it was asked; on a document
where the pictures are the weight, Small is much the smaller of the two.
