# ADR 0027 — Intrinsic embedded-image decoding and output choice

Status: accepted for M92 completion (2026-09-12; coordinator-approved contract).

`PdfEngine.pageImages` gains an optional third `PageImagesOptions` argument with
`output?: 'original' | 'png'` and an internal `purpose?: 'intrinsic' | 'appearance'`.
Omitting the purpose retains intrinsic extraction. Omission and `original` preserve the existing contract:
single-filter DCT/JPX streams are returned byte-for-byte; other encodings return RGBA.
`png` requests RGBA for every encoding. The generic engine RPC carries the optional
argument without new IPC channels or permission changes. Existing callers remain valid.

The Export All Images dialog exposes **Original formats** (default) and **PNG with
transparency**, with a remembered preference and equivalent headless command option.
Original JPEG/JP2 bytes may omit an external PDF image mask. PNG applies image-level
`SMask`/`Mask` and retains alpha, including masked DCT/JPX images. Placement transforms,
page clipping and graphics-state opacity are deliberately excluded from intrinsic pixels.

PDFium's public `FPDFImageObj_GetBitmap` excludes masks; `GetRenderedBitmap` includes
masks, placement and clipping. Consequently decoded images are isolated with their own
dictionary and colour resources on an intrinsic-size page, then decoded by PDFium.
The existing PDF parser handles traversal and dictionary copying; it does not implement
another colour-space or mask decoder. Live page objects are never transformed for a read.
Source bytes reflect current edits and are decrypted through the existing snapshot path.

Nested Form XObjects are included with resource inheritance and composed placement
matrices. Their `index` identifies the containing top-level page object, without adding
a new public identity type. Cycles and explicit traversal/allocation limits report errors
instead of quietly returning a partial set of images. This clarification does not make
extraction a page render or include undrawn resource entries as placements.

Deduplication groups by encoding, dimensions and a byte hash, then compares every byte.
RGBA comparisons include alpha, so distinct masks survive; hash collisions are not equality.
Effective DPI does not create a second copy of an otherwise identical image resource.

HTML explicitly requests `purpose: 'appearance'`: it needs the placed picture rather
than intrinsic samples. A disposable native document opened from current bytes retains
the page/form graphics state. `FPDFPageObj_SetIsActive` isolates the target image and
its ancestor forms; `FPDF_RenderPageBitmapWithMatrix` renders transparent RGBA, including
rotation, clipping and opacity, while sibling images, paths and text remain inactive.
No live page activity, matrix or content changes. The native page, document, bitmaps and
allocations are closed even on failure. Image errors propagate to the caller.

Appearance rectangles remain in original PDF page coordinates, as required by HTML's
positioning contract; the page display matrix is cancelled before rendering each crop.
Resolution is at least one pixel per point and sufficient for the larger of the image's
two effective sample densities. A render is limited to 64 million pixels, retained page
appearances to 512 MiB, and traversal to 100,000 objects / 256 levels. These limits do
not imply that the complete export result is streamed with constant memory.

Intrinsic colour conversion and mask resampling remain PDFium's responsibility. When
mask dimensions differ, its renderer resamples them to the intrinsic image dimensions;
the independent fixture checks the resulting bilinear alpha plane. Named colour-space
resolution follows array grammar, leaving colorant names, profiles, lookup tables and
tint functions in their own roles. This is distinct from substituting every PDF name.

HTML remains a text-and-picture reconstruction: this change does not claim vector,
annotation, backdrop-dependent blend-mode, or complete page-layout fidelity. Page-level
rotation/layout policy for text and images remains outside this bounded appearance repair.

References: [PDFium public image APIs](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_edit.h)
and [rendered-image implementation](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/fpdfsdk/fpdf_editimg.cpp).
The [page renderer](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/fpdfsdk/fpdf_view.cpp)
and [page matrices](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/core/fpdfapi/page/cpdf_page.cpp)
define the appearance route's matrix composition and bitmap ownership.
These are public API/implementation sources; no commercial product files were inspected.
