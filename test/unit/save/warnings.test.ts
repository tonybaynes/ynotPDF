/** Save warnings must be a decision before writing, not an ignored return value (audit 2). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Documents } from '@app/tabs/Documents';
import { Registry } from '@core/Registry';
import { SetMetadataCommand } from '@core/commands';
import { DOCUMENT_SERVICE } from '@modules/M20-document-model/DocumentService';
import { SaveService } from '@modules/M21-save/SaveService';
import { memoryRecoveryStorage } from '@modules/M21-save/recovery';
import { memorySettingsStorage } from '@modules/M21-save/settings';
import type { WriterClient } from '@modules/M21-save/WriterClient';
import { openFake, must } from '../core/helpers';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup(
  options: { writerWarnings?: string[]; answer?: string; clean?: boolean } = {},
) {
  const path = 'C:/audit/warnings.pdf';
  const { doc } = await openFake(undefined, {}, { path });
  const documents = new Documents();
  const tab = documents.open({ title: doc.state.title, path });
  documents.attach(tab.id, doc);
  const registry = new Registry();
  registry.provide(DOCUMENT_SERVICE, { active: doc, all: () => [doc], get: () => doc });
  const review = vi.fn(() => Promise.resolve(options.answer ?? 'cancel'));
  const toasts = vi.fn();
  const shell = {
    documents,
    invalidate: () => undefined,
    toasts: { show: toasts },
    dialogs: {
      message: () => Promise.resolve('save'),
      open: (opts: { id?: string }) => ({
        result: opts.id === 'save-warnings-dialog' ? review() : Promise.resolve('cancel'),
      }),
      error: vi.fn(),
      progress: () => ({
        set: () => undefined,
        close: () => undefined,
        onCancel: new Promise<void>(() => undefined),
      }),
    },
  };
  const write = vi.fn((job: { bytes: Uint8Array }) => ({
    promise: Promise.resolve({
      bytes: job.bytes,
      warnings: options.writerWarnings ?? [],
      applied: [],
      appearances: 0,
    }),
    cancel: () => undefined,
  }));
  const invoke = vi.fn((channel: string): Promise<unknown> => {
    if (channel === 'file:probe')
      return Promise.resolve({
        path,
        exists: true,
        size: 1,
        modifiedAt: 1,
        writable: true,
        directoryWritable: true,
        readOnly: false,
      });
    if (channel === 'file:saveAsDialog') return Promise.resolve('C:/audit/copy.pdf');
    if (channel === 'file:writeAtomic')
      return Promise.resolve({ path, bytesWritten: 1, backupPath: null, modifiedAt: 2 });
    return Promise.resolve(undefined);
  });
  vi.stubGlobal('ynot', { invoke, on: () => () => undefined });
  const recovery = memoryRecoveryStorage();
  const service = new SaveService({
    registry,
    shell: shell as never,
    recoveryStorage: recovery,
    settingsStorage: memorySettingsStorage(),
    writer: { write, dispose: () => undefined } as unknown as WriterClient,
  });
  await service.load();
  if (!options.clean) await doc.apply(new SetMetadataCommand(doc, { title: 'Unsaved edit' }));
  await service.autosaveNow();
  const writes = () => invoke.mock.calls.filter(([channel]) => channel === 'file:writeAtomic');
  return {
    doc,
    tab,
    service,
    review,
    recovery,
    write,
    invoke,
    documents,
    writes,
    toasts,
    close: async () => {
      service.dispose();
      await doc.close();
    },
  };
}

describe('review warnings before saving', () => {
  it('cancels stale output when edits arrive while the writer is pending', async () => {
    const f = await setup();
    try {
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.write.mockImplementation((job) => ({
        promise: barrier.then(() => ({
          bytes: job.bytes,
          warnings: [],
          applied: [],
          appearances: 0,
        })),
        cancel: () => undefined,
      }));
      const saving = f.service.save(f.doc);
      await vi.waitFor(() => {
        expect(f.write).toHaveBeenCalledTimes(1);
      });
      // Undo and branch to the SAME length: a savedIndex comparison alone misses this.
      await f.doc.undoLast();
      await f.doc.apply(new SetMetadataCommand(f.doc, { title: 'Different edit' }));
      release();
      expect((await saving).reason).toBe('cancelled');
      expect(f.writes()).toHaveLength(0);
      expect(f.doc.isDirty).toBe(true);
      expect(f.recovery.size).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('keeps newer edits dirty when they arrive during the filesystem write', async () => {
    const f = await setup();
    try {
      const original = must(f.invoke.getMockImplementation());
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.invoke.mockImplementation(async (channel) => {
        if (channel === 'file:writeAtomic') await barrier;
        return original(channel);
      });
      const saving = f.service.save(f.doc);
      await vi.waitFor(() => {
        expect(f.writes()).toHaveLength(1);
      });
      await f.doc.apply(new SetMetadataCommand(f.doc, { title: 'Edit during write' }));
      release();
      expect((await saving).saved).toBe(true);
      expect(f.doc.isDirty).toBe(true);
      expect(f.recovery.size).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('serializes overlapping saves and updates the model, tab and watcher on Save As', async () => {
    const f = await setup();
    try {
      const outcomes = await Promise.all([f.service.saveAs(f.doc), f.service.save(f.doc)]);
      expect(outcomes.map((outcome) => outcome.saved)).toEqual([true, false]);
      expect(outcomes[1]?.reason).toBe('clean');
      expect(f.writes()).toHaveLength(1);
      expect(f.doc.state.path).toBe('C:/audit/copy.pdf');
      expect(f.documents.get(f.tab.id)?.path).toBe(f.doc.state.path);
      expect(f.invoke).toHaveBeenCalledWith('file:watch', 'C:/audit/warnings.pdf', false);
      expect(f.invoke).toHaveBeenCalledWith('file:watch', 'C:/audit/copy.pdf', true);
    } finally {
      await f.close();
    }
  });

  it('cancels plan warnings before running the engine or writer and preserves recovery', async () => {
    const f = await setup();
    try {
      vi.spyOn(f.doc, 'enginePage').mockReturnValue(undefined);
      const save = vi.spyOn(f.doc.engine, 'save');
      expect((await f.service.save(f.doc)).reason).toBe('cancelled');
      expect(f.review).toHaveBeenCalledOnce();
      expect(save).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
      expect(f.writes()).toHaveLength(0);
      expect(f.doc.isDirty).toBe(true);
      expect(f.recovery.size).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('waits for a decision on writer/stage warnings before any filesystem write', async () => {
    const f = await setup({ writerWarnings: ['An attachment could not be saved'] });
    try {
      f.service.addStage({
        id: 'warning',
        order: 100,
        run: (input) =>
          Promise.resolve({ bytes: input.bytes, warnings: ['Protection will be removed'] }),
      });
      let answer!: (value: string) => void;
      f.review.mockImplementation(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      const saving = f.service.save(f.doc);
      await vi.waitFor(() => {
        expect(f.review).toHaveBeenCalledOnce();
      });
      expect(f.writes()).toHaveLength(0);
      expect(f.doc.isDirty).toBe(true);
      expect(f.recovery.size).toBe(1);
      answer('cancel');
      expect((await saving).reason).toBe('cancelled');
      expect(f.writes()).toHaveLength(0);
      expect(f.recovery.size).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('writes only after consent, returning all warnings while retaining dirty state and recovery', async () => {
    const f = await setup({ writerWarnings: ['Writer warning'], answer: 'save' });
    try {
      f.service.addStage({
        id: 'warning',
        order: 100,
        run: (input) => Promise.resolve({ bytes: input.bytes, warnings: ['Stage warning'] }),
      });
      const result = await f.service.save(f.doc);
      expect(f.review).toHaveBeenCalledOnce();
      expect(result.saved).toBe(true);
      expect(result.warnings).toEqual(['Writer warning', 'Stage warning']);
      expect(f.writes()).toHaveLength(1);
      expect(f.doc.isDirty).toBe(true);
      expect(f.recovery.size).toBe(1);
      expect(f.toasts).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning' }));
    } finally {
      await f.close();
    }
  });

  it('reviews later warnings even when plan warnings were already accepted', async () => {
    const f = await setup({ writerWarnings: ['Later warning'], answer: 'save' });
    try {
      vi.spyOn(f.doc, 'enginePage').mockReturnValue(undefined);
      f.review.mockResolvedValueOnce('save').mockResolvedValueOnce('cancel');
      expect((await f.service.save(f.doc)).reason).toBe('cancelled');
      expect(f.review).toHaveBeenCalledTimes(2);
      expect(f.writes()).toHaveLength(0);
      expect(f.recovery.size).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('does not close a document whose save had warnings, even after consenting to write', async () => {
    const f = await setup({ writerWarnings: ['An edit was omitted'], answer: 'save' });
    try {
      expect(await f.service.confirmClose(f.tab)).toBe('cancel');
      expect(f.writes()).toHaveLength(1);
      expect(f.doc.isDirty).toBe(true);
      expect(f.recovery.size).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('marks even a formerly clean document unsaved when Save As has warnings', async () => {
    const f = await setup({ writerWarnings: ['A field was omitted'], answer: 'save', clean: true });
    try {
      expect(f.doc.isDirty).toBe(false);
      expect((await f.service.saveAs(f.doc)).saved).toBe(true);
      expect(f.review).toHaveBeenCalledOnce();
      expect(f.doc.isDirty).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('keeps warning-free saves quiet and marks them saved', async () => {
    const f = await setup();
    try {
      expect((await f.service.save(f.doc)).saved).toBe(true);
      expect(f.review).not.toHaveBeenCalled();
      expect(f.writes()).toHaveLength(1);
      expect(f.doc.isDirty).toBe(false);
      expect(f.recovery.size).toBe(0);
    } finally {
      await f.close();
    }
  });
});
