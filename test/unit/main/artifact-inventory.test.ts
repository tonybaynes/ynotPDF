import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bundledPackageDirectories,
  releaseProblems,
  verifyArtifactReview,
  type ArtifactReview,
} from '../../../scripts/lib/artifact-inventory';

describe('artifact licence inventory', () => {
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
