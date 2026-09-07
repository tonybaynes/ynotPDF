# resources

Data that can change without code changes: icons, stamps, fonts, OCR language data, page-size
presets, font-substitution tables. Prefer JSON/CSV data files here over literals in code.

- `build/` — installer assets (icons, background) used by electron-builder.
- `bin/` — per-OS native binaries fetched by `scripts/fetch-binaries.ts` (git-ignored).
- `binaries.json` — the pinned download manifest for `bin/`.
