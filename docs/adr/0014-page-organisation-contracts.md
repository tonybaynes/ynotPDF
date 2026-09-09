# ADR 0014 — An empty document from the engine, for page organisation

- **Status:** accepted
- **Date:** 2026-09-09
- **Module:** M40 (Organise pages), needed again by M41 (merge, split, extract to files)
- **Supersedes / amends:** nothing. Additive to ADR 0005 / 0007's `PdfEngine`.

## Context

M40 has to build documents that did not come from a file:

- **Extract** takes pages 2–4 out of the open document and makes a new PDF of them, either saved
  to disk or opened in a tab.
- **Extract one file per page** does that once per page, with a naming pattern.
- M41 will need the same primitive twice more, for **split** and for **merge**.

`PdfEngine` can already copy pages between two open documents — `importPages(target, source,
pages, at)` (ADR 0007) — but it has no way to _make_ the target. Every entry point into the
engine takes bytes: `open(bytes)`.

Three ways to get an empty target were considered.

1. **Create a blank page through M91 and delete it afterwards.** M91's blank converter produces a
   real one-page PDF, which could be opened and then have its page removed once the extracted
   pages are in. It works, but the extracted file is then the descendant of a document that had a
   page of some arbitrary size, `FPDFPage_Delete` runs on the reader's behalf for no reason they
   asked for, and the produced file carries M91's producer string. It also makes M40 depend on
   M91 for something that has nothing to do with converting anything.
2. **Assemble the file in pdf-lib** (M21's writer already has pdf-lib loaded). This means a second
   implementation of "copy a page with its resources", which is exactly what ADR 0010 refused to
   do for the writer, and for the same reason: two implementations of one operation are two
   chances to disagree, and only one of them is PDFium's.
3. **Ask the engine for an empty document.** PDFium has `FPDF_CreateNewDocument`, it is exported
   by the wasm build already in `package.json` (`@hyzyla/pdfium` 2.1.13, verified), and it is the
   exact counterpart of `importPages`.

## Decision

Add one method to `PdfEngine`:

```ts
/** A new, empty document with no pages. The caller owns the handle and must `close` it. */
createDocument(): Promise<DocHandle>;
```

- **Additive**, as PLAN.md §12.5 requires: a new optional-in-practice method, no signature
  changed. `NotImplementedEngine` rejects with `NotImplementedError`, so a backend that cannot do
  it says so in the one way the command layer already understands.
- The handle behaves like any other: `importPages`, `deletePages`, `annotations`,
  `deleteAnnotation`, `save` and `close` all work on it. A document with no pages is legal inside
  the engine and illegal in a file, so `save` on an empty one is the caller's mistake — M40 never
  saves before importing.
- `ENGINE_METHODS` gains the name, so the Worker RPC forwards it with no other change.

## Consequences

- M40 extracts by `createDocument()` → `importPages(new, open, pages, 0)` → optionally strip
  markup annotations → `save()`. That is four calls and no second PDF implementation.
- M41 gets split and merge for free from the same call.
- The PDFium adapter grows about ten lines. `FPDF_CreateNewDocument` cannot fail for want of
  input; it returns `0` only when the wasm heap is exhausted, which is reported as
  `EngineError('internal')` like every other allocation failure in the adapter.
- `FakeEngine` (the unit tests' in-memory engine) implements it too, so the model tests can build
  an extracted document without PDFium.

## Also in this module, and deliberately _not_ a contract change

`pageLabelNums` in `src/engine/writers/FullRewriteWriter.ts` learns to recognise runs of roman
and alphabetic page labels, not only decimal ones, so a range labelled "i, ii, iii…" is written
as `/S /r` rather than as one `/P` literal per page. That is an improvement inside an exported
pure function with its own unit test, reversible by construction (every run must reproduce the
exact strings it replaced, or it stays a literal), and it changes no type and no signature. It is
recorded here only so the shared-file edit has a reason attached to it.
