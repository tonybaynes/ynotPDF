# M51 — Text editing with reflow (spike first)

| | |
|---|---|
| **Module id** | `M51` — folder `src/renderer/modules/M51-text-editing/`, branch `mod/M51-text-editing` |
| **Earliest wave** | 8 (see `PLAN.md` §0/§12) |
| **Tier** | Pro |
| **Depends on** | M50, M13 |
| **Unlocks** | [M54 Find & replace, spell-check](./M54-find-replace-spellcheck.md), [M71 Redaction & sanitise (remove hidden information)](./M71-redaction.md) |

## Your task — the prompt for this conversation

You are building **M51 — Text editing with reflow (spike first)** of ynotPDF. Carry this brief out end to
end without waiting to be asked for the next step:

1. Read this file completely, then `CLAUDE.md`, `PLAN.md` §2–4, §9 and §12,
   and the briefs of your direct dependencies: [M50 Page-object model — select, move, resize, align, arrange](./M50-object-model.md), [M13 Text selection, find, copy, snapshot & print](./M13-select-find-print.md).
   Confirm each dependency is ☑ in `PLAN.md` §0. If one is not, say so and
   stop — do not build against unfinished work.
2. Create branch `mod/M51-text-editing` from `main` in a new git worktree and
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

Edit existing text in place — paragraph-aware, with reflow inside the
block, font/size/style/colour/spacing changes, adding new text blocks,
joining/splitting blocks — while keeping the saved file's text extractable.
This is the hardest module in the project: run the spike, write the ADR,
then build to the proven scope.

## Foxit 14 reference — what to emulate

Foxit Edit → Edit Text: click into a paragraph, type, paragraph reflows
within its box, Format panel (font, size, bold/italic/underline/strike,
colour, character spacing/scale, line spacing, alignment, indent, sub/
superscript), Add Text, Link/Join Text Boxes, Split, "Paragraph" vs "Line"
edit modes, font embedding on save, missing-font substitution prompt.

## Scope — build all of this

- **Spike (time-boxed, first week):** on the corpus, measure (a) paragraph
  detection accuracy from `textRuns` (lines, spacing, alignment, indent),
  (b) re-layout of edited text with fontkit metrics of the *original*
  embedded font (glyph availability check), (c) content-stream rewrite of
  the affected text objects + font subset update so `pdftotext`-style
  extraction still reads correctly, (d) fallback when the font is not
  embedded or lacks glyphs (substitution table in `resources/fonts/
  substitutions.json`, prompt as Foxit). Record results and the chosen
  scope in `docs/adr/00NN-text-editing.md`. If reflow fails on typical
  files, ship line-scope editing first and keep paragraph mode behind a
  flag.
- Text block model: lines → runs → glyphs with fonts, spacing (`Tc`, `Tw`,
  `Tz`, `TL`, `Ts`), colour, render mode; block box and alignment inferred.
- Editing overlay: caret, selection, keyboard editing (incl. IME), undo
  coalescing per word, clipboard, Format panel bindings, WYSIWYG using
  fontkit metrics rendered in the overlay (canvas) so the box matches the
  engine render after commit.
- Layout engine (`engine/textlayout/`): line breaking (UAX #14 via a small
  implementation), justification, hyphenation off, RTL/CJK best-effort
  (mark limitations), fits text to box or grows box downward (setting).
- Writer: replace text objects for the block, write new `Tj/TJ` with
  correct encoding for the font (simple vs CID), update font subset
  (fontkit subset → embed) or embed the substitute; keep `/ToUnicode`.
- Add Text tool (new block with default font), join/split blocks, delete
  block, convert to text box annotation (escape hatch).
- Missing-glyph/font prompt with clear wording and a substitute choice.

## Out of scope

Spell-check and replace-all (M54). OCR editable text (M90 reuses the
writer).

## Design notes & constraints

- Correctness beats cleverness: the file must remain extractable and
  render identically outside the edited block (test enforces).
- Keep original text objects untouched when not edited — do not
  re-serialise a whole page's content unless necessary.

## Files you will create or touch

`src/renderer/modules/M51-text-editing/**`, `src/engine/textlayout/**`,
`src/engine/fonts/**` (fontkit wrappers, subset/embed), `resources/fonts/
substitutions.json`, `docs/adr/00NN-text-editing.md`, tests.

## Libraries

fontkit (MIT), @unicode/… line-break data if needed (MIT/Unicode).

## Acceptance tests — the module is done when these pass on all three OSes

- Edit one word in the middle of a justified paragraph in the fixture:
  extraction of the saved file reads the new paragraph exactly; render diff
  is confined to that block's bbox; other pages byte-identical.
- Change font size for a block ⇒ reflow keeps the box width; overflow
  behaviour per setting.
- Edit text in a non-embedded-font block ⇒ substitution prompt, result
  renders with the substitute and extracts correctly.
- Add a new text block, save, reopen, edit again.
- Paragraph detection precision/recall ≥ 90 % on the labelled fixture set
  (ADR records the numbers).

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
- Replies to the operator: short and plain (eyesight). Never leave the
  operator a to-do you could do yourself.

---

## Design decisions (fill in before coding; keep current)

_None yet._

## Build log (fill in at merge)

_Not started._
