# ynotPDF — Project Plan

Cross-platform (Windows / macOS / Linux) PDF editor with the feature set of
**Foxit PDF Editor 14**, four colour themes, dark by default.

This file is the master plan. Every build session starts here: read
**§0 Progress**, pick the next unchecked module whose dependencies are done,
open its spec in `docs/modules/`, build it to its acceptance test, tick it,
commit. Sub-conversations working in parallel follow **§12**.

---

## 0. Progress tracker

| Wave | Module | Spec | Status |
|---|---|---|---|
| 0 | M00 Scaffold, CI & packaging smoke | [M00-scaffold.md](docs/modules/M00-scaffold.md) | ☑ |
| 1 | M01 Theme system (four themes) | [M01-theme-system.md](docs/modules/M01-theme-system.md) | ☑ |
| 1 | M02 Application shell (ribbon, panes, tabs, status bar, dialogs) | [M02-app-shell.md](docs/modules/M02-app-shell.md) | ☐ |
| 1 | M10 PDF engine layer & PDFium adapter | [M10-engine-layer.md](docs/modules/M10-engine-layer.md) | ☐ |
| 1 | M20 Document model, commands & undo stack | [M20-document-model.md](docs/modules/M20-document-model.md) | ☐ |
| 2 | M11 Viewer — rendering, navigation, zoom, layouts | [M11-viewer.md](docs/modules/M11-viewer.md) | ☐ |
| 2 | M21 Save, Save As, autosave & recovery | [M21-save.md](docs/modules/M21-save.md) | ☐ |
| 2 | M70 Encryption, permissions & certificate security | [M70-encryption.md](docs/modules/M70-encryption.md) | ☐ |
| 2 | M91 Create PDF from images, web pages, clipboard, HTML/Markdown & text | [M91-create-pdf.md](docs/modules/M91-create-pdf.md) | ☐ |
| 3 | M12 Navigation panels — thumbnails, bookmarks, layers, attachments, destinations | [M12-navigation-panels.md](docs/modules/M12-navigation-panels.md) | ☐ |
| 3 | M13 Text selection, find, copy, snapshot & print | [M13-select-find-print.md](docs/modules/M13-select-find-print.md) | ☐ |
| 3 | M30 Annotations — text markup, notes, typewriter, text box, callout | [M30-markup-annotations.md](docs/modules/M30-markup-annotations.md) | ☐ |
| 3 | M40 Organise pages — insert, delete, extract, replace, rotate, move, labels | [M40-organise-pages.md](docs/modules/M40-organise-pages.md) | ☐ |
| 4 | M31 Annotations — shapes, ink & eraser, stamps, file attachments | [M31-shapes-ink-stamps.md](docs/modules/M31-shapes-ink-stamps.md) | ☐ |
| 4 | M32 Comments panel, replies & status, FDF/XFDF, summarise | [M32-comments-panel.md](docs/modules/M32-comments-panel.md) | ☐ |
| 4 | M41 Merge, split, extract to files, crop & flatten | [M41-merge-split-crop.md](docs/modules/M41-merge-split-crop.md) | ☐ |
| 4 | M72 Document properties, metadata & XMP, initial view | [M72-properties-metadata.md](docs/modules/M72-properties-metadata.md) | ☐ |
| 4 | M130 Preferences, keyboard shortcuts editor, ribbon/QAT customisation, UI scale, i18n framework | [M130-preferences.md](docs/modules/M130-preferences.md) | ☐ |
| | **MILESTONE 1 — usable viewer & annotator (v0.1)** — open, view, search, print, annotate, comment, organise pages, merge/split, save, encrypt, create PDFs, preferences | | |
| 5 | M33 Measuring tools — distance, perimeter, area, calibration | [M33-measuring-tools.md](docs/modules/M33-measuring-tools.md) | ☐ |
| 5 | M50 Page-object model — select, move, resize, align, arrange | [M50-object-model.md](docs/modules/M50-object-model.md) | ☐ |
| 5 | M60 Form fill & AcroForm field designer | [M60-forms.md](docs/modules/M60-forms.md) | ☐ |
| 5 | M92 Export to images, text, HTML & RTF | [M92-export.md](docs/modules/M92-export.md) | ☐ |
| 5 | M100 Optimise (reduce size), linearise, repair, remove duplicates | [M100-optimise-repair.md](docs/modules/M100-optimise-repair.md) | ☐ |
| 6 | M53 Header/footer, Bates numbering, watermark, background & links | [M53-headers-bates-watermarks-links.md](docs/modules/M53-headers-bates-watermarks-links.md) | ☐ |
| 6 | M61 Field logic — validation, formatting, calculation, actions; data import/export; flatten | [M61-form-logic-data.md](docs/modules/M61-form-logic-data.md) | ☐ |
| 6 | M82 Handwritten signatures & initials | [M82-handwritten-signatures.md](docs/modules/M82-handwritten-signatures.md) | ☐ |
| 6 | M90 OCR — searchable image, image+text, editable text | [M90-ocr.md](docs/modules/M90-ocr.md) | ☐ |
| 6 | M110 Compare documents | [M110-compare.md](docs/modules/M110-compare.md) | ☐ |
| 7 | M52 Image & path object editing | [M52-image-path-editing.md](docs/modules/M52-image-path-editing.md) | ☐ |
| 7 | M111 Read aloud, accessibility check & alt text | [M111-read-aloud-accessibility.md](docs/modules/M111-read-aloud-accessibility.md) | ☐ |
| 7 | M120 Batch processing & action wizard | [M120-batch-actions.md](docs/modules/M120-batch-actions.md) | ☐ |
| | **MILESTONE 2 — everyday editor (v0.5)** — forms fill & design, measuring, object move/resize, watermarks/Bates/headers, OCR (searchable), compare, export, batch, image editing | | |
| 8 | M51 Text editing with reflow (spike first) | [M51-text-editing.md](docs/modules/M51-text-editing.md) | ☐ |
| 8 | M62 Automatic form-field recognition | [M62-field-recognition.md](docs/modules/M62-field-recognition.md) | ☐ |
| 8 | M80 Incremental-update writer | [M80-incremental-writer.md](docs/modules/M80-incremental-writer.md) | ☐ |
| 8 | M93 Office ↔ PDF via LibreOffice bridge | [M93-office-bridge.md](docs/modules/M93-office-bridge.md) | ☐ |
| 8 | M121 Command-line interface | [M121-cli.md](docs/modules/M121-cli.md) | ☐ |
| 9 | M54 Find & replace, spell-check | [M54-find-replace-spellcheck.md](docs/modules/M54-find-replace-spellcheck.md) | ☐ |
| 9 | M71 Redaction & sanitise (remove hidden information) | [M71-redaction.md](docs/modules/M71-redaction.md) | ☐ |
| 9 | M81 Digital signatures — sign, certify, timestamp, LTV, validate, trust | [M81-digital-signatures.md](docs/modules/M81-digital-signatures.md) | ☐ |
| 9 | M94 PDF/A conversion & basic validation | [M94-pdfa.md](docs/modules/M94-pdfa.md) | ☐ |
| 10 | M131 Installers, code signing, auto-update, crash reporting, help & first run | [M131-release.md](docs/modules/M131-release.md) | ☐ |
| | **MILESTONE 3 — full editor (v1.0)** — text editing with reflow, redaction, digital signatures, incremental saves, PDF/A, Office bridge, CLI, signed installers & auto-update | | |

