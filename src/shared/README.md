# src/shared

Types and contracts shared by **all** processes (main, preload, renderer, engine worker).
Nothing here may import Electron, Node or DOM APIs — it must compile everywhere.

| File        | What                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `pdf.ts`    | PDF geometry: points, rects, rotation, page size, unit helpers.                                                |
| `module.ts` | `ModuleManifest`, `CommandSpec`, `RibbonGroupSpec`, `PanelSpec`, `ToolSpec`, `ShortcutSpec`, `SettingsSchema`. |
| `ipc.ts`    | Typed IPC channel map plus `invoke` / `on` helpers. Preload exposes exactly this.                              |

Changing any of these is a **contract change**: write an ADR in `docs/adr/` and merge it as its
own small PR first (PLAN.md §12.5). Additions should be optional/additive.
