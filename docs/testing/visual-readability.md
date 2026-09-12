# Visual readability checks

Tony asked for stronger end-to-end tests and actual inspection of screenshots from
the running app. Both are needed: an element can be visible to Playwright while its
label is cropped or a neighbouring control overlaps it.

`test/e2e/visual-layout.spec.ts` captures the start page, document panels, Preferences
and the longest fit-mode label across all four themes at 100%, 150% and 200% UI scale.
It also exercises the image-export choices at 200%, including CCITT Group 4. Tests
check clipping, contrast, keyboard focus, status-slot overlap and native value width.
The native-value helper measures text in the actual control font and reserves space
for a select's arrow. It is an additional check, not a substitute for visual review.

Two regressions prove that measurement can fail: a deliberately narrow native select,
and the original long TIFF label temporarily restored in the real export dialog.
Neither relies on the select reporting scroll overflow, which it does not do.

The status bar now wraps when its controls need more space, and the zoom field can
display Fit visible in full. Image-export choices use compact labels with wrapping,
selection-specific explanations below them; the grid stacks at larger UI scales.
Stored enum values and export behaviour are unchanged.

Screenshots are Playwright attachments. CI retains `visual-review-<platform>` PNG
artifacts for seven days on both passing and failing runs. Use synthetic fixtures;
never publish Tony's private documents. Inspect representative images after changes,
including scrolled sections of long dialogs. Report exactly which images were reviewed.
The existing Windows pixel comparisons keep their thresholds; absent macOS/Linux
pixel baselines remain explicitly skipped while geometry checks run cross-platform.

Local verification before the initial UI commit: all 26 focused tests passed, including
four themes at 200%, and 165 export unit tests passed. Build, typecheck and focused
ESLint passed. Individual Group 4 screenshots from all four themes were inspected:
the choice and its explanation are readable, and Export/Cancel remain accessible.
The Original/PNG embedded-image choice belongs to PR 63 and needs integration
verification once that feature merges; this document does not claim it was tested yet.

A final five-test run also passed after adding separate Format and Method captures.
The High Contrast 200% captures of those two sections were inspected individually:
selected values are complete and the explanation text wraps within the dialog.
Full lint passed before those final test-only capture additions; focused ESLint and
a fresh build passed afterward. These are focused local results; the full platform
matrix must still pass on the pushed commit before merge.
