/**
 * The save pipeline stage (M70, ADR 0012).
 *
 * The stage is where the whole module meets the disk: whatever the dialog produced and whatever
 * the reader typed, it comes down to "the bytes M21 was about to write are encrypted first". So
 * these tests drive the real `SecurityService` with the real `Security` (a real qpdf, and our own
 * certificate encryption) and check the *bytes it returns*, not what it says it did.
 *
 * `runSaveStages` is tested here too, because ordering and warning collection are M21's contract
 * and M120 will depend on both.
 */

import { describe, expect, it } from 'vitest';
import type { Document } from '@core/Document';
import { PERMISSION_GATE, Registry, type PermissionGate } from '@core/Registry';
import { runSaveStages, type SavePipelineStage } from '@engine/Writer';
import {
  ALL_ALLOWED,
  NONE_ALLOWED,
  NO_SECURITY,
  type SecurityIntent,
} from '@engine/security/types';
import { SetSecurityCommand } from '@modules/M70-encryption/commands';
import { SecurityClient } from '@modules/M70-encryption/SecurityClient';
import { SecurityService } from '@modules/M70-encryption/SecurityService';
import { openFake } from '../core/helpers';
import { fixture, makeIdentity, recipientFor, security } from './helpers';
import { summarise } from '@engine/security/pubsec/certificates';

const alice = makeIdentity('Alice Adams');

/**
 * A `SecurityService` wired to real crypto and a shell that is only what the stage touches.
 *
 * Nothing here is a mock of the code under test: the client runs the same `Security` the app
 * ships, in-process because there is no `Worker` in Node — which is exactly the fallback
 * `SecurityClient.spawn` was written for.
 */
function serviceFor(
  doc: Document,
  askPassword?: (options: { title: string; reason: string }) => Promise<string | null>,
): SecurityService {
  const registry = {
    hasService: (name: string) => name === 'document',
    service: (name: string) => {
      if (name === 'document') return { active: doc, all: () => [doc] };
      throw new Error(`no service ${name}`);
    },
  };
  const shell = {
    documents: { onAttached: () => () => undefined },
    dialogs: {},
    toasts: { show: () => undefined },
    invalidate: () => undefined,
  };
  return new SecurityService({
    registry: registry as never,
    shell: shell as never,
    client: new SecurityClient(security()),
    // The default opens a dialog; a Node test has no DOM, and what matters here is *whether* it
    // asks, not what the dialog looks like — that is Playwright's job.
    askPassword: askPassword ?? (() => Promise.resolve(null)),
  });
}

/**
 * A document with an intent applied the way the dialog applies one — through the service, so the
 * passwords land in its private map exactly as they would in the app.
 */
async function protectedDocument(
  intent: SecurityIntent,
  secrets: { user?: string; owner?: string } = {},
  askPassword?: (options: { title: string; reason: string }) => Promise<string | null>,
): Promise<{ doc: Document; service: SecurityService }> {
  const { doc } = await openFake();
  const service = serviceFor(doc, askPassword);
  service.load();
  await service.applyIntentDirectly(doc, { ...intentArgs(intent), ...secrets });
  return { doc, service };
}

/** `applyIntentDirectly`'s argument form for an intent, so the tests read as intents. */
function intentArgs(intent: SecurityIntent): Record<string, unknown> {
  if (intent.kind === 'none') return { kind: 'none' };
  if (intent.kind === 'certificate') {
    return { kind: 'certificate', scope: intent.scope, recipients: intent.recipients };
  }
  return {
    kind: 'password',
    algorithm: intent.algorithm,
    scope: intent.scope,
    print: intent.permissions.print,
    modify: intent.permissions.modify,
    copy: intent.permissions.copy,
    accessibility: intent.permissions.accessibility,
  };
}