Legend: ☐ not started · ◐ in progress (branch open) · ☑ merged to `main`,
acceptance test green on all three OSes.

**Ordering principle (operator, 2026-09-07): easiest-first, hardest-last.**
Waves 0–4 give an installable, usable viewer/annotator; waves 5–7 make it an
everyday editor; the genuinely hard modules — text editing with reflow, true
redaction, incremental writer + digital signatures, PDF/A, the Office bridge
— are waves 8–9, added one at a time onto a working app. Unsigned
installers exist from M00 onwards (CI artifacts), so the app can be used
long before M131.

---

## 1. Honest scope statement

**Buildable, module by module, to a genuinely useful editor: yes.** The
architecture below is designed so every module ships working on its own and
nothing has to be rewritten to add the next one.

**"Same capabilities as Foxit 14", exactly: no — and it is worth saying why
up front.** Foxit is ~20 years of a large team on a proprietary engine. Three
tiers:

| Tier | Meaning | Examples |
|---|---|---|
| **Core** | Build fully; parity with Foxit is realistic | View, annotate, organise pages, forms, protect, redact, sign, OCR, optimise, compare, batch, watermarks/Bates, create-from-image/web |
| **Pro** | Build, but expect ~80 % of Foxit's polish | Text editing with reflow (see §8), auto form-field recognition, PDF/A conversion, OCR "editable text" mode |
| **Parked** | Not planned unless asked — cost far exceeds value for one operator | XFA forms, Acrobat-JavaScript compatibility, PDF→Word/Excel with layout fidelity, 3D/video/rich media, PDF portfolios, tag-tree accessibility editor, full preflight, cloud/ECM connectors, virtual printer driver, scanner drivers |

