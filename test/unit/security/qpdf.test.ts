/**
 * The qpdf runner and password protection (M70).
 *
 * These are the tests that prove the app and qpdf agree about what a permission means. Every
 * assertion about a flag is checked against qpdf's own `--show-encryption`, so a bug in our `/P`
 * arithmetic cannot hide behind a mapping that only we read.
 */

import { describe, expect, it } from 'vitest';
import { permissionsToP, pToPermissions } from '@engine/security/permissions';
import { ALL_ALLOWED, NONE_ALLOWED, type PermissionFlags } from '@engine/security/types';
import { warningsFrom } from '@engine/security/qpdf';
import { fixture, qpdf, security } from './helpers';

describe('the qpdf runner', () => {
  it('is qpdf 12 or newer', async () => {
    const version = await qpdf().version();
    expect(Number.parseInt(version.split('.')[0] ?? '0', 10)).toBeGreaterThanOrEqual(12);
  });

  it('deletes every file a run created', async () => {
    const q = qpdf();
    const before = await q.run(['--version'], {});
    expect(before.code).toBe(0);
    // Two runs in a row must not see each other's files: the second asks for a file the first
    // wrote, under the same name, and must not find it.
    await q.run(['--decrypt', 'in.pdf', 'out.pdf'], { 'in.pdf': fixture('blank.pdf') }, [
      'out.pdf',
    ]);
    const second = await q.run(['--check', 'out.pdf'], {}, ['out.pdf']);
    expect(second.files.size).toBe(0);
    expect(second.code).not.toBe(0);
  });

  it('reports an exit code rather than throwing when qpdf refuses', async () => {
    const run = await qpdf().run(['--check', 'in.pdf'], { 'in.pdf': fixture('truncated.pdf') });
    expect(run.code).not.toBe(0);
    expect(run.output.length).toBeGreaterThan(0);
  });

  it('passes a password containing spaces and quotes through untouched', async () => {
    const awkward = 'a b "c" \\d\' --not-a-flag';
    const s = security();
    const { bytes } = await s.protect(
      fixture('blank.pdf'),
      {
        kind: 'password',
        algorithm: 'aes-256',
        scope: 'all',
        permissions: ALL_ALLOWED,
        hasUserPassword: true,
        hasOwnerPassword: false,
      },
      { user: awkward, owner: `${awkward} owner` },
    );
    const info = await s.inspect(bytes);
    expect(info.encrypted).toBe(true);
    expect(info.opensWithoutPassword).toBe(false);
    const removed = await s.remove(bytes, `${awkward} owner`);
    expect((await s.inspect(removed.bytes)).encrypted).toBe(false);
  });

  it('an open password with no permissions password leaves the file openable as owner', async () => {
    // Not a bug, and worth a test so it stays deliberate: an empty owner password *is* a valid
    // owner password, so anyone can open such a file with full rights. qpdf calls this insecure
    // and needs `--allow-insecure` to write it; the dialog says so in words before it happens.
    const s = security();
    const { bytes } = await s.protect(
      fixture('blank.pdf'),
      {
        kind: 'password',
        algorithm: 'aes-256',
        scope: 'all',
        permissions: NONE_ALLOWED,
        hasUserPassword: true,
        hasOwnerPassword: false,
      },
      { user: 'reader-only' },
    );
    expect((await s.inspect(bytes)).encrypted).toBe(true);
    expect(await security().isOwnerPassword(bytes, '')).toBe(true);
  });
});

describe('the /P bitfield', () => {
  const cases: PermissionFlags[] = [
    ALL_ALLOWED,
    NONE_ALLOWED,
    { print: 'low', modify: 'none', copy: false, accessibility: true },
    { print: 'none', modify: 'comment-fill-and-sign', copy: true, accessibility: false },
    { print: 'high', modify: 'fill-and-sign', copy: false, accessibility: true },
    { print: 'low', modify: 'assemble', copy: true, accessibility: true },
  ];

  it.each(cases)('round-trips %j', (flags) => {
    expect(pToPermissions(permissionsToP(flags))).toEqual(flags);
  });

  it('keeps the reserved bits set, so /P is the negative number a PDF expects', () => {
    for (const flags of cases) {
      const p = permissionsToP(flags);
      expect(p).toBeLessThan(0);
      // Bits 1, 2, 7 and 8 are reserved and must be clear.
      for (const bit of [1, 2, 7, 8]) expect(p & (1 << (bit - 1))).toBe(0);
    }
  });
});

