/**
 * Downloads per-OS native binaries listed in `resources/binaries.json` into `resources/bin/`,
 * verifying SHA-256. No Docker, no compilers: prebuilt official releases only.
 *
 * Manifest entry shape:
 * {
 *   "name": "pdfium", "version": "7000", "module": "M10",
 *   "targets": {
 *     "win32-x64":  { "url": "https://…/pdfium-win-x64.tgz",  "sha256": "…", "extract": true },
 *     "darwin-universal": { … }, "linux-x64": { … }
 *   }
 * }
 * Usage: `node scripts/fetch-binaries.ts [--platform win32] [--arch x64] [--force]`
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Target {
  readonly url: string;
  readonly sha256: string;
  /** File name inside resources/bin/<name>/ (defaults to the URL's basename). */
  readonly file?: string;
}

interface BinaryEntry {
  readonly name: string;
  readonly version: string;
  readonly module: string;
  readonly targets: Readonly<Record<string, Target>>;
}

interface Manifest {
  readonly binaries: ReadonlyArray<BinaryEntry>;
}

const args = process.argv.slice(2);
const opt = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const platform = opt('--platform') ?? process.platform;
const arch = opt('--arch') ?? process.arch;
const force = args.includes('--force');
const key = `${platform}-${arch}`;

const root = process.cwd();
const manifest = JSON.parse(
  readFileSync(join(root, 'resources', 'binaries.json'), 'utf8'),
) as Manifest;
const outDir = join(root, 'resources', 'bin');
mkdirSync(outDir, { recursive: true });

async function fetchOne(entry: BinaryEntry): Promise<void> {
  const target = entry.targets[key] ?? entry.targets[`${platform}-universal`];
  if (!target) {
    console.info(`fetch-binaries: ${entry.name} has no target for ${key}, skipping`);
    return;
  }
  const dir = join(outDir, entry.name);
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    target.file ?? new URL(target.url).pathname.split('/').pop() ?? entry.name,
  );
  if (existsSync(file) && !force) {
    const existing = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (existing === target.sha256) {
      console.info(`fetch-binaries: ${entry.name} ${entry.version} already present`);
      return;
    }
  }
  console.info(`fetch-binaries: downloading ${entry.name} ${entry.version} for ${key}`);
  const res = await fetch(target.url);
  if (!res.ok) throw new Error(`${target.url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== target.sha256) {
    throw new Error(
      `${entry.name}: checksum mismatch\n  expected ${target.sha256}\n  got      ${digest}`,
    );
  }
  writeFileSync(file, bytes);
  console.info(`fetch-binaries: wrote ${file}`);
}

for (const entry of manifest.binaries) await fetchOne(entry);
console.info(`fetch-binaries: done (${manifest.binaries.length} entries)`);
