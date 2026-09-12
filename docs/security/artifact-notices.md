# Build inputs and release notices

Audit finding 24 has two separate concerns. The SPDX policy checks actual AND/OR
grouping and allows UNLICENSED only for this private root package. Distribution
notice completeness is a separate release decision; a package's declared licence
is not proof that all compiled code has been inventoried or its notices included.

Every main, preload, renderer and web-worker build emits an input manifest. The
post-build check covers production dependencies and packages actually bundled from
devDependencies, including Lucide. Downloaded font files and their notices are
inventoried, with hashes of the files used. Pinned opaque binary artifacts have
separate hashes and provenance records in `resources/licenses/artifacts.json`;
an upgrade or replacement fails until that record is reviewed.

Development builds include `out/notices/third-party.json` and `NOTICES.txt` via the
existing `out/**/*` packaging rule. The JSON explicitly records incomplete notice
reviews and does not call the build release-ready when any are unresolved.
Electron's bundled runtime licence and Chromium notices must also exist.

`npm run licenses:release` is the strict release gate and currently fails on known
missing notices/reviews. M131 must run it after a fresh build and before publishing.
Do not bypass it by relabelling a README that only names a licence as a complete
notice. Current release blockers include the qpdf wrapper's missing ISC text,
@nodable/entities' missing MIT notice text, and complete compiled-component/notice
reviews for the PDFium and qpdf WebAssembly artifacts. No redistribution-rights
conclusion is inferred from the npm gate. These release prerequisites remain open;
ordinary development and unsigned CI packaging can continue with the visible report.

The installed PDFium WASM was compared byte-for-byte with
[pdfium-lib release 7243](https://github.com/paulocoutinhox/pdfium-lib/releases/tag/7243).
Its source build configuration selects a branch rather than attesting an exact
checkout, so that comparison establishes the binary release, not reproducibility
from today's branch tip. The qpdf component pins come from the published wrapper's
[source build recipe](https://github.com/neslinesli93/qpdf-wasm/blob/e661db2d17e391a9fbe6b350b4ea6dbd8c385891/Dockerfile).
That recipe was read as evidence; no Docker build was run.
