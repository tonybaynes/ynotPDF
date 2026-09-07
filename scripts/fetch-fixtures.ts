/**
 * Downloads the pinned external fixture PDFs (pdf.js test suite, Apache-2.0) listed in
 * `test/fixtures/external/manifest.json` into `test/fixtures/external/`, verifying SHA-256.
 * The files are git-ignored; the manifest (commit + hashes) is the source of truth.
 *
 * Usage: `node scripts/fetch-fixtures.ts [--force]`
 * Exit code 0 when every file is present and matches; the engine corpus test skips external
 * entries that are missing, so an offline developer is never blocked.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface ExternalFile {
  readonly file: string;
  readonly sha256: string;
  readonly size: number;
  readonly password?: string;
  readonly notes?: string;
}

interface ExternalManifest {
  readonly base: string;
  readonly commit: string;
  readonly files: ReadonlyArray<ExternalFile>;
}

const root = process.cwd();
const dir = join(root, 'test', 'fixtures', 'external');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ExternalManifest;
const force = process.argv.includes('--force');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

mkdirSync(dir, { recursive: true });
let downloaded = 0;
let present = 0;
for (const entry of manifest.files) {
  const target = join(dir, entry.file);
  if (!force && existsSync(target) && sha256(readFileSync(target)) === entry.sha256) {
    present++;
    continue;
  }
  const url = `${manifest.base}${entry.file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== entry.sha256) {
    throw new Error(
      `${entry.file}: checksum mismatch\n  expected ${entry.sha256}\n  got      ${digest}`,
    );
  }
  writeFileSync(target, bytes);
  downloaded++;
  console.info(`fetch-fixtures: ${entry.file} (${bytes.byteLength} bytes)`);
}
console.info(
  `fetch-fixtures: ${manifest.files.length} files pinned to pdf.js ${manifest.commit.slice(0, 10)} — ${present} present, ${downloaded} downloaded`,
);
