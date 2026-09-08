; NSIS customisation for ynotPDF (M03, ADR 0009).
;
; electron-builder has no architecture guard for arm64: `check64BitAndSetRegView` only ever
; rejects 32-bit Windows, and on an x64 PC an arm64-only installer would leave $packageArch
; empty in `identify_package` and then fail while unpacking, with no explanation.
;
; `customInit` runs inside .onInit, but only in the real-installer pass — `preInit` is also
; inserted into electron-builder's intermediate BUILD_UNINSTALLER compile, which it *runs on the
; x64 build machine*, so a guard there would break the arm64 build itself.
;
; The condition is compile-time: APP_ARM64 defined and APP_64 not means this file is the
; arm64-only installer. The x64 installer stays installable on ARM64 on purpose — Windows 11
; runs it under emulation and the About dialog says so.

!macro customInit
  !ifdef APP_ARM64
    !ifndef APP_64
      ${IfNot} ${IsNativeARM64}
        ; /SD IDOK so a silent install (/S) aborts instead of waiting on an invisible dialog.
        MessageBox MB_OK|MB_ICONSTOP "This is the Windows on ARM (arm64) installer for ${PRODUCT_NAME}.$\r$\n$\r$\nThis PC is not an ARM64 PC, so the app would not run. Download the Windows x64 installer instead." /SD IDOK
        SetErrorLevel 1
        Quit
      ${EndIf}
    !endif
  !endif
!macroend
