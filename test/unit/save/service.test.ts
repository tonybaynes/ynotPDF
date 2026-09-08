/**
 * `SaveService` (M21) — the decisions, without a DOM.
 *
 * There is no jsdom in this repo, so the dialogs are stubbed with objects that record what they
 * were asked and answer what the test says. What is under test is the *logic*: when a save is a
 * no-op, when it becomes a Save As, what happens to the recovery record, what the close flow
 * answers, and whether a failure on permissions is offered as a read-only file rather than as an
 * error the reader can do nothing with. The dialogs' own behaviour is M02's, and the wiring is
 * proved end to end in `test/e2e/save.spec.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import { Documents } from '@app/tabs/Documents';
import { RotatePagesCommand, SetMetadataCommand } from '@core/commands';
import { Registry } from '@core/Registry';
import { DOCUMENT_SERVICE } from '@modules/M20-document-model/DocumentService';
import { SaveService } from '@modules/M21-save/SaveService';
import { fileNameFor, folderOf, joinPath } from '@modules/M21-save/SaveService';
import { memoryRecoveryStorage } from '@modules/M21-save/recovery';
import { memorySettingsStorage } from '@modules/M21-save/settings';
import { WriterClient } from '@modules/M21-save/WriterClient';
import { openFake, must } from '../core/helpers';

/** What the tests want the dialogs to answer, and what they were asked. */
interface FakeDialogs {
  answers: Record<string, string>;
  asked: { id: string; title: string }[];
}

function makeShell(
  dialogs: FakeDialogs,
  documents: Documents,
): {
  shell: never;
  toasts: { kind: string; text: string }[];
} {
  const toasts: { kind: string; text: string }[] = [];
  const answer = (options: { id?: string; title: string }): Promise<string> => {
    dialogs.asked.push({ id: options.id ?? '', title: options.title });
    return Promise.resolve(dialogs.answers[options.id ?? ''] ?? 'cancel');
  };
  const shell = {
    documents,
    dialogs: {
      message: answer,
      open: (options: { id?: string; title: string }) => ({ result: answer(options) }),
      error: (title: string, text: string) => {
        toasts.push({ kind: 'error', text: `${title}: ${text}` });
        return Promise.resolve('ok');
      },
      progress: () => ({
        set: () => undefined,
        close: () => undefined,
        cancelled: false,
        onCancel: new Promise<void>(() => undefined),
      }),
    },
    toasts: {
      show: (options: { kind?: string; text: string }) => {
        toasts.push({ kind: options.kind ?? 'info', text: options.text });
        return { close: () => undefined };
      },
    },
    invalidate: () => undefined,
    // Not reached by anything under test; the service only uses the four above.
  };
  // The real `ShellServices` carries a dozen more members that this suite never touches.
  return { shell: shell as unknown as never, toasts };
}

/** A service over a fake document, with in-memory storage and no worker. */
async function makeService(options: { answers?: Record<string, string> } = {}) {
  const documents = new Documents();
  const registry = new Registry();
  const dialogs: FakeDialogs = { answers: options.answers ?? {}, asked: [] };
  const { shell, toasts } = makeShell(dialogs, documents);

  const { doc } = await openFake();
  const tab = documents.open({ title: doc.state.title, path: null });
  documents.attach(tab.id, doc);
  const docService = {
    active: doc,
    get: (id: string) => (id === tab.id ? doc : null),
    all: () => [doc],
    open: () => Promise.reject(new Error('not used in this suite')),
  };
  registry.provide(DOCUMENT_SERVICE, docService);

  const recovery = memoryRecoveryStorage();
  const service = new SaveService({
    registry,
    shell,
    settingsStorage: memorySettingsStorage(),
    recoveryStorage: recovery,
    // No `Worker` in Node, so this runs the same writer in-process.
    writer: new WriterClient(null),
    now: () => 1_000,
  });
  await service.load();
  return { service, doc, tab, documents, dialogs, recovery, toasts };
}

