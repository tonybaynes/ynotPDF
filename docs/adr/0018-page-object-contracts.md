# 0018 — Page-object contracts: engine mutations, content streams and the writer

Status: accepted (M50, 2026-09-10)

## Context

M50 makes the content of a page editable as objects: select a text block, an image,
a path or a form XObject, then move, resize, rotate, flip, align, arrange, group,
delete, copy and paste it. Three contracts have to grow for that, and one new engine
sub-system has to exist.

Two constraints shape every decision below.

1. **Undo must be exact.** `FPDFPage_Delete` taught M20 the lesson: anything the
   engine cannot reverse is the model's business, not PDFium's.
2. **Nothing unknown may be lost.** A content stream carries operators PDFium models,
   operators it does not, marked content, optional content, and whatever a producer
   invented. `FPDFPage_GenerateContent` re-emits a stream from PDFium's parsed object
   list, so everything in that stream PDFium did not model is gone. M71 (redaction)
   and M51 (text editing) cannot be built on that.

## Decision

### 1. `src/engine/content/` — our own content-stream parser and serialiser

A new engine sub-system, independent of PDFium and of pdf-lib, shared with M51, M52
and M71:

- `lexer.ts` tokenises a content stream (numbers, names, literal and hex strings,
  arrays, dictionaries, booleans, `null`, comments, inline images, operators).
- `parser.ts` turns tokens into `ContentOp[]`. **Every op keeps the byte span it came
  from**, and the spans tile the input with no gaps: op _i_ owns everything from the
  end of op _i−1_ to the end of its own operator token, so whitespace and comments
  belong to an op rather than to nobody.
- `serialise.ts` writes ops back. An op that still has its span is copied byte for
  byte; only an op that was built or changed is formatted. A stream nothing touched
  therefore round-trips **byte-identical**, which is asserted over every fixture page.
- `objects.ts` scans the ops into _content objects_ — one per painted path, per
  text-showing operator, per `Do`, per `sh` and per inline image — each with the byte
  span of its own operators and the CTM in force at its start. The order matches
  PDFium's `pageObjects()` enumeration; a corpus test asserts that, kind by kind.
- `edit.ts` applies edits to the op list: `transform` wraps an object's span in
  `q … cm … Q`, `remove` drops it, `insert` splices new ops at an object boundary.

### 2. Engine mutations (additive to `PdfEngine`)

`pageContent`, `transformObject`, `setObjectMatrix`, `removeObject`, `restoreObject`,
`insertObject`, `reorderObjects`, `objectAsPdf`, `setObjectStyle` and `objectPath`,
implemented in `src/engine/pdfium/objects.ts` over PDFium's page-object API. All are
additive: `NotImplementedEngine` rejects them and the RPC list grows by ten names.
`removeObject` hands back a token and `restoreObject` takes it, because
`FPDFPage_RemoveObject` returns ownership of the object and keeping it aside is what
lets an undo put _the same_ object back rather than a form-XObject copy of it.

`objectAsPdf(doc, page, index)` returns a **one-page PDF containing only that object**,
made by importing the page into a scratch document and destroying every other object.
That single value is the clipboard payload, the paste source and the writer's input,
so a copy carries its own resources — fonts, images, colour spaces — and pastes into
another document without hunting for them.

### 3. The split that keeps unknown operators: the engine renders, the writer writes

**Every object mutation calls `FPDFPage_GenerateContent`**, so the engine's page is
self-consistent: M20's annotation methods unload and reload pages freely, and an edit
that lived only in PDFium's parsed object list would vanish under them. The price is
that the bytes `PdfEngine.save()` produces carry PDFium's _regenerated_ stream for
that page — with every resource renamed (`/FXX1`, `/FXF1`, …) and every operator
PDFium does not model gone.

So the renderer captures the page's **original content stream and `/Resources`**
(`PdfEngine.pageContent`) before the first edit on that page, keeps them in
`Document.custom('M50')`, and the writer puts both back and replays the edits onto the
original operators with the parser above. The resources travel as pdf-lib's
serialisation of the dictionary; the indirect references in it name objects that
PDFium's save and pdf-lib's both keep under their original numbers, which the writer
checks rather than assumes (a reference that no longer resolves leaves the page as the
engine wrote it, with a warning). Every operator PDFium does not model therefore
survives the save, and a full undo saves the file's own bytes for that page.

One exception, and it is explicit. Z-order rewrites the _order_ of objects, and
re-establishing each moved object's full graphics state from the outside is exactly
the reconstruction that loses things. A reordered page goes the other way: PDFium's
regenerated stream stands and the writer plans nothing for it. Grouping has no PDF
representation at all and touches neither. So per page there is one path, never two:

| Page has                                   | Path                                             | Unknown operators |
| ------------------------------------------ | ------------------------------------------------ | ----------------- |
| transforms, deletions, styles, pastes only | writer restores the original and replays onto it | preserved         |
| any z-order change still in effect         | PDFium's regenerated stream stands               | lost on that page |

`buildWritePlan` decides which from the live order alone (`isReordered`), so undoing
the z-order change puts the page back on the first row.

### 4. Writer contracts (additive)

- `PlannedPage.objects?: PlannedObjectEdit[]` — the edits to replay, plus `objectKinds`,
  the kind sequence PDFium reported when the edit was made. The applier compares that
  against its own scan of the page and refuses (with a warning, not a wrong write) if
  they disagree, so an index can never land on the wrong object.
- `PlannedXObject` gains `{ kind: 'pdf', data }` — a base64 one-page PDF embedded with
  pdf-lib's `embedPdf`. That is how a pasted object becomes a form XObject in the
  target file.

### 5. Model contracts (additive)

- A `page-objects` write intent.
- The module's state — the per-page edit list, groups, and the ids that survive a
  reload — lives in `Document.custom('M50')`, which is JSON, journalled, and recovered
  with everything else.

## Consequences

- A save that only moved an image is byte-identical to the original except inside that
  image's own `q … Q` wrapper.
- Clipping and nested `q/Q` come out right without special cases: a transform is
  conjugated into the object's own frame (`C⁻¹ · D · C`), which is what "move it 10 pt
  down the page" means when the object sits under a rotation.
- A clip set _outside_ an object's span does not move with it. That is the PDF
  semantic and what PDFium and Foxit both do; the properties panel says so.
- Pages whose z-order changed lose operators PDFium does not model. M80's incremental
  writer does not fix that; extending `edit.ts` with a reorder that reconstructs
  graphics state does, and is the natural next step for M52.
