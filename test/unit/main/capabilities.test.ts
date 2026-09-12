import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalPath, FileCapabilities } from '../../../src/main/fs/capabilities';
import { safeFileName, writeInto } from '../../../src/main/files';
import { assertExternalDocument, externalWebUrl } from '../../../src/main/externalFiles';
import { validateFileRequest } from '../../../src/main/fs/ipcValidation';
let root: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ynot-capabilities-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('window file capabilities', () => {
  it('separates windows, access modes, files and folder roots', () => {
    const caps = new FileCapabilities();
    const file = join(root, 'one.pdf');
    writeFileSync(file, 'one');
    caps.grant(1, file, ['read']);
    expect(caps.check(1, file, 'read')).toBe(file);
    expect(() => caps.check(1, file, 'write')).toThrow(/not granted/);
    expect(() => caps.check(2, file, 'read')).toThrow(/not granted/);
    expect(() => caps.check(1, root, 'read', true)).toThrow(/not granted/);
    caps.grant(1, root, ['write'], true);
    expect(caps.check(1, join(root, 'new.pdf'), 'write')).toBe(join(root, 'new.pdf'));
    caps.clear(1);
    expect(() => caps.check(1, file, 'read')).toThrow(/not granted/);
  });
  it('keeps a root-level target basename and canonicalises both grants and checks', () => {
    const missing = join(parse(root).root, 'ynot-capability-root-probe-9cb56.pdf');
    expect(basename(canonicalPath(missing))).toBe(basename(missing));
    const alias = join(root, 'alias');
    const target = join(root, 'real');
    mkdirSync(target);
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const caps = new FileCapabilities();
    caps.grant(1, alias, ['read'], true);
    expect(caps.check(1, target, 'read', true)).toBe(canonicalPath(target));
  });
  it('does not follow a link from an approved directory to an unapproved one', () => {
    const inside = join(root, 'inside');
    const outside = join(root, 'outside');
    mkdirSync(inside);
    mkdirSync(outside);
    const file = join(outside, 'private.txt');
    writeFileSync(file, 'private');
    symlinkSync(outside, join(inside, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const caps = new FileCapabilities();
    caps.grant(1, inside, ['read', 'write'], true);
    expect(() => caps.check(1, join(inside, 'linked', 'private.txt'), 'read')).toThrow(
      /not granted/,
    );
    expect(() => caps.check(1, join(inside, 'linked', 'new.txt'), 'write')).toThrow(/not granted/);
  });
});

describe('extraction ownership', () => {
  it('preserves existing, duplicate, sanitised and case-only names without replacing bytes', async () => {
    writeFileSync(join(root, 'Report.txt'), 'original');
    const names = ['report.txt', 'Report.txt', 'a:b.txt', 'a?b.txt', 'CON.txt', 'CON.txt'];
    const paths: string[] = [];
    for (const [i, name] of names.entries())
      paths.push(await writeInto(root, name, bytes(String(i))));
    expect(new Set(paths).size).toBe(names.length);
    expect(readFileSync(join(root, 'Report.txt'), 'utf8')).toBe('original');
    paths.forEach((path, i) => {
      expect(readFileSync(path, 'utf8')).toBe(String(i));
    });
    expect(paths.map((path) => basename(path))).toEqual([
      'report (1).txt',
      'Report (2).txt',
      'a_b.txt',
      'a_b (1).txt',
      '_CON.txt',
      '_CON (1).txt',
    ]);
  });
  it('resolves concurrent leaf collisions with exclusive creation', async () => {
    const paths = await Promise.all(
      Array.from({ length: 8 }, (_, i) => writeInto(root, 'same.txt', bytes(String(i)))),
    );
    expect(new Set(paths).size).toBe(8);
    paths.forEach((path, i) => {
      expect(readFileSync(path, 'utf8')).toBe(String(i));
    });
  });
  it('rejects linked output components and does not invent a missing chosen root', async () => {
    const outside = join(root, 'outside');
    const inside = join(root, 'inside');
    mkdirSync(outside);
    mkdirSync(inside);
    symlinkSync(outside, join(inside, 'jump'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(writeInto(inside, 'jump/file.txt', bytes('bad'))).rejects.toThrow(/link/);
    await expect(writeInto(join(root, 'missing'), 'file.txt', bytes('bad'))).rejects.toThrow();
  });
});

describe('native external-action policy', () => {
  it.each(['ps1', 'cmd', 'exe'])(
    'rejects a disguised .%s filename when truncation would expose that extension',
    (extension) => {
      const name = 'evil.' + extension + ' .'.repeat(120) + '.pdf';
      expect(safeFileName(name)).toBe('evil.' + extension);
      expect(() => {
        assertExternalDocument(name);
      }).toThrow(/cannot be opened directly/);
    },
  );
  it.each([
    'a.exe',
    'a.cmd',
    'a.bat',
    'a.ps1',
    'a.js',
    'a.vbs',
    'a.sh',
    'a.desktop',
    'a.lnk',
    'a.url',
    'a.html',
    'a.svg',
    'a.docm',
    'a.unknown',
    'a.txt.exe',
    'a.pdf ',
  ])('refuses %s before asking an OS handler', (name) => {
    expect(() => {
      assertExternalDocument(name);
    }).toThrow(/cannot be opened directly/);
  });
  it.each(['notes.txt', 'Report.PDF', 'photo.png', 'sheet.xlsx'])(
    'allows confirmation for ordinary document %s',
    (name) => {
      expect(() => {
        assertExternalDocument(name);
      }).not.toThrow();
    },
  );
  it('returns a stable approved filename and refuses misleading trailing punctuation', () => {
    const safe = assertExternalDocument('quarter:one.pdf');
    expect(safe).toBe('quarter_one.pdf');
    expect(safeFileName(safe)).toBe(safe);
    for (const name of ['evil.exe.pdf.', 'evil.cmd.pdf ', 'evil.ps1.pdf. '])
      expect(() => {
        assertExternalDocument(name);
      }).toThrow(/cannot be opened directly/);
  });
  it('parses web links and rejects other protocols', () => {
    expect(externalWebUrl('https://example.com')).toBe('https://example.com/');
    expect(() => externalWebUrl('file:///etc/passwd')).toThrow();
    expect(() => externalWebUrl('javascript:alert(1)')).toThrow();
  });
  it('validates malformed filesystem payloads at runtime', () => {
    expect(() => {
      validateFileRequest('file:read', [{ path: root }]);
    }).toThrow();
    expect(() => {
      validateFileRequest('file:write', [join(root, 'f'), []]);
    }).toThrow();
    expect(() => {
      validateFileRequest('file:writeAtomic', [join(root, 'f'), bytes('x'), { backup: 'yes' }]);
    }).toThrow();
    expect(() => {
      validateFileRequest('file:readFolder', [root, { limit: Infinity }]);
    }).toThrow();
    expect(() => {
      validateFileRequest('search:folder', [{ root, query: 'x', options: {}, maxHits: -1 }]);
    }).toThrow();
  });
  it('requires the complete folder-search contract before scanning a directory', () => {
    const valid = {
      root,
      query: 'needle',
      recursive: true,
      maxHits: 20,
      options: {
        matchCase: false,
        wholeWord: false,
        regex: false,
        ignoreDiacritics: true,
        proximity: 0,
        includeBookmarks: true,
        includeComments: true,
        includeFormFields: true,
      },
    };
    expect(() => {
      validateFileRequest('search:folder', [valid]);
    }).not.toThrow();
    for (const key of ['recursive', 'maxHits']) {
      const request = Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key));
      expect(() => {
        validateFileRequest('search:folder', [request]);
      }).toThrow(/required/);
    }
    for (const key of Object.keys(valid.options)) {
      const options = Object.fromEntries(
        Object.entries(valid.options).filter(([name]) => name !== key),
      );
      expect(() => {
        validateFileRequest('search:folder', [{ ...valid, options }]);
      }).toThrow(/required/);
    }
  });
});
