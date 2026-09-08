# resources/build

electron-builder `buildResources`. `icon.png` (1024×1024, RGBA) is the **real app icon** —
the operator's logo, cropped with transparent rounded corners from
`resources/brand/ynotPDF-logo-source.jpg` (2026-09-08). electron-builder derives `icon.ico`
and `icon.icns` from it. WiX refuses to build an MSI without an icon, so it cannot be omitted.

`npm run icon` (`scripts/make-icon.ts`) **verifies** the file (square, ≥ 512 px, RGBA); it no
longer generates a placeholder. To change the icon, replace the PNG and re-run. M131 may add a
DMG background from the same brand folder.
