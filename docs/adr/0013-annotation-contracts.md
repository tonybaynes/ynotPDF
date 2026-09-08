# ADR 0013 — Annotation contracts: appearance streams, dictionary entries and the system font list

- Status: accepted
- Date: 2026-09-08
- Module: M30 (text markup, notes, typewriter, text box, callout); consumed by M31, M32, M33, M60,
  M82

## Context

M30 is the first module that **creates** annotations, and building it turned up four things the
contracts as they stood could not express. None of them is a matter of taste; each is a place
where PDFium's public API stops.

1. **PDFium creates ten annotation subtypes and refuses the rest.** `FPDFPage_CreateAnnot` accepts
   Circle, Highlight, Ink, Popup, Square, Squiggly, Stamp, StrikeOut, Text and Underline. FreeText
   and Caret — the typewriter, the text box, the callout, and both proof-reading marks — are
   refused outright, and so are Line, Polygon and PolyLine, which M31 will want. `AddAnnotationCommand`
   reported this as an internal error and gave up.
2. **`FPDFAnnot_SetColor` refuses while an annotation has an `/AP`.** PDFium builds an appearance
   stream itself for most markup subtypes the moment a page loads, so in practice _every_ edit to
   a highlight's colour was silently dropped: the model changed, the file did not.
3. **PDFium's annotation API has no generic setter for numbers or arrays.**
   `FPDFAnnot_SetStringValue` is all there is, so `/CL` (a callout's leader line), `/Q`
   (alignment), `/Rotate` and `/RD` cannot be written through the engine at all — and `/Name`,
   which the spec wants as a _name_ object, comes out as a string.
4. **PDFium's Text appearance is one fixed yellow square**, whatever `/Name` says, and it rewrites
   `/Rect` to 20 × 20 on the way past. A reader who picks the Key icon sees a square.
5. **There is no font list.** Electron has no API for the fonts installed on a machine, and the
   module adds no libraries.

## Decision

### 1. A write plan can add an annotation, not only change one

`PlannedAnnotation` gains `insert?: boolean`. When it is set, `FullRewriteWriter` builds a fresh
dictionary — `/Type /Annot`, `/Subtype`, `/Rect` — appends it to the page's `/Annots` (creating
the array when the page has none) and then applies the entry's properties, dictionary entries and
appearance exactly as it does for an annotation that was already there.

`PdfiumEngine.addAnnotation` now reports a subtype PDFium will not create as
`EngineError('not-implemented')` rather than `'internal'`, which is what it is: a limit of the
backend. `AddAnnotationCommand` already treats that as "the engine could not, so the writer must"
and records the `annotations` write intent; `buildWritePlan` marks any annotation with no engine
binding as an insert. Nothing above the model changes.

**Consequence, stated plainly:** an annotation PDFium cannot create is not in the engine's copy of
the document, so it is not in the live page raster either. The annotation overlay draws it instead
(see below), and every later save re-derives it from the same journal, so the file is identical
whether it is saved once or five times.

### 2. A changed annotation is planned in full, not only its removals

M21 planned only the _nulls_, on the reasoning that a value the engine could set was already in
its bytes. Point 2 above is why that was too narrow. For an annotation the session actually
touched, `buildWritePlan` now writes the whole model record: contents, author, subject, name,
state, colour, interior colour, opacity, border width, flags, dates and geometry.

The risk the original comment named — overwriting something the model reads less exactly than the
file holds it — does not apply here, because this is only ever an annotation the reader has just
edited, and there the model _is_ the intent. Annotations the session did not touch are still
offered for appearance repair alone, with `replace: false`, exactly as before.

`writeAnnotation` in the PDFium adapter also drops the appearance stream **first** rather than
last, so the setters that refuse to run beside an `/AP` get their chance.

### 3. `Annotation.extra` reaches the file through one mapping table

`src/engine/appearance/dict.ts` is the only place that knows which model key is which PDF key:
`icon` → `/Name`, `defaultAppearance` → `/DA`, `defaultStyle` → `/DS`, `richContents` → `/RC`,
`intent` → `/IT`, `stateModel` → `/StateModel`, `callout` → `/CL`, `align` → `/Q`, `rotate` →
`/Rotate`, `padding` → `/RD`, `lineEnding` → `/LE`. Each entry says whether PDFium can write it
(only strings can), and `PlannedAnnotationProperties.entries` carries the rest to the writer as
typed values — a name where the spec wants a name, an array of numbers where it wants an array.

The list is closed on purpose. An unknown key in the bag is something another module put there for
its own use, and must not reach the file as a guess.

### 4. `PdfEngine.setAnnotationAppearance`

New method: `setAnnotationAppearance(doc, id, content | null)`. It writes content-stream text as
the annotation's `/AP /N`, or removes it so the backend draws its own again.

PDFium writes that stream with `/BBox` = `/Rect`, an identity `/Matrix` and **no `/Resources`**,
which is all its API allows — so only an appearance that needs no font and no graphics state may
go through it. Note icons qualify, because they are pure vector, and that is what this exists for:
the live page shows the icon the reader chose instead of PDFium's square. Free text does not
qualify, and is drawn by the annotation overlay until a save can attach real resources.

`AppearanceResources.fonts` also widens from `StandardFontName` to
`StandardFontName | NonEmbeddedFont`, so a stream can name a family the file does not embed.

### 5. `fonts:list` IPC, and what a system font means

Main walks the OS font directories and parses each file's sfnt `name` table for its family name
(id 16 where a font has one, else id 1), caching the answer for the life of the process. About
sixty lines, no new libraries.

A family that is not one of the base 14 is written into `/DA` and into a plain non-embedded
TrueType font dictionary, and laid out with the metrics of the standard face it maps to. **Nothing
is embedded**, because there is no font subsetter in this repo before M51. PDFium is both our
renderer and Chrome's, and both resolve such a name through the same bundled Liberation/DejaVu
substitutes, so the two agree; an editor that has the real family uses it. The properties panel
says so in words rather than leaving the reader to find out.

## Alternatives considered

- **Create a Stamp and change its `/Subtype`.** PDFium has no name setter, so this is not
  available; and even if it were, it would leave the annotation carrying a stamp's other entries.
- **Draw free text through `setAnnotationAppearance` too.** The stream would reference a font that
  is in no `/Resources`, so the text would silently not draw. Rejected: an appearance that draws
  nothing is worse than none, which is the same rule `ContentBuilder.isEmpty` already enforces.
- **Embed a subset of the chosen system font.** The right answer, and it needs a subsetter.
  fontkit arrives with M51's text editing; when it does, this becomes an option in the same
  properties panel and nothing else has to move.
- **Let each module register its generators into its own `AppearanceService`.** M21 designed the
  service that way, and it works for the renderer — but the writer runs in M21's own Worker, which
  has no module registry, so a generator registered from a manifest would never reach the file.
  M30's generators are therefore registered in `createAppearanceService()` itself. A module that
  only needs a generator _in the renderer_ can still use `register()`.

## Consequences

- `src/shared/ipc.ts` gains one channel; `src/engine/PdfEngine.ts` one method; `src/engine/Writer.ts`
  one flag and four property fields. All additive.
- One behaviour change with a test to match: `buildWritePlan` now plans every property of a changed
  annotation. `test/unit/save/plan.test.ts` asserts the new rule and says why.
- M31, M33 and M82 inherit the insert path for free — Line, Polygon, PolyLine and their own
  subtypes are all in the same position — and `AnnotationLayer` with it.
