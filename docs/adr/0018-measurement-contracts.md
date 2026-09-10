# ADR 0018 — Measurement contracts: `/Measure`, provider priority, and page-object paths

- Status: accepted
- Date: 2026-09-10
- Module: M33 (measuring tools — distance, perimeter, area, calibration); consumed by M50, M52

## Context

M33 writes measurement annotations — a `Line`, a `PolyLine` or a `Polygon` carrying a `/Measure`
dictionary and an `/IT` dimension intent — and snaps the points it measures to what is drawn on
the page. Four things the existing contracts could not express came up.

1. **`/Measure` is an array of dictionaries.** `DictValue` (ADR 0013, extended by ADR 0015) knew
   strings, names, numbers, number arrays, name arrays, dictionaries, an embedded-file reference
   and an annotation reference. A RectilinearMeasure dictionary is `<< /X [ << … >> ] /Y [ … ] … >>`
   — a dictionary whose entries are **arrays of dictionaries**, which nothing in the table could
   say. `/Cap` is a boolean, which it also could not say.
2. **Only one provider can own an annotation, and M31's owns every shape.**
   `AnnotationService.providerFor` returned the _first_ provider whose `owns()` passed. M31's
   `isDrawing` passes for the whole `shape` family, and M31 is registered before M33, so M33's
   provider would never have been asked about a measurement.
3. **Snapping needs the paths on the page, and the engine only exposed bounding boxes.**
   `PageObject` carries a `rect` and a `matrix`; the brief asks for vertices, midpoints and
   intersections of page-object _paths_. M50 will need the same segments to select and reshape a
   path, so this belongs in the engine rather than in a module.
4. **M31 deferred the line's leaders and caption** (`/LL`, `/LLE`, `/LLO`, `/Cap`, `/CP`, `/CO`)
   to "M33's, where a dimension line needs them". They are annotation dictionary entries and go in
   the same table as everything else.

## Decision

### 1. Two new `DictValue` kinds: `bool` and `array`

```ts
type DictValue =
  | …                                                     // unchanged
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'array'; readonly value: ReadonlyArray<DictValue> };
```

`array` may hold any `DictValue`, `dict` included, so a `/Measure` number-format array is
expressible. `FullRewriteWriter` converts both, recursively; an `array` entry **replaces** rather
than merges, because an array has no keys to merge on. `embeddedFile` and `annotationRef` stay
top-level-only and are skipped inside an array, exactly as they already are inside a nested
dictionary.

### 2. `AnnotationProvider.priority`

```ts
export interface AnnotationProvider {
  readonly id: string;
  /** Higher wins when two providers both claim an annotation. Default 0. */
  readonly priority?: number;
  …
}
```

`providerFor` now takes the highest-priority provider that owns the annotation, registration order
breaking a tie. M33 registers at 10 and claims a shape with a dimension `/IT`; M31 stays at the
default and keeps every other shape. Nothing else changes, and a build without M33 behaves exactly
as before.

### 3. `PdfEngine.pageObjectPaths` — optional, additive

```ts
export interface PageObjectPath {
  /** Index into the page's object list, as `pageObjects` numbers them. */
  readonly index: number;
  /** Subpaths, flattened to polylines in page space. A closed subpath repeats its first point. */
  readonly subpaths: ReadonlyArray<ReadonlyArray<PdfPoint>>;
}

interface PdfEngine {
  pageObjectPaths?(doc: DocHandle, page: PageIndex): Promise<ReadonlyArray<PageObjectPath>>;
}
```

**Optional on purpose.** It is implemented with PDFium's `FPDFPath_CountSegments`,
`FPDFPath_GetPathSegment`, `FPDFPathSegment_GetPoint` / `GetType` / `GetClose` and
`FPDFPageObj_GetMatrix`, which a wasm build need not export; the adapter checks with `ffi.has` and
returns an empty list rather than throwing. It is also optional so the in-memory `FakeEngine` the
model tests use does not have to grow a path rasteriser. Callers must cope with its absence — M33
falls back to page-object bounding boxes, which still yields corners and edge midpoints.

Béziers are subdivided to a fixed tolerance (16 segments per curve, which is under a tenth of a
point at any zoom a reader can reach). Form objects are walked one level deep with their matrices
composed, because a stamped logo's outline is exactly the sort of thing a reader wants to snap to.
The method is added to `ENGINE_METHODS`, so the Worker proxy forwards it like any other.

### 4. Six more entries in `ANNOTATION_DICT_MAPPINGS`

| model key         | PDF key    | kind      | why                                                                    |
| ----------------- | ---------- | --------- | ---------------------------------------------------------------------- |
| `measure`         | `/Measure` | `dict`    | the whole RectilinearMeasure dictionary, encoded from a `MeasureScale` |
| `leaderLength`    | `/LL`      | `number`  | the dimension line's offset from the points it measures                |
| `leaderExtend`    | `/LLE`     | `number`  | how far the leaders run past the line                                  |
| `leaderOffset`    | `/LLO`     | `number`  | the gap between a measured point and its leader                        |
| `caption`         | `/Cap`     | `bool`    | whether `/Contents` is drawn on the line                               |
| `captionPosition` | `/CP`      | `name`    | `Inline` or `Top`                                                      |
| `captionOffset`   | `/CO`      | `numbers` | nudge, two numbers                                                     |

`src/engine/appearance/measure.ts` owns the encoding and the parsing, so the shape of a
`MeasureScale` is stated once. The raw reader (`pdfium/rawdoc.ts`) reads all seven back, since
PDFium has a getter for none of them.

## Consequences

- A file this app writes carries a `/Measure` an unmodified Acrobat reads: the number formats are
  written in full, with `/U`, `/C`, `/F`, `/D`, `/RD`, `/RT` and `/O` rather than relying on
  defaults.
- `pageObjectPaths` is the first optional method on `PdfEngine`. Every caller must have a
  fallback; the type makes that impossible to forget.
- M50 gets its path segments for free, and M52 gets them for path editing.
- The `bool` and `array` kinds close the last gaps in `DictValue`: everything PDF's object model
  has except streams and references can now be planned.

## Alternatives considered

- **A `measure` family in the model.** Rejected: the subtypes really are `Line`, `PolyLine` and
  `Polygon`, every viewer treats them as such, and a fourth family would have had to reimplement
  vertex handles, resizing and the appearance generators M31 already has.
- **Raw dictionary text in `DictValue`.** A `{ kind: 'raw', value: string }` would have taken
  `/Measure` in one line. Rejected: it defeats the point of the table, which is that one file
  knows the shape of what is written, and it cannot be read back.
- **Registering M33 before M31 in `main.ts`.** It would have worked, and it would have made the
  correctness of a measurement depend on the order of two lines in a file neither module owns.
