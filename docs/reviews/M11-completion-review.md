# M11 completion review — 12 September 2026

Tony's bounded repair is Fit Visible. Baseline source was `origin/main` at
`b9c570a` (PR 53); claims below were checked against that source, not inferred from tracker
ticks. Later integration and validation are recorded at the end. The save/recovery and
security audit remains owned by its separate task.

## Reading record

Read `CLAUDE.md` and `PLAN.md`, including the full architecture and parallel-work rules.
All 33 assigned Markdown files were read; repeated project-context prose was read once:

- ADRs: `0001-stack`, `0002-status-colour-separation`, `0003-settings-ipc`,
  `0004-shell-contribution-points`, `0005-engine-contract-additions`, `0006-pdfium-adapter`,
  `0007-document-model-contracts`, `0008-ribbon-dynamic-labels`, `0009-viewer-contracts`,
  `0009-windows-arm`, `0011-navigation-panel-contracts` (all under `docs/adr/`).
- Briefs: `M00-scaffold`, `M01-theme-system`, `M02-app-shell`, `M03-windows-arm`,
  `M04-ui-journey-tests`, `M10-engine-layer`, `M11-viewer`, `M12-navigation-panels`
  (all under `docs/modules/`).
- READMEs: `src/engine`, `src/main`, `src/preload`, `src/renderer/app`,
  `src/renderer/core`, `src/renderer/modules/M00-scaffold`,
  `src/renderer/modules/M01-theme-system`, `src/renderer/modules/M10-engine-layer`,
  `src/renderer/modules/M11-viewer`, `src/renderer/modules/M12-navigation-panels`,
  `src/renderer/modules`, `src/renderer/theme`, `src/renderer/view`, `src/shared`.

Direct implementation dependencies also reviewed: `test/README.md`, the journey/layout
helpers, `PdfEngine`, `PageGeometry`, the model's page/event contracts, the existing viewer
and zoom/layout tests, M50 object-edit notifications, and CI configuration. The source
checkout's `Codex_Audit.md` was consulted as historical, read-only context, not used as proof
of current defects.

## Evidence and scope

| Finding                                                              | Current source evidence                                                                                                              | Disposition                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Fit Visible was unfinished original M11 scope                        | `DocumentView.applyFit` passed full `PageSize`s; `zoom.fitZoom` treats visible like width; M11 build log explicitly admitted the gap | Complete in this repair                                                                    |
| Content reads need stable page identity                              | `Document.enginePage`, ADR 0007; model reordering does not reorder engine pages                                                      | Resolve model ID to engine index before each uncached read                                 |
| Edits and view transformations are hidden dependencies               | M50 changes object bounds; model page boxes/rotation and M12 layer visibility change displayed bounds                                | Invalidate on page state, revision and layer changes; transform through `PageGeometry`     |
| Text selection was described as a stub                               | `view/TextLayer.ts`, M13 registration and journeys now implement it                                                                  | Stale M11 history, not unfinished M11 work                                                 |
| Native PDFium was not built                                          | ADR 0006 records measured WASM decision                                                                                              | Intentional fallback held in reserve                                                       |
| Page transitions, selection/find/print and extra annotation overlays | Explicit M11 exclusions and later-module ownership                                                                                   | Excluded; no unrelated repair                                                              |
| Loupe uses the screen canvas                                         | `view/Loupe.ts` and M11 build log agree                                                                                              | Documented sharpness tradeoff, especially at low zoom; not a newly discovered missing tool |
| Split uses two panes                                                 | `Viewer.setSplit`; scope explicitly requests two viewports                                                                           | Intentional; separate-window detach is M02                                                 |

The repair fits geometric page content bounds, not a raster analysis of non-white pixels.
Full-page scanned images and painted page backgrounds remain full-page content. Form XObject
bounds and path clipping are conservative under the existing engine contract; annotations are
not page content objects. These distinctions prevent a misleading claim of pixel-perfect
ink detection. No engine contract, codec, lifecycle, printing or crop implementation changes
are included.

## Additional findings for the coordinator

- `src/renderer/theme/README.md` still permits 3:1 placeholders. Current `pairs.ts`,
  `theme-contrast.test.ts`, `CLAUDE.md` and Tony's instructions require stronger contrast.
  Correct the documentation centrally; do not weaken the theme tests.
