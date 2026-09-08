# M11 — Viewer

The page view the reader actually uses: rendering, navigation, zoom, layouts, rulers and guides,
split view, reading mode and the tools that point at a page.

The reusable machinery lives in `src/renderer/view/` (see its README). This folder is the module:
what the reader can reach, and how it plugs into the shell.

| File               | What                                                                                |
| ------------------ | ----------------------------------------------------------------------------------- |
| `manifest.ts`      | Commands, View ribbon groups, tools, shortcuts, context menu, settings schema.      |
| `ViewerService.ts` | One `Viewer` per tab; opening documents; the `ui.view` bridge; per-document memory. |
| `Viewer.ts`        | One tab's panes, overlays, history, auto-scroll, loupe, HUD and input handling.     |
| `tools.ts`         | Hand, Select text (M13 finishes it), Marquee zoom, Loupe.                           |
| `password.ts`      | The opaque password prompt, with show/hide and a worded retry.                      |
| `settings.ts`      | `viewer.*` settings, their schema, and the per-document place-keeping.              |

## How it joins the app

- **The store is the contract.** M02 registered `view.page.*`, `view.zoom.*` and `view.layout.*`,
  which only write `ui.view`. `ViewerService.install()` applies that slice to the viewport and
  writes the viewport's own state back, so the status bar, the ribbon toggles, the palette and
  the tests all read one object. M11 adds only the commands M02 could not: rotation, fit visible,
  rulers, grid, guides, split, full screen, reading mode, auto-scroll, the loupe, the rendering
  options and the view history.
- **Opening a file** goes `file.openBytes` (M00) → `view.openFile` → `DocumentService` (M20) →
  a tab, a `Document` and a `Viewer`. Drag-drop, the OS file association and a `.pdf` on the
  command line all arrive through the same door.
- **Tools** are declared on the manifest, because the shell hands page layers the _manifest's_
  specs; they reach the active viewer through the module-level `live` reference that `activate`
  sets, not through a closure captured when the manifest was built.
- **Night Mode** is M01's toggle. M11 subscribes to it and applies the matching inversion to the
  rendered raster (`view/night.ts`), so an open document darkens too.

## What later modules should use

- `PageView.layers.text` / `.annot` / `.widget` / `.object` are empty hosts waiting for M13, M30,
  M60 and M50. They already exist on every page and are sized to it.
- `PageView.transform` carries the page's `/Rotate` _and_ the view rotation. Use it rather than
  the page's `/Rotate` when placing an overlay, or a rotated view will put things in the wrong
  place.
- `Viewer.snap(page, point)` is the one implementation of "snap to the grid and the guides".
- `ToolSpec` handlers receive `ToolPointerEvent` in PDF user space, with the raw `PointerEvent`
  under `original` when a gesture needs screen pixels.
