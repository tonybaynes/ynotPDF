import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_ALLOWED, NONE_ALLOWED, UNENCRYPTED } from '@engine/security/types';
import { SecurityClient } from '@modules/M70-encryption/SecurityClient';
import { SecurityService } from '@modules/M70-encryption/SecurityService';
import { openFake } from '../core/helpers';
import { FakeEngine } from '../core/fakeEngine';
import { Documents } from '@app/tabs/Documents';
import { DocumentService } from '@modules/M20-document-model/DocumentService';
import { security } from './helpers';

afterEach(() => vi.restoreAllMocks());

async function setup() {
  const { doc } = await openFake();
  const client = new SecurityClient(security());
  const inspect = vi.spyOn(client, 'inspect').mockResolvedValue(UNENCRYPTED);
  const service = new SecurityService({
    registry: {
      hasService: () => false,
      service: () => ({ active: doc, all: () => [doc] }),
    } as never,
    shell: {
      documents: { onAttached: () => () => undefined },
      dialogs: { info: () => Promise.resolve() },
      invalidate: () => undefined,
    } as never,
    client,
  });
  service.load();
  await service.refresh(doc);
  return {
    doc,
    service,
    client,
    inspect,
    close: async () => {
      service.dispose();
      await doc.close();
    },
  };
}

describe('certificate recipient policy (audit finding 3)', () => {
  it('installs policy before attachment observers run without sending callbacks to the engine', async () => {
    const f = await setup();
    const engine = new FakeEngine();
    const opening = vi.spyOn(engine, 'open');
    const tabs = new Documents();
    const documents = new DocumentService(tabs, engine);
    const observed: boolean[] = [];
    tabs.onAttached((tab) => {
      const doc = documents.get(tab.id);
      if (doc) observed.push(f.service.allows('copy', doc));
    });
    try {
      await documents.open(new Uint8Array([1]), {
        beforeAttach: (doc) => {
          f.service.noteSource(doc, {
            bytes: new Uint8Array([1]),
            openedAs: 'Reader',
            permissions: NONE_ALLOWED,
            sourceInfo: { ...UNENCRYPTED, encrypted: true, handler: 'public-key' },
          });
        },
      });
      expect(observed).toEqual([false]);
      expect(opening.mock.calls[0]?.[1]).not.toHaveProperty('beforeAttach');
    } finally {
      await documents.disposeAll();
      await f.close();
    }
  });

  it('carries the envelope permissions through the ordinary open preparation', async () => {
    const f = await setup();
    try {
      f.inspect.mockResolvedValue({ ...UNENCRYPTED, encrypted: true, handler: 'public-key' });
      vi.spyOn(f.service, 'unlockBytesWithDigitalId').mockResolvedValue({
        bytes: new Uint8Array([1]),
        openedAs: 'Reader',
        permissions: NONE_ALLOWED,
      });
      expect(await f.service.prepareForOpen(new Uint8Array([2]), 'sealed.pdf')).toMatchObject({
        openedAs: 'Reader',
        permissions: NONE_ALLOWED,
      });
    } finally {
      await f.close();
    }
  });

  it('enforces recipient restrictions even when the engine has plaintext', async () => {
    const f = await setup();
    try {
      f.service.noteOpenedAs(f.doc.id, 'Reader', NONE_ALLOWED);
      expect(f.service.allows('copy', f.doc)).toBe(false);
      expect(f.service.allows('modify', f.doc)).toBe(false);
      expect(f.service.permissionsFor(f.doc)).toEqual(NONE_ALLOWED);
      expect(f.service.securityOf(f.doc)).toMatchObject({
        info: { encrypted: true, handler: 'public-key', permissions: NONE_ALLOWED },
        unlocked: false,
      });
    } finally {
      await f.close();
    }
  });

  it('does not promote modify permission into authority to copy or print', async () => {
    const f = await setup();
    try {
      f.service.noteOpenedAs(f.doc.id, 'Editor', { ...NONE_ALLOWED, modify: 'all' });
      expect(f.service.allows('modify', f.doc)).toBe(true);
      expect(f.service.allows('copy', f.doc)).toBe(false);
      expect(f.service.allows('print', f.doc)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('keeps the policy when an already-running refresh returns plaintext', async () => {
    const f = await setup();
    try {
      let finish!: (info: typeof UNENCRYPTED) => void;
      f.inspect.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const refreshing = f.service.refresh(f.doc);
      await vi.waitFor(() => {
        expect(finish).toBeTypeOf('function');
      });
      f.service.noteOpenedAs(f.doc.id, 'Reader', NONE_ALLOWED);
      finish(UNENCRYPTED);
      await refreshing;
      expect(f.service.allows('copy', f.doc)).toBe(false);
      expect(f.service.permissionsFor(f.doc)).toEqual(NONE_ALLOWED);
    } finally {
      await f.close();
    }
  });

  it('fails closed when a legacy caller omits recipient permissions', async () => {
    const f = await setup();
    try {
      f.service.noteOpenedAs(f.doc.id, 'Unknown rights');
      expect(f.service.allows('modify', f.doc)).toBe(false);
      expect(f.service.allows('copy', f.doc)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('never authenticates a recipient as an owner against the plaintext working copy', async () => {
    const f = await setup();
    try {
      const owner = vi.spyOn(f.client, 'isOwnerPassword').mockResolvedValue(true);
      f.service.noteOpenedAs(f.doc.id, 'Reader', NONE_ALLOWED);
      expect(await f.service.unlockWithPassword(f.doc, 'irrelevant')).toBe(false);
      expect(owner).not.toHaveBeenCalled();
      expect(f.service.allows('modify', f.doc)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('still permits the individual rights of an unrestricted recipient', async () => {
    const f = await setup();
    try {
      f.service.noteOpenedAs(f.doc.id, 'Full rights', ALL_ALLOWED);
      expect(f.service.allows('copy', f.doc)).toBe(true);
      expect(f.service.allows('modify', f.doc)).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('does not revoke verified owner authority when a fallback source inspection finishes', async () => {
    const f = await setup();
    try {
      const current = f.doc.state;
      vi.spyOn(f.doc, 'state', 'get').mockReturnValue({
        ...current,
        security: { ...current.security, encrypted: true },
      });
      f.service.forget(f.doc.id);
      let finish!: (info: typeof UNENCRYPTED) => void;
      const inspection = new Promise<typeof UNENCRYPTED>((resolve) => {
        finish = resolve;
      });
      f.inspect.mockReturnValue(inspection);
      f.service.load();
      const refreshing = f.service.refresh(f.doc);
      vi.spyOn(f.client, 'isOwnerPassword').mockResolvedValue(true);
      expect(await f.service.unlockWithPassword(f.doc, 'owner')).toBe(true);
      finish({ ...UNENCRYPTED, encrypted: true, handler: 'standard', permissions: NONE_ALLOWED });
      await refreshing;
      expect(f.service.securityOf(f.doc).authority).toBe('owner');
      expect(f.service.allows('copy', f.doc)).toBe(true);
    } finally {
      await f.close();
    }
  });
});
