# ADR 0007 — Document model contracts: stable ids, change events, journal, transactions

- Status: accepted
- Date: 2026-09-08
- Module: M20 (document model); consumed by M11, M12, M21, M30, M31, M40, M41, M60, M72, M120

## Context

M00 stubbed `Document`, `Command` and `UndoStack` with a working undo stack and a thin model
(pages, annotations by page, fields, outline, layers, attachments, metadata). M20 has to turn
that into the complete in-memory model of everything editable, and four things it needs are
contract-level, not module-level:

1. **Identity.** The stub addresses pages by index and annotations by the engine's
   `a<page>.<index>` id. Both renumber the moment a page moves or an annotation is deleted, so
   a selection, a comment reply or an undo entry captured before the change points at the wrong
   entity afterwards.
2. **Change granularity.** The stub bumps a single `revision` counter. A thumbnail panel, a
   comments panel and a page overlay all subscribe to the same store, so any edit anywhere
   repaints all of them.
3. **Persistence.** `Command.toJSON()` was optional and unused. M21 (autosave and crash
   recovery) and M120 (batch) both need to write a command sequence out and replay it.
4. **Transactions.** `UndoStack.group(label, fn)` only supports the callback form. A tool that
   starts a drag on pointer-down and finishes it on pointer-up cannot express that as a
   callback, so it either pushes many undo entries or none.

Two read-only facts the brief puts in the model — named destinations and a signature summary —
have no `PdfEngine` method, although the PDFium build M10 ships exports both APIs.

`PLAN.md` §12.5: contracts change only by ADR, and only additively.

## Decision

Everything below is additive. Code written against the M00 contracts compiles and behaves
unchanged: the existing `Document` methods keep their signatures, `UndoStack.group()` keeps its
semantics, and `Command` gains no required member.

### Stable ids (`src/renderer/core/Ids.ts`, new)

Every model entity carries a document-unique id — `pg-1`, `an-7`, `fl-2`, `ol-3`, `ly-1`,
`at-2`, `ds-4`, `wg-5`, `sg-1` — allocated by `IdAllocator` and never reused within a document,
including after undo. Ids survive reordering, deletion and restoration.

`IdTable` is the two-way map between a model id and the engine's key for the same entity (a page
index, an `a<page>.<index>` annotation id). Any engine call that renumbers rebinds it. This is
why an annotation that is deleted and then restored by undo keeps its model id while its engine
id changes: views, comment threads and selections stay valid across undo.

### Model shape (`Document.ts`)

`DocumentState` keeps its existing members and gains `pages` as `ReadonlyArray<ModelPage>`
(ordered, id-bearing), `annotations` keyed by page id, `fields` as a tree with widgets,
`destinations`, `signatures`, `security`, `view`, `custom` and `writeIntents`. `PageInfo` is
retained as an alias of `ModelPage` so M00-era code keeps compiling.

Annotations become a discriminated union over subtype families — markup, ink, shape, note, free
text, stamp, widget, link, file attachment, other — sharing an `AnnotationBase` of id, pageId,
rect, flags, author, dates, contents and appearance. Subtypes the classifier does not recognise
become `other` rather than failing, so no file is unopenable because of an annotation.

`Document.custom` is a namespaced bag: `document.custom('M30')` returns that module's slice.
Modules must not read another module's namespace.

### Change events

`document.on(type, handler)` and `document.onAny(handler)`, fired after the store notification
for the same change. Types: `page:added`, `page:removed`, `page:moved`, `page:changed`,
`annotation:added`, `annotation:changed`, `annotation:removed`, `field:changed`,
`outline:changed`, `layer:changed`, `attachment:added`, `attachment:removed`,
`metadata:changed`, `custom:changed`, `document:revision`. Each carries the id of what changed.
The store subscription is unchanged, so existing subscribers keep working.

### Journal (`src/renderer/core/Journal.ts`, new)

`Command.toJSON()` returns `{ id, data }` where `data` is plain JSON. A codec registered per
command type rebuilds the command against a document. `serialiseJournal(stack)` produces
`{ version, entries: [{ type, payload }] }`; `replayJournal(document, entries)` applies them in
order. `CompositeCommand` serialises its children, so a transaction round-trips as one entry.
Commands without a codec serialise as `null` and the journal records that the sequence is not
fully replayable, rather than silently losing a step.

### Transactions (`UndoStack`)

`beginTransaction(label, id?)`, `commit()` and `rollback()` share the group stack with the
existing `group(label, fn)`. Nesting either form flattens into one composite entry and one undo
step. `rollback()` undoes what was applied, in reverse, and records nothing.

### Write intents

A command reports whether the engine accepted its change. What the engine cannot express is
recorded as a `WriteIntent` on the document — `page-order`, `page-labels`, `metadata`, `layers`,
`outline`, `custom` — so M21's writer knows what it must apply on top of the engine's bytes
instead of diffing two documents.

### `PdfEngine` additions

- `signatures(doc): Promise<ReadonlyArray<SignatureSummary>>` — read-only summary of each
  signature field: reason, sub-filter, signing time, byte range, DocMDP permission. Backed by
  `FPDF_GetSignatureCount` / `FPDF_GetSignatureObject` and the `FPDFSignatureObj_*` getters.
  Validation is M81's job; this is what a viewer shows before any trust decision.
- `namedDestinations(doc): Promise<ReadonlyArray<NamedDestination>>` — `{ name, dest }` from
  `FPDF_CountNamedDests` / `FPDF_GetNamedDest`.

`NotImplementedEngine` gains both, and `ENGINE_METHODS` lists them so the worker proxy picks
them up automatically.

## Consequences

- Page order and page presence are model state, not engine state. `FPDFPage_Delete` is
  destructive and cannot be undone, so a delete that went to the engine would make undo a lie.
  Views resolve a model page id to the live PDFium index through `Document.enginePage(pageId)`,
  and M21's writer emits the model's order. Rotation, boxes, annotations, field values and
  blank pages we inserted ourselves are reversible in PDFium and do go to the engine, so a
  render reflects them immediately.
- M21 gets autosave and recovery from the journal without inventing its own format.
- M12, M30 and M32 can hold an id across an edit, which is what makes comment threads and
  thumbnail selection survive page reordering.
- The cost is one indirection on every page access in the view layer. It is a map lookup.
