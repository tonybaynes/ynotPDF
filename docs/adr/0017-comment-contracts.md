# ADR 0017 — Reply references, comment visibility, and drawing without the raster

- Status: accepted
- Date: 2026-09-09
- Module: M32 (comments panel, replies & status, FDF/XFDF, summarise); consumed by M13, M120

## Context

M32 builds the review workflow on top of the annotations M30 and M31 create. Three of the things
it needs cannot be said with the contracts as they stand.

1. **A reply is an object reference, and the plan has no way to write one.** `/IRT` must be an
   _indirect reference_ to the parent annotation's dictionary (ISO 32000-1, 12.5.6.2). Anything
   else — a string, a name, the parent's `/NM` written literally — is ignored by Acrobat, Foxit
   and PDFium alike, so a reply written that way is a loose sticky note. `DictValue`
   (ADR 0013, extended by ADR 0015) can express strings, names, numbers, arrays, nested
   dictionaries and a reference to an embedded file. It cannot express "the object of that other
   annotation on this page", and neither `toEngineAnnotation` nor `PdfiumEngine` writes `/IRT`
   at all: M30 could hold a reply thread in the model, but a save lost it.
2. **Hiding a comment must not change the document.** Foxit and Acrobat both let a reader hide
   comments by type, by author and by status, and neither writes anything to the file for it.
   Our raster comes from PDFium, which draws either every annotation on a page or none of them
   (`FPDF_ANNOT`), and has no per-annotation filter. The only in-file switch is the annotation's
   own `/F` hidden bit — which lives in the bytes `engine.save()` hands the writer, so setting it
   for a view filter would ship hidden annotations in the saved file. `RenderFlags.annotations`
   exists but is hard-coded `true` by `ViewerService.flags()`.
3. **The overlay refuses to draw what the raster is carrying, and that is the wrong rule when the
   raster is off.** `AnnotationProvider.toLayer` (ADR 0015) decides per annotation whether the
   SVG layer draws it, and the rule — correctly — is "draw exactly what PDFium does not". With
   annotation rendering switched off there is nothing to collide with, and the same generators
   that already draw a FreeText need to draw a highlight as well.

## Decision

### 1. `DictValue` gains `annotationRef`

```ts
| { readonly kind: 'annotationRef'; readonly value: string }
```

`value` is the target annotation's `/NM` name. `FullRewriteWriter` resolves it **after** every
planned annotation on the page has been created, by scanning the page's `/Annots` for a
dictionary whose `/NM` matches, and sets the entry to that object's reference. A name that
matches nothing is a warning, not a failure: the reply is written without `/IRT` — a note in the
right place beats a broken reference.

`plan.ts` turns the model's `inReplyTo` (a `ModelId`) into the parent's `/NM` while it builds
`changedProperties`, because the plan is the last place that can still see both. An annotation
being replied to that has no `/NM` is given one by M32 before the reply is made, so the name is
always there by save time.

Two mappings join `ANNOTATION_DICT_MAPPINGS`:

| model key   | PDF key | kind            | engine-writable |
| ----------- | ------- | --------------- | --------------- |
| `replyType` | `/RT`   | `name`          | yes             |
| `inReplyTo` | `/IRT`  | `annotationRef` | no              |

`inReplyTo` is not read from `extra` — it is a first-class model field — so `dictEntries` never
produces it; `plan.ts` adds the entry itself using the mapping's PDF key. Keeping it in the table
anyway is what makes the table still the single answer to "which PDF key is that?".

### 2. `ViewerService.setAnnotationsVisible(visible)`

M11's `flags()` reads a field instead of the literal `true`, and the new method sets it and
repaints every open viewer. Nothing else changes: the flag was always part of `RenderFlags` and
part of every tile's cache key, so turning it off and on again reuses tiles rather than
re-rendering them.

### 3. `AnnotationProvider.toLayer` gains `raster?: boolean`

```ts
toLayer(a, page, { edited, hidden?, raster? }): LayerAnnotation
```

`raster` defaults to `true` and means "the tile raster is drawing annotation appearance streams".
When it is `false`, `drawnByOverlay` returns true for every annotation the provider owns that is
not hidden — so the overlay draws the whole comment layer itself. M30 and M31 each thread the
option through their own `drawnByOverlay`; no other behaviour changes.

`AnnotationService` gains `setVisibility(filter | null)`: a predicate M32 registers. An
annotation the filter rejects is passed to the provider with `hidden: true`, which the layer
already understands (it neither draws nor hit-tests a hidden annotation). Registering any filter
is what switches the raster off; clearing it switches the raster back on.

## Consequences

- A reply thread survives a save, which is what makes the Comments panel worth having.
- Hiding comments never touches the file. The cost is that while a filter is on, every visible
  annotation is drawn by our own generators rather than by PDFium — close, but not byte-identical
  for annotations that arrived from another editor with an appearance we do not reproduce
  exactly. Turning the filter off restores PDFium's drawing immediately, and the file is
  unchanged throughout. The alternative — writing `/F` — would have been faithful on screen and
  wrong in the file, which is the worse trade.
- `annotationRef` is the second `DictValue` kind that resolves against something else in the
  document (`embeddedFile` was the first). Both are resolved by the writer, not the plan, because
  only the writer has the object graph.
