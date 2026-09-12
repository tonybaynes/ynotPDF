# M13 completion review — 12 September 2026

Reviewed for Tony on `codex/M13-print-appearances`. Defects were checked against `origin/main`
`b9c570af44b9a0d40efe01e2495d1c2943d1a0ab`, then integrated with the save checkpoint repair
merged as `d322de7b43070979fac5ff586a16e39ddbda4d47`. This review separates documented scope,
observed implementation defects, intentional limits and incomplete validation evidence.

## Reading completed

All twenty assigned Markdown files were read completely; the identical project-context block
was read once. CLAUDE.md, the required PLAN.md sections, and the M11/M41 dependency briefs were
also reviewed. Codex_Audit.md was consulted as read-only context for save and permission risks.

- docs/adr/0012-printing.md
- docs/adr/0013-annotation-contracts.md
- docs/adr/0015-shared-xobjects-and-providers.md
- docs/adr/0017-comment-contracts.md
- docs/adr/0018-measurement-contracts.md
- docs/modules/M13-select-find-print.md
- docs/modules/M30-markup-annotations.md
- docs/modules/M31-shapes-ink-stamps.md
- docs/modules/M32-comments-panel.md
- docs/modules/M33-measuring-tools.md
- src/renderer/modules/M13-select-find-print/README.md
- src/renderer/modules/M30-markup-annotations/README.md
- src/renderer/modules/M31-shapes-ink-stamps/README.md
- src/renderer/modules/M32-comments-panel/README.md
- src/renderer/modules/M33-measuring-tools/README.md
- test/README.md
- test/fixtures/README.md
- test/fixtures/create/notes.md
- test/fixtures/external/README.md
- test/fixtures/local/README.md

## Required repair and evidence

M13's original scope promises printing with/without annotations and forms and reuse of the same
imposition for Print to PDF. The build log explicitly deferred vector annotation/widget appearances
until M41 flattening. Current-main `print/printToPdf.ts` still embedded `engine.save()` pages
directly: pdf-lib copies page content, excluding `/Annots`. This was unfinished required scope,
not an intentional exclusion in the original brief.

The same code omitted model-only unsaved annotations/form designs that M21 writes; it also used
embedPage's MediaBox default and ignored source `/Rotate`. Vector borders/tile labels were absent
despite existing placement flags. These directly related print defects are repaired together.

The repaired pipeline captures a consistent model/engine snapshot with the PR54 read barrier,
materialises M21 write intent in a worker, and uses a separate PDF object graph to bake printable
appearance streams. It neither applies a document Command nor replaces pages, resets history,
marks saved, discards recovery, or runs output encryption stages. Missing appearances, ambiguous
states and invalid geometry fail before output. Unknown subtypes with usable streams survive.

Print flags differ from screen flags: Print is required, Hidden excludes and NoView alone does
not exclude. NoRotate cancels page rotation at the annotation's upper-left corner. Both content
switches apply independently. Existing widget appearances are preserved; missing appearances or
NeedAppearances use pdf-lib's built-in providers, with failures propagated.

## Hidden dependencies and quality risks

- M21's planner/writer is necessary for unsaved FreeText, custom stamp XObjects, form design and
  field values. Engine bytes alone are insufficient. The read barrier from PR54 prevents mixing
  a model revision with engine bytes from a concurrent command. Writer warnings stop printing.
- M41 supplies the tested BBox/Matrix-to-Rect placement algorithm. Its complete flatten function
  is unsuitable unchanged: it uses screen NoView rules, preserves unresolved marks in `/Annots`
  that embedPage drops, and treats missing named states as empty. M13 owns the stricter compositor;
  shared flattening code was not edited. Resource dictionaries are cloned to prevent cross-page
  aliasing, and appearance names avoid existing XObject keys.
- CropBox intersected with MediaBox, nonzero origins and source rotation must precede imposition.
  Nested XObject embedding is flushed before copying normalised pages. Blank pages receive an
  empty content stream so pdf-lib can embed them.
- Existing M70 permission gates remain authoritative, including certificate recipient authority.
  Vector output and DPI above 150 additionally require `print-high`; plaintext is transient
  print input only. The normal Save security stages do not belong in this pipeline.
- Greyscale uses the raster route explicitly described in the dialog; arbitrary PDF colour spaces
  cannot be made grey reliably by substituting a few operators. Print as image remains available.
- Unsupported/malformed marks are reported, not guessed. For example, an unsigned signature widget
  with no appearance may require its author to provide one or the user to exclude forms. This
  repair does not implement M61's custom appearance providers or repair every malformed PDF.
- **PR58 checkpoint — unfinished original M13 scope:** physical printer delivery and preview used engine-only
  rasters and can omit writer-only unsaved FreeText, custom stamps and form designs. Only
  `runPrintToPdf` supplied the materialised snapshot in that bounded repair. The follow-up below must
  render the snapshot for both paths and add a printer dry-run/preview journey before the whole
  M13 module is closed. No shared IPC change is needed to demonstrate the missing raster marks.
  They have no vector driver route. Hardware printing, arbitrary third-party appearance fidelity, very large
  documents and macOS Intel runtime remain outside what a Windows local test can establish.

## Other modules: required evidence versus intentional limits

