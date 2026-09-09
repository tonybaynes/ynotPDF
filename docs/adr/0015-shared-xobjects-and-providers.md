# ADR 0015 — Shared XObjects, annotation providers, and the entries the shape family needs

- Status: accepted
- Date: 2026-09-09
- Module: M31 (shapes, ink & eraser, stamps, file attachments); consumed by M33, M60, M82

## Context

M31 is the second module that creates annotations, and four things the contracts could not say
came up in building it.

1. **A stamp is a picture placed many times.** The brief asks for it to be a Form XObject embedded
   once per document and referenced; `AppearanceStream` could only describe a stream of its own,
   with fonts and graphics states, and `FullRewriteWriter` attached one stream per annotation.
   Ten placements of one PNG would have been ten copies of the PNG.
2. **There is one overlay, one selection and one pointer controller, and they are M30's.** A second
   `AnnotationLayer` on the same page would fight the first for the same SVG element; a second
   controller would fight for the pointer. M31 needs its shapes selected, dragged, resized, nudged,
   deleted, copied and pasted exactly as M30's markup is, plus vertex handles of its own.
3. **The shape family's dictionary entries have no PDFium setter and were not in the mapping.** A
   line's `/LE` is an array of two names, a cloud's `/BE` a dictionary, a dash a dictionary that
   has to merge into the `/BS` the border width already wrote, and a file attachment's `/FS` a
   reference to an object elsewhere in the file. `dict.ts` (ADR 0013) knew strings, names, numbers
   and number arrays.
4. **`writeAnnotation` dropped the appearance stream on every edit** (ADR 0013, so that
   `FPDFAnnot_SetColor` would run). For a stamp the appearance _is_ the content; dropping it on a
   move left a reopened stamp invisible.

## Decision

### 1. Shared XObjects: `AppearanceResources.xobjects` and `WritePlan.xobjects`

An appearance stream may name a shared XObject: `resources.xobjects` maps the name the content
uses (`/Fm1`) to a **key**. `WritePlan.xobjects` maps each key to its source — `{ kind: 'form',
content, bbox, resources }` for a drawing of ours, `{ kind: 'image', format: 'png', data, width,
height }` for a picture. `FullRewriteWriter` embeds each key **once per write**, only when a stream
names it, and points every stream that names it at the same object. `ContentBuilder.drawXObject`
emits `q <matrix> cm /Fm1 Do Q` and registers the name.

Sources live in `Document.custom['xobjects']`, written by a `SetCustomCommand`, so they are
undoable, journalled and in the recovery file; `buildWritePlan` copies that namespace into the
plan. Bytes travel as base64 because the plan is JSON.

**Every custom stamp is PNG** (operator, 2026-09-09): a picture file is re-encoded, a clipboard
image already is one, a PDF page is rendered by the engine. One stored format, and the
"treat white as transparent" import option works for all of them. The `pdf` source kind that a
first draft had is gone.

### 2. `AnnotationService.registerProvider`

An `AnnotationProvider` says which annotations it owns (`owns`), what the overlay draws for them
(`toLayer`), how a move, a resize and a handle drag patch their geometry (`movePatch`,
`resizePatch`, `handlePatch`), what runs after a change (`afterChange` — M31 pushes a shape's
appearance into PDFium), what the properties panel shows (`panel`, `describe`), what a double-click
does (`open`), and which tool ids are creation tools the controller must stand aside for. M30's
service consults providers before its own families; everything else is shared.

`AnnotationLayer` gains `HandleSet 'vertices'` with `LayerAnnotation.vertices` (one handle per point,
`v0…vN`) and `ShapeImage` (a `data:` picture in page space, for a custom stamp while it is edited).
Both additive.

### 3. `DictValue` gains `names`, `dict` and `embeddedFile`

- `names` — an array of names: `/LE [/None /OpenArrow]`.
- `dict` — a dictionary, **merged** into one the annotation already has: `/BE << /S /C /I 1 >>`,
  and `/BS << /S /D /D [3 2] >>` beside the `/W` the border width wrote. A `null` inside removes
  that entry, which is how a dash goes back to solid.
- `embeddedFile` — the name of a file in the `/EmbeddedFiles` name tree. The writer resolves it to
  the file specification, sets the entry (`/FS`) to it, and **removes the name-tree entry** so the
  file is listed once, on the annotation. The specification's `/Desc` and the stream's `/Subtype`
  are moved out of `/Params` on the way, as `writeAttachments` does for tree entries.

