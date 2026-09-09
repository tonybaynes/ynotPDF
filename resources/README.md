# resources

Data that can change without code changes: icons, stamps, fonts, OCR language data, page-size
presets, font-substitution tables. Prefer JSON/CSV data files here over literals in code.

- `annotations/` — the comment tools' colour presets and font list (M30). The colours are **PDF
  content colours**, not theme tokens: a highlight keeps its colour when the reader changes theme,
  so they cannot come from `src/renderer/theme/`. Each is named, because a swatch that says only
  its colour says nothing to a colourblind reader.
- `build/` — installer assets (icons, background) used by electron-builder.
- `bin/` — per-OS native binaries fetched by `scripts/fetch-binaries.ts` (git-ignored).
- `binaries.json` — the pinned download manifest for `bin/`.
