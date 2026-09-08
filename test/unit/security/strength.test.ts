/**
 * The password strength meter and the two checks around it (M70).
 *
 * The behaviour worth pinning is that the meter *always says something specific*. A band without
 * advice, or advice that repeats the band, is what makes a strength meter useless — and it is the
 * failure a colour bar cannot even have, so it is the one to test for.
 */

import { describe, expect, it } from 'vitest';
import { passwordProblem, permissionsCaution, strengthOf } from '@modules/M70-encryption/strength';

describe('scoring a password', () => {
  it('puts the obvious ones at the bottom and says which they are', () => {
    for (const bad of ['password', 'PASSWORD', '123456', 'qwerty', 'letmein']) {
      const s = strengthOf(bad);
      expect(s.word).toBe('Very weak');
      expect(s.advice).toMatch(/most commonly used/);
    }
  });

  it('scores a long varied passphrase at the top', () => {
    const s = strengthOf('Correct-Horse-Battery-Staple-42');
    expect(s.word).toBe('Very strong');
    expect(s.advice).toMatch(/Long, varied/);
  });

  it('rewards length more than punctuation, because length is what matters', () => {
    const long = strengthOf('bookshelfmarmalade');
    const short = strengthOf('aB3$');
    expect(long.score).toBeGreaterThan(short.score);
  });

  it('marks a repeated block down and says why', () => {
    const s = strengthOf('abcabcabcabcabcabc');
    expect(s.advice).toMatch(/repeats/);
    expect(s.score).toBeLessThan(strengthOf('bookshelfmarmalade').score);
  });

  it('marks a keyboard run down and says why', () => {
    const s = strengthOf('mnopqrstuvwx');
    expect(s.advice).toMatch(/run like/);
  });

  it('always names a band and always gives a reason', () => {
    const samples = ['', 'a', 'aa', 'password', 'Tr0ub4dor&3', 'x'.repeat(40), 'ΩΩΩΩΩΩΩΩΩΩΩΩ'];
    for (const sample of samples) {
      const s = strengthOf(sample);
      expect(s.word).not.toBe('');
      expect(s.advice).not.toBe('');
      expect(s.icon).not.toBe('');
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
    }
  });

  it('says nothing alarming about an empty field', () => {
    expect(strengthOf('').advice).toBe('No password yet.');
  });
});

describe('what the dialog refuses to accept', () => {
  const base = { user: '', userConfirm: '', owner: '', ownerConfirm: '' };

  it('needs at least one password', () => {
    expect(passwordProblem(base)).toMatch(/Enter an open password/);
  });

  it('needs the confirmations to match, and says which one', () => {
    expect(passwordProblem({ ...base, user: 'a', userConfirm: 'b' })).toMatch(/two open passwords/);
    expect(passwordProblem({ ...base, owner: 'a', ownerConfirm: 'b' })).toMatch(
      /two permissions passwords/,
    );
  });

  it('refuses two identical passwords, because the second would protect nothing', () => {
    expect(
      passwordProblem({ user: 'same', userConfirm: 'same', owner: 'same', ownerConfirm: 'same' }),
    ).toMatch(/protects nothing/);
  });

  it('accepts either password on its own', () => {
    expect(passwordProblem({ ...base, user: 'open', userConfirm: 'open' })).toBeNull();
    expect(passwordProblem({ ...base, owner: 'own', ownerConfirm: 'own' })).toBeNull();
    expect(
      passwordProblem({ user: 'open', userConfirm: 'open', owner: 'own', ownerConfirm: 'own' }),
    ).toBeNull();
  });
});

describe('the cautions', () => {
  it('warns that permissions without a permissions password are only a request', () => {
    expect(permissionsCaution('open', '')).toMatch(/request rather than a rule/);
  });

  it('explains what a permissions-password-only document is', () => {
    expect(permissionsCaution('', 'own')).toMatch(/Anyone can open the document/);
  });

  it('says nothing when both are set, or neither', () => {
    expect(permissionsCaution('open', 'own')).toBeNull();
    expect(permissionsCaution('', '')).toBeNull();
  });
});
