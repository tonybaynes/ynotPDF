# ADR 0009 — Windows on ARM: every native binary ships arm64 or declares a WASM fallback

- Status: accepted
- Date: 2026-09-08
- Module: M03 (Windows on ARM)

## Context

`PLAN.md` §3.1 makes Windows 10/11 **arm64** a first-class target alongside x64. After M00 and
M10 the app contains no architecture-specific code at all: Electron publishes `win32-arm64`
itself, PDFium runs as WebAssembly inside the renderer's engine Worker (ADR 0006), and the only
build-time downloads are font files, whose manifest target is `any`. Windows-on-ARM support
today is therefore packaging plus verification.

The lasting problem is the one that arrives later. M70 (qpdf), M90 (Tesseract) and M131
(installers, auto-update) each add a real native binary. If any of them ships a `win32-x64`
download and nothing for arm64, the arm64 installer still builds, still installs and still
launches — and then one feature fails at the moment a user reaches for it, on the platform
nobody on the team runs day to day. That is the failure mode this ADR exists to prevent.

## Decision

**Every entry in `resources/binaries.json` that offers a `win32-x64` download must also offer
`win32-arm64`, or declare `"arm64Fallback": "wasm"` — meaning the module detects the
architecture and uses a WebAssembly path there instead.** A third option, shipping the feature
broken on arm64, does not exist.

`scripts/fetch-binaries.ts` enforces it. `checkArm64Coverage()` runs before any download and
fails the script with a message naming the offending entry _and its module_:

```
fetch-binaries: qpdf (M70) offers a win32-x64 download but nothing for win32-arm64.
  Windows on ARM is a supported target (ADR 0009). Add a "win32-arm64" entry, or set
  "arm64Fallback": "wasm" on the entry and make the module use a WebAssembly path when
  targetArch() is 'arm64'.
```

Supporting decisions:

- **Fetching follows the target, not the host.** `fetch-binaries` resolves its target from
  `--platform`/`--arch`, else `YNOT_TARGET` (`win32-arm64`), else the host. An x64 CI runner can
  therefore assemble an arm64 payload. `resolveTarget()` is a pure function with unit tests.
- **CI packages both architectures on the x64 Windows runner**
  (`electron-builder --win --x64 --arm64`). electron-builder downloads the arm64 Electron zip
  into the cache; cross-packaging is its normal path and needs no ARM hardware.
- **Runtime architecture is read through `src/main/arch.ts`**, never from scattered
  `process.arch` checks. `targetArch()` is what the build was compiled for — the value a module
  uses to choose a native binary or a WASM path. `hostArch()` is what the PC actually is, seen
  through Windows' x64 emulation via `PROCESSOR_ARCHITEW6432`. `isEmulated()` is the difference.
- **One installer per architecture.** `nsis.buildUniversalInstaller: false`. The default (`true`)
  emits a combined installer carrying both payloads _in addition to_ the per-arch ones, doubling
  the download for no benefit here.

## What is architecture-specific in the app today

| Thing                             | Architecture-specific?             | Why                                                                                                                       |
| --------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Electron runtime                  | Yes — supplied by electron-builder | Official `win32-arm64` build                                                                                              |
| PDFium engine                     | **No**                             | WebAssembly, byte-identical everywhere (ADR 0006), which is also why the render-hash fixtures are shared across platforms |
| Fonts (Liberation, DejaVu)        | **No**                             | `targets: { any: … }` — data files                                                                                        |
| pdf-lib, electron-store, app code | **No**                             | Pure JavaScript/TypeScript                                                                                                |
| qpdf (M70), Tesseract (M90)       | **Not yet built**                  | Bound by the rule above                                                                                                   |

So the arm64 installer ships the same feature set as the x64 one, and the render-hash regression
does not need an arm64 baseline.

## electron-builder's actual behaviour (verified, 26.15.3)

The M03 brief assumed electron-builder refuses to install the wrong architecture by default. It
does not, and the difference matters enough to record.

- `templates/nsis/common.nsh` → `check64BitAndSetRegView` guards **32-bit Windows only**. The
  message catalogue (`templates/nsis/messages.yml`) has `win7Required` and `x64WinRequired`;
  there is no arm64 message.
- `templates/nsis/include/extractAppPackage.nsh` → `identify_package` chooses the payload at run
  time. On an x64 PC an **arm64-only** installer leaves `$packageArch` empty and then tries to
  unpack `app-.7z` — a messy failure with no explanation, not a refusal.
- The same file's `${OrIf} ${IsNativeARM64}` means an **x64** installer deliberately _accepts_ an
  ARM64 PC. That is correct: Windows 11 runs x64 Electron under emulation, so it is a working
  fallback, and we keep it.

