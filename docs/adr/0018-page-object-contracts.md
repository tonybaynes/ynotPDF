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

`setObjectMatrix`, `removeObject`, `insertObject`, `reorderObjects`, `objectAsPdf`
and `generateContent`, implemented in `src/engine/pdfium/objects.ts` over PDFium's
page-object API. All are additive: `NotImplementedEngine` rejects them and the RPC
list grows by six names.

`objectAsPdf(doc, page, index)` returns a **one-page PDF containing only that object**,
made by importing the page into a scratch document and destroying every other object.
That single value is the clipboard payload, the paste source and the writer's input,
so a copy carries its own resources — fonts, images, colour spaces — and pastes into
another document without hunting for them.

### 3. The split that keeps unknown operators: the engine renders, the writer writes

**The object mutations deliberately do not call `FPDFPage_GenerateContent`.** PDFium
renders from its parsed object list, so a matrix change is visible in the very next
render; but the bytes `PdfEngine.save()` produces still carry the _original_ content
stream. The edit reaches the file through the writer instead, which replays it onto
those original bytes with the parser above — so every operator PDFium does not model
survives the save.

One exception, and it is explicit. Z-order and grouping rewrite the _order_ of
objects, and re-establishing each moved object's full graphics state from the outside
is exactly the reconstruction that loses things. Those go the other way: the engine
reorders its object list and **does** generate content for that page, and the writer
plans nothing for it. So per page there is one path, never two:

| Page has                           | Path                                  | Unknown operators |
| ---------------------------------- | ------------------------------------- | ----------------- |
| transforms, deletions, pastes only | writer replays onto original bytes    | preserved         |
| any z-order or group change        | PDFium regenerates that page's stream | lost on that page |

`buildWritePlan` decides which, and `SaveService` asks the engine to generate content
for the pages on the second row before it reads the base bytes.

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
