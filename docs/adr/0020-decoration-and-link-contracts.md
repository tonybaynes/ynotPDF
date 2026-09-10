# 0020 — Page decorations and links: engine, writer and marker contracts

Status: accepted (M53, 2026-09-11)

## Context

M53 adds headers and footers, Bates numbering, watermarks, backgrounds and links.
The first four all put the same kind of thing on a page — a small piece of drawn
content that the reader adds, changes and takes away again as a unit, long after the
session that made it. The brief states the constraint plainly:

> Decorations are XObjects added to each page's content with a marker so later edits
> are exact and undoable; never bake into existing streams.

Three things follow from that and are what this ADR settles.

1. **A decoration has to be findable again.** "Update header" and "Remove watermark"
   have to reach exactly what we put there and nothing else — in this session, and in
   a file reopened next year.
2. **Adding one must not damage the page.** `FPDFPage_GenerateContent` re-emits a
   page from PDFium's parsed object list, so every operator PDFium does not model is
   lost (ADR 0018 §Context). Decorating a hundred pages would do that to a hundred
   pages.
3. **A link is an annotation PDFium refuses to create.** `FPDFPage_CreateAnnot` makes
   ten subtypes and Link is not one of them, so links take M30's "the writer inserts
   it" path (ADR 0013) — but a link's destination is a *reference to a page object*,
   which nothing in the plan could express.

## Decision

### 1. The marker is a PDFium content mark, not a dictionary key

Every decoration is drawn into a form XObject and invoked inside a marked-content
sequence tagged `/YNOTDec`:

```
/YNOTDec <</Id (d3) /Kind (header-footer) /Spec (\{...json...\})>> BDC
  q  <matrix> cm  /X1 Do  Q
EMC
```

The tag was chosen because it is the one marker that survives every path a decoration
takes:

- `FPDFPageObj_AddMark` puts it on the live object, so the session can find its own
  decorations however the object list has shifted underneath;
- `FPDFPage_GenerateContent` **writes it out** as the sequence above;
- reopening the file gives it back as a mark on the object (verified against the
  PDFium build we ship, not assumed);
- our own content parser (`src/engine/content/`) sees it as two ordinary ops, so the
  writer can find and remove the span without PDFium.

A key on the XObject's dictionary would have been lost the moment PDFium rebuilt the
XObject; a private `/PieceInfo` on the page cannot say *which* object.

`Spec` carries the decoration's settings as JSON. That is what makes "Update" possible
in a file this application did not open before: the dialog opens on what the last
person chose rather than on defaults.

### 2. Two engine methods, additive (`PdfEngine`)

```ts
setDecorations(doc, page, items, sources?): Promise<void>;
decorations(doc, page): Promise<ReadonlyArray<FoundDecoration>>;
```

`setDecorations` **replaces** every `/YNOTDec`-marked object on the page with the
items given, so it is idempotent and one call expresses add, update and remove. Each
item is a `DecorationDraw` — content-stream text, a bounding box, a placement matrix,
its resources and whether it goes behind or in front of the page's own content — the
same shape the writer takes. `sources` supplies the pictures and PDF pages the
resources name, once per call.

`decorations` reads the marks back. It is what fills the dialogs in for a file the
reader opens with decorations already on it, and what "Remove all headers" counts.

Foreign decorations — another application's watermark — are reported by the same
method with `foreign: true` when the page carries a `/Watermark` annotation or an
optional-content group whose name says so. They can be counted and removed; they
cannot be edited, because nothing states what they were meant to be.

### 3. The writer restores the page and appends a stream

`PlannedPage.decorations` is a new sparse section:

```ts
interface PlannedDecorations {
  readonly original?: { readonly content: string; readonly resources: string };
  readonly items: ReadonlyArray<DecorationDraw>;
}
```

For each planned page the applier, in order:

1. **restores** the page's original content stream and `/Resources` when `original` is
   present and the page-object applier (M50) has not already done so — that undoes
   PDFium's regeneration, which is how requirement 2 is met;
2. **strips** every `/YNOTDec … BDC … EMC` span from the content, whatever wrote it,
   and drops any `/Contents` array element that is one of ours;
3. **appends** a new content stream to the page's `/Contents` array holding the
   planned decorations, each wrapped in its marked-content sequence.

Step 3 never touches an existing stream: `/Contents` is an array, and a new element is
new bytes beside the old ones. Step 2 is what makes the whole thing order-independent
— it does not matter whether M50 captured its original before or after a decoration
went on, because any baked copy is removed before a fresh one is written.

The appended stream is preceded by a guard element holding `q` and followed by the
matching `Q`s, computed from the real nesting depth of the streams before it, so a
producer that left a `q` open cannot drag the decoration out of place.

### 4. `PlannedXObject` gains a `pdf` kind

A watermark or background can be a page of another PDF. The existing kinds are a
content stream and a PNG; neither can carry one. The new kind is
`{ kind: 'pdf', data, page }` and the writer embeds it with `PDFDocument.embedPdf`,
once per key like the others (ADR 0015).

### 5. `PlannedAnnotation` gains `dest`

A link's `/Dest` (or the `/D` of its `/A /GoTo`) is an array whose first element is a
*reference to a page*. `PlannedAnnotationProperties.entries` is values, not references,
so a link could not be planned. `PlannedAnnotation.dest: PlannedDestination | null`
reuses the destination shape the outline and the name tree already use — it indexes
`WritePlan.pages`, so a link still points at the right page after a reorder.

Everything else about a link is expressible today: `/A` for a URI, a remote go-to, a
launch or an open action is a `DictValue` dictionary through the `linkAction` mapping
in `engine/appearance/dict.ts`; `/Border`, `/H` and `/BS` are the border the reader
chose.

### 6. A `link` overlay layer

`LAYER_NAMES` gains `link`, between `annot` and `widget`. The layer draws the outline
of each link — dashed while the link tool is active, invisible otherwise — and is what
a click on a link lands on. It takes pointer events only on the link boxes themselves,
raised above the tool layer exactly as M60's widget layer is and for the same reason
(ADR 0019 §Widget layer): a click anywhere else still reaches the active tool.

## Consequences

- Decorating a page costs one extra content stream and one form XObject per
  decoration, and leaves every byte of the page's own content where it was.
- A decoration made by ynotPDF is editable in ynotPDF forever, because the file itself
  carries what it was asked to be.
- Removing a decoration returns the page to bytes identical to the ones it was opened
  with, which is what the acceptance test asserts.
- A viewer that ignores marked content — every viewer — draws the decoration exactly
  as if it had been part of the page.
- `setDecorations` regenerates the page content it is called on, so a page that has
  never had a decoration and never will is never regenerated.
