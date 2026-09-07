# resources/fonts

Fonts PDFium uses for **non-embedded** fonts so a document renders identically on Windows, macOS
and Linux (M10). The font files themselves are **not committed** — `npm run fetch-binaries`
downloads the pinned release archives listed in `resources/binaries.json` and extracts the
`.ttf` files here (git-ignored). The renderer build inlines whatever is present; when the files
are missing PDFium falls back to its built-in Foxit fonts (still deterministic, less faithful).

| Family                      | Version | Licence                                   | Stands in for                                                                 |
| --------------------------- | ------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| Liberation Sans/Serif/Mono  | 2.1.5   | SIL Open Font License 1.1                 | Arial/Helvetica, Times, Courier (metric-compatible)                           |
| DejaVu Sans/Serif/Sans Mono | 2.37    | Bitstream Vera licence (free, permissive) | Verdana, Georgia, Consolas; Greek, Cyrillic, Hebrew, Arabic, Baltic fallbacks |

`substitutions.json` is the data file that maps PDF font names and charsets to these files. Edit
it, not `src/engine/pdfium/fonts.ts`, to change a mapping.
