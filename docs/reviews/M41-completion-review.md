# M41 completion review — crop aspect ratios

Reviewed for Tony on 12 September 2026 against `origin/main`
`b9c570af44b9a0d40efe01e2495d1c2943d1a0ab`. This is a bounded completion repair,
not a fresh certification of every module described below.

## Reading completed

All 18 assigned files were read completely; the identical project-context section
in module briefs was read once, as requested:

- `docs/adr/0010-writer-and-save-contracts.md`
- `docs/adr/0014-portfolio-model.md`
- `docs/adr/0016-page-organisation-contracts.md`
- `docs/adr/0017-page-boxes-from-the-engine.md`
- `docs/adr/0018-page-object-contracts.md`
- `docs/adr/0019-form-field-contracts.md`
- `docs/modules/M20-document-model.md`
- `docs/modules/M21-save.md`
- `docs/modules/M40-organise-pages.md`
- `docs/modules/M41-merge-split-crop.md`
- `docs/modules/M42-portfolios.md`
- `docs/modules/M50-object-model.md`
- `docs/modules/M60-forms.md`
- `src/renderer/modules/M20-document-model/README.md`
- `src/renderer/modules/M21-save/README.md`
- `src/renderer/modules/M40-organise-pages/README.md`
- `src/renderer/modules/M41-merge-split-crop/README.md`
- `src/renderer/modules/M50-object-model/README.md`

Also read `CLAUDE.md`, `PLAN.md`, and `test/README.md`. The source checkout's
`Codex_Audit.md` supplied read-only background; its older findings are not treated
as current defects without checking current code. Tony's current delegation
overrides its old branch/co-author/merge instructions.

## Original scope still unfinished

- **M41 crop ratio UI, confirmed.** The brief explicitly requires a ratio
  constraint; its build log defers the control. At the reviewed SHA,
  `manifest.ts` registers `ratio: () => null`. This repair supplies Free,
  resource-backed fixed presets, and bounded Custom width : height, shared by
  the tool and dialog. Enter now reviews the drawn rectangle in the dialog, as
  the tool's original comment promised. Previously the manifest's `rect` argument
  went straight to `service.crop`, bypassing that review.
- **M41 crop geometry, confirmed.** The old tool and dialog converted PDF
  rectangles to CSS by flipping Y only. Quarter-turn rotations require swapping
  axes too. The repair uses the existing `PageGeometry` contract for overlays,
  previews, detection and ratio orientation. Range application plans every page
  before mutating, and rejects a page whose result would be smaller than 1 pt.
- **M41 automatic deskew on image import, confirmed still missing on main
  `d322de7`.** The original scope explicitly requires M91's from-images path to
  call deskew when `scan.autoDeskew` is enabled. A repository search finds the
  setting only in M41's schema/default/reader (`settings.ts`); neither M91 nor
  `src/engine/create` refers to deskew/straightening. The manual
  `organize.autoDeskew` command does not supply this import hook. The build-log
  claim that M91 reads this preference is therefore premature. Recommend a
  separate M41/M91 completion task with an on/off image-import journey. This
  crop-only PR does not complete M41 as a whole while that omission remains.
- **M50 unknown operators under z-order, documented and code-confirmed.** The
  original brief says never lose unknown operators. ADR 0018 and the build log
  explicitly exempt reordered pages; `model.ts:plannedObjectsFor` returns
  `undefined` when `isReordered(state.live)`. This is unfinished preservation
  scope, rather than evidence that arbitrary object edits fail. Recommend a
  separate bounded preservation repair before describing M50 as complete.
- **M60 image-field picture selection, documented and code-confirmed.** Original
  scope includes image fields and button icons. `PropertiesPanel.ts` still tells
  Tony that choosing the picture arrives with the form-logic module. Field box
  and layout support do not complete filling an image field. Recommend a separate
  completion task or an explicit scope decision; this crop repair changes none
  of the form implementation.

## Intentional exclusions and stale notes

Office inputs remain M93; form validation/calculation and flatten appearance
regeneration remain M61; incremental saving remains M80. XFA, scanner drivers,
rich media and portfolio full-text search are explicitly excluded or parked.
M40's cross-document thumbnail drag onto a tab is its documented reachable
alternative while the shell has one navigation pane.

The M41 design paragraph cites ADR 0018 for page boxes, but that contract is
ADR 0017. The M20 README still describes its rotation ribbon as awaiting M40;
current M40 registration supersedes it. M20's notes about pending M60/M72 and
M21's statements that M41/M70 do not exist are historical build notes, not
evidence that those modules are absent now. M42's documented Foxit portfolio
reopen/order/layout confirmation is completed manual evidence, not an open task.

## Dependencies and quality risks

Crop depends on M11's displayed geometry and units, M40's target/range parser,
M20's undoable page-box commands and M21's engine-base write plan. The ratio is
session tool state; only the resulting boxes are document edits. Saving must not
discard the undo stack. No writer, document model, main IPC, MergeService or
OpsClient changes are part of this repair; the separate audit task owns those
integration contracts.

Coordinator review found a crop context race during asynchronous dialog/settings
work. The helper now receives the original document and revision, rejects a
changed context before planning, and checks the active document and planned page
IDs before each mutation. A mid-range switch rolls back prior crop changes.
`test/unit/ops/crop-context.test.ts` deterministically covers pending settings
plus a tab switch, a changed revision, rollback and stable-range undo.

Ratio components must be finite and between 0.01 and 1000, and width/height
between 1:100 and 100:1. Invalid input disables Crop/Use ratio and supplies a
worded error. Results smaller than one point are rejected without replacing the
chosen ratio with a minimum-size distortion. Ratios follow the displayed page,
including view rotation; margin labels explicitly use unrotated PDF edges.

The assigned portfolio brief's 1 GB responsiveness requirement needs a measured
stress test; no new proof of it is claimed here. Packaging CI on three operating
systems plus an ARM installer smoke does not establish full native crop UI
coverage on every CPU. The crop change introduces no dependency or native code.
Private fixtures remain ignored and their contents are not included in this review.

## Validation record

New unit tests exercise invalid/extreme ratios, every page rotation, offset crop
boxes, bounded drags and every resize handle. UI journeys use visible commands,
actual page drags and keyboard input, then inspect real PDF boxes after range
application, undo/redo and save/reopen. A second journey exercises Custom and
Free at 200% UI scale with High Contrast and layout/readability assertions.
Final local and exact-head CI results are recorded in the PR and coordinator
handoff; this file does not turn a pending run into a completion claim.
