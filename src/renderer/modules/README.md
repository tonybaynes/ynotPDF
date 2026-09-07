# src/renderer/modules

One folder per module: `<Mid>-<slug>/` with a `manifest.ts` default-exporting a
`ModuleManifest` (see `src/shared/module.ts`). Register it in `src/renderer/main.ts`.

A module writes only inside its own folder (plus its engine adapter, tests, spec and
`resources/` data). `M00-scaffold/` holds the application-level commands (open, about, undo,
redo, palette, quit) that exist before any feature module.
