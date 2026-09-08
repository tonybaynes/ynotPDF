# ADR 0009 — Viewer contract additions: view state, full screen and line weights

- Status: accepted
- Date: 2026-09-08
- Module: M11 (viewer); consumed by M12, M13, M30, M40, M50, M92, M110 and M130

## Context

M11 builds the page view on top of three contracts it does not own:

1. **`ui.view`** (`src/renderer/app/ui/UiState.ts`). M02 shipped the status bar, the View ribbon
   groups and the `view.page.*` / `view.zoom.*` / `view.layout.*` commands, all of which write a
   `ViewState` of `{ page, pageCount, zoom, fit, layout }` and nothing else. M11's brief also
   requires view rotation, a fifth layout (continuous facing), a third fit mode (fit visible) and
   split view — none of which that shape can express. M02's own build log asks M11 to drive
   `ui.view` rather than register a second set of commands, so the shape has to grow.
2. **IPC.** F11 must enter and leave OS full screen. A renderer cannot do that; there was no
   `window:*` call for it, only `window:getState` reporting `fullScreen` after the fact.
3. **`RenderOptions`.** Foxit's View tab has a **Line Weights** toggle: off, every stroke is
   drawn as a one-pixel hairline, which is how a zoomed-out CAD drawing stays readable. PDFium's
   public render flags have no hairline mode (`FPDF_RENDER_NO_SMOOTHPATH` is anti-aliasing, not
   width), so the flag cannot simply be forwarded.

## Decision

All three changes are additive; nothing existing changes shape or meaning.

### `ViewState` gains three fields, `LayoutMode` a fifth mode, `ZoomFit` a third mode

```ts
readonly rotation: 0 | 90 | 180 | 270;      // view rotation, clockwise. Not a document change.
readonly split: 'off' | 'vertical' | 'horizontal';
readonly syncScroll: boolean;
type LayoutMode = 'single' | 'continuous' | 'facing' | 'facingContinuous' | 'book';
type ZoomFit = 'page' | 'width' | 'visible' | null;
```

`facingContinuous` is camelCase, not `facing-continuous`, because `LAYOUT_MODES` generates the
command id `view.layout.<id>` and command ids are dotted alphanumerics (a hyphen fails the
convention test in `test/unit/shell-manifest.test.ts`).

The status bar therefore grows a fifth layout button and the palette five `view.layout.*`
commands, which is what Foxit's View tab shows.

**View rotation is not a `Command`.** It changes nothing in the document — it is where the reader
is standing, like the zoom. `page.rotateRight` / `organize.rotate` (M20) remain the undoable
document rotation, and the two are deliberately separate: rotating the _view_ of a scanned page
to read it must not dirty the file.

### New IPC: `window:setFullScreen`

```ts
'window:setFullScreen': { args: [fullScreen?: boolean]; result: boolean };
```

Omitting the argument toggles. The result is what the window ended up as, and the existing
`window:stateChanged` event still reports it, so nothing has to poll. Reading mode is _not_ here:
hiding the app's own chrome is a renderer concern (`data-reading-mode` on `<html>`), and the two
are independent — Foxit lets you read full-screen or windowed.

### New render option: `RenderOptions.lineWeights`

```ts
readonly lineWeights?: boolean;   // default true
```

`false` is implemented in `PdfiumEngine.renderRaw` by walking the page's objects (and one level
into its form XObjects), setting every non-zero stroke width to 0 with
`FPDFPageObj_SetStrokeWidth` — which PDFium draws as a one-pixel hairline — rendering, then
putting the widths back in a `finally`. `FPDFPage_GenerateContent` is never called, so the
document's bytes are untouched and a later save is unaffected. Measured on a synthetic page of
8 pt strokes: 16 % ink becomes 2 %, and the restored render is identical to the original.

The flag is part of the tile cache key, so turning it on and off re-renders rather than showing
stale tiles.

## Consequences

- Modules reading `ui.view` see three more fields; nothing that ignores them breaks.
- M130's preferences UI gets the viewer's settings schema for free (`viewer.*`).
- M12, M13, M30 and M50 read the rotation when placing overlays: a page's `PageTransform`
  already carries it, so they should use `PageView.transform` rather than the page's `/Rotate`.
- A future engine that cannot set stroke widths must ignore `lineWeights` rather than fail; the
  option is optional and defaults to the faithful behaviour.

## Alternatives considered

- **A second `viewer.*` store slice instead of extending `ui.view`.** Rejected: the status bar
  and the View ribbon already read `ui.view`, and M11's brief is explicit that all view state
  lives in one place so the status bar, the ribbon toggles and the tests read one source.
- **Registering `view.rotate.*` as `Command`s on the undo stack.** Rejected: undoing a rotation
  the reader made to read a page would surprise them, and it would make every document dirty.
- **Leaving Line Weights as a no-op toggle** with a note that PDFium cannot do it. Rejected: a
  visible control that does nothing is worse than no control, and the stroke-width route works.
