# M10 — PDF engine layer

The engine itself is `src/engine/` (`PdfiumEngine`, `EngineClient`, the worker and the geometry
helper); see `docs/modules/M10-engine-layer.md` and ADRs 0005/0006. This module folder holds the
renderer-side contribution:

- `dev.engineOpen` — "Engine: probe a PDF" (Developer). Opens bytes (or a file picked in the
  native dialog) in the engine worker and reports page count, size, first text, annotation /
  field / layer / attachment / outline / link counts, XFA flag, render time and a render hash.
  The e2e suite uses it to prove the WASM engine runs inside the packaged app.