describe('what qpdf says about a file we protected', () => {
  const s = security();

  async function protectAndShow(
    permissions: PermissionFlags,
    algorithm: 'aes-256' | 'aes-128' | 'rc4-128' = 'aes-256',
  ): Promise<{ output: string; bytes: Uint8Array }> {
    const { bytes } = await s.protect(
      fixture('multipage.pdf'),
      {
        kind: 'password',
        algorithm,
        scope: 'all',
        permissions,
        hasUserPassword: true,
        hasOwnerPassword: true,
      },
      { user: 'open-me', owner: 'change-me' },
    );
    const run = await qpdf().run(['--show-encryption', '--password=change-me', 'in.pdf'], {
      'in.pdf': bytes,
    });
    return { output: run.output, bytes };
  }

  it('agrees that "no printing, no changes" means exactly that', async () => {
    const { output } = await protectAndShow({
      print: 'none',
      modify: 'none',
      copy: false,
      accessibility: false,
    });
    expect(output).toMatch(/print low resolution: not allowed/);
    expect(output).toMatch(/print high resolution: not allowed/);
    expect(output).toMatch(/modify anything: not allowed/);
    expect(output).toMatch(/extract for any purpose: not allowed/);
  }, 40_000);

  it('agrees that low-resolution printing allows one and forbids the other', async () => {
    const { output } = await protectAndShow({
      print: 'low',
      modify: 'none',
      copy: false,
      accessibility: true,
    });
    expect(output).toMatch(/print low resolution: allowed/);
    expect(output).toMatch(/print high resolution: not allowed/);
  }, 40_000);

  it('agrees that commenting is allowed while other changes are not', async () => {
    const { output } = await protectAndShow({
      print: 'high',
      modify: 'comment-fill-and-sign',
      copy: true,
      accessibility: true,
    });
    expect(output).toMatch(/modify annotations: allowed/);
    expect(output).toMatch(/modify forms: allowed/);
    expect(output).toMatch(/modify other: not allowed/);
    expect(output).toMatch(/print high resolution: allowed/);
  }, 40_000);

  it('reads its own /P back to the flags it was given', async () => {
    const flags: PermissionFlags = {
      print: 'low',
      modify: 'fill-and-sign',
      copy: false,
      accessibility: true,
    };
    const { bytes } = await protectAndShow(flags);
    const info = await s.inspect(bytes);
    expect(info.permissions).toEqual(flags);
    expect(info.algorithm).toBe('aes-256');
    expect(info.revision).toBe(6);
    expect(info.handler).toBe('standard');
  }, 40_000);
});

describe('the algorithms the dialog offers', () => {
  const s = security();

  it.each([
    ['aes-256', 6],
    ['aes-128', 4],
    ['rc4-128', 3],
    ['rc4-40', 2],
  ] as const)(
    'writes %s and reads it back',
    async (algorithm, revision) => {
      const { bytes } = await s.protect(
        fixture('blank.pdf'),
        {
          kind: 'password',
          algorithm,
          scope: 'all',
          permissions: ALL_ALLOWED,
          hasUserPassword: false,
          hasOwnerPassword: true,
        },
        { owner: 'owner-only' },
      );
      const info = await s.inspect(bytes);
      expect(info.encrypted).toBe(true);
      expect(info.algorithm).toBe(algorithm);
      expect(info.revision).toBe(revision);
      // No user password: the file opens for reading without one.
      expect(info.opensWithoutPassword).toBe(true);
    },
    40_000,
  );
});

describe('removing security', () => {
  const s = security();

  it('leaves a file qpdf --check calls unencrypted', async () => {
    const { bytes } = await s.protect(
      fixture('annotated.pdf'),
      {
        kind: 'password',
        algorithm: 'aes-256',
        scope: 'all',
        permissions: NONE_ALLOWED,
        hasUserPassword: true,
        hasOwnerPassword: true,
      },
      { user: 'open', owner: 'own' },
    );
    const removed = await s.remove(bytes, 'own');
    const check = await qpdf().run(['--check', 'in.pdf'], { 'in.pdf': removed.bytes });
    expect(check.output).toMatch(/File is not encrypted/);
    expect(check.code).toBe(0);
    expect((await s.inspect(removed.bytes)).encrypted).toBe(false);
  }, 40_000);

  it('says the password was wrong rather than failing silently', async () => {
    const { bytes } = await s.protect(
      fixture('blank.pdf'),
      {
        kind: 'password',
        algorithm: 'aes-256',
        scope: 'all',
        permissions: ALL_ALLOWED,
        hasUserPassword: true,
        hasOwnerPassword: true,
      },
      { user: 'open', owner: 'own' },
    );
    await expect(s.remove(bytes, 'not-the-password')).rejects.toMatchObject({
      code: 'wrong-password',
      message: 'That password did not open the file.',
    });
  }, 40_000);

  it('knows an owner password from a user password', async () => {
    const { bytes } = await s.protect(
      fixture('blank.pdf'),
      {
        kind: 'password',
        algorithm: 'aes-256',
        scope: 'all',
        permissions: NONE_ALLOWED,
        hasUserPassword: true,
        hasOwnerPassword: true,
      },
      { user: 'reader', owner: 'boss' },
    );
    expect(await s.isOwnerPassword(bytes, 'boss')).toBe(true);
    expect(await s.isOwnerPassword(bytes, 'reader')).toBe(false);
    expect(await s.isOwnerPassword(bytes, 'neither')).toBe(false);
  }, 40_000);
});