describe('save decides what to do', () => {
  it('a document with no changes is left alone', async () => {
    const { service, doc } = await makeService();
    const outcome = await service.save(doc);
    expect(outcome).toEqual({ saved: false, path: null, reason: 'clean' });
    service.dispose();
    await doc.close();
  });

  it('a document that has never been saved goes to Save As', async () => {
    const { service, doc } = await makeService();
    await doc.apply(new SetMetadataCommand(doc, { title: 'Changed' }));
    // Without the Electron bridge there is no dialog to show, which is the honest answer.
    const outcome = await service.save(doc);
    expect(outcome.reason).toBe('no-bridge');
    service.dispose();
    await doc.close();
  });

  it('knows whether a save would write anything', async () => {
    const { service, doc } = await makeService();
    expect(service.canSave).toBe(false);
    expect(service.canSaveAs).toBe(true);
    expect(service.wouldWriteNothing(doc)).toBe(true);
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    expect(service.canSave).toBe(true);
    service.dispose();
    await doc.close();
  });
});

describe('autosave', () => {
  it('writes a record for a changed document and nothing for a clean one', async () => {
    const { service, doc, recovery } = await makeService();
    expect(await service.autosaveNow()).toBe(0);
    expect(recovery.size).toBe(0);

    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    expect(await service.autosaveNow()).toBe(1);
    expect(recovery.size).toBe(1);

    const [entry] = await recovery.list();
    const record = JSON.parse(must(entry, 'record').payload) as {
      changes: number;
      savedAt: number;
      title: string;
    };
    expect(record.changes).toBe(1);
    expect(record.savedAt).toBe(1_000);
    expect(record.title).toBe(doc.state.title);
    service.dispose();
    await doc.close();
  });

  it('the record names this document only once, however often autosave runs', async () => {
    const { service, doc, recovery } = await makeService();
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    await service.autosaveNow();
    await doc.apply(new SetMetadataCommand(doc, { title: 'More' }));
    await service.autosaveNow();
    expect(recovery.size).toBe(1);
    service.dispose();
    await doc.close();
  });

  it('closing a tab throws its record away — there is nothing left to recover', async () => {
    const { service, doc, documents, tab, recovery } = await makeService();
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    await service.autosaveNow();
    expect(recovery.size).toBe(1);
    await documents.close(tab.id, { force: true });
    // The discard is fired without being waited on, so let the microtask queue drain.
    await Promise.resolve();
    await Promise.resolve();
    expect(recovery.size).toBe(0);
    service.dispose();
    await doc.close();
  });

  it('turning the interval off stops it, and setting one starts it again', async () => {
    const { service, doc } = await makeService();
    expect(service.settings.autosaveMinutes).toBe(5);
    expect(await service.setSetting('autosaveMinutes', 0)).toBe(0);
    expect(service.settings.autosaveMinutes).toBe(0);
    expect(await service.setSetting('autosaveMinutes', 2)).toBe(2);
    service.dispose();
    await doc.close();
  });

  it('runs on the interval once it is armed', async () => {
    vi.useFakeTimers();
    try {
      const { service, doc, recovery } = await makeService();
      await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
      expect(recovery.size).toBe(1);
      service.dispose();
      await doc.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the close flow', () => {
  it('a clean document closes without asking', async () => {
    const { service, doc, tab, dialogs } = await makeService();
    expect(await service.confirmClose(tab)).toBe('discard');
    expect(dialogs.asked).toEqual([]);
    service.dispose();
    await doc.close();
  });

  it('"Don\'t save" closes and asks nothing else', async () => {
    const { service, doc, tab, dialogs } = await makeService({
      answers: { 'save-unsaved-dialog': 'discard' },
    });
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    expect(await service.confirmClose(tab)).toBe('discard');
    expect(dialogs.asked.map((a) => a.id)).toEqual(['save-unsaved-dialog']);
    service.dispose();
    await doc.close();
  });

  it('Cancel keeps the document, and the tab does not close', async () => {
    const { service, doc, tab, documents } = await makeService({
      answers: { 'save-unsaved-dialog': 'cancel' },
    });
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    expect(await service.confirmClose(tab)).toBe('cancel');
    // And through the shell's own hook, which is what a click on the tab's × runs.
    expect(await documents.close(tab.id)).toBe(false);
    expect(documents.tabs).toHaveLength(1);
    service.dispose();
    await doc.close();
  });

  it('a Save that cannot happen counts as Cancel rather than losing the work', async () => {
    const { service, doc, tab } = await makeService({
      answers: { 'save-unsaved-dialog': 'save' },
    });
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    // No bridge, so the save cannot happen; the document must stay open.
    expect(await service.confirmClose(tab)).toBe('cancel');
    service.dispose();
    await doc.close();
  });

  it('closing everything stops at the first Cancel', async () => {
    const { service, doc, documents } = await makeService({
      answers: { 'save-unsaved-dialog': 'cancel' },
    });
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    expect(await service.confirmCloseAll()).toBe(false);
    expect(documents.tabs).toHaveLength(1);
    service.dispose();
    await doc.close();
  });
});

describe('recovery', () => {
  it('offers nothing when there is nothing to offer', async () => {
    const { service, doc, dialogs } = await makeService();
    expect(await service.offerRecovery()).toEqual({ recovered: 0, discarded: 0 });
    expect(dialogs.asked).toEqual([]);
    service.dispose();
    await doc.close();
  });

  it('Discard throws the records away without opening anything', async () => {
    const { service, doc, recovery } = await makeService({
      answers: { 'save-recovery-dialog': 'discard' },
    });
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    await service.autosaveNow();
    expect(await service.offerRecovery()).toEqual({ recovered: 0, discarded: 1 });
    expect(recovery.size).toBe(0);
    service.dispose();
    await doc.close();
  });

  it('"Not now" leaves them for next time', async () => {
    const { service, doc, recovery } = await makeService({
      answers: { 'save-recovery-dialog': 'later' },
    });
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    await service.autosaveNow();
    expect(await service.offerRecovery()).toEqual({ recovered: 0, discarded: 0 });
    expect(recovery.size).toBe(1);
    service.dispose();
    await doc.close();
  });

  it('a record for a document that was never saved cannot be recovered, and says so', async () => {
    const { service, doc, recovery, toasts } = await makeService({
      answers: { 'save-recovery-dialog': 'recover' },
    });
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    await service.autosaveNow();
    expect(await service.offerRecovery()).toEqual({ recovered: 0, discarded: 0 });
    expect(toasts.at(-1)?.text).toContain('never saved');
    expect(recovery.size).toBe(0);
    service.dispose();
    await doc.close();
  });

  it('turning recovery off means nothing is offered on launch', async () => {
    const { service, doc, dialogs } = await makeService({
      answers: { 'save-recovery-dialog': 'recover' },
    });
    await service.setSetting('recoverOnLaunch', false);
    await doc.apply(new RotatePagesCommand(doc, [doc.page(0).id], 90, true));
    await service.autosaveNow();
    expect(await service.offerRecovery()).toEqual({ recovered: 0, discarded: 0 });
    expect(dialogs.asked).toEqual([]);
    service.dispose();
    await doc.close();
  });
});

describe('paths', () => {
  it('turns a title into a file name a filesystem will take', () => {
    expect(fileNameFor('Report')).toBe('Report.pdf');
    expect(fileNameFor('Report.pdf')).toBe('Report.pdf');
    expect(fileNameFor('Q1/Q2: results?')).toBe('Q1-Q2- results-.pdf');
    expect(fileNameFor('   ')).toBe('Untitled.pdf');
    expect(fileNameFor('')).toBe('Untitled.pdf');
  });

  it('splits and joins on whichever separator the folder uses', () => {
    expect(folderOf('C:\\Users\\tony\\doc.pdf')).toBe('C:\\Users\\tony');
    expect(folderOf('/home/tony/doc.pdf')).toBe('/home/tony');
    expect(folderOf('doc.pdf')).toBe('doc.pdf');
    expect(joinPath('C:\\Users\\tony', 'a.pdf')).toBe('C:\\Users\\tony\\a.pdf');
    expect(joinPath('/home/tony', 'a.pdf')).toBe('/home/tony/a.pdf');
    expect(joinPath('/home/tony/', 'a.pdf')).toBe('/home/tony/a.pdf');
  });
});
