# M33 — Measuring tools: distance, perimeter, area, calibration

Measure a page in real-world units. A distance between two points, a perimeter along a run of
segments, an area inside a shape; a calibration that says what a length on the page is worth; and
a panel listing everything measured, with running totals and a CSV.

Spec: [`docs/modules/M33-measuring-tools.md`](../../../../docs/modules/M33-measuring-tools.md).
Contracts it changed: [ADR 0018](../../../../docs/adr/0018-measurement-contracts.md), on top of
[ADR 0015](../../../../docs/adr/0015-shared-xobjects-and-providers.md).

## The two rules to know

**A measurement is one of M31's shapes with a `/Measure` dictionary.** A distance is a `Line` with
`/IT /LineDimension`, a perimeter a `PolyLine` with `/IT /PolyLineDimension`, an area a `Polygon`
with `/IT /PolygonDimension` — exactly what Acrobat and Foxit write, so ours reopen there as
measurements rather than as plain shapes. Nothing new was added to the annotation model.

**M33 creates; M30 owns everything after that**, through the same
[`AnnotationProvider`](../M30-markup-annotations/AnnotationService.ts) hook M31 uses — registered
at `priority: 10`, so it takes measurements back off M31's provider, which claims every shape.

## Where the scale lives, and why in three places

| Where                            | What it is                                                       |
| -------------------------------- | ---------------------------------------------------------------- |
| The annotation's own `/Measure`  | What it was measured with. This is what makes it reopen right.   |
| `Document.custom['M33.measure']` | The document's working scale, and any page calibrated on its own |
| The settings (`measure.scale`)   | What a document with no calibration of its own starts from       |

A page's own calibration beats the document's, and the document's beats the settings'. Calibrating
is a `SetCustomCommand`, so it is undoable, journalled and in the recovery file — and it
**re-measures** every measurement it covers, because a ruler that has moved and captions that have
not is the one state a reader cannot tell apart from a correct one.

## What is where

| File                 | What it is                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `manifest.ts`        | Commands, the Comment-tab Measure group, the four tools, the results panel, the settings, the probes |
| `MeasureService.ts`  | Creating measurements, the scale and calibration, the snap cache, the live value, the results        |
| `provider.ts`        | The `AnnotationProvider`: what M30's overlay, selection and panel do with a measurement              |
| `tools.ts`           | The four `ToolSpec`s: drag a line, click the corners, calibrate — with the snap marker               |
| `overlay.ts`         | **Pure.** Model annotation → what the overlay draws and lets you grab                                |
| `geometry.ts`        | **Pure.** Segment intersection, shoelace area, point-to-segment distance, path length                |
| `snap.ts`            | **Pure.** Endpoints, midpoints, intersections and points on a path, nearest-within-tolerance         |
| `scale.ts`           | **Pure.** The document's calibration record, and the arithmetic of a calibration                     |
| `results.ts`         | **Pure.** The rows, the totals, the CSV and the clipboard text                                       |
| `panel.ts`           | The properties sections: the value, the colour, the stroke, the leaders, the caption                 |
| `ResultsPanel.ts`    | The Measurements panel (left dock): the live value, the list, the totals, Copy and Export            |
| `CalibrateDialog.ts` | "That line really is _n_ mm" — and, opened without a line, the scale by hand                         |
| `settings.ts`        | Per-tool defaults, the snap toggles and the tolerance, the starting scale                            |

The arithmetic and the drawing are not here: they are in
[`src/engine/appearance/measure.ts`](../../../engine/appearance/measure.ts) — the units, the
scale, the `/Measure` dictionary and its number formats, the leaders and the caption — because the
writer needs them too and there must be exactly one answer per question.

## Two things worth knowing before changing it

- **A measurement's `/Rect` is exactly its appearance `/BBox`.** A viewer maps one on to the other
  (PDF 12.5.5), so the two disagreeing by a point scales everything the stream draws — invisible on
  an outline, obvious on a caption. `measureRectFor` and `paintMeasurement` compute the same box.
- **`PdfEngine.pageObjectPaths` is optional.** Snapping falls back to page-object bounding boxes
  when a backend has no path data, which still gives corners and edge midpoints (ADR 0018).
