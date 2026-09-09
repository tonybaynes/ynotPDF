/**
 * The two main-process handlers M42 added (ADR 0014, decision 7).
 *
 * Both take a string that came out of a PDF and turn it into a path on the operator's disk,
 * which is the one place in this module where getting it wrong writes a file somewhere it should
 * not be. So the tests that matter here are about names nobody typed: one that climbs out of the
 * chosen folder, one with punctuation a file system refuses, one with nothing usable left.
 *
 * Run against a real temporary directory rather than a mocked `fs`, like the rest of the
 * main-process suite: what is being tested is what a real filesystem does.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFolder, writeInto } from '../../../src/main/files';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ynot-portfolio-files-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function make(relative: string, contents = 'x'): void {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

describe('listing a folder for a new portfolio', () => {
  it('walks subfolders and reports a relative path with forward slashes', async () => {
    make('readme.txt', 'hello');
    make('Statements/january.txt');
    make('Statements/2026/february.txt');

    const entries = await readFolder(root);
    expect(entries.map((e) => e.relativePath).sort()).toEqual([
      'Statements/2026/february.txt',
      'Statements/january.txt',
      'readme.txt',
    ]);
    const readme = entries.find((e) => e.name === 'readme.txt');
    expect(readme?.size).toBe(5);
    expect(readme?.modified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Metadata only: the bytes come later, one file at a time.
    expect(Object.keys(readme ?? {}).sort()).toEqual([
      'modified',
      'name',
      'path',
      'relativePath',
      'size',
    ]);
  });

  it('stays at the top level when asked not to recurse', async () => {
    make('a.txt');
    make('sub/b.txt');
    const entries = await readFolder(root, { recursive: false });
    expect(entries.map((e) => e.name)).toEqual(['a.txt']);
  });

  it('stops at the limit, so choosing a home directory cannot hang the app', async () => {
    for (let i = 0; i < 12; i++) make(`file-${String(i)}.txt`);
    const entries = await readFolder(root, { limit: 5 });
    expect(entries).toHaveLength(5);
  });

  it('is empty rather than an error for a folder that is not there', async () => {
    expect(await readFolder(join(root, 'nowhere'))).toEqual([]);
  });
});

describe('writing one extracted file', () => {
  it('creates the folders on the way and answers with the path it wrote', async () => {
    const path = await writeInto(
      root,
      'Statements/2026/january.txt',
      new TextEncoder().encode('J'),
    );
    expect(path).toBe(resolve(root, 'Statements', '2026', 'january.txt'));
    expect(readFileSync(path, 'utf8')).toBe('J');
  });

  it('cannot climb out of the chosen folder, however the path is written', async () => {
    // A file specification inside a PDF is free to say `../../.bashrc`, so this is the
    // guarantee that matters: whatever it says, the bytes land under the folder the reader
    // chose. A `..` segment is dropped rather than refused — the file still arrives, which is
    // kinder than failing an extraction over a name the reader did not write.
    for (const climb of ['../escaped.txt', 'a/../../escaped.txt', '../../escaped.txt']) {
      const path = await writeInto(root, climb, new TextEncoder().encode('inside'));
      expect(path.startsWith(resolve(root)), `${climb} stays inside`).toBe(true);
    }
    expect(existsSync(join(root, '..', 'escaped.txt'))).toBe(false);
    expect(readFileSync(join(root, 'escaped.txt'), 'utf8')).toBe('inside');
  });

  it('sanitises each segment rather than refusing the whole file', async () => {
    const path = await writeInto(root, 'in:valid/na*me.txt', new TextEncoder().encode('ok'));
    expect(path.startsWith(resolve(root))).toBe(true);
    expect(path).not.toContain('*');
    expect(readFileSync(path, 'utf8')).toBe('ok');
  });

  it('refuses a relative path with nothing usable left in it', async () => {
    await expect(writeInto(root, '..', new Uint8Array())).rejects.toThrow(/no usable name/);
    await expect(writeInto(root, '', new Uint8Array())).rejects.toThrow(/no usable name/);
  });

  it('writes the bytes exactly, which is what "extract" has to mean', async () => {
    const body = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const path = await writeInto(root, 'raw.bin', body);
    expect(Array.from(readFileSync(path))).toEqual(Array.from(body));
  });
});