Anything Parked can be promoted later; the engine layer does not block it.

---

## 2. Language & stack decision

### Languages
| Language | Where | Why |
|---|---|---|
| **TypeScript** (end-to-end) | Everything we write: UI, document model, engine adapters, main process, tests, build scripts | One language, one toolchain, one debugger. Node 26 is already installed. Same vanilla-DOM conventions as the logistics hub, so nothing new to learn. |
| **C/C++** (consumed, not written) | PDFium, qpdf, Tesseract — used as prebuilt WASM or prebuilt binaries | The heavy lifting. Prebuilt releases are fetched by script; a local compiler is only needed if we build a custom PDFium WASM (see §8.2). |
| **Rust** (optional) | Only if profiling shows a hot path WASM can't handle — via `napi-rs` | Kept out until proven necessary. |

**Toolchain authorisation (operator, 2026-09-07):** installing Rust, a C++
toolchain, emsdk or anything else the *build* needs is pre-approved. Install
when a module needs it, record what was installed and why in `docs/adr/`,
and add the install step to `README.md`.

**No Docker — anywhere (operator, 2026-09-07).** Not at build time, not at
runtime. The installed app is fully self-contained: every native dependency
(PDFium, qpdf, Tesseract + language data) ships inside the installer, and an
end user needs nothing but the installer. Custom engine builds, if ever
needed, use a locally installed emsdk and plain GitHub Actions runners.

No Python in the app. (Python 3.11 stays useful for one-off tooling.)

### Runtime & framework
- **Electron** (MIT) — desktop shell. Chosen over Tauri because Tauri's
  webview differs per OS (WebKit on mac/Linux, WebView2 on Windows) and a PDF
  renderer needs identical canvas/worker behaviour everywhere; Electron ships
  one Chromium. Binary size (~150 MB installed) is the accepted cost.
- **Vite + electron-vite** — build/dev server, HMR.
- **Vanilla TypeScript + DOM** for the UI. No React/Vue/Angular. A tiny
  in-house reactive store (`src/renderer/core/store.ts`) handles
  state → DOM updates. The UI is toolbars, panels and a canvas, not a
  form-heavy CRUD app, and one fewer framework to fight on theme and
  accessibility rules.
- **Web Workers** for the PDF engine so rendering never blocks the UI.

