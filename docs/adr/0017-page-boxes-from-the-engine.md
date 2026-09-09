# ADR 0017 — Reading all five page boxes from the engine

- **Status:** accepted
- **Date:** 2026-09-09
- **Module:** M41 (merge, split, crop & flatten)
- **Supersedes / amends:** nothing. Additive to ADR 0005 / 0007's `PdfEngine`.
- **Numbering:** the next free number on `main` at the time of writing. M32 and M72 are in
  flight on their own branches; parallel modules cannot see each other's unmerged ADR numbers,
  so whoever lands last renumbers — see ADR 0016 for the precedent.

## Context

M41's Crop Pages dialog offers the reader the four boxes Foxit's does — CropBox, TrimBox,
BleedBox and ArtBox — plus the MediaBox behind the "change page size" option. Writing them is
already solved: `SetPageBoxCommand` (M20) sends CropBox to the engine and records the other four
as a `page-boxes` write intent that M21's writer emits.

Reading them is not. `PdfEngine.pageSize` returns the displayed size, the CropBox and the
MediaBox, and nothing else; `ModelPage.bleedBox`, `trimBox` and `artBox` are therefore `null` on
every document the app opens, and `pageBox(page, 'trim')` falls back to the CropBox as the PDF
spec says it should. That fallback is correct for _rendering_ — a page with no TrimBox is trimmed
at its CropBox — but it is wrong for a dialog, which has to be able to tell the reader whether
this page has a TrimBox of its own and, if so, where it is. Offering "Trim" as a choice and then
silently showing the CropBox's numbers would be the dialog lying about the file.

The `mixed-boxes.pdf` fixture exists precisely because these five can disagree, and nothing in
the app could read four of them.

Three options were considered.

1. **Widen `pageSize` to return all five.** `PageSize` is used by the viewer on every page, every
   layout pass, and by the tile renderer; three more rectangles on it would be carried a million
   times to be read by one dialog. It is also a _breaking_ change to a type M11, M12, M13, M40
   and M42 all construct, which ADR 0005's rule against signature changes exists to prevent.
2. **Parse the boxes out of `engine.save()` bytes with pdf-lib.** No engine change, and M41
   already has pdf-lib to hand. But it serialises the whole document — hundreds of megabytes for
   the files the operator works with — to read twenty numbers, and it would read the boxes as
   they will be _written_, not as PDFium currently holds them, which is a difference that would
   surface as a wrong number the moment a crop had been applied but not saved.
3. **One new read-only method.** PDFium already exposes `FPDFPage_GetMediaBox`, `GetCropBox`,
   `GetBleedBox`, `GetTrimBox` and `GetArtBox`, each of which answers whether the box is present.

## Decision

Add one method to `PdfEngine`:

```ts
/** Every box the page actually defines. A box the page does not carry is `null`. */
pageBoxes(doc: DocHandle, page: PageIndex): Promise<PageBoxes>;
```

with

```ts
type PageBoxName = 'media' | 'crop' | 'bleed' | 'trim' | 'art'; // moved to @shared/pdf
type PageBoxes = Readonly<Record<PageBoxName, PdfRect | null>>;
```

`PageBoxName` moves from `@core/model` to `@shared/pdf`, which is where the other geometry types
already live, and `@core/model` re-exports it so every existing import keeps working. The engine
must not import from `@core`, and the alternative — a second, structurally identical union
declared in `PdfEngine.ts` — is the kind of duplication that drifts.

The method is **additive**: it is appended to `ENGINE_METHODS` (so the worker proxy forwards it),
implemented in `PdfiumEngine`, and answered by `NotImplementedEngine` with the usual rejection.
Nothing that exists changes behaviour. `setCropBox` stays exactly as it is; M41 does not need a
setter for the other four, because the write plan already carries them.

## Consequences

- M41's crop dialog can show, per page, which boxes the file actually defines, and can say "this
  page has no TrimBox" in words rather than showing the CropBox under a Trim label.
- `MediaBox` and `CropBox` come back non-null from any real document (PDFium synthesises a
  CropBox from the MediaBox when the file omits one, which is what every renderer does); the
  other three are `null` unless the file carries them.
- One more method on the four `PdfEngine` implementations. `NotImplementedEngine` and the
  in-memory test engine get it for free from their existing patterns.
- A future module that wants to _write_ Trim/Bleed/Art through the engine rather than the write
  plan — M94's PDF/A conversion is the likely one — adds `setPageBox` then, by the same rule.