We therefore ship `resources/build/installer.nsh` (electron-builder's `nsis.include` hook) with a
`customInit` macro: when the package is arm64-only — `APP_ARM64` defined, `APP_64` not — and
`${IsNativeARM64}` is false, it shows a worded message naming the x64 installer and quits.

`customInit` is the hook rather than `preInit` because `preInit` is inserted into `.onInit`
_before_ the `BUILD_UNINSTALLER` branch, and electron-builder runs that intermediate installer on
the (x64) build machine to generate the uninstaller. A guard there would fail the arm64 build
itself. `customInit` is inserted only in the real-installer pass. The message carries `/SD IDOK`
so a silent install (`/S`) aborts instead of hanging on an invisible dialog.

Verified on an x64 Windows 11 PC, 2026-09-08, against the installers this branch builds:
`ynotPDF-0.0.1-win-arm64.exe /S` exits **1** and installs nothing;
`ynotPDF-0.0.1-win-x64.exe /S` exits **0**, installs, and the Playwright smoke passes against the
installed `ynotPDF.exe` with `YNOT_EXPECT_ARCH=x64` — so the guard refuses the wrong architecture
without misfiring on the right one.

**MSI has no architecture guard at all, and cannot easily get one.** `MsiTarget.js` maps
`Arch.arm64 → x64` when invoking WiX candle, because the bundled WiX 4.0.0.5512.2 predates arm64
support: `ynotPDF-<ver>-win-arm64.msi` is an x64-declared package carrying arm64 binaries. It
builds and installs correctly on ARM, but it will also install on an x64 PC and produce an app
that cannot start. **NSIS is the recommended installer on Windows on ARM**; the MSI stays for
group-policy deployment, where the architecture is decided by the deploying admin. M131 revisits
this when it upgrades or replaces the WiX toolset.

## ARM CI

GitHub's hosted `windows-11-arm` runners are free for public repositories, and
`tonybaynes/ynotPDF` is public with no self-hosted runners registered
(`gh api /repos/tonybaynes/ynotPDF/actions/runners` → `total_count: 0`). **Confirmed by running
one**: the job picked up a `windows-11-arm` runner on the first push of this branch, and the
arm64 installer installed on it. ARM CI is available to this repository — the fallback of
documenting an untested arm64 build is not needed.

The job takes the packaged arm64 installers from the Windows job, installs silently, and drives
the installed `ynotPDF.exe` through the Playwright `app.about` smoke with `YNOT_EXPECT_ARCH=arm64`,
which asserts the About dialog reads exactly `Windows arm64` — i.e. the arm64 binaries really are
running natively, not under emulation. The engine worker round-trip runs there too, so PDFium's
WebAssembly is exercised on ARM.

Two traps, both worth keeping.

**`perMachine: false` only sets the installer's default.** The runner user is an administrator, so
the first elevated `/S` install chose all-users and landed in `C:\Program Files\ynotPDF`, not
`%LOCALAPPDATA%\Programs`. The step passes `/S /currentuser` and reads the location back from the
uninstall registry key rather than assuming a path — and because electron-builder leaves
`InstallLocation` empty there, it parses `DisplayIcon` and `UninstallString` as well.

**The NSIS installer does not survive this runner, so CI installs the MSI.** On every attempt the
NSIS silent install exited 0 and produced an install directory containing `locales/`,
`resources/app.asar` and every `.pak`/`.dat`/`.bin` data file — and _none_ of the PE binaries: no
`ynotPDF.exe`, no DLLs. NSIS unpacks to `%TEMP%` and then `CopyFiles /SILENT` into the install
directory, swallowing failures, and Defender removes the unsigned binaries in between. It cannot
be switched off on the hosted image: `Set-MpPreference -DisableRealtimeMonitoring $true` reports
success and `Get-MpPreference` still returns `False` (Tamper Protection), and path exclusions
changed nothing. `msiexec /qn` works because Windows Installer writes the files itself instead of
copying them out of a temp directory. The job therefore tries NSIS first, falls back to the MSI,
and prints which one produced the app; today that is always the MSI.

This is a property of unsigned binaries on an aggressive scanner, not of the arm64 build — the
same NSIS installer installs correctly on a normal machine (verified on x64, and it is what the
operator's manual smoke checks on real ARM hardware). **M131 signs the installers, which is the
actual fix**; when it lands, re-check whether the NSIS path passes here and drop the fallback.
Until then, an unsigned NSIS install can silently lose its executable on any machine with strict
AV — which is why step 3 of the manual checklist below is "check the executable is there".

The job is `continue-on-error: false` and part of the definition of done for Windows on ARM. If
GitHub ever withdraws the label from this repository the job will fail to start; the response is
to delete the job, say so here and in `README.md`, and fall back to the manual checklist below —
never to leave a job that silently skips.

## Manual smoke on a real ARM device

Kept regardless of CI, and it covers what CI cannot: CI installs the **MSI** into a clean runner
image, so the **NSIS** installer — the one users are pointed at — is only ever exercised on ARM by
hand. Run after any change to packaging or to a native binary:

1. Download `ynotPDF-<ver>-win-arm64.exe` from the run's `installers-win-arm64` artifact.
2. Install it (per-user, no elevation needed).
3. Check `%LOCALAPPDATA%\Programs\ynotPDF` actually contains `ynotPDF.exe` and the `.dll` files.
   Until M131 signs the builds, a strict AV can remove the unsigned binaries mid-install while
   NSIS still reports success — that is exactly what happens on GitHub's ARM runner.
4. Launch, open Help ▸ About ynotPDF. The **Platform** row must read `Windows arm64`. If it
   reads `Windows x64 (emulated on arm64)` the x64 installer was used by mistake.
5. Open a PDF and check it renders — that exercises the WebAssembly engine on ARM.
6. Run `ynotPDF-<ver>-win-arm64.exe` on an **x64** PC and confirm the refusal message appears
   instead of a broken install.

## Consequences

- Any module adding a native binary must think about arm64 at the moment it edits
  `resources/binaries.json`, not at release time. The check makes that unavoidable.
- The Windows CI job builds two Electron payloads instead of one; wall-clock cost is a few
  minutes and one extra cached Electron zip.
- `AppInfo` gains `hostArch` (additive), and the About dialog names the architecture in words.
- Linux arm64 is _not_ covered. The same mechanism would extend to it — a `linux-arm64` key and
  the matching check — but it is not a supported target, so no unused code was written for it.
