# M92 completion review

Reviewed 2026-09-12 against origin/main `b9c570af44b9a0d40efe01e2495d1c2943d1a0ab`,
the supplied worktree's initial HEAD. Later integration and validation are recorded below.
This is a bounded TIFF export repair and a documentation review, not a claim that the
whole editor or every external PDF has been certified.

## Reading completed

All 27 assigned Markdown files were read completely; repeated project-context prose
was read once, as instructed. Historical Claude/session/branch/merge boilerplate is
overridden by Tony's current instructions. No customer files were copied or committed.

- `docs/adr/0011-create-converters-and-ipc.md`
- `docs/adr/0011-qpdf-packaging.md`
- `docs/adr/0012-security-contracts.md`
- `docs/adr/0017-properties-and-initial-view-contracts.md`
- `docs/adr/0018-preferences-contracts.md`
- `docs/adr/0019-export-contracts.md`
- `docs/adr/0019-optimise-contracts.md`
- `docs/adr/0019-ui-journey-harness.md`
- `docs/adr/0020-decoration-and-link-contracts.md`
- `docs/modules/M100-optimise-repair.md`
- `docs/modules/M130-preferences.md`
- `docs/modules/M53-headers-bates-watermarks-links.md`
- `docs/modules/M70-encryption.md`
- `docs/modules/M72-properties-metadata.md`
- `docs/modules/M91-create-pdf.md`
- `docs/modules/M92-export.md`
- `resources/README.md`
- `resources/bin/README.md`
- `resources/brand/README.md`
- `resources/fonts/README.md`
- `scripts/README.md`
- `src/renderer/modules/M100-optimise-repair/README.md`
- `src/renderer/modules/M130-preferences/README.md`
- `src/renderer/modules/M53-headers-bates-watermarks-links/README.md`
- `src/renderer/modules/M70-encryption/README.md`
- `src/renderer/modules/M72-properties-metadata/README.md`
- `src/renderer/modules/M92-export/README.md`

Also read `CLAUDE.md`, `PLAN.md`, `test/README.md`, the M11 and M13 dependency briefs,
and relevant export, optimiser, settings, TIFF import and UI harness code. The source
checkout's `Codex_Audit.md` was consulted as read-only context for export permissions,
worker ownership and memory risks; its older findings were not assumed to remain open.

## Confirmed M92 repair

- The original brief's image-export scope includes TIFF compression and monochrome
  output. Its build log explicitly deferred CCITT Group 4 rather than excluding it.
  `TiffCompression`, `COMPRESSION_CODE` and `TIFF_COMPRESSION_OPTIONS` on the reviewed
  main contain no Group 4 option. This is unfinished scope, now implemented here.
- `exportImages` passed `tiffCompression` only to the multi-page writer. The single-page
  `encodeRaster` options did not accept it, so selecting None or PackBits still wrote
  Deflate for separate files. This was confirmed in code, and tests now assert each
  compression tag and decoded pixels for both output paths.
- M100 already exports `encodeGroup4` through `src/engine/optimise/index.ts`. Its input
  is one 8-bit component per pixel, whereas M92's `MonoRaster` packs bits MSB-first with
  byte-aligned rows and a set bit meaning white. `monoToGrey` bridges those representations
  without feeding padding into the encoder or changing the chosen threshold/dither.
