/**
 * The system font list (M30, ADR 0013).
 *
 * Electron has no API for "what fonts does this machine have", and the module adds no libraries,
 * so the families are read the only way left: walk the OS font directories and parse each file's
 * `name` table. That is about a hundred lines of sfnt reading and needs nothing but `fs`.
 *
 * **It reads a few hundred bytes per font, not the font.** The first version read each file whole
 * and took over thirty seconds on a Windows CI runner — and this runs in the main process, where
 * that is a frozen window, not a slow test. A font's table directory is at a known offset and
 * names its `name` table's offset and length, so two small reads answer the question whatever the
 * file's size. A wall-clock budget stops a pathological machine — a network font folder, a
 * spinning disk with ten thousand faces — from holding the picker open regardless.
 *
 * Only the **family name** is taken — id 16 where a font has one, because that is the name a font
 * menu shows when a family has been split into Light and Semibold, else id 1. TrueType collections
 * (`.ttc`) are walked font by font. Anything that fails to parse is skipped: a broken font on the
 * machine must not cost the reader their font picker.
 *
 * The result is cached for the life of the process — fonts do not appear while an app is running
 * often enough to justify walking the folders twice.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.TTF', '.OTF', '.TTC']);

/** How long the whole walk may take. Past this the list is whatever has been found so far. */
const BUDGET_MS = 4000;

/** Most fonts a machine is asked about. Well past any real font folder; a stop, not a target. */
const MAX_FILES = 4000;

/** Where each OS keeps its fonts. Missing directories are skipped in silence. */
function fontDirectories(): string[] {
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return [
        join(process.env['SystemRoot'] ?? 'C:\\Windows', 'Fonts'),
        join(
          process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'),
          'Microsoft',
          'Windows',
          'Fonts',
        ),
      ];
    case 'darwin':
      return ['/System/Library/Fonts', '/Library/Fonts', join(home, 'Library', 'Fonts')];
    default:
      return [
        '/usr/share/fonts',
        '/usr/local/share/fonts',
        join(home, '.local', 'share', 'fonts'),
        join(home, '.fonts'),
      ];
  }
}

function* walk(dir: string, depth = 0): Generator<string> {
  if (depth > 4) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) {
      yield* walk(full, depth + 1);
      continue;
    }
    const dot = name.lastIndexOf('.');
    if (dot > 0 && EXTENSIONS.has(name.slice(dot))) yield full;
  }
}

// ---- sfnt reading ------------------------------------------------------------------------------

/** Reads `length` bytes at `at`. Returns a shorter buffer, or an empty one, past the end. */
export type ByteReader = (at: number, length: number) => Buffer;

/** A reader over an open file descriptor: this is what keeps the cost to a few hundred bytes. */
function fileReader(fd: number): ByteReader {
  return (at, length) => {
    if (length <= 0 || at < 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(length);
    let read: number;
    try {
      read = readSync(fd, buffer, 0, length, at);
    } catch {
      return Buffer.alloc(0);
    }
    return read === length ? buffer : buffer.subarray(0, Math.max(0, read));
  };
}

/** A reader over bytes already in memory — what the tests use. */
export function bufferReader(bytes: Buffer): ByteReader {
  return (at, length) => bytes.subarray(Math.max(0, at), Math.max(0, at + length));
}

/** The family names an sfnt or a collection holds, given a reader over it. */
export function familiesIn(read: ByteReader): string[] {
  const head = read(0, 12);
  if (head.length < 12) return [];
  const out: string[] = [];
  // 'ttcf' — a collection header, then an offset per font.
  if (head.readUInt32BE(0) === 0x74746366) {
    const count = Math.min(head.readUInt32BE(8), 64);
    const offsets = read(12, count * 4);
    for (let i = 0; i + 4 <= offsets.length; i += 4) {
      const family = familyAt(read, offsets.readUInt32BE(i));
      if (family) out.push(family);
    }
    return out;
  }
  const family = familyAt(read, 0);
  if (family) out.push(family);
  return out;
}

/** The family name of the sfnt whose header starts at `base`. */
function familyAt(read: ByteReader, base: number): string | null {
  const header = read(base, 12);
  if (header.length < 12) return null;
  const numTables = header.readUInt16BE(4);
  if (numTables === 0 || numTables > 512) return null;
  const directory = read(base + 12, numTables * 16);
  let nameOffset = -1;
  let nameLength = 0;
  for (let i = 0; i + 16 <= directory.length; i += 16) {
    if (directory.toString('latin1', i, i + 4) !== 'name') continue;
    nameOffset = directory.readUInt32BE(i + 8);
    nameLength = directory.readUInt32BE(i + 12);
    break;
  }
  // A `name` table larger than a megabyte is not a name table; refuse rather than read it.
  if (nameOffset < 0 || nameLength < 6 || nameLength > 1_000_000) return null;
  const table = read(nameOffset, nameLength);
  if (table.length < 6) return null;

  const count = table.readUInt16BE(2);
  const storage = table.readUInt16BE(4);
  let best: string | null = null;
  for (let i = 0; i < count; i++) {
    const record = 6 + i * 12;
    if (record + 12 > table.length) break;
    const platformId = table.readUInt16BE(record);
    const nameId = table.readUInt16BE(record + 6);
    // Id 1 is the family; id 16 is the *typographic* family, which is the better one when a
    // family has been split into "Semibold", "Light" and so on.
    if (nameId !== 1 && nameId !== 16) continue;
    const length = table.readUInt16BE(record + 8);
    const offset = storage + table.readUInt16BE(record + 10);
    if (offset + length > table.length) continue;
    const slice = table.subarray(offset, offset + length);
    // Platform 1 is Macintosh (one byte per character); everything else here is UTF-16BE.
    const text =
      platformId === 1 ? slice.toString('latin1') : Buffer.from(slice).swap16().toString('utf16le');
    const cleaned = text.replace(/\0/g, '').trim();
    if (cleaned === '') continue;
    if (nameId === 16) return cleaned;
    best ??= cleaned;
  }
  return best;
}

/** The family names in one font file, reading only the parts of it that carry them. */
export function familiesInFontFile(path: string): string[] {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return [];
  }
  try {
    return familiesIn(fileReader(fd));
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

// ---- the list ------------------------------------------------------------------------------------

let cached: string[] | null = null;

/** Every family the machine has, sorted, de-duplicated and case-insensitively unique. */
export function systemFontFamilies(): string[] {
  if (cached) return cached;
  const seen = new Map<string, string>();
  const deadline = Date.now() + BUDGET_MS;
  let files = 0;
  outer: for (const dir of fontDirectories()) {
    for (const file of walk(dir)) {
      if (++files > MAX_FILES || Date.now() > deadline) break outer;
      for (const family of familiesInFontFile(file)) {
        const key = family.toLowerCase();
        if (!seen.has(key)) seen.set(key, family);
      }
    }
  }
  cached = [...seen.values()].sort((a, b) => a.localeCompare(b));
  return cached;
}

/** Forgets the cached list. For the tests; nothing in the app needs it. */
export function forgetSystemFonts(): void {
  cached = null;
}
