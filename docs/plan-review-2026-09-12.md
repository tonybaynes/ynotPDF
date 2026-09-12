# Plan review — 12 September 2026

## Decision

Keep the Electron/TypeScript architecture, PDFium worker boundary, document
commands, undo stack, module services and accessible theme system. They are a
reasonable foundation for this product. Do not equate completing the original
44 briefs with matching three commercial editors: the plan explicitly excluded
important functionality, accepted partial implementations and postponed the
largest feasibility risks. Those boundaries no longer satisfy Tony's target.

The target is Windows Intel/AMD **x64**, Windows ARM64, macOS Intel and Apple
Silicon, and Ubuntu Desktop x64. Windows 32-bit is not required. Every target
needs usable installed software and documented feature coverage, not just an
artifact that builds.

This review covers all **124 repository-owned Markdown files** present at the
review baseline, plus `CHECKLIST.txt`. Dependencies, generated files and private
PDF fixtures are excluded. The coordinator read the master documents, audit,
open-work register and all 17 unstarted briefs. Four module tasks read the other
98 Markdown files in assigned groups (33, 20, 18 and 27), including implementation
READMEs and ADRs, and reported their findings. Repeated shared project context
was read once. Their detailed reading inventories and completion findings are
being committed as `docs/reviews/M11-completion-review.md`,
`M13-completion-review.md`, `M41-completion-review.md` and
`M92-completion-review.md`. This is a documentation review with targeted code
and test checks; it does not replace the separately owned code/security audit.

The [reading inventory](reviews/2026-09-12-markdown-inventory.md) records every
baseline file and its reviewing task.

## First repair batch

The original checklist had 27 delivered modules and 17 unstarted modules. The
first four confirmed gaps started repair tasks. Further reading established seven
more required implementation or validation gaps: **16 ticked, four active
repairs, seven queued completions, 17 unstarted**. Counts are not an estimate of
effort remaining. `CHECKLIST.txt` is the live status window; this document records
the review baseline and reasoning.

| Task                                       | Confirmed gap                                                                                   | Boundary                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| M11 - Complete Fit Visible                 | Fit Visible behaves like full-page-width fitting                                                | Viewer geometry/cache; no authenticated opening changes          |
| M13 - Preserve annotations in PDF printing | Vector printing loses annotation/widget appearances and writer-only unsaved edits               | Print snapshot/composition; use the merged save API              |
| M41 - Complete crop aspect ratios          | Ratio selection is unimplemented; rotated/cropped geometry needs correction                     | Crop tool/dialog/helpers; no combine service changes             |
| M92 - Complete bilevel TIFF compression    | Promised bilevel compression is incomplete; single-page output ignores its selected compression | TIFF writer/export options; no export permissions client changes |

Task IDs for coordination and duplicate prevention:

- M11: `01a0946e-700c-7532-92fa-031594975752`
- M13: `01a0946e-7005-73e0-afae-3c0b8c212a44`
- M41: `01a0946e-7009-78c2-8c46-a1346a0b07a1`
- M92: `01a0946e-7006-7402-a18f-9c9acbd3ba72`
- Existing audit: `01a08f69-dfd6-71c0-a622-badd897cf217`
- Coordinator: `01a09469-799c-7d20-8cc5-168ca554d892`

Four tasks are appropriate now. Tony permits up to ten; that is a ceiling.
The concurrent audit owns shared document/save/IPC/client contracts, so filling
every slot would increase integration risk. Separate worktrees prevent shared
working-directory races; they do not prevent incompatible contracts or local
Electron tests competing for clipboard, CPU and GPU resources. Full local UI
suites run one at a time. Replace a slot only after its task has finished and
merged, then inspect current ownership before choosing another module.

The coordinator owns PLAN/CHECKLIST edits and merges. Module tasks own their
implementation, tests, brief/build log and review report, commit their work and
submit PRs. Required CI must pass after integrating current main; completion
ticks follow the merge. Keep the existing audit owner on its current repairs.

Before starting new features, finish the queued M50 unknown-operator preservation
on reorder, M53 multi-file Bates, M60 image-field pictures and M70 per-recipient
certificate rights. Their briefs require these workflows; deferring them to
another module did not complete them. M30 also lacks its promised cross-renderer
appearance comparison, and M32 lacks genuine Acrobat/Foxit-exported XFDF fixtures.
These two are missing acceptance evidence, not demonstrated renderer/importer
defects. These rows are reopened and queued without creating duplicate tasks.