- M11 design prose names `spread` and `facing-continuous`; the actual contract uses
  `facingContinuous` and has no `spread` member. Several early READMEs/build logs describe
  now-completed model, mutation, save and navigation work as future stubs. Preserve dated
  history but add current-state notes when maintaining those modules.
- M04's old claim that a form-fill journey is impossible is stale:
  `test/e2e/journeys/forms.spec.ts` exists. Its cross-platform visual baseline and macOS
  large-window omissions are genuine documented verification limits; `visual.spec.ts` still
  conditionally skips missing baselines. This repair adds no skips or assertion relaxations.
- M03 still documents unsigned ARM NSIS/Defender failures and MSI's x64 architecture
  declaration for ARM payloads. These are M131 packaging/signing follow-ups. CI ARM coverage
  is an installed-app smoke, not the complete viewer suite. Mac universal packaging is also
  distinct from running the complete suite natively on both Intel and Apple Silicon.
- M12's file-launch bookmark action is deliberately not followed; it is retained as data.
  Its portfolio and page-manipulation deferrals belong to the now-implemented M42/M40 modules.
  The panel brief's thumbnail frame-rate requirement warrants its own evidence check: it is
  separate from M11's scrolling benchmark and not repaired by Fit Visible.

## Validation

Integrated main `d322de7` (PR 54). The full unit suite passed 4,050 tests with its 24 existing
fixture skips; lint and licences passed. Full local e2e and all CI/platform checks are required
merge gates, with exact-head results tracked in [PR 59](https://github.com/tonybaynes/ynotPDF/pull/59).
New unit tests cover content unions, CropBox clipping,
hidden layers, invalid bounds, blank fallback, page/view rotations with real PDFium, facing
spacing, LRU eviction, deduplication, retry and stale-cache completion. New real-user journeys
cover the visible content edges, zoom controls, layouts, navigation, resizing, editing and undo.
Six new journeys pass together, including a controlled delayed real-worker bounds request:
the test holds the request, selects Actual Size through the ribbon, releases the request, and
checks that its eventual result cannot override the newer zoom command.
All fixtures added for this repair are generated synthetic documents; no private PDFs copied.

The split-pane journey found a viewer input defect: `PageView` stops propagation when a tool
handles pointer-down, so the scroller's bubbling focus handler never activated the clicked
pane. The repair selects the pane in the capture phase, before tool dispatch. This is needed
for independent fitting and zoom. An additional M50 observation was passed to the coordinator:
the Delete Object ribbon click cleared a selected object without incrementing document
revision, whereas the Delete key performed the edit and undo correctly. No M50 repair or
claim that its broader acceptance scope passed is included here.

M50's `ObjectController` also consumes pointer-down in capture phase at its outer host,
before the viewer receives it. With Edit Object active, a click in another split pane therefore
does not activate that pane. The viewer journey explicitly selects the Hand tool; the object-tool
interaction remains assigned to M50 and was reported to the coordinator with its source location.

## Raster verification follow-up

Tony requested actual screenshot inspection as well as automated journeys. Settled captures
at 510% zoom exposed a real M11 dependency: the geometric left/top edges were 16px, but the
canvas ink appeared at 26/35px and extended beyond the viewport. Both queued and in-flight
render counts were zero. `DocumentView` requested bucketed tiles while `PageView` painted
them at the exact zoom without the promised scale compensation.

The follow-up maps visible tile requests into bucket coordinates and maps each bitmap back
into exact display coordinates, snapping shared destination edges to avoid seams. Tiles for
another pane's zoom, rotation or flags cannot paint into the current pane. A late placeholder
stays behind detailed tiles. Synchronized panes remember mirrored positions so asynchronous,
rounded scroll events cannot echo back and shift the fitted source pane.

The six journeys now also inspect actual canvas pixels after rendering drains: raster edges
must match geometry plus the page border within one CSS pixel, and every interior pixel must
be opaque black, including tile seams and clipped tiles. The split journey checks this with
the other pane at a different zoom. All six pass together. These product changes touch only
`Viewer.ts`, `DocumentView.ts` and `PageView.ts`; the engine contract stays unchanged.
Main `753f5cb` (PR 58's print repair) is integrated. Earlier head `61d0c2e` and its passing
full suite are superseded; final integrated unit/UI/platform results remain tracked in PR 59.