describe('what qpdf had to say about it', () => {
  const s = security();

  it('reads qpdf’s warnings as lines a reader could act on', () => {
    // No fixture in the corpus makes qpdf warn rather than fail, so the parser is exercised
    // directly. It is a parser, not a policy, and its job is to hand back qpdf's own words
    // without the "WARNING:" scaffolding.
    const output = [
      'checking in.pdf',
      'WARNING: in.pdf (offset 1234): file is damaged',
      'WARNING:   attempting to reconstruct cross-reference table',
      '',
      'No syntax or stream encoding errors found',
    ].join('\n');
    expect(warningsFrom(output)).toEqual([
      'in.pdf (offset 1234): file is damaged',
      'attempting to reconstruct cross-reference table',
    ]);
    expect(warningsFrom('checking in.pdf\nFile is not encrypted')).toEqual([]);
    expect(warningsFrom('')).toEqual([]);
  });

  it('never shows the reader the name of the program qpdf thinks it is', async () => {
    // qpdf prefixes every message with argv[0], and this build ignores `thisProgram` — so without
    // stripping, a reader would be told "forks.js: invalid password" under vitest and
    // "this.program: invalid password" in the app. Neither is anything to do with them, and the
    // filename that follows must survive.
    const run = await qpdf().run(['--check', 'in.pdf'], {
      'in.pdf': fixture('encrypted-aes256.pdf'),
    });
    expect(run.code).not.toBe(0);
    expect(run.output).toMatch(/in\.pdf: invalid password/);
    expect(run.output).not.toMatch(/this\.program|forks\.js|\.mjs:|\.exe:/);
    // And the run's own scratch directory is an implementation detail, not part of a message.
    expect(run.output).not.toMatch(/\/run\d+\//);
  });

  it('decrypts to plain bytes for the writer', async () => {
    const { bytes } = await s.protect(
      fixture('multipage.pdf'),
      {
        kind: 'password',
        algorithm: 'aes-256',
        scope: 'all',
        permissions: NONE_ALLOWED,
        hasUserPassword: true,
        hasOwnerPassword: true,
      },
      { user: 'open', owner: 'own' },
    );
    const plain = await s.decrypt(bytes, 'own');
    expect((await s.inspect(plain)).encrypted).toBe(false);
    await expect(s.decrypt(bytes, 'wrong')).rejects.toMatchObject({ code: 'wrong-password' });
  }, 40_000);

  it('reports the qpdf it is actually running', async () => {
    expect(await s.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('what gets encrypted', () => {
  const s = security();

  it('leaves metadata readable when asked to', async () => {
    const { bytes } = await s.protect(
      fixture('text.pdf'),
      {
        kind: 'password',
        algorithm: 'aes-256',
        scope: 'except-metadata',
        permissions: ALL_ALLOWED,
        hasUserPassword: true,
        hasOwnerPassword: false,
      },
      { user: 'secret' },
    );
    const info = await s.inspect(bytes);
    expect(info.encrypted).toBe(true);
    expect(info.metadataEncrypted).toBe(false);
  }, 40_000);

  it('encrypts metadata by default', async () => {
    const { bytes } = await s.protect(
      fixture('text.pdf'),
      {
        kind: 'password',
        algorithm: 'aes-256',
        scope: 'all',
        permissions: ALL_ALLOWED,
        hasUserPassword: true,
        hasOwnerPassword: false,
      },
      { user: 'secret' },
    );
    expect((await s.inspect(bytes)).metadataEncrypted).toBe(true);
  }, 40_000);
});
