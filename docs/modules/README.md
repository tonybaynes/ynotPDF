# Module briefs

One self-contained brief per module. Tell a conversation:

> Read `docs/modules/<file>` and carry out the task in its **Your task** section.

| Wave | Module | Tier | Depends on |
|---|---|---|---|
| 0 | [M00 Scaffold, CI & packaging smoke](./M00-scaffold.md) | Core | — |
| 1 | [M01 Theme system (four themes)](./M01-theme-system.md) | Core | M00 |
| 1 | [M02 Application shell (ribbon, panes, tabs, status bar, dialogs)](./M02-app-shell.md) | Core | M00, M01 |
| 1 | [M10 PDF engine layer & PDFium adapter](./M10-engine-layer.md) | Core | M00 |
| 1 | [M20 Document model, commands & undo stack](./M20-document-model.md) | Core | M00, M10 |
| 2 | [M03 Windows on ARM (arm64) support](./M03-windows-arm.md) | Core | M00, M10 |
| 2 | [M11 Viewer — rendering, navigation, zoom, layouts](./M11-viewer.md) | Core | M02, M10 |
| 2 | [M21 Save, Save As, autosave & recovery](./M21-save.md) | Core | M20, M11 |
| 2 | [M70 Encryption, permissions & certificate security](./M70-encryption.md) | Core | M21 |
| 2 | [M91 Create PDF from images, web pages, clipboard, HTML/Markdown & text](./M91-create-pdf.md) | Core | M21 |
| 3 | [M12 Navigation panels — thumbnails, bookmarks, layers, attachments, destinations](./M12-navigation-panels.md) | Core | M11, M20 |
| 3 | [M13 Text selection, find, copy, snapshot & print](./M13-select-find-print.md) | Core | M11 |
| 3 | [M30 Annotations — text markup, notes, typewriter, text box, callout](./M30-markup-annotations.md) | Core | M21, M11, M13 |
| 3 | [M40 Organise pages — insert, delete, extract, replace, rotate, move, labels](./M40-organise-pages.md) | Core | M21, M12 |
| 4 | [M04 UI-journey and layout test harness](./M04-ui-journey-tests.md) | Core | M02, M11, M12, M13, M30 |
| 4 | [M42 PDF Portfolios — create, edit, cover sheet, extract](./M42-portfolios.md) | Core | M12, M21 |
| 4 | [M31 Annotations — shapes, ink & eraser, stamps, file attachments](./M31-shapes-ink-stamps.md) | Core | M30 |
| 4 | [M32 Comments panel, replies & status, FDF/XFDF, summarise](./M32-comments-panel.md) | Core | M30 |
| 4 | [M41 Merge, split, extract to files, crop, deskew & flatten](./M41-merge-split-crop.md) | Core | M40 |
| 4 | [M72 Document properties, metadata & XMP, initial view](./M72-properties-metadata.md) | Core | M21 |
| 4 | [M130 Preferences, keyboard shortcuts editor, ribbon/QAT customisation, UI scale, i18n framework](./M130-preferences.md) | Core | M02, M01 |
| 5 | [M33 Measuring tools — distance, perimeter, area, calibration](./M33-measuring-tools.md) | Core | M31 |
| 5 | [M50 Page-object model — select, move, resize, align, arrange](./M50-object-model.md) | Core | M21, M11 |
| 5 | [M60 Form fill & AcroForm field designer](./M60-forms.md) | Core | M21, M30 |
| 5 | [M92 Export to images, text, HTML & RTF](./M92-export.md) | Core | M11, M13 |
| 5 | [M100 Optimise (reduce size), linearise, repair, remove duplicates](./M100-optimise-repair.md) | Core | M21 |
| 6 | [M53 Header/footer, Bates numbering, watermark, background & links](./M53-headers-bates-watermarks-links.md) | Core | M50, M21 |
| 6 | [M61 Field logic — validation, formatting, calculation, actions; data import/export; flatten](./M61-form-logic-data.md) | Core | M60 |
| 6 | [M82 Handwritten signatures & initials](./M82-handwritten-signatures.md) | Core | M30, M60 |
| 6 | [M90 OCR — searchable image, image+text, editable text](./M90-ocr.md) | Core | M21 |
| 6 | [M110 Compare documents](./M110-compare.md) | Core | M11, M13 |
| 7 | [M52 Image & path object editing](./M52-image-path-editing.md) | Core | M50 |
| 7 | [M111 Read aloud, accessibility check & alt text](./M111-read-aloud-accessibility.md) | Core | M13 |
| 7 | [M120 Batch processing & action wizard](./M120-batch-actions.md) | Core | M21, M41, M53, M61, M70, M90, M92, M100 |
| 8 | [M51 Text editing with reflow (spike first)](./M51-text-editing.md) | Pro | M50, M13 |
| 8 | [M62 Automatic form-field recognition](./M62-field-recognition.md) | Pro | M60 |
| 8 | [M80 Incremental-update writer](./M80-incremental-writer.md) | Core | M21, M20 |
| 8 | [M93 Office ↔ PDF via LibreOffice bridge](./M93-office-bridge.md) | Pro | M21, M91 |
| 8 | [M121 Command-line interface](./M121-cli.md) | Core | M120 |
| 9 | [M54 Find & replace, spell-check](./M54-find-replace-spellcheck.md) | Core | M51, M13 |
| 9 | [M71 Redaction & sanitise (remove hidden information)](./M71-redaction.md) | Core | M50, M51, M30 |
| 9 | [M81 Digital signatures — sign, certify, timestamp, LTV, validate, trust](./M81-digital-signatures.md) | Core | M80, M60 |
| 9 | [M94 PDF/A conversion & basic validation](./M94-pdfa.md) | Pro | M100, M72 |
| 10 | [M131 Installers, code signing, auto-update, crash reporting, help & first run](./M131-release.md) | Core | M00, M130 |
