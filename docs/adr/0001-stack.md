# ADR 0001 — Stack: Electron + TypeScript + PDFium, no Docker

**Status:** accepted (M00, 2026-09-07)
**Deciders:** operator (Tony Baynes), M00 session

## Context

ynotPDF targets Foxit PDF Editor 14 feature parity on Windows, macOS and Linux for a single
operator with low vision and colour-blindness. It must be buildable module-by-module by parallel
Claude Code sessions, ship self-contained installers, and use only permissive licences.

## Decision

1. **TypeScript end-to-end**, `strict`, Node 26. One language for UI, model, engine adapters,
   main process, scripts and tests. Scripts run directly under Node's native TypeScript
   support (erasable syntax only; `erasableSyntaxOnly` is on).
2. **Electron** (MIT) as the shell, **electron-vite** for build/dev, **electron-builder** for
   installers. Chosen over Tauri because a PDF renderer needs identical Chromium canvas/worker
   behaviour on every OS. ~150 MB installed is the accepted cost.
3. **Vanilla DOM UI, no framework.** State → DOM via the in-house `Store`
   (`src/renderer/core/Store.ts`). Fewer things to fight on theming and accessibility.
4. **PDFium** (BSD-3) as the engine behind the `PdfEngine` interface, in a Web Worker.
   Writing via **pdf-lib** (MIT); structure via **qpdf** (Apache-2.0); fonts via **fontkit**
   (MIT); OCR via **Tesseract** (Apache-2.0). MuPDF, iText, Ghostscript, PDFTron are excluded
   (AGPL/commercial). A `license-checker` gate in CI fails on copyleft.
5. **No Docker, ever** — build or runtime. Native binaries are prebuilt official releases
   fetched by `scripts/fetch-binaries.ts` with pinned SHA-256 (`resources/binaries.json`) and
   bundled per OS by electron-builder. If a custom engine build is ever needed it uses a locally
   installed emsdk on plain GitHub runners. Installing local toolchains (Rust, C++, emsdk) is
   pre-approved; record each in a new ADR and in `README.md`.
6. **Contracts first.** M00 stubs `PdfEngine`, `EngineClient`, `Document`, `Command`,
   `UndoStack`, `Store`, `Registry`, `Selection`, the view shells, `ModuleManifest` and the typed
   IPC map so wave-1 modules can build in parallel. Changing a contract needs its own ADR merged
   first, and must be additive.

## Consequences

- Every user action is a registered command (palette-visible); every document change is an
  undoable `Command`.
- Colours only via theme tokens; `scripts/check-styles.ts` fails the build on literals outside
  `src/renderer/theme/`, on `rgba()` alpha < 1, `opacity` < 1, or `backdrop-filter`.
- The engine Worker boundary means every `PdfEngine` method is async and all payloads are
  structured-cloneable; bitmaps and buffers are transferred.
- Node 26 / npm 11: install scripts are gated by `allowScripts` in `package.json`; Electron's
  binary is fetched by the `postinstall` step (`install-electron`).
