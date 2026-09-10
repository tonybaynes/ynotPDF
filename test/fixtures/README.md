# test/fixtures

The PDF corpus. **Synthetic or public-domain only** — never a customer file. This is the only
folder where `.pdf` files may be committed (`.gitignore` + pre-commit hook enforce it).

Regenerate with `npm run fixtures` (`scripts/make-fixtures.ts`, deterministic — every byte is
derived from fixed dates, ids and labelled pseudo-random seeds). Expected facts per file live in
`manifest.json`; the render/text snapshots the engine corpus test compares against live in
`hashes/<platform>.json` (`npm run hashes` regenerates them after an intentional change).

## Synthetic files (M00)

| File              | Exercises                                                                             |
| ----------------- | ------------------------------------------------------------------------------------- |
| `blank.pdf`       | 1 A4 page, no content                                                                 |
| `multipage.pdf`   | 5 pages: A4 ×2, Letter, landscape A4, A4 with `/Rotate 90`; page numbers drawn        |
| `text.pdf`        | Helvetica / Times / Courier at 24, 11, 10, 9 pt; wrapped paragraphs; rotated run      |
| `image.pdf`       | Embedded 64×64 RGB PNG drawn twice (scaled, rotated)                                  |
| `form.pdf`        | AcroForm: text, checkbox (checked), radio group, dropdown, multiline text, button     |
| `annotated.pdf`   | Square, Circle, Highlight (QuadPoints), Text note, Ink annotations                    |
| `encrypted.pdf`   | RC4 128-bit standard security (R3). User password `ynot`, owner `owner`               |
| `outline.pdf`     | 3 pages, nested bookmarks (chapter → section) with XYZ destinations                   |
| `layers.pdf`      | Optional content: `Base` (on) and `Overlay` (off) with BDC/EMC marked content         |
| `attachments.pdf` | Two embedded files (`note.txt`, `people.csv`) in the EmbeddedFiles name tree          |
| `portfolio.pdf`   | A PDF Portfolio: `/Collection`, `/Folders` (root + "Statements"), five embedded files |

## Synthetic files added by M10

| File                   | Exercises                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `encrypted-aes128.pdf` | AESV2 / R4, user `ynot`, owner `owner`                                                                                      |
| `encrypted-aes256.pdf` | AESV3 / R6 (SHA-256 hash rounds), user `ynot`, owner `owner`                                                                |
| `encrypted-owner.pdf`  | RC4 R3 with an empty user password, owner `owner`, print/copy/modify denied (P = -3904)                                     |
| `rotated.pdf`          | 4 A5 pages with `/Rotate` 0/90/180/270 and an arrow pointing to the unrotated top                                           |
| `mixed-boxes.pdf`      | MediaBox ≠ CropBox with negative origin; CropBox larger than MediaBox; reversed arrays; art/trim/bleed                      |
| `page-labels.pdf`      | `/PageLabels`: i, ii, A-5, A-6, a, b                                                                                        |
| `links.pdf`            | Link annotations: URI with QuadPoints, `/Dest` XYZ, `/A GoTo Fit`                                                           |
| `forms-all.pdf`        | Every field type: text, multiline, password, read-only+required, checkbox ×2, radio, combo, list (multi), button, signature |
| `annotations-all.pdf`  | Every subtype of PDF 32000-1 table 169, a Popup, and a reply (`/IRT`, `/State Accepted`)                                    |
| `javascript.pdf`       | `/OpenAction` JavaScript, `/Names /JavaScript`, a field with `/AA`                                                          |
| `xfa.pdf`              | AcroForm + `/XFA` packet — engines must open it with `hasXfa = true`                                                        |
| `pdfa-1b.pdf`          | PDF/A-1b structure only: XMP with `pdfaid`, OutputIntent (placeholder ICC), MarkInfo                                        |
| `cjk-rtl.pdf`          | Non-embedded CJK (Type0 / UniGB-UCS2-H) and Hebrew (Differences + ToUnicode)                                                |
| `broken-xref.pdf`      | `blank.pdf` with a wrong `startxref` — PDFium reconstructs                                                                  |
| `truncated.pdf`        | `text.pdf` cut at 70 % — expected error `corrupt`                                                                           |
| `corrupt.pdf`          | PDF header followed by garbage — expected error `corrupt`                                                                   |
| `huge-page-count.pdf`  | 1000 tiny pages                                                                                                             |
| `scanned.pdf`          | Full-page 150-dpi grayscale "scan" (procedural), no text — OCR input for M90                                                |