- Group 4 TIFF uses Compression 4, PhotometricInterpretation 0 (WhiteIsZero), FillOrder 1,
  and T6Options 0. Each page has its own encoded strip and independently terminated
  reference state; existing IFD chaining and DPI rationals are retained. Provenance:
  [TIFF 6.0 section 11](https://www.itu.int/itudoc/itu-t/com16/tiff-fx/docs/tiff6.pdf)
  and [ITU-T T.6](https://www.itu.int/rec/T-REC-T.6-198811-I/en).
- Colour/greyscale Group 4 requests fail before rendering, and the low-level TIFF writer
  refuses a mixed frame set. The dialog explains the mismatch and disables Export until
  Tony chooses black and white or another compression. No silent conversion or fallback.
- This adds no dependency, native binary, IPC channel, document mutation, theme token
  or shared model contract. ExportClient, permission checks and M100's encoder are untouched.

## Additional unfinished scope and intentional exclusions

These are recommendations to the coordinator, not repairs included in this change.

- **M70 per-recipient permission editing remains unfinished.** The original scope asks for
  recipients with individual permissions. On reviewed main, `dialogs.ts` initialises from
  recipient zero and applies one `permissions` value to every recipient on confirmation.
  Its build-log deferral to M81 is a hidden dependency, not the brief's explicit exclusion.
  This differs from recipient permission enforcement, already repaired by main PR #53.
- **M53 multi-file Bates numbering remains unfinished.** Its scope explicitly includes
  several documents in one run; the module's build log defers the runner to M120, while
  the manifest only applies a decoration to the active document. Carrying `startAt` in
  a spec is groundwork, not a completed multi-file workflow.
- **M100 font subsetting is partial.** `fonts/pipeline.ts` explicitly retains Type 1,
  CFF and Type 3 programs; the module's build log discloses this. Original general font
  subsetting scope is broader. JBIG2 and JPX encoding, by contrast, are explicit exclusions.
- **M91 plain-text Unicode is deferred.** The brief asks for text conversion, while the
  implementation and log substitute unsupported WinAnsi characters with `?` and warnings.
  Waiting for M51's font work is a dependency to track, rather than full text fidelity.
  Office conversion, scanner and virtual printer support are explicitly excluded.
- **M72 raw-XMP editing is ambiguous in the original brief.** Its out-of-scope wording
  says raw view/edit is enough, but the design decision makes it read-only to prevent
  disagreement with derived metadata. Record this as an intentional policy narrowing
  needing consistent wording, not a newly discovered parser defect. Respecting Tony's
  pane preference instead of `/PageMode`, and declining window resize for a tab, are
  recorded product decisions. Signature management belongs to M81.
- **M130 i18n is a framework with an en-US proof**, explicitly limited in the log to
  M130's UI. Other modules' English strings are adoption work, not evidence that language
  switching is broken. M01 setting aliases are documented technical debt.
- **M92 exclusions retained:** Office output belongs to M93; selection-to-file and a
  second backstage entry were not original required scope. JPEG's grey pixels remain
  three-channel due to jpeg-js. Embedded image masks/colour spaces are a separate fidelity
  concern; the ADR's mask-applied promise and later build-log exclusion disagree.

## Hidden dependencies, stale notes and quality risks

- M92 depends on M100's portable public encoder, M41's range controls, M40 progress,
  M13 text grouping and existing file IPC. Importing the public optimiser boundary is
  deliberate; the Worker build must remain free of Node-only code. No M100 edit is needed.
- Tests reproduced a **TIFF import dependency defect**: utif 3.1.0 `_decompress` copies
  compressed bytes as raw whenever the strip byte count equals the decoded size. A valid
  17 by 2 all-black Group 4 frame triggers it. The test calls utif's independent T.6
  decoder directly in that one dispatcher case, without changing the bytes or expected
  pixels, and PDFium separately decodes that exact strip to pixel equality. M91 uses the
  affected dispatcher; repair its decoder adapter separately. This is not an invalid G4
  stream, and avoiding that test size would conceal a real interoperability risk.
- M92 accumulates every encoded output, and multi-page TIFF retains all reduced frames.
  Reusing M100 requires a transient byte per pixel for each mono frame. Large-document
  memory is therefore not bounded solely by a one-page render; budget/streaming work is
  separate. Do not repeat the ADR/build-log implication that all export memory is flat.
- M100's repeated linear searches through row transitions can be expensive on wide,
  noisy/dithered pages. Existing worker termination keeps the UI responsive; do not
  claim constant-time encoding or production-scale performance from small fixtures.
- M70 README's claim that any digital ID grants unrestricted authority is stale after
  PR #53. Its standalone-Security-tab and unavailable-Preferences notes are also stale:
  M72 hosts the panel and M130 renders registered schemas. Do not re-open those as defects.
- M53 ADR's statement that PDFium refuses Link creation conflicts with its later measured
  build log: creation works, setting `/A` needs the writer. The final implementation/log
  should inform future work, not the obsolete observation.
- `resources/bin/README.md` describes native PDFium/qpdf/Tesseract destinations generically;
  qpdf currently ships through its npm WASM package. `scripts/README.md` is an incomplete
  index of today's scripts. Historical test counts and window-baseline tolerances are
  snapshots, not current test requirements.
- Windows x64/ARM64, macOS Intel/Apple Silicon and Ubuntu x64 need no new architecture
  binary for this TypeScript codec. Current CI runs Windows/macOS/Ubuntu plus Windows ARM
  installer smoke; ARM smoke alone does not execute the new export journeys. Universal
  packaging likewise does not prove both Mac CPU architectures ran every test.
- Private fixture contents stay outside commits/logs. The new fixtures are generated
  synthetic pixels/PDFs. Tests retain full pixel assertions, tags, unequal DPI, odd widths,
  long runs, IFD termination, strip separation, settings persistence and real UI clicks.

## Integration and validation

In progress. Full local and CI results, exact PR head, and any remaining platform limitations
will be recorded before handing the PR to the coordinator. PLAN.md and CHECKLIST.txt are owned
centrally and are deliberately not edited by this task.