M41's crop PR will not close its entire row: automatic deskew on image import
is another confirmed omission. The setting is declared in M41, but M91 does not
read it or invoke deskew. Assign that follow-up after the crop task merges and
the audit's M91 ownership clears. M91's production TIFF decoder is also reopened:
a valid 17 × 2 black Group 4 image decodes 27 of its 34 pixels incorrectly when
compressed and decoded strip lengths happen to match. A focused production-adapter
probe reproduced it; an independent PDFium decode verifies the encoded strip.
M92's TIFF repair does not fix that importer. M91 Unicode text quality and M100 font
subsetting breadth still need triage. M31's inability to rotate an externally
reopened custom stamp is a documented limitation beyond its literal original
placement requirement, so that finding alone does not reopen M31.

Two active modules also retain follow-ups after their first PRs: M13 physical
printing/preview still use engine-only state and can omit writer-only unsaved
edits; M92's decoded embedded-image export drops alpha and can substitute
placement dimensions for stored pixel dimensions despite the ADR contract.
Keep those rows open until their required scope is repaired and validated.

## Corrections applied to the plan and briefs

| Area               | Correction and acceptance consequence                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope              | Original Core/Pro/Parked tiers are delivery history, not permission to omit parity requirements. Track unsupported functionality explicitly.                                                                                                                                                      |
| PDF engine         | PDFium supplies low-level operations, not a complete paragraph editor or the current commercial Foxit product. Keep it, but prove higher-level capabilities independently.                                                                                                                        |
| M51 text editing   | Font subsetting cannot create missing glyphs. Test font reconstruction/substitution, shaping, Unicode extraction, bidirectional and complex text. Line-only editing does not complete paragraph reflow.                                                                                           |
| M71 redaction      | Clipping or painting over content cannot satisfy removal. Rewrite affected objects and image samples, remove hidden representations and old revisions, then independently inspect the saved artifact. Unsupported structures require a clear failure or explicitly selected destructive fallback. |
| M80 saving         | Implement an explicit append-versus-rewrite policy. Redaction/sanitisation and incompatible security changes need a clean rewrite. Do not assume a library exposes an incremental-save option without proving it.                                                                                 |
| M81 signatures     | Certification permission P=2 does not permit ordinary annotation edits; use P=3 for that fixture. Test cryptographic validity, certificate trust and allowed modifications separately. Non-exportable OS keys need a real signing operation.                                                      |
| M90 OCR            | Add the M41 deskew dependency. Track searchable/image and editable output separately; M51 is needed for the latter. Test accuracy and geometry across implementations instead of assuming byte-identical output.                                                                                  |
| M93 Office         | Verify each conversion direction and LibreOffice filter family independently. An optional external installation and a generic conversion command do not establish faithful PDF-to-Word/Excel/PowerPoint parity.                                                                                   |
| M94 PDF/A          | Test each promised profile. PDF/A-2 permits transparency; attachment rules differ among profiles. A small in-app check is not a conformance validator, and adding an output intent does not convert colours.                                                                                      |
| M82 handwriting    | Add the existing M31 ink/pressure dependency.                                                                                                                                                                                                                                                     |
| M111 accessibility | Minimal figure tags and a checker do not complete reading-order/tag-tree remediation or PDF/UA. Validate tag structure and real assistive-technology behaviour.                                                                                                                                   |
| UI accessibility   | Opaque application controls remain mandatory. This does not prohibit preserving or editing transparency in PDF content.                                                                                                                                                                           |
| Platforms          | Separate Windows x64/ARM64 and macOS Intel/ARM64 evidence. Pin OS floors against the shipped runtime. Test Ubuntu X11/Wayland and actual installer/update flows.                                                                                                                                  |