### PDF engine libraries (all licences permit commercial use, no copyleft)
| Library | Licence | Role |
|---|---|---|
| **PDFium** (`@hyzyla/pdfium` WASM; later `pdfium-binaries` native via `koffi` FFI if needed) | BSD-3 | Rendering, text extraction/positions, page objects (text/image/path) read + edit, AcroForm fill/draw, annotations. **PDFium is the engine Foxit donated to Google** — Foxit's own core, the strongest possible base for a "Foxit-like" editor. |
| **pdf-lib** | MIT | Writing: page ops, embedding fonts/images, forms, metadata, drawing content streams. |
| **qpdf** (`@jspawn/qpdf-wasm` or bundled CLI) | Apache-2.0 | Encryption/decryption, linearisation, repair, object-stream optimisation, structural surgery. |
| **fontkit** | MIT | Font metrics, glyph lookup, subsetting for text editing. |
| **Tesseract** (`tesseract.js` WASM; bundled native CLI per OS for speed) | Apache-2.0 | OCR. |
| **@signpdf/*** + **node-forge** / Node `crypto` | MIT / BSD | CMS/PAdES signing, certificates, RFC 3161 timestamps. |
| **diff-match-patch** | Apache-2.0 | Text compare. |
| **Lucide** icons | ISC | Stroke icons drawn with `currentColor` → contrast comes from the theme, never the icon. |
| **electron-builder**, **electron-updater** | MIT | Installers and auto-update. |

**Deliberately avoided:** MuPDF/PyMuPDF (AGPL), iText (AGPL), Ghostscript
(AGPL), PDFTron/Apryse (commercial). The `PdfEngine` interface (§4) means
MuPDF could be swapped in later under a commercial licence without touching
the UI.

---

## 3. Product requirements

### 3.1 Platforms
Windows 10/11 x64 · macOS 12+ (universal) · Linux x64 (AppImage, .deb,
.rpm). CI builds all three on every push; a module is "done" only when its
tests pass on all three.

### 3.2 Themes — four, dark default
All colours are **semantic tokens** (`--bg-app`, `--bg-panel`, `--bg-ribbon`,
`--fg`, `--fg-muted`, `--icon`, `--accent`, `--fg-on-accent`, `--border`,
`--focus`, `--selection`, `--danger`, `--warning`, `--success`, `--info`, …)
defined once per theme in `src/renderer/theme/<name>.css`. **No colour
literal anywhere else in the codebase** — a lint rule enforces it.

**Built and approved by the operator on 2026-09-07 (M01).** The character of
each theme is below; `src/renderer/theme/*.css` and the token catalogue in
`tokens.css` are the source of truth for exact values, and
`test/unit/theme-contrast.test.ts` fails the build if any of them breaks a rule.
A few values moved during M01 to clear the contrast floor — the accents darkened
so the white focus ring keeps 3:1 on them, and the borders lightened to reach
3:1 on their surfaces.

| # | Name | Character |
|---|---|---|
| 1 | **Graphite** (default) | Dark: app `#121212`, panels `#1c1c1e`, ribbon `#232326`, text `#f2f2f2`, icons `#ffffff`, accent `#3392ff`, borders `#767680`. Text ≥ 7:1, icons ≥ 4.5:1 on every surface. |
| 2 | **Midnight** | Black `#000000` app, dark-blue `#0a0a2e` panels, gold `#ffd700` text, white borders — the logistics-hub palette. |
| 3 | **Daylight** | Mid grey, **no white anywhere in the chrome**: panels `#d9d9e3`, app and ribbon `#d2d2dc`, inputs `#d5d5df`, page backdrop `#9e9eb0`, black text, accent `#082a68`. Only the PDF page is white. |
| 4 | **High Contrast** | Pure black / white / yellow, 2 px borders, no greys. |

Accessibility rules baked into every theme (non-negotiable — the operator's
own requirements):
- WCAG AA minimum: text ≥ 4.5:1, icons and UI borders ≥ 3:1. A unit test
  computes every token pair per theme and fails the build if violated.
- **Never differentiate by red/green or gold/green alone** — the operator is
  colourblind and black and red read as one colour. Status uses a word + icon;
  the palette separates on blue↔yellow and lightness. No red text on black.
  A test simulates protanopia and deuteranopia and asserts every status pair
  still separates by lightness (ΔL\* ≥ 20) **or** blue↔yellow (Δb\* ≥ 45), never
  by red↔green alone. The two channels are needed because a flat ΔL\* rule is
  impossible next to the 4.5:1 floor — see `docs/adr/0002-status-colour-separation.md`.
- Muted/secondary text is still ≥ 4.5:1 — no dim grey on dark. **There is no
  low-contrast text anywhere** (operator, 2026-09-07): the 3:1 this plan first
  allowed for placeholder hints proved unreadable, and so did 4.5:1. A hint is
  now never fainter than the theme's own muted text, which the tests enforce as
  a relative rule so it cannot drift when a surface moves. The italics carry
  the "this is a hint" signal instead of low contrast.
- **Modals and overlays are fully opaque.** No `rgba()` with alpha < 1, no
  `opacity` < 1, no `backdrop-filter`. Lint rule.
- `color-scheme: <scheme> only` declared per theme. The `only` keyword is what
  actually stops a browser-level auto-dark feature repainting the app (Chrome's
  Auto Dark Mode ignores a bare `light`); the tests assert it.
- Every control has a keyboard path and a visible 2 px focus ring, drawn as two
  solid rings (`--focus` outside on the surface, `--focus-contrast` inside on the
  control) because one colour cannot clear 3:1 against both a pale surface and a
  dark accent fill.
- UI scale 100–200 % in Preferences.

Theme switch is live (no restart) and persisted.

**Night Mode** (`view.nightMode.toggle`, `Mod+Alt+N`) is a separate toggle, not a property of
the dark themes: a theme colours the interface, while a PDF page renders as its author made it.
Turning it on darkens the page and every annotation colour with it. Off by default in every
theme, persisted, and available whichever theme is active — as in Foxit's View menu. M01 owns
the tokens, the command and the `data-night-mode` attribute; M11 applies the matching inversion
to the rendered page raster.

The Daylight chrome contains **no white at all** (operator requirement): a full-screen
`#ffffff` reads as glare, and so do white input fields. It is grey throughout, with black
text — panels lightest, then the app, inputs and ribbon, and the page backdrop darkest so a
page stands out against it. The only white in the window is the PDF page, because that is the
document rather than the interface.

There is a floor on how dark that grey can go, and it is set by the status colours rather than
by taste. Every status must clear 4.5:1 on the darkest surface that carries text, which caps
its lightness; the four then have to stay distinguishable to a dichromat inside whatever band
is left. Searching the colour space under semantic hue constraints puts the floor at a
text-bearing surface of about `#ccccd8`; below that nothing works. At the current `#d2d2dc`
the band is already narrow enough to force a choice, and the one taken is: **all four statuses
stay clearly lighter than body text, at the cost of `--danger` being a burnt orange rather than
a vivid red-orange.** Discrimination is what the operator actually needs; how red the red looks
is not something he can use. Going darker again means giving up one of those two.

### 3.3 UI layout (Foxit-style)
- **Ribbon** tabs: File · Home · Edit · Comment · View · Form · Protect ·
  Organize · Convert · Accessibility · Help. Each module registers its own
  ribbon groups; the ribbon is data-driven from module manifests, so an
  unbuilt module simply doesn't appear.
- **Left navigation pane**: Thumbnails · Bookmarks · Layers · Attachments ·
  Comments · Fields · Signatures · Search. Collapsible, resizable.
- **Right properties pane**: context properties for the current selection.
- **Document tabs** (multi-document), drag to reorder, drag out to new window.
- **Status bar**: page x of y, zoom, layout mode, cursor coordinates, theme
  quick-switch.
- **Quick-access toolbar** above the ribbon, user-customisable.
- **Command palette** (Ctrl/Cmd+Shift+P) listing every command — also how
  end-to-end tests drive the UI.

---

## 4. Architecture

```
┌──────────────────────────── Electron ────────────────────────────┐
│ main/                                                            │
│   windows, native menus, file dialogs, file I/O, recent files,   │
│   printing, updater, OS integration, LibreOffice/Tesseract       │
│   process launcher, native PDFium (optional, via koffi)          │
│                    ▲ typed IPC (contextBridge)                   │
│ preload/  — exposes ONLY the typed API in shared/ipc.ts          │
│                    ▼                                             │
│ renderer/                                                        │
│   app/      shell: ribbon, panes, tabs, dialogs, command palette │
│   theme/    tokens + 4 themes                                    │
│   core/     Document model · Command/Undo · Selection · Events   │
│             · Store · Module registry                            │
│   modules/  one folder per M-id; each exports a Manifest         │
│             { id, ribbon, commands, panels, tools, shortcuts }   │
│   view/     PageView (canvas + overlay layers), Viewport, tiles  │
│                    ▲ postMessage                                 │
│ engine/  (Web Worker)                                            │
│   PdfEngine interface ──► PdfiumEngine (default)                 │
│   Writer  ──► pdf-lib · IncrementalWriter (M80)                  │
│   Tools   ──► qpdf · fontkit · tesseract                         │
└──────────────────────────────────────────────────────────────────┘
```

### 4.1 Key contracts (all stubbed by M00 so parallel modules can code against them)
- **`PdfEngine`** (`src/engine/PdfEngine.ts`): `open`, `close`, `pageCount`,
  `pageSize`, `render(page, scale, rect, opts) → ImageBitmap`, `textRuns(page)`,
  `pageObjects(page)`, `annotations(page)`, `formFields()`, `outline()`,
  `layers()`, `attachments()`, `metadata()`, plus mutation counterparts.
  Everything above the engine talks to this interface only.
- **`Document`** (`src/renderer/core/Document.ts`): the in-memory model —
  pages, annotations, fields, objects, metadata — with a **journal of
  Commands**. The engine is the source of truth for *bytes*; the Document is
  the source of truth for *intent*. Saving replays the journal into the writer.
- **`Command`**: `{ id, label, do(), undo(), merge?(next) }`. Every user
  action that changes the document is a Command. One undo stack per document,
  unlimited, persisted to the recovery file.
- **`Tool`**: mouse/keyboard/touch handler bound to the page overlay. One
  active tool at a time; tools are provided by modules.
- **Overlay layers** per page (bottom → top): raster canvas · text layer
  (selection/search hit-testing) · annotation layer (SVG) · form-widget layer ·
  object-edit layer · tool layer. DOM layers inherit theme tokens.
- **`ModuleManifest`** (`src/shared/module.ts`): a module folder exports
  `manifest.ts` registering commands, ribbon groups, panels, tools, shortcuts
  and a settings schema. The shell knows nothing about specific features.

### 4.2 Rendering strategy
Tile-based rendering (512 px tiles) at device pixel ratio, LRU cache,
progressive: low-res whole page first, then tiles in viewport order. Text
layer built from `textRuns` once per page and cached. Annotation appearance
streams rendered by PDFium; our own SVG only while an annotation is being
created/edited, then baked to an appearance stream.

### 4.3 Save strategy
- **M21:** full rewrite via pdf-lib. Simple, correct, invalidates existing
  signatures (Foxit warns about this too — we do the same).
- **M80:** incremental update — append-only, preserves everything before it.
  Required for signing; makes saves of large files instant. Once M80 exists it
  is the default; full rewrite is "Save As (optimised)".
- Autosave every N minutes to `<userData>/recovery/<hash>.ynot`; offered on
  next launch after a crash.

### 4.4 Settings & data
No database. `electron-store` JSON in the OS user-data dir: preferences,
theme, recent files, custom stamps, saved actions, signature appearances,
trust store. Schema-versioned with migrations. Anything that can vary (font
substitution table, stamp catalogue, page-size presets, OCR languages) is a
data file under `resources/`, never a literal in code.

---

## 5. Feature inventory — Foxit 14 → ynotPDF modules

**View** — Open/recent/drag-drop, tabs, navigation, zoom (fit page/width/
visible, marquee, loupe), single/continuous/facing/book, rotate view, rulers/
grids/guides, split view, full screen, reading mode, night mode (= theme),
line-weights toggle → M11 · Thumbnails, bookmarks, layers, attachments,
destinations → M12 · Select text/image, snapshot, find (options, results
panel, across open docs and folders), print (ranges, scaling, booklet,
comments) → M13 · Document properties → M72.

**Comment** — Highlight/underline/strikeout/squiggly/replace/insert, note,
typewriter, callout, text box → M30 · Rectangle, oval, line, arrow, polygon,
polyline, cloud, pencil, eraser, stamps (standard, dynamic, custom), file
attachment → M31 · Comments panel, replies, status, sort/filter, FDF/XFDF,
summarise → M32 · Distance/perimeter/area, calibrate, snap → M33.

**Organize** — Insert (blank/file/clipboard), delete, extract, replace,
rotate, duplicate, reverse, move, page labels → M40 · Split, merge with
bookmarks, crop, flatten → M41.

**Edit** — Select object, move/resize/rotate/flip, align/distribute, z-order,
group → M50 · Edit text in place with reflow, font/size/style/colour/spacing,
add text, join/split blocks → M51 · Edit/add image, path objects → M52 ·
Header/footer, Bates, watermark, background, links → M53 · Find & replace,
spell check → M54.

**Form** — Fill, highlight, tab order → M60 · Field designer (text, check,
radio, list, combo, button, date, image, signature, barcode), actions,
validate/format/calculate, FDF/XFDF/CSV/XML, flatten, reset → M61 · Field
recognition → M62.

**Protect** — Password AES-256/128/RC4, permissions, remove security,
certificate encryption → M70 · Mark/search/apply redaction, patterns,
sanitise → M71 · Metadata / XMP → M72.

**Sign** — Digital IDs (PKCS#12, OS stores; PKCS#11 later), PAdES B-B/B-T/
B-LT, timestamps, LTV, certify, validate, trust → M81 · Incremental writer →
M80 · Handwritten signatures/initials → M82.

**Convert / Create** — OCR → M90 · From images/web/clipboard/HTML → M91 ·
To image/text/HTML/RTF → M92 · Office bridge → M93 · PDF/A → M94.

**Optimise / Repair** — Reduce size, linearise, repair, remove duplicates →
M100.

**Review** — Compare → M110 · Read aloud, accessibility check, alt text →
M111.

**Automation** — Batch, action wizard → M120 · CLI → M121.

**App** — Preferences, shortcuts, customisation, UI scale, i18n framework →
M130 · Installers, auto-update, crash logs, help → M131.

Full per-module detail is in each `docs/modules/*.md`.

---

## 6. Build order by wave (dependencies in each brief)

- **Wave 0:** M00 (no deps)
- **Wave 1:** M01 (M00) · M02 (M00, M01) · M10 (M00) · M20 (M00, M10)
- **Wave 2:** M11 (M02, M10) · M21 (M20, M11) · M70 (M21) · M91 (M21)
- **Wave 3:** M12 (M11, M20) · M13 (M11) · M30 (M21, M11, M13) · M40 (M21, M12)
- **Wave 4:** M31 (M30) · M32 (M30) · M41 (M40) · M72 (M21) · M130 (M02, M01)
  - → *MILESTONE 1 — usable viewer & annotator (v0.1)*
- **Wave 5:** M33 (M31) · M50 (M21, M11) · M60 (M21, M30) · M92 (M11, M13) · M100 (M21)
- **Wave 6:** M53 (M50, M21) · M61 (M60) · M82 (M30, M60) · M90 (M21) · M110 (M11, M13)
- **Wave 7:** M52 (M50) · M111 (M13) · M120 (M21, M41, M53, M61, M70, M90, M92, M100)
  - → *MILESTONE 2 — everyday editor (v0.5)*
- **Wave 8:** M51 (M50, M13) · M62 (M60) · M80 (M21, M20) · M93 (M21, M91) · M121 (M120)
- **Wave 9:** M54 (M51, M13) · M71 (M50, M51, M30) · M81 (M80, M60) · M94 (M100, M72)
- **Wave 10:** M131 (M00, M130)
  - → *MILESTONE 3 — full editor (v1.0)*

---

## 7. Repository layout

```
D:\Projects\ynotPDF\
  PLAN.md                  ← this file
  CLAUDE.md                ← session conventions (points here)
  README.md
  package.json / tsconfig.json / electron.vite.config.ts / eslint.config.js
  .github/workflows/ci.yml
  src/
    main/                  Electron main process
    preload/               contextBridge — typed IPC only
    shared/                types, ipc contracts, module manifest type, constants
    engine/                PdfEngine + adapters (runs in Worker)
    renderer/
      index.html
      app/                 shell (ribbon, panes, tabs, dialogs, palette)
      core/                Document, Command, Store, Registry, Selection
      view/                PageView, Viewport, tiles, layers
      theme/               tokens.css, graphite.css, midnight.css, daylight.css, high-contrast.css
      modules/             M10-engine/ M11-viewer/ … one folder per module
  resources/               icons, stamps, fonts, tessdata, per-OS binaries (git-ignored)
  test/
    fixtures/              PDF corpus (public-domain / synthetic only)
    unit/                  vitest
    e2e/                   Playwright
  docs/
    adr/                   architecture decision records
    modules/               one spec per module — the sub-conversation brief
  scripts/                 build/fetch helpers (TS)
```

---

## 8. Known hard problems (spike before committing)

1. **Text editing with reflow (M51).** Hardest module by far. 1-week spike on
   the corpus proving (a) paragraph detection from PDFium text runs, (b)
   re-layout of edited text with fontkit metrics, (c) writing the replaced
   content stream + font subset so extraction still works. If the spike fails
   on typical files, fall back to Foxit-like "edit within a line" scope.
2. **PDFium API surface in WASM.** `@hyzyla/pdfium` exports render/text APIs
   but may not export every edit/form/annotation function. Two fixes, no
   Docker: (a) prebuilt native PDFium from `pdfium-binaries` called through
   `koffi` FFI (no compiler at all, full C API), or (b) our own emscripten
   build with a locally installed emsdk, reproduced on plain GitHub runners.
   Evaluate in M10.
3. **True redaction (M71).** Partial-glyph-run removal inside a text object
   needs content-stream rewriting, not just object deletion. Design once with
   M51's writer.
4. **Signatures & incremental saves (M80/M81).** Byte-exact `/ByteRange`;
   test against Acrobat Reader's validator, not only our own.
5. **Native binaries per OS** (Tesseract, optional PDFium, qpdf). Fetched by
   `scripts/fetch-binaries.ts` from official releases with pinned checksums;
   never committed.
6. **macOS notarisation and Windows signing** need the operator's developer
   accounts — §10.

---

## 9. Conventions

- TypeScript `strict`; no `any` without a comment. ESLint + Prettier on
  commit (husky).
- Tests accompany every module: unit for model/engine, Playwright for UI,
  render-hash regression on the corpus.
- Every user-visible document change is a Command (undoable).
- Colours only via tokens; no transparency; keyboard path for everything;
  status = word + icon, never colour alone.
- Number/date formatting via `Intl`, locale en-GB default.
- Commit per sub-step, message `M11: tile cache LRU` style, ending with the
  Claude co-author trailer. Never commit `resources/bin/**` or any real
  customer PDF.
- Module spec lives in `docs/modules/`; the sub-conversation updates it
  with decisions made while building (section "Build log").

---

## 10. Decisions & inputs needed from the operator

| # | Item | Needed by |
|---|---|---|
| 1 | App name/branding confirmed as **ynotPDF**; icon/logo | M00 |
| 2 | GitHub repo for CI (private) — create `tonybaynes/ynotPDF` and tell the M00 session | M00 |
| 3 | Approve the Tier list in §1 (anything to promote from Parked?) | Wave 1 |
| 4 | ~~Theme names/palettes in §3.2 — tweak before M01~~ **Approved as built, 2026-09-07** (all four, via the M01 gallery) | M01 |
| 5 | A few real-world non-confidential PDFs typical of your use, for the corpus | M10 |
| 6 | Windows code-signing certificate and Apple Developer account (paid) | M131 |
| 7 | Is LibreOffice acceptable as the Office-conversion dependency? | M93 |

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Text editing quality below Foxit | Spike early (§8.1); scope fallback defined |
| WASM performance on huge scans | Decision gate after M11 benchmark; native adapter via koffi is drop-in |
| Electron size / RAM | Accepted; tile cache bounded; one engine worker per window |
| Cross-OS rendering drift | Render-hash tests in CI on all three OSes |
| Parallel sessions colliding | §12 protocol: own folder, own branch, contracts stubbed first |
| Scope creep toward Parked tier | Tier list explicit; promotion is a written decision |
| Licence contamination | Permissive licences only; `license-checker` in CI fails on copyleft |

---

## 12. Parallel sub-conversation protocol

The operator runs 3–4 Claude Code conversations at once, one module each.
To make that safe:

1. **Waves.** Start a module only when every module it depends on is ☑ on
   `main`. The wave number in §0 is the earliest wave it can start; modules
   in the same wave are independent of each other. **M00 runs alone first** —
   it creates the repo, the folder skeleton and, crucially, the **stubbed
   contracts** (`PdfEngine`, `Document`, `Command`, `ModuleManifest`, IPC
   types) that every later module codes against.
2. **One branch per module:** `mod/M11-viewer`, created from `main`. Work in
   a git worktree (`git worktree add ../ynotPDF-M11 mod/M11-viewer`) so
   sessions never share a working directory. Merge to `main` via a PR (or
   fast-forward merge if no PR flow) only when the acceptance test passes in
   CI; then tick §0 in the same commit.
3. **Own your folder.** A module writes only inside
   `src/renderer/modules/<Mid>-<name>/`, its engine adapter file(s) under
   `src/engine/`, its tests, its `docs/modules/` spec and `resources/` data.
   Touching shared files (`src/shared/*`, `src/renderer/core/*`,
   `src/renderer/app/*`, `package.json`) is allowed but must be **minimal,
   additive and called out in the PR description** — that is where merge
   conflicts come from.
4. **Read before building:** `CLAUDE.md`, this file (§2–4, §9), your module
   spec, and the specs of your direct dependencies. The spec is written to
   be self-sufficient; if it isn't, fix the spec.
5. **Contracts change by ADR.** If a module needs to change `PdfEngine`,
   `Document` or `ModuleManifest`, write `docs/adr/NNNN-*.md` explaining why,
   make the change additive (new optional method, not a signature change) and
   merge that first as its own small PR so other sessions pick it up.
6. **Definition of done** (every module): spec updated with a Build log ·
   unit + e2e tests green on all three OSes in CI · no new lint violations ·
   commands appear in the palette · undo/redo works for every change ·
   theme test still passes · §0 ticked.
