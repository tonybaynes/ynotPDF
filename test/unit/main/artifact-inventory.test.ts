import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bundledPackageDirectories,
  collectPackageNotices,
  releaseProblems,
  verifyArtifactReview,
  type ArtifactReview,
} from '../../../scripts/lib/artifact-inventory';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof Fs>();
  return { ...original, openSync: vi.fn(original.openSync) };
});

const scratch: string[] = [];
afterEach(() => {
  vi.mocked(openSync).mockClear();
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});
function noticePath(name = 'LICENSE.txt'): string {
  const root = mkdtempSync(join(tmpdir(), 'ynot-notice-'));
  scratch.push(root);
  return join(root, name);
}

describe('artifact licence inventory', () => {
  it.each(['missing', 'empty', 'whitespace', 'directory', 'unreadable'] as const)(
    'blocks release when a LICENSE-named notice is %s',
    (state) => {
      const path = noticePath();
      if (state === 'directory') mkdirSync(path);
      else if (state !== 'missing')
        writeFileSync(
          path,
          state === 'empty' ? '' : state === 'whitespace' ? ' \n\t' : 'Synthetic notice',
        );
      if (state === 'unreadable')
        vi.mocked(openSync).mockImplementationOnce(() => {
          throw new Error('EACCES: fault-injected notice access denial');
        });
      const inventory = collectPackageNotices({
        'example@1': { licenses: 'MIT', licenseFile: path },
      });
      expect(inventory.components[0]?.completeNotice).toBe(false);
      expect(inventory.components[0]?.noticeSha256).toBeNull();
      expect(inventory.notices).toEqual([]);
      expect(releaseProblems(inventory.components, [])).toEqual([
        'example@1: complete licence notice not verified',
      ]);
    },
  );
  it('hashes and emits the same readable notice bytes without inferring completeness from README metadata', () => {
    const bytes = 'Synthetic copyright and permission notice\n';
    const path = noticePath();
    const metadata = noticePath('README.md');
    writeFileSync(path, bytes);
    writeFileSync(metadata, 'MIT');
    const inventory = collectPackageNotices({
      'example@1': { licenses: 'MIT', licenseFile: path },
      'metadata@1': { licenses: 'MIT', licenseFile: metadata },
    });
    expect(inventory.components[0]).toEqual({
      id: 'example@1',
      license: 'MIT',
      completeNotice: true,
      noticeSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(inventory.notices[0]).toBe('example@1\n\n\n' + bytes);
    expect(inventory.components[1]?.completeNotice).toBe(false);
    expect(releaseProblems(inventory.components, [])).toEqual([
      'metadata@1: complete licence notice not verified',
    ]);
  });
  it('counts bundled dev dependencies and retains nested package locations', () => {
    expect(
      bundledPackageDirectories([
        'src/renderer/main.ts',
        'node_modules/lucide/dist/index.js',
        'node_modules/lucide/dist/icons/eye.js',
        'node_modules/@scope/parent/node_modules/nested/index.js',
        'node_modules/@scope/parent/index.js',
      ]),
    ).toEqual([
      'node_modules/@scope/parent',
      'node_modules/@scope/parent/node_modules/nested',
      'node_modules/lucide',
    ]);
  });
  it('refuses a changed opaque artifact version or hash until provenance is reviewed again', () => {
    const reviews = (
      JSON.parse(readFileSync('resources/licenses/artifacts.json', 'utf8')) as {
        artifacts: ArtifactReview[];
      }
    ).artifacts;
    const review = reviews[0];
    if (!review) throw new Error('Missing binary review fixture');
    expect(() => {
      verifyArtifactReview(review);
    }).not.toThrow();
    expect(() => {
      verifyArtifactReview({ ...review, version: 'unreviewed' });
    }).toThrow(/Artifact changed/);
    expect(() => {
      verifyArtifactReview({ ...review, sha256: '0'.repeat(64) });
    }).toThrow(/Artifact changed/);
  });
  it('keeps the strict release gate closed on missing texts or incomplete compiled reviews', () => {
    const review: ArtifactReview = {
      id: 'engine',
      package: 'engine',
      version: '1',
      file: 'engine.wasm',
      sha256: '',
      source: '',
      provenance: '',
      reviewComplete: true,
      notices: ['LICENSE.txt'],
      openItems: [],
    };
    expect(releaseProblems([{ id: 'icons', completeNotice: true }], [review])).toEqual([]);
    expect(
      releaseProblems(
        [{ id: 'wrapper', completeNotice: false }],
        [{ ...review, reviewComplete: false }],
      ),
    ).toHaveLength(2);
    expect(releaseProblems([], [{ ...review, notices: [] }])).toHaveLength(1);
    expect(
      releaseProblems([], [{ ...review, openItems: ['Unidentified compiled component'] }]),
    ).toHaveLength(1);
  });
});