These decisions are supported by the primary
[PDFium editing API](https://pdfium.googlesource.com/pdfium/+/main/public/fpdf_edit.h),
[LibreOffice filter tables](https://help.libreoffice.org/latest/en-GB/text/shared/guide/convertfilters.html),
[PDF Association PDF/A FAQ](https://pdfa.org/pdfa-faq/) and
[PDF Association document-security presentation](https://pdfa.org/wp-content/uploads/2025/05/0-1-16_15-YulianEugene-Document_Security_Authenticity-untagged.pdf).
The engineering acceptance changes above are our conclusions from those
capabilities and the repository's own requirements.

## Product parity requires a separate acceptance matrix

Maintain a versioned feature matrix with product, edition, platform, source,
ynotPDF owner, implemented scope, representative documents, acceptance evidence
and remaining gaps. Distinguish desktop features from separately sold services.
Current product pages establish broad comparison categories; they are not proof
that ynotPDF implements them. Foxit describes editing, conversion and
accessibility workflows in its [PDF Editor offering](https://www.foxit.com/pdf-editor/).
Adobe documents [accessibility remediation](https://helpx.adobe.com/acrobat/using/accessibility-features-pdfs.html)
and [preflight](https://helpx.adobe.com/acrobat/using/analyzing-documents-preflight-tool-acrobat.html).
Tungsten's [Power PDF Advanced offering](https://www.tungstenautomation.com/products/power-pdf/advanced)
includes integration and collaboration workflows beyond a local editor core.

| Product requirement           | Initial module owner                     | Gap to resolve before claiming parity                                                               |
| ----------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Faithful text/image editing   | M50–M54                                  | Layout reconstruction, fonts, scripts, clipping/transparency and unknown-object preservation        |
| Scanned-document workflows    | M90, M62                                 | OCR quality, correction, editable reconstruction, scanner acquisition requirements                  |
| Office conversion             | M93                                      | Direction-specific fidelity, native deployment and external-dependency decision                     |
| Accessible PDF authoring      | M111 plus a follow-up brief              | Full tag/reading-order editing, semantics, validation and assistive-technology corpus               |
| Print production              | M13, M94 plus a follow-up brief          | Preflight profiles/fixups, colour management, separations and output fidelity                       |
| Forms and automation          | M60–M62, M120                            | Image fields, scripting/action compatibility, XFA applicability and unsupported-action handling     |
| Security and signatures       | M70, M71, M80, M81                       | Independent security evidence, trust/LTV, OS key stores, modification permissions and clean rewrite |
| Enterprise/document workflows | M42, M53, M120, M131 plus follow-ups     | Connectors, collaboration/e-sign services, virtual printer and watched-folder requirements          |
| Rich PDF compatibility        | Engine/navigation plus a follow-up brief | 3D/media and other formerly parked formats need explicit support decisions and safe fallback        |

New follow-up modules need numbered briefs and dependencies before implementation;
do not silently treat the original 44 as exhaustive. Exact edition/version and
document-level comparisons remain work to perform, not completed research in
this review. Keep cloud services and commercial licensing decisions visible
without blocking unrelated local-editor repairs.

## Delivery order and evidence

Preserve the existing usable-app milestones and Tony's easiest-first delivery
preference. Finish incomplete delivered scope first. After repairs, I recommend
bringing the **feasibility work** for M51 text/fonts, M80 save policy and M93
Office conversion forward, while retaining staged feature delivery. Establish
the structure/tagging contract before new features proliferate untagged objects.
Waiting until the final waves to discover that these foundations cannot meet
the target creates avoidable rework. A spike is a decision with evidence, not a
completion tick for the whole module.

M120 must enumerate implemented service capabilities and reject unavailable
verbs; later signature/PDF-A/text services cannot be promised merely because
the batch UI contains their names. M62 should distinguish vector-form detection
from scanned-form detection that depends on OCR. Use explicit dependency gates
and subfeature status instead of disabled controls presented as finished scope.

Every relevant module needs tests that create/edit through the UI, save, reopen
in ynotPDF and an independent reader, and check both appearance and document
semantics. Include undo/redo, concurrent mutation barriers, recovery, passwords
and permissions, rotated/CropBox pages, annotations/widgets, layers, fonts and
non-Latin text where applicable. Keep genuine third-party exported interchange
fixtures alongside synthetic edge cases; synthetic fixtures alone cannot prove
Acrobat/Foxit interoperability. Never commit Tony's private documents.

Set measured latency and memory budgets on named representative hardware and
document classes, including large scans and portfolios. Record cold/warm timing,
tail latency, cancellation and sustained memory growth. One small fixture or
an installer smoke test is not evidence of responsive large-file editing.
Malformed files require bounded parsing, cancellation and worker/process
isolation. Follow the audit's runtime-validation and filesystem-boundary fixes.

Required CI on Windows/macOS/Linux remains a merge gate. Native ARM installer
smoke evidence, complete feature tests, signing/notarisation, upgrades and real
assistive-technology checks are distinct release gates. Do not describe a
successful MSI smoke as proof that NSIS installs without warnings. The exact
macOS/Ubuntu minimum versions must be reconciled with the shipped Electron and
helper binaries, then tested and documented.

## Documentation debt discovered while reading

Several READMEs still describe completed selection, model, save and shell
integrations as future stubs. M11 layout names and M41 ADR links have drifted.
Some theme instructions retain the superseded low-contrast placeholder
exception. M04 notes a deferred forms journey although a forms suite now exists.
M33 describes an older measurement structure. Retain historical build logs,
but put current capability and outstanding work above them when each owner
updates its brief. The current CLAUDE/PLAN coordination rules override old
Claude-only model, branch and co-author instructions in copied brief context.

Do not rewrite a permissive-only dependency preference as a claim that copyleft
software cannot be used commercially. The shipped dependency policy remains
unchanged. External development/validation tools and bundled runtime libraries
must be distinguished and reviewed under their actual licences; the audit owns
the existing licence gate repairs.
