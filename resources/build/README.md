# resources/build

electron-builder `buildResources`. `icon.png` (512×512) is a generated **placeholder**
(`npm run icon`, `scripts/make-icon.ts`); electron-builder derives `icon.ico` and `icon.icns`
from it. WiX refuses to build an MSI without an icon, so it cannot be omitted.

The operator supplies the real logo (PLAN.md §10.1) and M131 replaces this file (plus a DMG
background if wanted).
