# ADR 0017 — Document properties: what the engine reads, what the writer writes

- **Status:** accepted
- **Date:** 2026-09-09
- **Module:** M72 (Document properties, metadata & XMP, initial view)
- **Supersedes / amends:** nothing. Additive to ADR 0005 / 0007 (`PdfEngine`), ADR 0010 (`Writer`),
  ADR 0007 (`Document` model).
- **Numbering:** M32 and M41 are in flight on their own branches and cannot see this number until
  it merges. Whoever lands last renumbers, as ADR 0016 records having done twice.

## Context

The Document Properties dialog has to show, and let the reader change, six kinds of fact that
nothing in the app can currently reach:

1. **Custom Info-dictionary entries** — arbitrary keys beside `/Title` and `/Author`. `Metadata`
   has fixed fields only, so a custom property is invisible on open and lost on save.
2. **`/Trapped`, `/Lang` and the base URL** (`/URI /Base`) — Foxit's Advanced tab, three plain
   document facts with nowhere to live.
3. **The fonts a document uses**, with their type, embedding, subsetting and encoding. PDFium's
   text API reports the font of a glyph that was actually drawn; it cannot enumerate the
   `/Resources /Font` dictionaries, which is what a Fonts tab lists.
4. **How the file asks to be opened** — `/PageMode`, `/PageLayout`, `/OpenAction` and
   `/ViewerPreferences`. M20 declared `ViewSettings` for exactly this and left it at defaults,
   because nothing read it and nothing wrote it.
5. **Writing all of the above back.** `WritePlan.metadata` covers the six standard Info keys and
   the XMP packet, and stops there.
6. **XMP that agrees with the Info dictionary** without destroying the packets already in the
   file.

## Decision

### `PdfEngine` — two new reads and four optional fields

```ts
/** Fonts the document's page resources name, deduplicated, in first-use order. */
fonts(doc: DocHandle): Promise<ReadonlyArray<FontUsage>>;

/** `/PageMode`, `/PageLayout`, `/OpenAction` and `/ViewerPreferences`. */
initialView(doc: DocHandle): Promise<InitialView>;
```

and `Metadata` gains `custom?`, `trapped?`, `lang?`, `baseUrl?` — all optional, so every existing
reader of `Metadata` compiles and behaves unchanged.

Both methods are **additive**, as PLAN.md §12.5 requires: no signature changes, `ENGINE_METHODS`
gains the two names so the Worker RPC forwards them, and `NotImplementedEngine` rejects with
`NotImplementedError` — the one failure the command layer already understands.

Both are implemented in `src/engine/pdfium/rawdoc.ts`, the pdf-lib reader M10 already uses for
optional-content groups, XMP and annotation colours, for the reason ADR 0006 gives: PDFium has no
API for either, and the raw dictionaries are exact where an inference would be a guess.

### `Document` — `ViewSettings` filled in, metadata widened

`ViewSettings` gains `pageLayout` and the seven viewer preferences the dialog offers
(`hideToolbar`, `hideMenubar`, `hideWindowUi`, `fitWindow`, `centreWindow`, `displayDocTitle`,
`printScaling`, `direction`); `ModelMetadata` gains `custom`, `trapped`, `lang` and `baseUrl`.
`Document.build` fills both from the engine, and `Document.setViewRecord()` is the setter M72's
command uses — the same shape as the `setMetadataRecord` that is already there.

`WriteIntent` gains `'view'`.

### `Writer` — one new plan section, two new metadata keys

```ts
/** `/PageMode`, `/PageLayout`, `/OpenAction`, `/ViewerPreferences`, `/Lang`, `/URI /Base`. */
readonly view: PlannedView | null;
```

`PlannedMetadata` gains `custom?: Readonly<Record<string, string | null>>` and `trapped?`.
`WRITE_PHASES` gains `'view'` between `metadata` and `outline`. The section is nullable like every
other: a document nobody changed plans no view, and the writer touches no catalogue entry.

## Alternatives considered

- **A save-pipeline stage (ADR 0012's mechanism) instead of a plan section.** M72 could take the
  writer's bytes and edit the catalogue itself. It needs no shared-file change at all, which is
  its whole appeal — and it means parsing and re-serialising the document a second time, with a
  second implementation of "set an entry on the catalogue" that M80's incremental writer would
  then have to defeat. The plan section is what M12 and M42 both did for the same problem.
- **Custom properties in the module's `custom` bag rather than in `ModelMetadata`.** They are
  read from the file, so they must exist in the model before anyone edits anything; a bag entry
  that is populated on open is a second metadata record under another name.
- **Reading fonts through PDFium's `FPDFTextObj_GetFont`.** It reports the font of a text object,
  so a font named in `/Resources` but never used is missing, and a font inside a form XObject
  depends on whether the object was parsed. `pdffonts` reads the dictionaries; so do we.

## Consequences

- Every module that shows a font, a document language or an initial view reads it from the model
  rather than opening the file again. M92 (export), M94 (PDF/A) and M111 (accessibility) all need
  at least one of the three.
- `test/unit/roundtrip.ts` gains `viewSettings` and `fonts`, so from now on every save is checked
  for having kept them — including saves made by modules that have never heard of M72.
- An engine backend that is not PDFium answers `NotImplementedError` for both new methods; the
  Fonts tab then says the engine cannot list fonts, and the Initial View tab shows the defaults.