- **M30 validation gap:** its acceptance requires PDFium/overlay-free/Chrome render equivalence.
  `test/e2e/annotations.spec.ts` checks that Chrome changes when annotations are added and that
  the same file repeats consistently; it does not compare equally cropped page pixels across
  renderers. The brief acknowledges this substitution. This is incomplete evidence, not a
  newly demonstrated annotation rendering defect. Recommend a crop-addressable independent
  renderer comparison before claiming the literal acceptance is satisfied.
- **M32 validation gap:** the original scope explicitly requires Acrobat/Foxit exports as fixtures
  and their complete import. The committed exchange fixtures are synthetic, as its build log
  states. Obtain genuine exports with permitted provenance (keep personal files private) and
  run the data-driven importer assertions. No importer defect is established solely by this gap.
- **M31 intentional limit:** `DrawingService.canRotate` and the disabled rotation control in
  `panel.ts` match the documented inability to turn a reopened custom stamp whose source is
  unavailable. The original wording is _stamp placement with rotation/scale_, not arbitrary
  post-reopen rotation. Treat expanding that capability as a proposed improvement, not a
  confirmed unmet literal placement requirement.
- **M32 intentional quality limit:** `engine/summary/text.ts` substitutes unsupported WinAnsi
  characters with lookalikes or `?`. The brief records the lack of Unicode font embedding.
  Recommend Unicode summaries when font embedding is available; this does not prove that its
  separate UTF-8 FDF/XFDF round trip is defective.
- **M33 stale notes:** ADR 0018 describes one-level Form traversal; current
  `PdfiumEngine.pageObjectPaths` uses a 20,000-object budget and a cycle/depth guard. The README
  and post-merge build log describe the later implementation. Update the ADR's historical note
  rather than reopening the already repaired nesting limitation.
- M13 find/replace and read-aloud are explicit later-module exclusions. Folder password prompting,
  one-sheet preview and the missing selection-count status slot are documented design limits;
  they are not repaired as part of this print-specific task. M33 3D/angle tools are excluded or
  absent from its required scope. Existing M31 line leaders/captions have already landed in M33.

## Validation status

The dedicated print unit suite exercises source isolation/undo, concurrent-command rejection,
cancellation, independent comment/form toggles, Print/Hidden/NoView, unknown appearances and
missing states, generated field appearances, blank pages, all source rotations and crop origins,
appearance Matrix/NoRotate/opacity, and annotation/field text through n-up, booklet and tiling.
Pixel comparisons use real PDFium rendering; searchable-text assertions independently detect
missing marks. The UI journeys fill a field and create a Text Box by visible controls, print
through the actual dialog, reopen the output, check the unchanged source journal and Undo,
and prove an unresolved appearance yields an error until explicitly excluded.

At this review checkpoint, the full local unit suite passed 4,055 tests (24 existing optional
fixture skips); both focused invisible UI journeys passed. Required final lint, refreshed unit,
full e2e and CI/platform results will be recorded before reporting merge readiness. No new test
skips, dependencies or private fixtures were introduced. The coordinator owns central trackers
and the eventual merge; this review is not a claim that an unmerged module is complete.

## Printer and preview follow-up

The follow-up uses the materialised model/engine snapshot for printer sheets, preview and raster
PDF output. It bakes only requested printable appearances on pages actually placed on the sheets,
then opens an isolated engine handle. One handle serves a complete printer job; preview requests
own their individual handles and abort obsolete work. Handles close in `finally`, including when
cancellation arrives during an asynchronous open or a render fails. The source and its undo and
recovery state remain untouched. Loading/error text replaces the former broken-image placeholder.

Independent source review found a production race after the print dialog: remembering settings
awaited storage, then output re-resolved the active tab. The follow-up revalidates the captured
document/revision after that await. Deterministic deferred-storage tests switch tabs and prove
neither print nor PDF dispatch occurs. A separate test edits the document while the PDF destination
dialog is open and proves rejection before source bytes are materialised or a file is written.

Test fixture corrections are separate from product defects: the custom-stamp journey initially
waited on an author-identity prompt before setting its identity; the first pixel probe attempted
a blob fetch disallowed by the existing CSP; the encrypted-fixture helper initially omitted its
requested output filename. The corrected probe samples decoded canvas pixels and compares them
with native-decoded prepared printer sheets. No CSP or shared contract was changed.

The follow-up checkpoint on integrated main `c492bfd` passes 4,139 unit tests with coverage
(24 existing optional skips), and all 11 focused invisible UI journeys. The printer probe resets
its capture for each job and waits for that job's unique completion serial before exact decoded
pixel comparisons; repeated status toasts cannot substitute an earlier job's sheets. Settled
preview, actual prepared sheet, error, n-up, booklet and tile screenshots were inspected: unsaved
text/stamp/field content survives, intended source rotations and crop placement remain visible,
and no new dialog layout defect was found. Screenshots are retained outside the worktree.

Full local UI and platform CI results will be recorded in the follow-up PR before handoff, against
its final head (discovery currently lists 571 tests in 42 files). Physical printer
hardware and driver fidelity require hardware testing; automated journeys intercept only the
native delivery boundary after main has prepared its actual HTML and sheet images. No physical
test jobs are sent, and no existing hardware limitation is presented as automated evidence.
