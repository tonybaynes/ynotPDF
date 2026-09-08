/**
 * The system font list (M30, ADR 0013).
 *
 * Electron has no API for "what fonts does this machine have", and the module adds no libraries,
 * so the families are read the only way left: walk the OS font directories and parse each file's
 * `name` table. That is about sixty lines of sfnt reading and needs nothing but `fs`.
 *
 * Only the **family name** (name id 1) is taken, and only from the Windows/Unicode or Macintosh/
 * Roman platforms, so the list reads the way a font menu does. TrueType collections (`.ttc`) are
 * walked font by font. Anything that fails to parse is skipped: a broken font on the machine must
 * not cost the reader their font picker.
 *
 * The result is cached for the life of the process — fonts do not appear while an app is running
 * often enough to justify re-reading a thousand files.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.TTF', '.OTF', '.TTC']);

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

/** The family names in one font file. A collection contributes one per member. */
export function familiesInFont(bytes: Buffer): string[] {
  const out: string[] = [];
  if (bytes.length < 12) return out;
  const tag = bytes.readUInt32BE(0);
  // 'ttcf' — a collection header, then an offset per font.
  if (tag === 0x74746366) {
    const count = bytes.readUInt32BE(8);
    for (let i = 0; i < Math.min(count, 64); i++) {
      const at = 12 + i * 4;
      if (at + 4 > bytes.length) break;
      const family = familyAt(bytes, bytes.readUInt32BE(at));
      if (family) out.push(family);
    }
    return out;
  }
  const family = familyAt(bytes, 0);
  if (family) out.push(family);
  return out;
}

/** The family name of the sfnt whose header starts at `base`. */
function familyAt(bytes: Buffer, base: number): string | null {
  if (base + 12 > bytes.length) return null;
  const numTables = bytes.readUInt16BE(base + 4);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const record = base + 12 + i * 16;
    if (record + 16 > bytes.length) return null;
    if (bytes.toString('latin1', record, record + 4) === 'name') {
      nameOffset = bytes.readUInt32BE(record + 8);
      break;
    }
  }
  if (nameOffset < 0 || nameOffset + 6 > bytes.length) return null;
  const count = bytes.readUInt16BE(nameOffset + 2);
  const storage = nameOffset + bytes.readUInt16BE(nameOffset + 4);
  let best: string | null = null;
  for (let i = 0; i < count; i++) {
    const record = nameOffset + 6 + i * 12;
    if (record + 12 > bytes.length) break;
    const platformId = bytes.readUInt16BE(record);
    const nameId = bytes.readUInt16BE(record + 6);
    // Name id 1 is the family; id 16 is the *typographic* family, which is the better one when
    // a face family has been split into "Semibold", "Light" and so on.
    if (nameId !== 1 && nameId !== 16) continue;
    const length = bytes.readUInt16BE(record + 8);
    const offset = storage + bytes.readUInt16BE(record + 10);
    if (offset + length > bytes.length) continue;
    const slice = bytes.subarray(offset, offset + length);
    const text = platformId === 1 ? slice.toString('latin1') : slice.swap16().toString('utf16le');
    const cleaned = text.replace(/\0/g, '').trim();
    if (cleaned === '') continue;
    if (nameId === 16) return cleaned;
    best ??= cleaned;
  }
  return best;
}

let cached: string[] | null = null;

/** Every family the machine has, sorted, de-duplicated and case-insensitively unique. */
export function systemFontFamilies(): string[] {
  if (cached) return cached;
  const seen = new Map<string, string>();
  for (const dir of fontDirectories()) {
    for (const file of walk(dir)) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(file);
      } catch {
        continue;
      }
      let families: string[];
      try {
        families = familiesInFont(bytes);
      } catch {
        continue;
      }
      for (const family of families) {
        const key = family.toLowerCase();
        if (!seen.has(key)) seen.set(key, family);
      }
    }
  }
  cached = [...seen.values()].sort((a, b) => a.localeCompare(b));
  return cached;
}