A `DictMapping` may carry an `encode` function for the kinds whose model shape is not the PDF
shape: `dashArray: [3, 2]` → the `/BS` dictionary, `cloudy: 1` → the `/BE` dictionary. The list
stays closed.

The PDFium adapter's raw pass (`rawdoc.ts`) reads `/LE` (two names), `/BE /I` and `/BS /D` back
for the shape family, so a reopened file says what was written.

### 4. A stamp's appearance survives a move

`writeAnnotation` takes `{ keepAppearance }`; `PdfiumEngine.updateAnnotation` sets it for a Stamp
or a FileAttachment when the patch carries no visual property (no colour, border, quads, paths or
opacity). PDF maps the stream's `/BBox` to the new `/Rect`, so the picture follows. The service
drops the stream explicitly — `setAnnotationAppearance(null)` plus `extra.hasAP = false` — when it
changes something the picture must redraw for, and only when it can redraw it: a custom stamp
reopened from a file can be moved and resized but not turned, and the panel says so in words.

### 4a. The adapter installs the app's own appearance for Square, Circle and Ink

`PdfiumEngine.addAnnotation` and `updateAnnotation` generate the app's appearance for those three
subtypes and set it with `FPDFAnnot_SetAP` before the page reloads. PDFium would otherwise build
its own as the page loads — and, for an Ink, inflate `/Rect` by half the border width on every
regeneration, which the model never hears of, so after a few edits M21's writer refused to touch
the annotation. With an `/AP` already there PDFium generates nothing; the rect stays what the model
said, and the live page shows the cloud, the dash and the smoothed stroke. Pure vector only, which
is all `FPDFAnnot_SetAP` can carry (ADR 0013); nothing above the engine changes.

### 4b. A creation tool owns the keyboard while it is active

M30's `AnnotationController` handles Enter, Escape, Delete and the arrows for the selection. While
a tool a provider declared as a creation tool is active, it stands aside for keys as it already
did for the pointer, so the Enter that finishes a polygon reaches the tool through the viewer's
own routing rather than opening the popup of whatever is selected. M30's own creation tools take
no keys and are unaffected.

### 5. `Document.rebindAttachments` pairs by engine key, not by page

A file a FileAttachment annotation made this session is in the name tree (`att.<n>`) _and_ pinned
to a page in the model. Rebinding after an add or a delete now walks the records whose engine key
is a tree key, so a page-pinned file still shifts with its neighbours.

## Alternatives considered

- **A second `AnnotationLayer` for M31.** Rejected: `paintPage` replaces the SVG's children, so two
  layers on one element erase each other, and two controllers on one viewport both take the press.
- **One appearance stream per placement with the picture inlined.** The simple thing, and what the
  brief forbids: ten placements of a 300 KB PNG is 3 MB.
- **Storing the smoothed ink.** Would make the eraser cut an approximation of what was drawn.
  `/InkList` holds the raw points and every viewer without our `/AP` draws the same polyline.
- **Keeping the `pdf` source kind for custom stamps.** Sharper, but two stored formats and no way
  to knock out white. The operator chose one format.

## Consequences

- `src/engine/appearance/types.ts` gains an optional field; `content.ts` two methods and the
  `PathOp` type; `dict.ts` three kinds and `encode`; `Writer.ts` one plan section and one type;
  `PdfEngine` is unchanged. All additive.
- `src/renderer/modules/M30-markup-annotations/{AnnotationService,AnnotationController,PropertiesPanel}.ts`
  gain the provider hook; M30's own behaviour is unchanged when no provider is registered.
- `src/engine/pdfium/mutations.ts` — one behaviour change, for two subtypes, with a test;
  `PdfiumEngine.ts` — the appearance installed for three subtypes, with a test.
- `scripts/lib/register-ts.mjs` — a resolve hook so a script can import the engine's own
  TypeScript (Node resolves `./content`, not `./content.ts`); used by `npm run stamps`.
- `src/renderer/core/Document.ts` — one behaviour change in `rebindAttachments`, with a test.
- M33's measurements and M82's signatures register a provider and put their pictures in
  `custom.xobjects`; nothing else has to move.
