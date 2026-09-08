/**
 * CPU architecture at runtime (M03, ADR 0009).
 *
 * Two different questions, and modules get them wrong if they only have `process.arch`:
 *
 * - **`targetArch()`** — what this build was compiled for. This is the one a module uses to
 *   choose between a bundled native binary and a WebAssembly path, because it decides which
 *   binaries were packaged next to it.
 * - **`hostArch()`** — what the PC actually is. On Windows an x64 build runs happily on an ARM64
 *   PC under emulation, and then the two answers differ.
 *
 * Nothing here imports Electron, so it is unit-testable and usable from any process.
 */

import { binaryTargetKey, platformLabel, type TargetArch } from '../shared/platform';
import type { Platform } from '../shared/ipc';

/** Architecture this build was compiled for — what decides which native binaries are bundled. */
export function targetArch(): string {
  return process.arch;
}

/** Platform this build was compiled for. */
export function targetPlatform(): Platform {
  return process.platform;
}

/** This build's key in `resources/binaries.json`, e.g. `win32-arm64`. */
export function binaryTarget(): string {
  return binaryTargetKey(process.platform, process.arch);
}

/** True when this build is one of the two Windows architectures the project ships. */
export function isSupportedWindowsArch(arch: string = process.arch): arch is TargetArch {
  return arch === 'x64' || arch === 'arm64';
}

/**
 * The PC's own architecture, seeing through Windows' x64-on-ARM64 emulation.
 *
 * Windows sets `PROCESSOR_ARCHITEW6432` in an emulated process to the *native* architecture
 * (`ARM64`), leaving `PROCESSOR_ARCHITECTURE` as the emulated one (`AMD64`) — the same mechanism
 * WOW64 has always used, and the only detection available without a native `IsWow64Process2`
 * call. Everywhere else, and when the variable is absent, the answer is just `arch`.
 *
 * Arguments are injectable so the emulation cases can be unit-tested off an ARM PC.
 */
export function hostArch(
  arch: string = process.arch,
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  if (platform !== 'win32') return arch;
  const native = env['PROCESSOR_ARCHITEW6432'];
  if (native === undefined || native === '') return arch;
  switch (native.toUpperCase()) {
    case 'ARM64':
      return 'arm64';
    case 'AMD64':
      return 'x64';
    case 'X86':
      return 'ia32';
    default:
      return arch;
  }
}

/** True when this build is not native to the PC it is running on (x64 app on an ARM64 PC). */
export function isEmulated(
  arch: string = process.arch,
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return hostArch(arch, platform, env) !== arch;
}

/**
 * What the About dialog shows: `Windows arm64`, `Windows x64`, or
 * `Windows x64 (emulated on arm64)`.
 */
export function archLabel(
  platform: Platform = process.platform,
  arch: string = process.arch,
  env: Record<string, string | undefined> = process.env,
): string {
  return platformLabel(platform, arch, hostArch(arch, platform, env));
}
