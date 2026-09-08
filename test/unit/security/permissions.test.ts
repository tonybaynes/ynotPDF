/**
 * What a permission set means, in the app's own words (M70).
 *
 * `permissionsToP` and its inverse are checked against qpdf in `qpdf.test.ts`; what is checked
 * here is everything built on top of them — the question every command asks (`permits`), the
 * sentence a disabled control shows (`reasonFor`), the line the Properties tab prints, and the
 * translation of PDFium's own booleans. These are the parts a reader actually sees, and the parts
 * a wrong answer would silently mislead them about.
 */

import { describe, expect, it } from 'vitest';
import {
  describePermissions,
  encryptArgs,
  forbidden,
  fromEnginePermissions,
  needsWeakCryptoFlag,
  permits,
  pToPermissions,
  permissionsToP,
  reasonFor,
} from '@engine/security/permissions';
import {
  ALGORITHM_LABELS,
  ALL_ALLOWED,
  NONE_ALLOWED,
  SCOPE_LABELS,
  algorithmBits,
  isWeakAlgorithm,
  type EncryptionAlgorithm,
  type PermissionFlags,
  type ProtectedAction,
} from '@engine/security/types';

const ALL_ACTIONS: ProtectedAction[] = [
  'print',
  'print-high',
  'copy',
  'extract-for-accessibility',
  'modify',
  'annotate',
  'fill-forms',
  'assemble',
];

describe('what a permission set allows', () => {
  it('allows everything when everything is allowed', () => {
    for (const action of ALL_ACTIONS) expect(permits(ALL_ALLOWED, action)).toBe(true);
    expect(forbidden(ALL_ALLOWED)).toEqual([]);
  });

  it('forbids everything but accessibility when nothing is allowed', () => {
    expect(permits(NONE_ALLOWED, 'extract-for-accessibility')).toBe(true);
    for (const action of ALL_ACTIONS.filter((a) => a !== 'extract-for-accessibility')) {
      expect(permits(NONE_ALLOWED, action)).toBe(false);
    }
    expect(forbidden(NONE_ALLOWED)).toHaveLength(ALL_ACTIONS.length - 1);
  });

  it('separates printing at all from printing at full resolution', () => {
    const low: PermissionFlags = { ...ALL_ALLOWED, print: 'low' };
    expect(permits(low, 'print')).toBe(true);
    expect(permits(low, 'print-high')).toBe(false);
    expect(forbidden(low)).toEqual(['print-high']);
  });

  it('reads the five modify levels as a ladder', () => {
    const at = (modify: PermissionFlags['modify']): ProtectedAction[] =>
      ALL_ACTIONS.filter((a) => permits({ ...ALL_ALLOWED, modify }, a));
    expect(at('all')).toEqual(ALL_ACTIONS);
    expect(at('comment-fill-and-sign')).not.toContain('modify');
    expect(at('comment-fill-and-sign')).toContain('annotate');
    expect(at('fill-and-sign')).not.toContain('annotate');
    expect(at('fill-and-sign')).toContain('fill-forms');
    expect(at('assemble')).not.toContain('fill-forms');
    expect(at('assemble')).toContain('assemble');
    expect(at('none')).not.toContain('assemble');
  });

  it('treats copying as enough for accessibility extraction', () => {
    // The `/P` bit for accessibility is deprecated and widely ignored; a file that allows copying
    // outright cannot sensibly be said to forbid a screen reader.
    const copyOnly: PermissionFlags = { ...NONE_ALLOWED, copy: true, accessibility: false };
    expect(permits(copyOnly, 'extract-for-accessibility')).toBe(true);
  });

  it('answers true for anything it does not recognise, rather than blocking it', () => {
    expect(permits(NONE_ALLOWED, 'something-new' as ProtectedAction)).toBe(true);
  });
});

describe('what the reader is told', () => {
  it('names the permission and what would lift it, for every action', () => {
    for (const action of ALL_ACTIONS) {
      const reason = reasonFor(action);
      expect(reason).toMatch(/do not allow/);
      expect(reason).toMatch(/owner password/);
      // Never a field name or a bit number.
      expect(reason).not.toMatch(/\/P|bit \d|undefined/);
    }
  });

  it('describes a permission set as a sentence, not as flags', () => {
    expect(describePermissions(ALL_ALLOWED)).toBe(
      'Printing allowed, all changes allowed, copying allowed.',
    );
    expect(describePermissions(NONE_ALLOWED)).toBe('No printing, no changes, no copying.');
    expect(describePermissions({ ...ALL_ALLOWED, print: 'low' })).toMatch(
      /^Low-resolution printing only/,
    );
    for (const modify of ['comment-fill-and-sign', 'fill-and-sign', 'assemble'] as const) {
      expect(describePermissions({ ...ALL_ALLOWED, modify })).not.toMatch(/undefined/);
    }
  });

  it('has a human name for every algorithm and every scope', () => {
    for (const [id, label] of Object.entries(ALGORITHM_LABELS)) {
      expect(label).not.toBe('');
      expect(label).not.toBe(id);
    }
    for (const label of Object.values(SCOPE_LABELS)) expect(label).not.toBe('');
    expect(algorithmBits('aes-256')).toBe(256);
    expect(algorithmBits('aes-128')).toBe(128);
    expect(algorithmBits('rc4-128')).toBe(128);
    expect(algorithmBits('rc4-40')).toBe(40);
    expect(isWeakAlgorithm('aes-256')).toBe(false);
    for (const weak of ['aes-128', 'rc4-128', 'rc4-40'] as const) {
      expect(isWeakAlgorithm(weak)).toBe(true);
    }
  });
});

