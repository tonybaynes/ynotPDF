# ADR 0005 — Engine contract additions for M10 (links, render flags, styles, cancellation)

- Status: accepted
- Date: 2026-09-07
- Module: M10 (engine layer); consumed by M11, M12, M13, M20, M30, M50, M60

## Context

M00 stubbed `PdfEngine` with the read methods every module codes against. Building the PDFium
adapter showed four gaps that later modules would otherwise have to work around:

1. **Links.** `annotations(page)` returns Link annotations as opaque records; the viewer needs the
   resolved destination or URI per link without re-parsing actions.
2. **Render flags.** M11's rendering options (smooth text/images/line art, print mode, LCD text)
   have direct PDFium flags but no field in `RenderOptions`.
3. **Styles.** `TextRun` had no font style (bold/italic/weight) and `PageObject` had no fill/stroke
   colour, stroke width or font — M50/M51 need them and PDFium exposes them cheaply.
4. **Cancellation.** The RPC could not drop or abort a request; a scroll that queues 50 renders
   would block the worker for seconds. `Annotation` also lacked `/AS` (appearance state), `/NM`
   and `/Subj`, which M30/M60 need.

`PLAN.md` §12.5: contracts change only by ADR and only additively.

## Decision

All changes are additive: new optional fields, one new method, one new error code, one new RPC
message kind. Every manifest, engine implementation and test written against M00 compiles
unchanged (`NotImplementedEngine` gains the new method).

### `PdfEngine`

- `links(doc, page): Promise<ReadonlyArray<Link>>` with
  `Link { rect, quadPoints?, dest?: Destination, uri?, annotationId? }`.
- `RenderOptions` gains `printing?`, `smoothText?`, `smoothImages?`, `smoothPaths?`, `lcdText?`
  (all default to PDFium's screen defaults: smooth on, print off, LCD off).
- `TextRun` gains `bold?`, `italic?`, `weight?`, `angle?` (radians, counter-clockwise) and
  `fontFlags?` (raw PDF font descriptor flags).
- `PageObject` gains `fillColor?`, `strokeColor?` (0xRRGGBB), `fillAlpha?`, `strokeAlpha?`,
  `strokeWidth?`, `fontName?`, `fontSize?`.
- `Annotation` gains `appearanceState?` (`/AS`), `name?` (`/NM`), `subject?` (`/Subj`).
- `EngineErrorCode` gains `'cancelled'`.

### RPC (`src/engine/rpc.ts`)

- Client → worker: `{ kind: 'cancel', id }`. A queued request is dropped; an in-flight `render`
  is aborted at its next pause point. The request rejects with `EngineError('cancelled')`.
- The worker serialises requests (one at a time) so PDFium is never re-entered; cancel messages
  are handled immediately because renders yield to the event loop between progressive passes.

### `EngineClient`

- `request(method, args)` returns `{ promise, cancel() }`; `cancelRenders(doc?)` cancels every
  pending or in-flight render (optionally for one document). The typed `engine` proxy is
  unchanged.

## Consequences

- M11 gets tile cancellation for free and can expose the rendering-option toggles as commands.
- M20's mutation work is untouched; ids and rects keep their M00 semantics.
- Engines that cannot cancel mid-render may still honour queue cancellation; `cancelled` is
  the only new rejection they must be able to produce.
