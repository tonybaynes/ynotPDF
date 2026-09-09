# M31 — Annotations: shapes, ink & eraser, stamps, file attachments

The drawing tools. Rectangles, ovals, lines and arrows, polygons, polylines and clouds; the
pencil and its eraser; the stamp palette with the standard set, dynamic stamps and custom ones;
and a file pinned to a page.

Spec: [`docs/modules/M31-shapes-ink-stamps.md`](../../../../docs/modules/M31-shapes-ink-stamps.md).
Contracts it changed: [ADR 0015](../../../../docs/adr/0015-shared-xobjects-and-providers.md).

## The one rule to know

**M31 creates; M30 owns everything after that.** There is one annotation overlay, one selection and
one pointer controller in the app, and they are M30's. This module registers an
[`AnnotationProvider`](../M30-markup-annotations/AnnotationService.ts) — which annotations are its,
what the overlay draws for them, how a move, a resize and a vertex drag patch their geometry, and
what the properties panel shows — and the rest (marquee, nudge, delete, copy and paste, undo, the
panel's shared tail) comes for free. A second overlay would fight the first for the same SVG.

## What is where

| File                | What it is                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `manifest.ts`       | Commands, the three Comment-tab groups, the tools, the stamp panel, the settings schema, the probes |
| `DrawingService.ts` | Creating shapes, strokes, stamps and attachments; ink grouping; the eraser; the stamp catalogue     |
| `provider.ts`       | The `AnnotationProvider`: what M30's overlay, selection and panel do with M31's annotations         |
| `tools.ts`          | The twelve `ToolSpec`s: drag a box, drag a line, click the corners, draw, rub out, place, pin       |
| `overlay.ts`        | **Pure.** Model annotation → what the overlay draws and lets you grab                               |
| `geometry.ts`       | **Pure.** Shift constraints, scaling geometry into a rect, the area highlight's quad                |
| `panel.ts`          | The properties sections: stroke, fill, dash, cloud, endings, stamp rotation, attachment icon        |
| `StampPanel.ts`     | The stamp palette (left dock) and the SVG preview of a catalogue stamp                              |
| `StampDialog.ts`    | Custom stamp from a picture, the clipboard or a PDF page: crop, white-to-transparent, name          |
| `stampImport.ts`    | Decoding, rendering a PDF page, cropping, knocking out white, encoding PNG                          |
| `commands.ts`       | `AttachFileCommand` — the one `Command` of its own — and its journal codec                          |
| `settings.ts`       | **Pure + storage.** Per-tool defaults, pencil and eraser settings, favourites, custom stamps        |

Shared code this module added elsewhere:

- [`src/engine/appearance/shapes.ts`](../../../engine/appearance/shapes.ts) — rect, ellipse, line
  endings, polygon, polyline, cloud; one list of drawings that the overlay paints and the writer
  bakes.
- [`src/engine/appearance/ink.ts`](../../../engine/appearance/ink.ts) — Catmull-Rom → Bézier
  smoothing, pressure widths, the eraser's cut.
- [`src/engine/appearance/stamp.ts`](../../../engine/appearance/stamp.ts) — the catalogue drawing,
  dynamic tokens, the fit-and-turn matrix, the `Do` appearance.
- [`src/engine/writers/FullRewriteWriter.ts`](../../../engine/writers/FullRewriteWriter.ts) — shared
  XObjects embedded once, `/LE` name arrays, `/BE` and `/BS` dictionaries merged, `/FS` resolved.
- [`resources/stamps/`](../../../../resources/stamps/) — the catalogue and the vector PDF of each
  stamp (`npm run stamps` regenerates them from the catalogue).

## Things that will surprise you

- **PDFium creates Square, Circle, Ink and Stamp; it refuses Line, Polygon, PolyLine and
  FileAttachment.** The refused ones live only in the model until a save inserts them (ADR 0013),
  and the overlay draws them. The created ones get _our_ appearance pushed into PDFium the moment
  they change, because PDFium's own drawing knows nothing of clouds, dashes or smoothing.
- **A stamp keeps its `/AP` through a move.** Its appearance is its content, so the engine no
  longer drops it on a geometry-only patch (`APPEARANCE_IS_CONTENT` in `pdfium/mutations.ts`).
  Turning one drops it on purpose, and only when the picture is known — a custom stamp reopened
  from a file can be moved and resized but not turned; the panel says so.
- **Every custom stamp is a PNG.** A JPEG is re-encoded, a clipboard image already is one, a PDF
  page is rendered. One stored format, and "treat white as transparent" works for all of them.
- **Ink stores raw points.** `/InkList` is what the pen drew; the smoothing is derived every time
  and never stored, so the eraser cuts the real stroke. Pressure lives in `extra.pressures` and
  only in the appearance.
- **The eraser splits into annotations.** In split mode the first fragment stays and every later
  one is a new Ink annotation — one composite command, one undo.
- **A file attachment is embedded through the engine and moved by the writer.** The bytes go into
  the `/EmbeddedFiles` name tree (the only place PDFium can put them), which is what gives M12's
  panel "open" and "save as"; on save the writer sets the annotation's `/FS` to that specification
  and takes it out of the tree so it is listed once.

## Testing

- `test/unit/drawing/` — the geometry (constraints, scaling, the rect a shape needs), the shapes
  and clouds and endings, the ink smoothing and the eraser's cut, the stamp drawing and matrix,
  the catalogue, the settings, the overlay's rules, the provider's patches, the manifest and the
  shortcut document, and a full save-and-reopen round trip through the real engine and the real
  writer — including ten placements of one PNG stamp counted in the file.
- `test/e2e/drawing.spec.ts` — one test per acceptance line, in the built app.