## Synthetic files added by M41

| File         | Exercises                                                                                                                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skewed.pdf` | One grey "scan" drawn through a rotation about the page centre at +2.3°, −1.1° and +7.5°, then a blank page. The skew is in the content stream, so the angle is exact and all three pages share one image XObject; a Highlight sits over a word on page 1 |

## Synthetic files added by M100

| File          | Exercises                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bloated.pdf` | Everything an optimiser is for: 3 A4 pages of Helvetica, one 240 px photograph drawn 74 pt wide (233 dpi) and embedded **three times over** as three separate XObjects, a `/Thumb` on every page, and `/PieceInfo` on the catalogue. The Standard preset should take it under half its size with the page count, page sizes and text unchanged. |

## create/ — inputs for "Create PDF from …" (M91)

Generated by the same script; not PDFs, so not in `manifest.json` (the corpus test iterates
manifest keys only). Formatting is left as generated (`.prettierignore`).

| File                     | Exercises                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `photo-landscape.jpg`    | 300×200 baseline JPEG, JFIF density 72 dpi (units 1) — page size from dpi                           |
| `photo-exif-rotated.jpg` | 200×300 JPEG, EXIF Orientation 6 (rotate 90° CW), X/YResolution 150 dpi; arrow "up"                 |
| `chart-300dpi.png`       | 600×450 RGB PNG with a `pHYs` chunk of 300 dpi (11811 px/m) — a bar chart                           |
| `logo-alpha.png`         | 128×128 RGBA PNG: filled circle, fully transparent corners, soft alpha edge (SMask)                 |
| `scan-gray.png`          | 200×280 8-bit grayscale PNG (colour type 0), 200 dpi, horizontal "text lines"                       |
| `pages-3.tif`            | 3-page uncompressed RGB TIFF: 120×80, 80×120, 100×100, flat colours + page-number bar               |
| `deflate.tif`            | 64×64 RGB TIFF, Compression 8 (Adobe deflate, zlib strip), 96 dpi                                   |
| `tiny.bmp`               | 32×24 24-bit bottom-up BMP, 54-byte header, BGR rows padded to 4 bytes                              |
| `not-an-image.png`       | 64 bytes of ASCII text named `.png` — must fail with a clear "not an image" error                   |
| `site/index.html`        | Home: `<h1 id="top">`, banner with background, print stylesheet, 4 links, `<img>` to logo           |
| `site/about.html`        | Links to `index.html`, `contact.html` and `deep.html` (depth 2 from home)                           |
| `site/contact.html`      | `<h2 id="team">`, 60 paragraphs (prints to 2+ A4 pages), `mailto:` link                             |
| `site/deep.html`         | Reachable only via about (depth 3 from home) — crawl-depth limit test                               |
| `notes.md`               | GFM: h1–h3, bold/italic/code, link, lists, blockquote, fenced `ts`, aligned table, hr, image, tasks |
| `long.txt`               | 250 LF lines; every 10th ~320 chars with a 120-char unbreakable token; tabs; blank lines            |
| `unicode.txt`            | 12 lines: accents, curly quotes, dashes, €, and one CJK + emoji line (beyond WinAnsi)               |

## External files (pdf.js test suite)

`external/manifest.json` pins 35 files from `mozilla/pdf.js/test/pdfs` (Apache-2.0) by commit and
SHA-256; `npm run fetch-fixtures` downloads them into `external/` (git-ignored). They cover
real-world encryption, annotation appearance streams, widgets, XFA, damaged files, CJK/RTL
text and scan codecs (CCITT, JBIG2, JPX). See `external/README.md`.

## `local/` — operator's real-world PDFs (never committed)

Real files the operator supplies for hands-on testing live in `test/fixtures/local/`. The
folder is git-ignored except its README (they carry personal data). Tests may use them only
opportunistically — `it.skipIf(!existsSync(...))` — never as a required fixture, because CI
and other machines do not have them. See `local/README.md` for what is there.