/** A document whose intent was replayed from a journal, so no password is held for it. */
async function recoveredDocument(
  intent: SecurityIntent,
  askPassword: (options: { title: string; reason: string }) => Promise<string | null>,
): Promise<{ doc: Document; service: SecurityService }> {
  const { doc } = await openFake();
  const service = serviceFor(doc, askPassword);
  service.load();
  // Exactly what the journal codec produces: the intent, and no secrets.
  await doc.apply(new SetSecurityCommand(doc, intent));
  return { doc, service };
}

/** Runs the stage over a real PDF, as M21 would. */
async function runStage(
  service: SecurityService,
  doc: Document,
  bytes = fixture('multipage.pdf'),
): Promise<{ bytes: Uint8Array; warnings: ReadonlyArray<string> }> {
  const result = await service.stage().run({
    bytes,
    context: { documentId: doc.id, path: 'C:/out.pdf', saveAs: false },
  });
  return { bytes: result.bytes, warnings: result.warnings ?? [] };
}

describe('running the stages', () => {
  const make = (id: string, order: number, mark: number): SavePipelineStage => ({
    id,
    order,
    run: (input) => {
      const out = new Uint8Array(input.bytes.length + 1);
      out.set(input.bytes);
      out[input.bytes.length] = mark;
      return Promise.resolve({ bytes: out, warnings: [`${id} ran`] });
    },
  });

  it('runs them in order and collects every warning', async () => {
    const result = await runSaveStages([make('b', 20, 2), make('a', 10, 1)], {
      bytes: new Uint8Array(0),
      context: { documentId: 'd', path: 'p', saveAs: false },
    });
    expect([...result.bytes]).toEqual([1, 2]);
    expect(result.warnings).toEqual(['a ran', 'b ran']);
  });

  it('does nothing at all when there are no stages', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await runSaveStages([], {
      bytes,
      context: { documentId: 'd', path: 'p', saveAs: false },
    });
    expect(result.bytes).toBe(bytes);
  });

  it('stops when the save is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runSaveStages([make('a', 10, 1)], {
        bytes: new Uint8Array(0),
        context: { documentId: 'd', path: 'p', saveAs: false },
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/i);
  });
});

