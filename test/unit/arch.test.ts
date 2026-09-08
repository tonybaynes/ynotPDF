/**
 * M03: architecture reporting. The interesting cases cannot be reproduced by running the suite
 * anywhere in particular — an x64 build emulated on an ARM64 PC is exactly the case the operator
 * needs named correctly — so every function takes its inputs.
 */

import { describe, expect, it } from 'vitest';
import {
  archLabel,
  binaryTarget,
  hostArch,
  isEmulated,
  isSupportedWindowsArch,
  targetArch,
  targetPlatform,
} from '../../src/main/arch';
import { binaryTargetKey, platformLabel, platformName } from '../../src/shared/platform';

describe('targetArch / targetPlatform', () => {
  it('report the build this process is', () => {
    expect(targetArch()).toBe(process.arch);
    expect(targetPlatform()).toBe(process.platform);
    expect(binaryTarget()).toBe(`${process.platform}-${process.arch}`);
  });

  it('accepts only the two architectures the project ships for Windows', () => {
    expect(isSupportedWindowsArch('x64')).toBe(true);
    expect(isSupportedWindowsArch('arm64')).toBe(true);
    expect(isSupportedWindowsArch('ia32')).toBe(false);
    expect(isSupportedWindowsArch('riscv64')).toBe(false);
  });
});

describe('hostArch', () => {
  it('is the build arch when nothing says otherwise', () => {
    expect(hostArch('x64', 'win32', {})).toBe('x64');
    expect(hostArch('arm64', 'win32', {})).toBe('arm64');
  });

  it('sees through Windows x64-on-ARM64 emulation', () => {
    expect(hostArch('x64', 'win32', { PROCESSOR_ARCHITEW6432: 'ARM64' })).toBe('arm64');
    // Windows writes it upper-case; be forgiving anyway.
    expect(hostArch('x64', 'win32', { PROCESSOR_ARCHITEW6432: 'arm64' })).toBe('arm64');
  });

  it('maps the other WOW64 values and ignores unknown ones', () => {
    expect(hostArch('ia32', 'win32', { PROCESSOR_ARCHITEW6432: 'AMD64' })).toBe('x64');
    expect(hostArch('ia32', 'win32', { PROCESSOR_ARCHITEW6432: 'x86' })).toBe('ia32');
    expect(hostArch('x64', 'win32', { PROCESSOR_ARCHITEW6432: 'ALPHA' })).toBe('x64');
    expect(hostArch('x64', 'win32', { PROCESSOR_ARCHITEW6432: '' })).toBe('x64');
  });

  it('ignores the variable off Windows — Rosetta is macOS universal, not our problem', () => {
    expect(hostArch('arm64', 'darwin', { PROCESSOR_ARCHITEW6432: 'ARM64' })).toBe('arm64');
    expect(hostArch('x64', 'linux', { PROCESSOR_ARCHITEW6432: 'ARM64' })).toBe('x64');
  });
});

describe('isEmulated', () => {
  it('is true only when the build and the PC disagree', () => {
    expect(isEmulated('arm64', 'win32', {})).toBe(false);
    expect(isEmulated('x64', 'win32', {})).toBe(false);
    expect(isEmulated('x64', 'win32', { PROCESSOR_ARCHITEW6432: 'ARM64' })).toBe(true);
  });
});

describe('archLabel / platformLabel', () => {
  it('names the supported targets in words', () => {
    expect(archLabel('win32', 'arm64', {})).toBe('Windows arm64');
    expect(archLabel('win32', 'x64', {})).toBe('Windows x64');
    expect(archLabel('darwin', 'arm64', {})).toBe('macOS arm64');
    expect(archLabel('linux', 'x64', {})).toBe('Linux x64');
  });

  it('says when an x64 build is running emulated on an ARM64 PC', () => {
    expect(archLabel('win32', 'x64', { PROCESSOR_ARCHITEW6432: 'ARM64' })).toBe(
      'Windows x64 (emulated on arm64)',
    );
  });

  it('keeps the Node name for a platform we do not ship', () => {
    expect(platformName('freebsd')).toBe('freebsd');
    expect(platformLabel('freebsd', 'x64')).toBe('freebsd x64');
  });

  it('omits the emulation note when the host is unknown or the same', () => {
    expect(platformLabel('win32', 'arm64')).toBe('Windows arm64');
    expect(platformLabel('win32', 'arm64', 'arm64')).toBe('Windows arm64');
  });
});

describe('binaryTargetKey', () => {
  it('matches the keys used in resources/binaries.json', () => {
    expect(binaryTargetKey('win32', 'arm64')).toBe('win32-arm64');
    expect(binaryTargetKey('darwin', 'universal')).toBe('darwin-universal');
  });
});
