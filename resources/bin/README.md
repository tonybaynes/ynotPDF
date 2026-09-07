# resources/bin

Native binaries (PDFium, qpdf, Tesseract + tessdata) land here per OS, fetched at build time by
`npm run fetch-binaries` from `resources/binaries.json` with pinned SHA-256 checksums.

Everything in this folder except this README is git-ignored and refused by the pre-commit hook.
