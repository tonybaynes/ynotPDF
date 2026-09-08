/**
 * Platform and CPU-architecture naming, shared by the main process (`src/main/arch.ts`) and the
 * renderer (the About dialog). Pure string work — no `process`, no Electron — so both sides and
 * the unit tests can use it (M03).
 *
 * `PLAN.md` §3.1 supported targets: Windows x64, Windows arm64, macOS universal, Linux x64.
 */

import type { Platform } from './ipc';

/** CPU architectures the project builds for. Keys of `targets` in `resources/binaries.json`. */
export type TargetArch = 'x64' | 'arm64';

/** Human names for the platforms we ship. Anything else falls back to its `process.platform`. */
const PLATFORM_NAMES: Partial<Record<Platform, string>> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

/** `'win32'` → `'Windows'`. Unknown platforms keep their Node name rather than guessing. */
export function platformName(platform: Platform): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

/**
 * The label the About dialog shows, e.g. `Windows arm64`, `Windows x64` or, when an x64 build
 * runs under Windows' emulation on an ARM64 PC, `Windows x64 (emulated on arm64)`.
 *
 * `arch` is the architecture of the *build*; `host` the architecture of the *PC*. Passing the
 * same value for both (or omitting `host`) means "not emulated".
 */
export function platformLabel(platform: Platform, arch: string, host?: string): string {
  const base = `${platformName(platform)} ${arch}`;
  return host !== undefined && host !== arch ? `${base} (emulated on ${host})` : base;
}

/** Manifest/target key for `resources/binaries.json` and CI, e.g. `win32-arm64`. */
export function binaryTargetKey(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}
