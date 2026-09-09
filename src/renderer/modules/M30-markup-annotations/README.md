# M30 — Annotations: text markup, notes, typewriter, text box, callout

The first editing module. It turns a text selection into a highlight, drops sticky notes, types on
the page, and gives everything it makes a properties panel, a selection with handles, and an undo
step.

Spec: [`docs/modules/M30-markup-annotations.md`](../../../../docs/modules/M30-markup-annotations.md).
Contracts it changed: [ADR 0013](../../../../docs/adr/0013-annotation-contracts.md).

## The one rule to know

**The overlay draws exactly the annotations the raster does not carry.**

PDFium builds an appearance stream for Highlight, Underline, Squiggly, StrikeOut and Text as it
loads a page, so those are already in the tiles and the SVG layer only draws their selection
handles. FreeText and Caret get nothing from PDFium — it will not even _create_ them — so those
are drawn by the layer until a save has baked a real stream and a reopen has read it back.
`drawnByOverlay()` in [`shapes.ts`](./shapes.ts) is that rule, in six lines, with the reasoning
above it. Get it wrong in one direction and a highlight is drawn twice; in the other, a typewriter
note vanishes.

## What is where

| File                      | What it is                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `manifest.ts`             | Commands, the Comment ribbon tab, the tools, the properties panel, the settings schema, the probes |
| `AnnotationService.ts`    | Creating, selecting, moving, deleting, copying, pasting; the per-tab layer; identity and defaults  |
| `AnnotationController.ts` | Pointer and keyboard on the viewport — selection, dragging, nudging, Delete, the clipboard keys    |
| `tools.ts`                | Select Annotation, Note, Typewriter, Text Box, Callout as `ToolSpec`s                              |
| `quads.ts`                | **Pure.** Text spans → `/QuadPoints`, in the line's own axes; caret placement                      |
| `shapes.ts`               | **Pure.** Model annotation → what the overlay draws and hit-tests                                  |
| `presets.ts`              | **Pure.** The colour and font catalogues, from `resources/annotations/`                            |
| `settings.ts`             | **Pure + storage.** Per-tool defaults, "keep tool selected", the author identity                   |
| `clipboard.ts`            | **Pure.** Annotations as clipboard text, and the validation a foreign payload gets                 |
| `InlineEditor.ts`         | The `contenteditable` overlay a free-text annotation is typed into                                 |
| `NotePopup.ts`            | The opaque popup note, and the `/RC` rich text it writes                                           |
| `PropertiesPanel.ts`      | The right pane, bound to the selection                                                             |
| `identity.ts`             | The one dialog, asked once, before the first annotation                                            |

Shared code this module added elsewhere:

- [`src/renderer/view/AnnotationLayer.ts`](../../view/AnnotationLayer.ts) — the SVG overlay,
  handles, hit-testing and the marquee. In `view/` because M31, M33, M50 and M82 all need it.
- [`src/engine/appearance/`](../../../engine/appearance/) — `markup.ts` (quad-aware text markup and
  the caret), `freetext.ts` (`/DA`, `/DS`, layout, the callout), `note.ts` (the icon catalogue),
  `dict.ts` (model key ↔ PDF key).
- [`src/main/fonts.ts`](../../../main/fonts.ts) — the system font list, read from the OS font
  directories.

## Things that will surprise you

- **PDFium creates ten annotation subtypes and refuses the rest.** FreeText and Caret are among the
  refusals, so those are written by M21's writer instead — `PlannedAnnotation.insert`. Nothing
  above the model has to know, but it is why a free text is not in the live page raster.
- **`FPDFAnnot_SetColor` returns false while an annotation has an `/AP`.** That is why
  `writeAnnotation` drops the appearance stream _first_, and why a changed annotation is planned in
  full rather than only for its removals.
- **Markup tools are commands, not tools.** M13 owns selecting text; a second implementation would
  disagree with it about where a word ends. Choosing Highlight with nothing selected switches to
  Select Text, which is what the reader needs next.
- **The controller stands aside for Select Text, Snapshot and Marquee Zoom**, or a second highlight
  over the first one would be impossible: the press would pick up the annotation instead of
  starting a drag.
- **A note is always 20 × 20 points.** PDFium rewrites `/Rect` to that size when it loads a `Text`
  annotation, so offering a resize handle would be offering something that does not stick.
- **Colours here are document content.** A theme token colours the interface; a highlight's colour
  is written into the file and must survive a theme change, so the presets are `0xRRGGBB` values in
  `resources/annotations/colours.json` and every swatch carries its **name** as text beside a
  colour chip — a grid of unlabelled squares is unusable to this operator.

## Testing

- `test/unit/annotations/` — the quads (including a highlight across a line break on a rotated
  page), the appearance streams, the overlay's rules, the settings, the clipboard, the manifest,
  the font reader, and a full save/reopen round trip through the real engine and the real writer.
- `test/e2e/annotations.spec.ts` — one test per acceptance line, in the built app.