describe('PDFium’s booleans in our words', () => {
  const engine = {
    print: true,
    printHighQuality: true,
    modify: true,
    copy: true,
    annotate: true,
    fillForms: true,
    extractForAccessibility: true,
    assemble: true,
  };

  it('reads "everything" as everything', () => {
    expect(fromEnginePermissions(engine)).toEqual(ALL_ALLOWED);
  });

  it('rounds an unnamed combination down rather than up', () => {
    // Modify off but annotate on is "commenting and form filling", not "any changes".
    expect(fromEnginePermissions({ ...engine, modify: false }).modify).toBe(
      'comment-fill-and-sign',
    );
    expect(fromEnginePermissions({ ...engine, modify: false, annotate: false }).modify).toBe(
      'fill-and-sign',
    );
    expect(
      fromEnginePermissions({ ...engine, modify: false, annotate: false, fillForms: false }).modify,
    ).toBe('assemble');
    expect(
      fromEnginePermissions({
        ...engine,
        modify: false,
        annotate: false,
        fillForms: false,
        assemble: false,
      }).modify,
    ).toBe('none');
  });

  it('reads the two printing bits the way the spec means them', () => {
    expect(fromEnginePermissions({ ...engine, printHighQuality: false }).print).toBe('low');
    expect(fromEnginePermissions({ ...engine, print: false }).print).toBe('none');
  });

  it('agrees with the /P round trip it stands beside', () => {
    const flags = fromEnginePermissions({ ...engine, modify: false, copy: false });
    expect(pToPermissions(permissionsToP(flags))).toEqual(flags);
  });
});

describe('the qpdf command line', () => {
  const args = (flags: PermissionFlags, algorithm: EncryptionAlgorithm = 'aes-256'): string[] =>
    encryptArgs({
      algorithm,
      permissions: flags,
      scope: 'all',
      userPassword: 'u',
      ownerPassword: 'o',
    });

  it('uses qpdf’s word for full-resolution printing, not ours', () => {
    // We say "high" after the spec's bit 12; qpdf says "full". The names differ, the meaning does
    // not — and getting this wrong makes qpdf refuse the whole command.
    expect(args(ALL_ALLOWED)).toContain('--print=full');
    expect(args({ ...ALL_ALLOWED, print: 'low' })).toContain('--print=low');
    expect(args({ ...ALL_ALLOWED, print: 'none' })).toContain('--print=none');
  });

  it('maps the modify ladder onto qpdf’s own levels', () => {
    expect(args(ALL_ALLOWED)).toContain('--modify=all');
    expect(args({ ...ALL_ALLOWED, modify: 'comment-fill-and-sign' })).toContain(
      '--modify=annotate',
    );
    expect(args({ ...ALL_ALLOWED, modify: 'fill-and-sign' })).toContain('--modify=form');
    expect(args({ ...ALL_ALLOWED, modify: 'assemble' })).toContain('--modify=assembly');
    expect(args({ ...ALL_ALLOWED, modify: 'none' })).toContain('--modify=none');
  });

  it('passes the passwords as flags, so any character survives', () => {
    const line = encryptArgs({
      algorithm: 'aes-256',
      permissions: ALL_ALLOWED,
      scope: 'all',
      userPassword: '--not-a-flag "x"',
      ownerPassword: 'o',
    });
    expect(line).toContain('--user-password=--not-a-flag "x"');
    expect(line.at(-1)).toBe('--');
  });

  it('asks qpdf for the older key lengths and their cipher', () => {
    expect(args(ALL_ALLOWED, 'aes-128')).toContain('--use-aes=y');
    expect(args(ALL_ALLOWED, 'rc4-128')).toContain('--use-aes=n');
    expect(args(ALL_ALLOWED, 'rc4-40')).toContain('--bits=40');
    // 40-bit has only the four original bits, so the richer flags must not appear.
    expect(args(ALL_ALLOWED, 'rc4-40').join(' ')).not.toMatch(/--assemble|--form|--modify-other/);
    expect(needsWeakCryptoFlag('aes-256')).toBe(false);
    expect(needsWeakCryptoFlag('aes-128')).toBe(false);
    expect(needsWeakCryptoFlag('rc4-128')).toBe(true);
    expect(needsWeakCryptoFlag('rc4-40')).toBe(true);
  });

  it('leaves metadata readable only when asked, and only where qpdf can', () => {
    const clear = encryptArgs({
      algorithm: 'aes-256',
      permissions: ALL_ALLOWED,
      scope: 'except-metadata',
      userPassword: 'u',
      ownerPassword: 'o',
    });
    expect(clear).toContain('--cleartext-metadata');
    expect(args(ALL_ALLOWED)).not.toContain('--cleartext-metadata');
    // 40-bit predates crypt filters, so the option does not exist there.
    expect(
      encryptArgs({
        algorithm: 'rc4-40',
        permissions: ALL_ALLOWED,
        scope: 'except-metadata',
        userPassword: 'u',
        ownerPassword: 'o',
      }),
    ).not.toContain('--cleartext-metadata');
  });

  it('tells qpdf when the reader has chosen the insecure combination on purpose', () => {
    const insecure = encryptArgs({
      algorithm: 'aes-256',
      permissions: ALL_ALLOWED,
      scope: 'all',
      userPassword: 'open',
      ownerPassword: '',
    });
    expect(insecure).toContain('--allow-insecure');
    expect(args(ALL_ALLOWED)).not.toContain('--allow-insecure');
  });
});
