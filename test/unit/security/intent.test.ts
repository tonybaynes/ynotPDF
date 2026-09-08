/**
 * The security intent, its command and its journal codec (M70).
 *
 * The property the whole design rests on is here, in `never writes a password to the journal`:
 * everything else about the intent could be wrong and be a bug, but a password reaching a
 * recovery file would be the one failure this module exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import type { Document } from '@core/Document';
import { replayJournal, serialiseCommand, serialiseJournal } from '@core/Journal';
import { NONE_ALLOWED, NO_SECURITY, type SecurityIntent } from '@engine/security/types';
import { SetSecurityCommand, removeSecurityCommand } from '@modules/M70-encryption/commands';
import {
  M70,
  defaultPasswordIntent,
  describeIntent,
  hasIntent,
  intentOf,
  isIntent,
} from '@modules/M70-encryption/intent';
import { openFake } from '../core/helpers';

const PASSWORD_INTENT: SecurityIntent = {
  kind: 'password',
  algorithm: 'aes-256',
  scope: 'all',
  permissions: NONE_ALLOWED,
  hasUserPassword: true,
  hasOwnerPassword: true,
};

async function doc(): Promise<Document> {
  const { doc: d } = await openFake();
  return d;
}

describe('reading an intent back', () => {
  it('accepts the three shapes it writes', () => {
    expect(isIntent(NO_SECURITY)).toBe(true);
    expect(isIntent(PASSWORD_INTENT)).toBe(true);
    expect(isIntent(defaultPasswordIntent())).toBe(true);
    expect(
      isIntent({
        kind: 'certificate',
        algorithm: 'aes-256',
        scope: 'all',
        recipients: [
          {
            id: 'r1',
            name: 'A',
            issuer: 'B',
            serial: '1',
            validFrom: '',
            validTo: '',
            certificateBase64: 'AAA=',
            permissions: NONE_ALLOWED,
          },
        ],
      }),
    ).toBe(true);
  });

  it('refuses anything it does not recognise, rather than trusting a file on disk', () => {
    for (const bad of [
      null,
      undefined,
      42,
      'password',
      {},
      { kind: 'password' },
      { kind: 'nonsense' },
      { ...PASSWORD_INTENT, algorithm: 'twofish' },
      { ...PASSWORD_INTENT, scope: 'some-of-it' },
      { ...PASSWORD_INTENT, permissions: { print: 'maybe' } },
      { kind: 'certificate', algorithm: 'aes-256', scope: 'all', recipients: [{ id: 'r1' }] },
      // A recipient with no certificate is a recipient nothing can be encrypted to.
      {
        kind: 'certificate',
        algorithm: 'aes-256',
        scope: 'all',
        recipients: [
          {
            id: 'r',
            name: 'n',
            issuer: 'i',
            serial: '1',
            certificateBase64: '',
            permissions: NONE_ALLOWED,
          },
        ],
      },
    ]) {
      expect(isIntent(bad)).toBe(false);
    }
  });

  it('describes itself in words, not in field names', () => {
    expect(describeIntent(NO_SECURITY)).toBe('No security');
    expect(describeIntent(PASSWORD_INTENT)).toBe(
      'Password security with open and permissions passwords',
    );
    expect(describeIntent({ ...PASSWORD_INTENT, hasOwnerPassword: false })).toBe(
      'Password security with an open password',
    );
    expect(describeIntent({ ...PASSWORD_INTENT, hasUserPassword: false })).toBe(
      'Password security with a permissions password',
    );
  });
});

describe('the set-security command', () => {
  it('puts the intent on the model and takes it off again on undo', async () => {
    const d = await doc();
    expect(hasIntent(d)).toBe(false);
    await d.apply(new SetSecurityCommand(d, PASSWORD_INTENT, { user: 'open' }));
    expect(intentOf(d)).toEqual(PASSWORD_INTENT);
    await d.undo.undo();
    // Undoing the *first* protection leaves no empty namespace behind.
    expect(hasIntent(d)).toBe(false);
    expect(d.state.custom[M70]).toBeUndefined();
    await d.undo.redo();
    expect(intentOf(d)).toEqual(PASSWORD_INTENT);
  });

  it('restores the previous intent rather than clearing it', async () => {
    const d = await doc();
    await d.apply(new SetSecurityCommand(d, PASSWORD_INTENT, { user: 'first' }));
    const second: SecurityIntent = { ...PASSWORD_INTENT, algorithm: 'aes-128' };
    await d.apply(new SetSecurityCommand(d, second, { user: 'second' }));
    expect(intentOf(d)).toEqual(second);
    await d.undo.undo();
    expect(intentOf(d)).toEqual(PASSWORD_INTENT);
  });

  it('reports what it changed from and to, for a caller that has to explain itself', async () => {
    const d = await doc();
    await d.apply(new SetSecurityCommand(d, PASSWORD_INTENT, { user: 'first' }));
    const second = new SetSecurityCommand(d, NO_SECURITY, {}, { user: 'first' });
    expect(second.previousIntent).toEqual(PASSWORD_INTENT);
    expect(second.intent).toEqual(NO_SECURITY);
    expect(second.previousSecrets).toEqual({ user: 'first' });
    // The very first command has nothing before it, and says so rather than inventing one.
    expect(new SetSecurityCommand(await doc(), PASSWORD_INTENT).previousIntent).toEqual(
      NO_SECURITY,
    );
  });

  it('names itself the way Edit ▸ Undo will read it', async () => {
    const d = await doc();
    expect(new SetSecurityCommand(d, PASSWORD_INTENT).label).toBe(
      'Set security: password security with open and permissions passwords',
    );
    expect(new SetSecurityCommand(d, NO_SECURITY).label).toBe('Remove security');
  });

  it('records the `custom` write intent, so a save knows there is work to do', async () => {
    const d = await doc();
    await d.apply(new SetSecurityCommand(d, PASSWORD_INTENT, { user: 'x' }));
    expect(d.state.writeIntents).toContain('custom');
  });

  it('removes security as its own named step', async () => {
    const d = await doc();
    await d.apply(new SetSecurityCommand(d, PASSWORD_INTENT, { user: 'x' }));
    const remove = removeSecurityCommand(d);
    expect(remove.label).toBe('Remove security');
    await d.apply(remove);
    expect(intentOf(d)).toEqual(NO_SECURITY);
    await d.undo.undo();
    expect(intentOf(d)).toEqual(PASSWORD_INTENT);
  });
});

describe('what reaches the journal', () => {
  it('never writes a password, however the command was built', async () => {
    const d = await doc();
    const command = new SetSecurityCommand(d, PASSWORD_INTENT, {
      user: 'open-sesame',
      owner: 'let-me-change-it',
    });
    await d.apply(command);
    const entry = serialiseCommand(command);
    const text = JSON.stringify(entry);
    expect(text).not.toContain('open-sesame');
    expect(text).not.toContain('let-me-change-it');
    // And nothing password-shaped got in by another name.
    expect(text).not.toMatch(/"(user|owner|password|secret)"\s*:\s*"[^"]/);
    // The whole document journal, not just this entry.
    expect(JSON.stringify(serialiseJournal(d))).not.toContain('open-sesame');
  });

  it('replays the settings and not the passwords', async () => {
    const d = await doc();
    await d.apply(new SetSecurityCommand(d, PASSWORD_INTENT, { user: 'open-sesame' }));
    const file = serialiseJournal(d);

    const fresh = await doc();
    const result = await replayJournal(fresh, file.entries);
    expect(result.applied).toBeGreaterThan(0);
    expect(intentOf(fresh)).toEqual(PASSWORD_INTENT);
    // The replayed command holds no secrets, which is what makes the save ask for them again.
    const top = fresh.undo.journal.at(-1);
    expect((top as SetSecurityCommand | undefined)?.secrets).toEqual({});
  });

  it('replays an entry it does not recognise as nothing, rather than as protection', async () => {
    const d = await doc();
    const result = await replayJournal(d, [
      { type: 'security.set', payload: { intent: { kind: 'password', algorithm: 'rot13' } } },
    ]);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(hasIntent(d)).toBe(false);
  });
});
