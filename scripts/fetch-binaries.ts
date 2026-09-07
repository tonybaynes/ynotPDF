/**
 * Downloads per-OS native binaries and platform-independent data (fonts) listed in
 * `resources/binaries.json`, verifying SHA-256. No Docker, no compilers: prebuilt official
 * releases only. Archives (`.tar.gz`, `.zip`) can be unpacked selectively (M10).
 *
 * Manifest entry shape:
 * {
 *   "name": "pdfium", "version": "7000", "module": "M10",
 *   "dir": "resources/bin/pdfium",              // optional, default resources/bin/<name>
 *   "targets": {
 *     "win32-x64":  { "url": "https://…/pdfium-win-x64.tgz",  "sha256": "…",
 *                     "extract": { "format": "tar.gz", "files": { "lib/pdfium.dll": "pdfium.dll" } } },
 *     "darwin-universal": { … }, "linux-x64": { … },
 *     "any": { … }                              // platform-independent (fonts, data)
 *   }
 * }
 * Usage: `node scripts/fetch-binaries.ts [--platform win32] [--arch x64] [--force] [--only name]`
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';

interface Extract {
  readonly format: 'tar.gz' | 'zip';
  /** archive member path → file name inside `dir`. */
  readonly files: Readonly<Record<string, string>>;
}

interface Target {
  readonly url: string;
  readonly sha256: string;
  /** File name inside the destination dir (defaults to the URL's basename). */
  readonly file?: string;
  readonly extract?: Extract;
}

interface BinaryEntry {
  readonly name: string;
  readonly version: string;
  readonly module: string;
  readonly dir?: string;
  readonly targets: Readonly<Record<string, Target>>;
}

interface Manifest {
  readonly binaries: ReadonlyArray<BinaryEntry>;
}

// ---- archive readers (small on purpose: gzip via zlib, tar/zip parsed here) ------------------

/** Extracts the wanted members of a POSIX/ustar tarball. */
export function readTar(tar: Uint8Array, wanted: ReadonlySet<string>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder('utf-8');
  const str = (off: number, len: number): string => {
    const slice = tar.subarray(off, off + len);
    const nul = slice.indexOf(0);
    return dec.decode(nul >= 0 ? slice.subarray(0, nul) : slice);
  };
  let p = 0;
  while (p + 512 <= tar.length) {
    if (tar[p] === 0) break; // end-of-archive zero blocks
    let name = str(p, 100);
    const size = parseInt(str(p + 124, 12).trim() || '0', 8);
    const type = tar[p + 156];
    const magic = str(p + 257, 6);
    if (magic.startsWith('ustar')) {
      const prefix = str(p + 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const dataStart = p + 512;
    if ((type === 0x30 || type === 0) && wanted.has(name)) {
      out.set(name, tar.slice(dataStart, dataStart + size));
    }
    p = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Extracts the wanted members of a zip file (stored or deflated entries). */
export function readZip(zip: Uint8Array, wanted: ReadonlySet<string>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const dec = new TextDecoder('utf-8');
  // End of central directory record: scan back for its signature.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('zip: bad central directory');
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    if (wanted.has(name)) {
      if (view.getUint32(localOffset, true) !== 0x04034b50)
        throw new Error('zip: bad local header');
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(dataStart, dataStart + compressed);
      if (method === 0) out.set(name, data.slice());
      else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(data)));
      else throw new Error(`zip: unsupported compression method ${method} for ${name}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---- main -----------------------------------------------------------------------------------

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function fetchOne(
  root: string,
  entry: BinaryEntry,
  key: string,
  platform: string,
  force: boolean,
) {
  const target =
    entry.targets[key] ?? entry.targets[`${platform}-universal`] ?? entry.targets['any'];
  if (!target) {
    console.info(`fetch-binaries: ${entry.name} has no target for ${key}, skipping`);
    return;
  }
  const dir = join(root, entry.dir ?? join('resources', 'bin', entry.name));
  mkdirSync(dir, { recursive: true });
  const stamp = join(dir, `.${entry.name}.sha256`);
  const outputs = target.extract
    ? Object.values(target.extract.files).map((f) => join(dir, f))
    : [join(dir, target.file ?? new URL(target.url).pathname.split('/').pop() ?? entry.name)];
  if (!force && outputs.every((f) => existsSync(f))) {
    if (target.extract) {
      if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === target.sha256) {
        console.info(`fetch-binaries: ${entry.name} ${entry.version} already present`);
        return;
      }
    } else if (sha256(readFileSync(outputs[0] ?? '')) === target.sha256) {
      console.info(`fetch-binaries: ${entry.name} ${entry.version} already present`);
      return;
    }
  }
  console.info(`fetch-binaries: downloading ${entry.name} ${entry.version} for ${key}`);
  const res = await fetch(target.url);
  if (!res.ok) throw new Error(`${target.url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== target.sha256) {
    throw new Error(
      `${entry.name}: checksum mismatch\n  expected ${target.sha256}\n  got      ${digest}`,
    );
  }
  if (target.extract) {
    const wanted = new Set(Object.keys(target.extract.files));
    const members =
      target.extract.format === 'tar.gz'
        ? readTar(new Uint8Array(gunzipSync(bytes)), wanted)
        : readZip(bytes, wanted);
    for (const [member, dest] of Object.entries(target.extract.files)) {
      const data = members.get(member);
      if (!data) throw new Error(`${entry.name}: ${member} not found in archive`);
      const file = join(dir, dest);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, data);
    }
    writeFileSync(stamp, `${target.sha256}\n`);
    console.info(`fetch-binaries: extracted ${wanted.size} files into ${dir}`);
  } else {
    writeFileSync(outputs[0] ?? '', bytes);
    console.info(`fetch-binaries: wrote ${outputs[0]}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const platform = opt('--platform') ?? process.platform;
  const arch = opt('--arch') ?? process.arch;
  const only = opt('--only');
  const force = args.includes('--force');
  const key = `${platform}-${arch}`;
  const root = process.cwd();
  const manifest = JSON.parse(
    readFileSync(join(root, 'resources', 'binaries.json'), 'utf8'),
  ) as Manifest;
  let n = 0;
  for (const entry of manifest.binaries) {
    if (only && entry.name !== only) continue;
    await fetchOne(root, entry, key, platform, force);
    n++;
  }
  console.info(`fetch-binaries: done (${n} entries)`);
}

// Run only as a script (the archive readers are imported by unit tests).
if (process.argv[1]?.endsWith('fetch-binaries.ts')) {
  await main();
}
