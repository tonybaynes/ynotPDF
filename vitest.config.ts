import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@engine': resolve(import.meta.dirname, 'src/engine'),
      '@core': resolve(import.meta.dirname, 'src/renderer/core'),
      '@app': resolve(import.meta.dirname, 'src/renderer/app'),
      '@view': resolve(import.meta.dirname, 'src/renderer/view'),
      '@theme': resolve(import.meta.dirname, 'src/renderer/theme'),
      '@modules': resolve(import.meta.dirname, 'src/renderer/modules'),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: [
        'src/renderer/core/**/*.ts',
        // M21's engine half: the writer contract, the pdf-lib writer and the appearance
        // generators. M10's PDFium adapter stays out — it is proved against the corpus, not by
        // line coverage.
        'src/engine/Writer.ts',
        'src/engine/writers/**/*.ts',
        'src/engine/appearance/**/*.ts',
        // M70's engine half: the security façade, the permission arithmetic and the public-key
        // handler. `qpdf-asset.ts` is gone (qpdf lives in main now, ADR 0011) and `qpdf.ts` is
        // the Emscripten wrapper, proved against a real qpdf rather than by line count.
        'src/engine/security/**/*.ts',
        // M91's converters: pure over bytes, so all of them are gated.
        'src/engine/create/**/*.ts',
        // M41's document operations: pure over bytes and over pixels, so all of them are gated.
        'src/engine/ops/**/*.ts',
        'src/shared/pageSizes.ts',
        'scripts/lib/**/*.ts',
        'src/renderer/theme/**/*.ts',
        'src/renderer/modules/**/*.ts',
        'src/renderer/view/**/*.ts',
      ],
      /*
       * Excluded from the gate, not from the tests: the gallery is a dev-only page and the
       * status-bar switcher is pure DOM wiring — both are exercised by Playwright
       * (test/e2e/theme.spec.ts), which is where UI behaviour belongs.
       */
      exclude: [
        'src/renderer/theme/gallery.ts',
        'src/renderer/modules/M01-theme-system/switcher.ts',
        /*
         * M11's DOM half. There is no jsdom in this repo (the brief adds no libraries), so the
         * viewport, the page views, the overlays, the loupe and the HUD are proved by Playwright
         * in `test/e2e/viewer.spec.ts` instead — which is where DOM behaviour belongs anyway.
         * Everything they are built out of is pure and gated below.
         */
        'src/renderer/view/DocumentView.ts',
        'src/renderer/view/PageView.ts',
        'src/renderer/view/Layers.ts',
        'src/renderer/view/Overlays.ts',
        'src/renderer/view/Loupe.ts',
        'src/renderer/view/PerfHud.ts',
        'src/renderer/view/TileRenderer.ts',
        'src/renderer/modules/M11-viewer/Viewer.ts',
        'src/renderer/modules/M11-viewer/ViewerService.ts',
        'src/renderer/modules/M11-viewer/password.ts',
        'src/renderer/modules/M11-viewer/tools.ts',
        /*
         * M21's DOM and shell half, for the same reason: `SaveService` orchestrates dialogs,
         * IPC and the tab strip, and `dialogs.ts` and `manifest.ts` are the dialogs and the
         * contribution points themselves. All three are proved by Playwright in
         * `test/e2e/save.spec.ts`, which is where a Save / Don't save / Cancel flow belongs;
         * the decisions underneath them are unit-tested in `test/unit/save/service.test.ts`.
         */
        /*
         * M12's DOM half, for the same reason: the five panels, the service that mounts them and
         * the manifest that wires them up are proved by Playwright in `test/e2e/panels.spec.ts`,
         * which is where a virtualised grid and a drag-to-reorder belong. Everything they are
         * built out of — the tree algebra, the grid geometry, the destination maths, the
         * settings, the thumbnail queue — is pure and gated below.
         */
        'src/renderer/modules/M12-navigation-panels/manifest.ts',
        'src/renderer/modules/M12-navigation-panels/NavigationService.ts',
        'src/renderer/modules/M12-navigation-panels/panelChrome.ts',
        'src/renderer/modules/M12-navigation-panels/thumbnails/ThumbnailPanel.ts',
        'src/renderer/modules/M12-navigation-panels/bookmarks/BookmarkPanel.ts',
        'src/renderer/modules/M12-navigation-panels/destinations/DestinationPanel.ts',
        'src/renderer/modules/M12-navigation-panels/attachments/AttachmentPanel.ts',
        'src/renderer/modules/M21-save/SaveService.ts',
        'src/renderer/modules/M21-save/dialogs.ts',
        'src/renderer/modules/M21-save/manifest.ts',
        /*
         * M13's DOM and shell half, for the same reason again: the find bar, the search panel,
         * the print dialog, the highlighter, the selection controller's event plumbing, the
         * canvas helpers and the service that wires them together are proved by Playwright in
         * `test/e2e/select-find-print.spec.ts`. Everything they are built out of — the text
         * layer, the matcher, the selection model, RTF, page ranges, the imposition, the plan,
         * the settings and the snapshot arithmetic — is pure and gated below.
         */
        'src/renderer/modules/M13-select-find-print/SelectFindService.ts',
        'src/renderer/modules/M13-select-find-print/canvas.ts',
        'src/renderer/modules/M13-select-find-print/find/FindBar.ts',
        'src/renderer/modules/M13-select-find-print/find/SearchPanel.ts',
        'src/renderer/modules/M13-select-find-print/manifest.ts',
        'src/renderer/modules/M13-select-find-print/print/PrintDialog.ts',
        'src/renderer/modules/M13-select-find-print/print/PrintService.ts',
        'src/renderer/modules/M13-select-find-print/print/render.ts',
        'src/renderer/modules/M13-select-find-print/selection/Highlighter.ts',
        'src/renderer/modules/M13-select-find-print/selection/TextSelectionController.ts',
        'src/renderer/modules/M13-select-find-print/selection/clipboard.ts',
        'src/renderer/modules/M13-select-find-print/tools.ts',
        /*
         * M70's DOM and shell half, for the same reason. `dialogs.ts` *is* the Protect dialog and
         * `manifest.ts` the contribution points; `SecurityService` orchestrates them, IPC and the
         * save pipeline. All three are proved by Playwright in `test/e2e/security.spec.ts` —
         * which is where "the file on disk is encrypted and Chrome asks for the password"
         * belongs — while the decisions underneath them are unit-tested in
         * `test/unit/security/`. `qpdf.ts` is the Emscripten wrapper: what matters about it is
         * that qpdf answers, which every test in that folder depends on.
         */
        'src/renderer/modules/M70-encryption/SecurityService.ts',
        'src/renderer/modules/M70-encryption/dialogs.ts',
        'src/renderer/modules/M70-encryption/manifest.ts',
        'src/engine/security/qpdf.ts',
        /*
         * M91's DOM and shell half, for the same reason again: `CreateService` orchestrates the
         * file dialogs, the Worker, main's printer and the tab strip; `dialogs.ts` and `forms.ts`
         * are the option dialogs themselves; `manifest.ts` is the contribution points; and the
         * two decoders and the Worker entry need a browser. All are proved by Playwright in
         * `test/e2e/create.spec.ts`, and everything they are built out of is pure and gated
         * above (`src/engine/create/**`) or below.
         */
        'src/renderer/modules/M91-create-pdf/CreateService.ts',
        'src/renderer/modules/M91-create-pdf/dialogs.ts',
        'src/renderer/modules/M91-create-pdf/forms.ts',
        'src/renderer/modules/M91-create-pdf/manifest.ts',
        'src/renderer/modules/M91-create-pdf/open.ts',
        'src/renderer/modules/M91-create-pdf/rasterDecoder.ts',
        'src/renderer/modules/M91-create-pdf/create.worker.ts',
        /*
         * M30's DOM and shell half, for the same reason again: the annotation layer's painting,
         * the pointer/keyboard controller, the inline editor, the popup note, the properties panel
         * and the service that wires them together all need a document and a running viewer, and
         * are proved by Playwright in `test/e2e/annotations.spec.ts`. Everything they are built out
         * of — the quads, the shapes, the presets, the settings, the clipboard and the whole of
         * `engine/appearance/` — is pure and gated below. `NotePopup`'s two exported string
         * functions are the exception and are unit-tested; the file is excluded because the rest of
         * it is a `contenteditable`.
         */
        'src/renderer/modules/M30-markup-annotations/AnnotationService.ts',
        'src/renderer/modules/M30-markup-annotations/AnnotationController.ts',
        'src/renderer/modules/M30-markup-annotations/InlineEditor.ts',
        'src/renderer/modules/M30-markup-annotations/NotePopup.ts',
        'src/renderer/modules/M30-markup-annotations/PropertiesPanel.ts',
        'src/renderer/modules/M30-markup-annotations/identity.ts',
        'src/renderer/modules/M30-markup-annotations/manifest.ts',
        'src/renderer/modules/M30-markup-annotations/tools.ts',
        'src/renderer/view/AnnotationLayer.ts',
        /*
         * M31's DOM and shell half, for the same reason: the tools, the properties sections, the
         * stamp palette, the custom-stamp dialog (a canvas), the PNG import (a canvas) and the
         * service that wires them together all need a document and a running viewer, and are
         * proved by Playwright in `test/e2e/drawing.spec.ts`. Everything they are built out of —
         * the geometry, the overlay's rules, the provider's patches, the settings, the commands
         * and the whole of `engine/appearance/` — is pure and gated below.
         */
        'src/renderer/modules/M31-shapes-ink-stamps/DrawingService.ts',
        'src/renderer/modules/M31-shapes-ink-stamps/manifest.ts',
        'src/renderer/modules/M31-shapes-ink-stamps/panel.ts',
        'src/renderer/modules/M31-shapes-ink-stamps/StampDialog.ts',
        'src/renderer/modules/M31-shapes-ink-stamps/StampPanel.ts',
        'src/renderer/modules/M31-shapes-ink-stamps/stampImport.ts',
        'src/renderer/modules/M31-shapes-ink-stamps/tools.ts',
        /*
         * M40's DOM and shell half, for the same reason again. `OrganiseService` orchestrates
         * the dialogs, the engine, the progress dialog and the tab strip; `dialogs.ts` *is* the
         * Organize dialogs; `manifest.ts` is the contribution points; and `dnd.ts` is a pointer
         * drag controller that only exists once there is a grid to drag in. All four are proved
         * by Playwright in `test/e2e/organise.spec.ts`, which is where a drag with an insertion
         * marker belongs. Everything they are built out of — the range dialect, the numbering,
         * the settings, the commands and the slicing — is pure and gated below, and so is the
         * one pure function inside `dnd.ts` (`insertionIndexFor`), which has its own tests.
         */
        'src/renderer/modules/M40-organise-pages/OrganiseService.ts',
        'src/renderer/modules/M40-organise-pages/dialogs.ts',
        'src/renderer/modules/M40-organise-pages/manifest.ts',
        'src/renderer/modules/M40-organise-pages/dnd.ts',
        /*
         * M41's DOM and shell half, for the same reason again: `MergeService` orchestrates the
         * dialogs, the Worker, the engine and the tab strip; the five dialogs and the crop tool
         * only exist once there is a document to drag a rectangle on; and `ops.worker.ts` is a
         * Worker entry. All are proved by Playwright in `test/e2e/document-ops.spec.ts`, and
         * everything they are built out of — the whole of `src/engine/ops/`, the commands and
         * the settings — is pure and gated above and below. `OpsClient` is gated: its two paths
         * are what a unit test can drive through a fake port.
         */
        'src/renderer/modules/M41-merge-split-crop/MergeService.ts',
        'src/renderer/modules/M41-merge-split-crop/manifest.ts',
        'src/renderer/modules/M41-merge-split-crop/combineDialog.ts',
        'src/renderer/modules/M41-merge-split-crop/splitDialog.ts',
        'src/renderer/modules/M41-merge-split-crop/cropDialog.ts',
        'src/renderer/modules/M41-merge-split-crop/flattenDialog.ts',
        'src/renderer/modules/M41-merge-split-crop/deskewDialog.ts',
        'src/renderer/modules/M41-merge-split-crop/cropTool.ts',
        'src/renderer/modules/M41-merge-split-crop/fields.ts',
        'src/renderer/modules/M41-merge-split-crop/ops.worker.ts',
      ],
      reporter: ['text', 'lcov'],
      thresholds: {
        'src/renderer/core/Store.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/core/UndoStack.ts': { lines: 95, functions: 95, statements: 95 },
        // M20's model. The undo stack has to be exactly right, so the gate is high.
        'src/renderer/core/Document.ts': { lines: 92, functions: 90, statements: 92 },
        'src/renderer/core/commands.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/core/Journal.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/core/Ids.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/core/model.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/core/events.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/theme/ThemeManager.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/theme/contrast.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/theme/separation.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/theme/parse.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/modules/M01-theme-system/**': { lines: 90, functions: 90, statements: 90 },
        // M11's pure view maths: the layout table, tiling, the LRU, Night Mode, zoom, units,
        // guides and history. These decide what the reader sees, so the gate is high.
        'src/renderer/view/layout.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/view/tiles.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/view/TileCache.ts': { lines: 95, functions: 90, statements: 95 },
        'src/renderer/view/night.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/view/zoom.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/view/units.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/view/guides.ts': { lines: 90, functions: 85, statements: 90 },
        'src/renderer/view/history.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/modules/M11-viewer/settings.ts': {
          lines: 90,
          functions: 85,
          statements: 90,
        },
        // M21. The writer decides what the file on disk says, so its gate is the highest here.
        'src/engine/writers/FullRewriteWriter.ts': { lines: 85, functions: 90, statements: 85 },
        'src/engine/appearance/generators.ts': { lines: 90, functions: 95, statements: 90 },
        'src/engine/appearance/content.ts': { lines: 90, functions: 85, statements: 90 },
        'src/engine/appearance/metrics.ts': { lines: 95, functions: 95, statements: 95 },
        'src/engine/appearance/index.ts': { lines: 90, functions: 90, statements: 90 },
        // M12's pure half. The tree is what a bookmark edit is, and the grid is the operator's
        // layout rule, so both are held high.
        'src/renderer/modules/M12-navigation-panels/bookmarks/tree.ts': {
          lines: 95,
          functions: 95,
          statements: 95,
        },
        'src/renderer/modules/M12-navigation-panels/thumbnails/grid.ts': {
          lines: 95,
          functions: 95,
          statements: 95,
        },
        'src/renderer/modules/M12-navigation-panels/destinations/navigate.ts': {
          lines: 95,
          functions: 95,
          statements: 95,
        },
        'src/renderer/modules/M12-navigation-panels/settings.ts': {
          lines: 85,
          functions: 80,
          statements: 85,
        },
        'src/renderer/modules/M12-navigation-panels/commands.ts': {
          lines: 85,
          functions: 85,
          statements: 85,
        },
        'src/renderer/modules/M21-save/plan.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/modules/M21-save/recovery.ts': { lines: 85, functions: 75, statements: 85 },
        'src/renderer/modules/M21-save/commands.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/modules/M21-save/settings.ts': { lines: 80, functions: 70, statements: 80 },
        'src/renderer/modules/M21-save/WriterClient.ts': {
          lines: 75,
          functions: 80,
          statements: 75,
        },
        // M13's pure half: the text model everything textual reads, the matcher, the selection
        // rules and the print arithmetic. These decide what is selected, found and printed.
        'src/renderer/view/TextLayer.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/modules/M13-select-find-print/find/search.ts': {
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'src/renderer/modules/M13-select-find-print/find/csv.ts': {
          lines: 95,
          functions: 95,
          statements: 95,
        },
        'src/renderer/modules/M13-select-find-print/selection/model.ts': {
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'src/renderer/modules/M13-select-find-print/selection/rtf.ts': {
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'src/renderer/modules/M13-select-find-print/print/pageRange.ts': {
          lines: 95,
          functions: 95,
          statements: 95,
        },
        'src/renderer/modules/M13-select-find-print/print/imposition.ts': {
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'src/renderer/modules/M13-select-find-print/print/plan.ts': {
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'src/renderer/modules/M13-select-find-print/print/paper.ts': {
          lines: 85,
          functions: 85,
          statements: 85,
        },
        /*
         * Only the *vector* half of "Print to PDF" can run in Node; the raster half needs a
         * canvas, so it is proved by Playwright (`print to PDF as an image` in
         * `test/e2e/select-find-print.spec.ts`). The gate covers what Node can reach.
         */
        'src/renderer/modules/M13-select-find-print/print/printToPdf.ts': {
          lines: 70,
          functions: 70,
          statements: 65,
        },
        'src/renderer/modules/M13-select-find-print/settings.ts': {
          lines: 85,
          functions: 75,
          statements: 85,
        },
        'src/renderer/modules/M13-select-find-print/TextService.ts': {
          lines: 85,
          functions: 80,
          statements: 85,
        },
        'src/renderer/modules/M13-select-find-print/find/FindController.ts': {
          lines: 80,
          functions: 80,
          statements: 80,
        },
        // M70. The permission arithmetic and the public-key handler decide what a protected file
        // allows and who can open it, so their gates are the highest here.
        'src/engine/security/permissions.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/security/pubsec/crypto.ts': { lines: 85, functions: 85, statements: 85 },
        'src/engine/security/pubsec/standard.ts': { lines: 95, functions: 95, statements: 95 },
        'src/engine/security/pubsec/envelope.ts': { lines: 85, functions: 85, statements: 85 },
        'src/engine/security/pubsec/encrypt.ts': { lines: 80, functions: 80, statements: 80 },
        'src/engine/security/pubsec/certificates.ts': { lines: 80, functions: 75, statements: 80 },
        'src/engine/security/Security.ts': { lines: 80, functions: 80, statements: 80 },
        'src/renderer/modules/M70-encryption/intent.ts': {
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'src/renderer/modules/M70-encryption/commands.ts': {
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'src/renderer/modules/M70-encryption/strength.ts': {
          lines: 95,
          functions: 95,
          statements: 95,
        },
        // M91. The converters decide what a created document says, so their gates are high; the
        // header parsers are the highest because everything downstream trusts what they report.
        'src/engine/create/images/headers.ts': { lines: 90, functions: 95, statements: 90 },
        'src/engine/create/images/layout.ts': { lines: 95, functions: 95, statements: 95 },
        'src/engine/create/images/raster.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/create/images/tiff.ts': { lines: 85, functions: 90, statements: 85 },
        'src/engine/create/images/ImageConverter.ts': { lines: 85, functions: 90, statements: 85 },
        'src/engine/create/text/TextConverter.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/create/text/decode.ts': { lines: 95, functions: 95, statements: 95 },
        'src/engine/create/blank/BlankConverter.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/create/html/HtmlConverter.ts': { lines: 85, functions: 85, statements: 85 },
        'src/engine/create/web/crawl.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/create/web/assemble.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/create/web/urls.ts': { lines: 95, functions: 95, statements: 95 },
        'src/engine/create/web/WebConverter.ts': { lines: 85, functions: 85, statements: 85 },
        'src/engine/create/registry.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/create/types.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/create/markdown.ts': { lines: 95, functions: 95, statements: 95 },
        'src/shared/pageSizes.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/modules/M91-create-pdf/settings.ts': {
          lines: 80,
          functions: 70,
          statements: 80,
        },
        'src/renderer/modules/M91-create-pdf/ConvertClient.ts': {
          lines: 75,
          functions: 80,
          statements: 75,
        },
        // M30's pure half: the quads a highlight is written from, what the overlay draws, the
        // presets, the settings and the clipboard. The quads decide what a markup annotation
        // actually marks, so their gate is the highest here.
        'src/renderer/modules/M30-markup-annotations/quads.ts': {
          lines: 95,
          functions: 95,
          statements: 95,
        },
        'src/renderer/modules/M30-markup-annotations/shapes.ts': {
          lines: 85,
          functions: 90,
          statements: 85,
        },
        'src/renderer/modules/M30-markup-annotations/clipboard.ts': {
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'src/renderer/modules/M30-markup-annotations/settings.ts': {
          lines: 85,
          functions: 85,
          statements: 85,
        },
        'src/renderer/modules/M30-markup-annotations/presets.ts': {
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'src/engine/appearance/dict.ts': { lines: 95, functions: 95, statements: 95 },
        'src/engine/appearance/freetext.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/appearance/markup.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/appearance/note.ts': { lines: 90, functions: 90, statements: 90 },
        // M31's pure half: the shapes, the ink and the stamps decide what the file draws, and the
        // geometry and the overlay rules decide what the reader can grab.
        'src/engine/appearance/shapes.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/appearance/ink.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/appearance/stamp.ts': { lines: 90, functions: 90, statements: 90 },
        'src/renderer/modules/M31-shapes-ink-stamps/geometry.ts': {
          lines: 95,
          functions: 95,
          statements: 95,
        },
        'src/renderer/modules/M31-shapes-ink-stamps/overlay.ts': {
          lines: 85,
          functions: 85,
          statements: 85,
        },
        'src/renderer/modules/M31-shapes-ink-stamps/provider.ts': {
          lines: 85,
          functions: 85,
          statements: 85,
        },
        'src/renderer/modules/M31-shapes-ink-stamps/settings.ts': {
          lines: 85,
          functions: 85,
          statements: 85,
        },
        'src/renderer/modules/M31-shapes-ink-stamps/commands.ts': {
          lines: 85,
          functions: 85,
          statements: 85,
        },
        // M40. The range dialect decides which pages a destructive command acts on and the
        // numbering decides what the file says a page is called, so both are held high; the
        // commands are what undo has to reverse exactly.
        'src/renderer/modules/M40-organise-pages/range.ts': {
          lines: 95,
          functions: 95,
          statements: 95,
        },
        'src/renderer/modules/M40-organise-pages/labels.ts': {
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'src/engine/pageLabels.ts': { lines: 95, functions: 95, statements: 95 },
        'src/renderer/modules/M40-organise-pages/commands.ts': {
          lines: 85,
          functions: 85,
          statements: 85,
        },
        'src/renderer/modules/M40-organise-pages/extract.ts': {
          lines: 90,
          functions: 90,
          statements: 90,
        },
        'src/renderer/modules/M40-organise-pages/settings.ts': {
          lines: 85,
          functions: 80,
          statements: 85,
        },
        // M41's operations. These decide what a combined, split, cropped, flattened or
        // straightened file actually says, so the gate is high; the two detectors are pure over
        // pixels and gated with them.
        'src/engine/ops/combine.ts': { lines: 85, functions: 85, statements: 85 },
        'src/engine/ops/split.ts': { lines: 90, functions: 95, statements: 90 },
        'src/engine/ops/crop.ts': { lines: 90, functions: 90, statements: 90 },
        'src/engine/ops/flatten.ts': { lines: 80, functions: 90, statements: 80 },
        'src/engine/ops/deskew.ts': { lines: 90, functions: 95, statements: 90 },
        'src/engine/ops/outline.ts': { lines: 90, functions: 95, statements: 90 },
        'src/engine/ops/pdfdoc.ts': { lines: 80, functions: 90, statements: 80 },
        'src/renderer/modules/M41-merge-split-crop/commands.ts': {
          lines: 85,
          functions: 85,
          statements: 85,
        },
        'src/renderer/modules/M41-merge-split-crop/settings.ts': {
          lines: 85,
          functions: 80,
          statements: 85,
        },
        'src/renderer/modules/M41-merge-split-crop/OpsClient.ts': {
          lines: 75,
          functions: 80,
          statements: 75,
        },
      },
    },
  },
});