describe('the encryption stage', () => {
  const s = security();

  it('leaves an unprotected document alone, byte for byte', async () => {
    const { doc, service } = await protectedDocument(NO_SECURITY);
    const input = fixture('multipage.pdf');
    const result = await runStage(service, doc, input);
    expect(result.bytes).toBe(input);
  });

  it('encrypts with the algorithm and permissions the intent asked for', async () => {
    const { doc, service } = await protectedDocument(
      {
        kind: 'password',
        algorithm: 'aes-256',
        scope: 'all',
        permissions: NONE_ALLOWED,
        hasUserPassword: true,
        hasOwnerPassword: true,
      },
      { user: 'open-me', owner: 'change-me' },
    );
    const result = await runStage(service, doc);
    const info = await s.inspect(result.bytes);
    expect(info.encrypted).toBe(true);
    expect(info.algorithm).toBe('aes-256');
    expect(info.permissions).toEqual(NONE_ALLOWED);
    expect(info.opensWithoutPassword).toBe(false);
    // And it really is that password, not just a protected file.
    expect(await s.isOwnerPassword(result.bytes, 'change-me')).toBe(true);
  }, 40_000);

  it('writes the older algorithms when asked, so an old viewer can open the file', async () => {
    for (const algorithm of ['aes-128', 'rc4-128'] as const) {
      const { doc, service } = await protectedDocument(
        {
          kind: 'password',
          algorithm,
          scope: 'all',
          permissions: ALL_ALLOWED,
          hasUserPassword: false,
          hasOwnerPassword: true,
        },
        { owner: 'owner' },
      );
      const result = await runStage(service, doc);
      expect((await s.inspect(result.bytes)).algorithm).toBe(algorithm);
    }
  }, 40_000);

  it('encrypts to certificate recipients, and only they can open it', async () => {
    const { doc, service } = await protectedDocument({
      kind: 'certificate',
      algorithm: 'aes-256',
      scope: 'all',
      recipients: [summarise(recipientFor(alice, NONE_ALLOWED))],
    });
    const result = await runStage(service, doc);
    const info = await s.inspect(result.bytes);
    expect(info.handler).toBe('public-key');
    const opened = await s.unlockWithDigitalId(result.bytes, alice.p12, alice.p12Password);
    expect(opened.openedAs).toBe('Alice Adams');
    expect(opened.permissions).toEqual(NONE_ALLOWED);
  }, 60_000);

  it('says so, without failing the save, when it could not do everything', async () => {
    const { doc, service } = await protectedDocument(
      {
        kind: 'password',
        algorithm: 'aes-256',
        scope: 'attachments-only',
        permissions: ALL_ALLOWED,
        hasUserPassword: false,
        hasOwnerPassword: true,
      },
      { owner: 'owner' },
    );
    // `multipage.pdf` has no attachments, so there is nothing for this scope to protect — which
    // the reader is told about rather than left to discover.
    const result = await runStage(service, doc);
    expect(result.warnings.join(' ')).toMatch(/no file attachments/);
    expect(result.bytes.length).toBeGreaterThan(0);
  }, 40_000);

  it('promises M21 that the file will be protected, so the save warning stays quiet', async () => {
    const { doc, service } = await protectedDocument(
      {
        kind: 'password',
        algorithm: 'aes-256',
        scope: 'all',
        permissions: ALL_ALLOWED,
        hasUserPassword: true,
        hasOwnerPassword: false,
      },
      { user: 'open' },
    );
    expect(service.willProtect(doc.id)).toBe(true);
    expect(service.stage().handlesSecurity?.(doc.id)).toBe(true);

    const { doc: plain, service: plainService } = await protectedDocument(NO_SECURITY);
    expect(plainService.willProtect(plain.id)).toBe(false);
  });

  it('asks for the password a recovered document no longer holds, and uses the answer', async () => {
    // The exact situation after a crash: the journal replayed the intent, and never held a
    // password to replay. The save must ask rather than quietly write an unprotected file.
    const asked: string[] = [];
    const { doc, service } = await recoveredDocument(
      {
        kind: 'password',
        algorithm: 'aes-256',
        scope: 'all',
        permissions: NONE_ALLOWED,
        hasUserPassword: true,
        hasOwnerPassword: true,
      },
      (ask) => {
        asked.push(ask.reason);
        return Promise.resolve(asked.length === 1 ? 'open-again' : 'change-again');
      },
    );
    const result = await runStage(service, doc);
    // One question per password, each saying which one it wants.
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatch(/needed to open it/);
    expect(asked[1]).toMatch(/controls permissions/);
    const info = await s.inspect(result.bytes);
    expect(info.encrypted).toBe(true);
    expect(info.opensWithoutPassword).toBe(false);
    expect(await s.isOwnerPassword(result.bytes, 'change-again')).toBe(true);
    expect(await s.isOwnerPassword(result.bytes, 'open-again')).toBe(false);
  }, 40_000);

  it('saves without protection, and says so, when the reader cancels that question', async () => {
    const { doc, service } = await recoveredDocument(
      {
        kind: 'password',
        algorithm: 'aes-256',
        scope: 'all',
        permissions: NONE_ALLOWED,
        hasUserPassword: true,
        hasOwnerPassword: false,
      },
      () => Promise.resolve(null),
    );
    const input = fixture('multipage.pdf');
    const result = await runStage(service, doc, input);
    // The document is still saved — losing the reader's edits would be the worse failure — and
    // the warning says exactly what was lost.
    expect(result.bytes).toBe(input);
    expect(result.warnings.join(' ')).toMatch(/without its password protection/);
  }, 40_000);

  it('really removes protection when asked, rather than putting it back', async () => {
    // The regression this exists for: the stage carries a protected file's own security forward
    // when nothing was asked for, and `{ kind: 'none' }` is *something being asked for*. Reading
    // the two as the same thing made Remove Security silently re-encrypt the file.
    const { doc, service } = await protectedDocument(
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
    const encrypted = await runStage(service, doc);
    expect((await s.inspect(encrypted.bytes)).encrypted).toBe(true);

    // Now the reader removes it. The passwords are still held, and the file it was opened from is
    // still protected — neither of which may override what was asked for.
    await service.applyIntentDirectly(doc, { kind: 'none' });
    // The stage is still in charge — the reader has already been asked, so M21 must not ask
    // again — but the outcome is now an unprotected file.
    expect(service.stage().handlesSecurity?.(doc.id)).toBe(true);
    expect(service.willProtect(doc.id)).toBe(false);
    const plain = fixture('multipage.pdf');
    const result = await runStage(service, doc, plain);
    expect(result.bytes).toBe(plain);
    expect((await s.inspect(result.bytes)).encrypted).toBe(false);
  }, 60_000);

  it('answers for a document it has never heard of without throwing', async () => {
    const { service } = await protectedDocument(NO_SECURITY);
    const bytes = fixture('blank.pdf');
    const result = await service.stage().run({
      bytes,
      context: { documentId: 'no-such-document', path: 'C:/x.pdf', saveAs: false },
    });
    expect(result.bytes).toBe(bytes);
    expect(service.stage().handlesSecurity?.('no-such-document')).toBe(false);
    expect(service.willProtect('no-such-document')).toBe(false);
  });
});

describe('what the reader is allowed to do', () => {
  it('allows everything on an unprotected document', async () => {
    const { doc, service } = await protectedDocument(NO_SECURITY);
    for (const action of ['print', 'copy', 'modify', 'annotate', 'assemble'] as const) {
      expect(service.allows(action, doc)).toBe(true);
      expect(service.reasonAgainst(action, doc)).toBe('');
    }
    expect(service.permissionsFor(doc)).toEqual(ALL_ALLOWED);
  });
});

describe('the permission gate on the registry', () => {
  /** A registry with one permission-governed command and a gate that refuses one thing. */
  function registryWith(allowed: boolean): Registry {
    const registry = new Registry();
    registry.register({
      id: 'M99',
      name: 'test',
      commands: [
        {
          id: 'test.print',
          label: 'Print',
          category: 'File',
          permission: 'print',
          run: () => 'printed',
        },
        { id: 'test.about', label: 'About', category: 'Help', run: () => 'about' },
      ],
    });
    registry.provide(PERMISSION_GATE, {
      allows: () => allowed,
      reasonAgainst: () => 'The document’s security settings do not allow printing.',
    } satisfies PermissionGate);
    return registry;
  }

  it('disables a command the gate refuses, and says why', () => {
    const registry = registryWith(false);
    expect(registry.isEnabled('test.print')).toBe(false);
    expect(registry.reasonDisabled('test.print')).toMatch(/do not allow printing/);
    // A command with no permission is untouched.
    expect(registry.isEnabled('test.about')).toBe(true);
    expect(registry.reasonDisabled('test.about')).toBe('');
  });

  it('runs it when the gate allows it', async () => {
    const registry = registryWith(true);
    expect(registry.isEnabled('test.print')).toBe(true);
    expect(registry.reasonDisabled('test.print')).toBe('');
    expect(await registry.run('test.print')).toBe('printed');
  });

  it('refuses to run it with the reason, not with "not available right now"', async () => {
    const registry = registryWith(false);
    await expect(registry.run('test.print')).rejects.toThrow(/do not allow printing/);
  });

  it('leaves every command enabled when no gate is registered', () => {
    const registry = new Registry();
    registry.register({
      id: 'M99',
      name: 'test',
      commands: [
        { id: 'test.print', label: 'Print', category: 'File', permission: 'print', run: () => 1 },
      ],
    });
    // A build without M70 registers no gate, and nothing is gated.
    expect(registry.isEnabled('test.print')).toBe(true);
    expect(registry.reasonDisabled('test.print')).toBe('');
  });
});
