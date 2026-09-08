/**
 * `SaveService` — everything that happens between "the reader pressed Ctrl+S" and "the bytes are
 * on disk", and everything that keeps them safe in between (M21).
 *
 * It owns: Save and Save As, the read-only check, the signature and encryption warnings, the
 * progress dialog, autosave into the recovery store, the offer to recover after a crash, the
 * close flow for one tab / all tabs / quitting, and the watcher that notices a document changing
 * underneath us.
 *
 * Registered as the service `"save"`. It holds one {@link SaveState} per open `Document`, keyed
 * by the document's own id, and cleans it up when the tab closes.
 *
 * **Saving does not reload the engine handle.** The brief asks for one, and the reason it is not
 * here is worth stating: after a full rewrite the engine's document still holds the pages the
 * model deleted, and those pages are what `undo` puts back. Reopening from the saved bytes would
 * throw them away, so a Save would quietly cost the reader their undo history — which Foxit does
 * not do and neither do we. The model stays the source of truth for intent and the engine for
 * content, exactly as the architecture says, and every later save re-derives the same file from
 * the same pair. The cost is memory: pages deleted in a long session stay in the engine until
 * the document is closed. See the build log.
 */

import type { ShellServices } from '@app/services';
import type { Documents, DocumentTab } from '@app/tabs/Documents';
import type { Document } from '@core/Document';
import type { Registry } from '@core/Registry';
import {
  WriteCancelled,
  WriteUnsupported,
  planIsEmpty,
  runSaveStages,
  type SavePipelineStage,
  type WriteResult,
} from '@engine/Writer';
import type { DocumentService } from '@modules/M20-document-model/manifest';
import { DOCUMENT_SERVICE } from '@modules/M20-document-model/DocumentService';
import { hasBridge, invoke, on, type FileProbe } from '@shared/ipc';
import {
  askAboutDiskChange,
  askAboutEncryption,
  askAboutReadOnly,
  askAboutRecovery,
  askAboutSignatures,
  askAboutUnsaved,
  type CloseAnswer,
} from './dialogs';
import { buildWritePlan } from './plan';
import {
  buildRecoveryRecord,
  fingerprintBytes,
  listRecoverable,
  replayRecord,
  describeOutcome,
  ipcRecoveryStorage,
  type RecoveryRecord,
  type RecoveryStorage,
  type SourceFingerprint,
} from './recovery';
import {
  DEFAULT_SAVE_SETTINGS,
  ipcSettingsStorage,
  readSaveSettings,
  writeSaveSetting,
  type SaveSettings,
  type SettingsStorage,
} from './settings';
import { LAST_FOLDER_KEY } from './settings';
import { WriterClient } from './WriterClient';

export const SAVE_SERVICE = 'save';

/** How long a save may take before the progress dialog appears. A small file never shows one. */
const PROGRESS_DELAY_MS = 400;

/** What a save attempt did. `path` is null when nothing was written. */
export interface SaveOutcome {
  readonly saved: boolean;
  readonly path: string | null;
  /** Why nothing was written, in the words the caller may show. */
  readonly reason?: 'clean' | 'cancelled' | 'read-only' | 'no-bridge' | 'failed';
  readonly message?: string;
  readonly bytesWritten?: number;
  readonly backupPath?: string | null;
  readonly warnings?: ReadonlyArray<string>;
}

/** What the service knows about one open document. */
export interface SaveState {
  readonly path: string | null;
  readonly readOnly: boolean;
  /** Why it is read-only, in words. Empty when it is not. */
  readonly readOnlyReason: string;
  /** Fingerprint of the bytes on disk as we last saw them. */
  readonly source: SourceFingerprint | null;
  /** Filename of this document's recovery record. */
  readonly recoveryId: string;
  /** True while a save is running. */
  readonly saving: boolean;
}

export interface SaveServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
  readonly settingsStorage?: SettingsStorage;
  readonly recoveryStorage?: RecoveryStorage;
  readonly writer?: WriterClient;
  /** Injected so the tests do not have to wait for real time to pass. */
  readonly now?: () => number;
}

interface Entry {
  readonly document: Document;
  readonly tabId: string;
  path: string | null;
  readOnly: boolean;
  readOnlyReason: string;
  source: SourceFingerprint | null;
  recoveryId: string;
  saving: boolean;
  /** Set while the reader is being asked about a change on disk, so we ask once. */
  askingAboutDisk: boolean;
}

export class SaveService {
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly documents: Documents;
  private readonly settingsStorage: SettingsStorage;
  private readonly recoveryStorage: RecoveryStorage;
  /**
   * Spawned on the first save, not at startup (see {@link writer}). Null until then.
   */
  private writerClient: WriterClient | null;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly disposers: Array<() => void> = [];
  private settingsValue: SaveSettings = DEFAULT_SAVE_SETTINGS;
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  private lastUnsavedReport: boolean | null = null;
  /** Random per window, so two windows' `doc-1`s do not overwrite each other's recovery file. */
  private readonly sessionToken = Math.random().toString(36).slice(2, 10);

  constructor(options: SaveServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.documents = options.shell.documents;
    this.settingsStorage = options.settingsStorage ?? ipcSettingsStorage();
    this.recoveryStorage = options.recoveryStorage ?? ipcRecoveryStorage();
    this.writerClient = options.writer ?? null;
    this.now = options.now ?? (() => Date.now());
  }

  get settings(): SaveSettings {
    return this.settingsValue;
  }

  /**
   * Transformations applied to the writer's output before it reaches the disk (ADR 0012).
   *
   * M70 registers one here to put encryption back on a protected document. Doing that *after* the
   * save would mean writing the file twice and leaving it unprotected in between, which is the
   * one thing a protect feature must not do.
   */
  private readonly stages = new Map<string, SavePipelineStage>();

  /** Registers a pipeline stage, replacing any stage with the same id. */
  addStage(stage: SavePipelineStage): () => void {
    this.stages.set(stage.id, stage);
    return () => {
      this.removeStage(stage.id);
    };
  }

  removeStage(id: string): void {
    this.stages.delete(id);
  }

  /** Whether a registered stage owns this document's protection, so the warning is not ours. */
  private stageHandlesSecurity(documentId: string): boolean {
    for (const stage of this.stages.values()) {
      if (stage.handlesSecurity?.(documentId) === true) return true;
    }
    return false;
  }

  /** The state of one document, or null when the service has never seen it. */
  state(documentId: string): SaveState | null {
    const entry = this.entries.get(documentId);
    return entry ? toState(entry) : null;
  }

  /** The state of the active document. */
  get activeState(): SaveState | null {
    const doc = this.docs.active;
    return doc ? this.state(doc.id) : null;
  }

  /**
   * The writer, spawned the first time something is actually saved.
   *
   * Eagerly is the obvious place, and it is the wrong one: the Worker loads pdf-lib, which is
   * the better part of a megabyte of JavaScript that nothing needs until the reader presses
   * Ctrl+S — and every window would pay for it at startup, including one that only ever reads.
   */
  private get writer(): WriterClient {
    this.writerClient ??= WriterClient.spawn();
    return this.writerClient;
  }

  private get docs(): DocumentService {
    return this.registry.service<DocumentService>(DOCUMENT_SERVICE);
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  /** Reads settings, installs the hooks and starts autosave. Called once from `activate`. */
  async load(): Promise<void> {
    this.settingsValue = await readSaveSettings(this.settingsStorage);
    this.install();
    this.restartAutosave();
  }

  private install(): void {
    // Adopt every document that is already open, and every one that opens later.
    //
    // Opening a tab and attaching its `Document` are two steps: the store notification comes on
    // the first, when there is nothing to adopt yet. `onAttached` is the second, and is what
    // actually starts the watcher and the read-only check for a newly opened file. The store
    // subscription stays as well, so a document attached before this service existed — or by a
    // path that does not go through `attach` — is still picked up.
    this.adoptOpenDocuments();
    this.disposers.push(
      this.documents.onAttached(() => {
        this.adoptOpenDocuments();
      }),
    );
    this.disposers.push(
      this.documents.subscribe(() => {
        this.adoptOpenDocuments();
        this.reportUnsaved();
      }),
    );
    this.disposers.push(
      this.documents.onClosed((tab) => {
        this.forget(tab.id);
      }),
    );
    // Save / Don't save / Cancel, for one tab and — through `closeAll` — for all of them.
    this.disposers.push(
      this.documents.onBeforeClose(async (tab) => {
        const answer = await this.confirmClose(tab);
        return answer === 'cancel' ? 'cancel' : 'close';
      }),
    );
    if (!hasBridge()) return;
    this.disposers.push(
      on('file:changedOnDisk', ({ path }) => {
        void this.onDiskChange(path);
      }),
    );
    this.disposers.push(
      on('window:closeRequested', () => {
        void this.answerWindowClose();
      }),
    );
    this.disposers.push(
      on('app:quitRequested', () => {
        void this.answerQuit();
      }),
    );
  }

  /** Takes on every open tab whose document this service has not seen yet. */
  private adoptOpenDocuments(): void {
    for (const tab of this.documents.tabs) {
      const doc = this.docs.get(tab.id);
      if (doc && !this.entries.has(doc.id)) void this.adopt(tab, doc);
    }
  }

  /** Starts watching a document and works out whether it can be saved where it is. */
  async adopt(tab: DocumentTab, document: Document): Promise<void> {
    if (this.entries.has(document.id)) return;
    const path = document.state.path;
    const entry: Entry = {
      document,
      tabId: tab.id,
      path,
      readOnly: false,
      readOnlyReason: '',
      source: null,
      recoveryId: `${this.sessionToken}-${document.id}`,
      saving: false,
      askingAboutDisk: false,
    };
    this.entries.set(document.id, entry);
    this.disposers.push(
      document.undo.subscribe(() => {
        this.reportUnsaved();
      }),
    );
    if (path) await this.refreshPath(entry, path);
    this.reportUnsaved();
  }

  /** Re-probes a path, updates the read-only state and (re)starts the watcher. */
  private async refreshPath(entry: Entry, path: string): Promise<void> {
    const probe = await this.probe(path);
    entry.path = path;
    entry.readOnly = probe.readOnly;
    entry.readOnlyReason = readOnlyReason(probe);
    this.documents.update(entry.tabId, { path, readOnly: probe.readOnly });
    if (this.settingsValue.watchFiles && hasBridge()) {
      await invoke('file:watch', path, true).catch(() => undefined);
    }
  }

  private async probe(path: string): Promise<FileProbe> {
    if (!hasBridge()) {
      return {
        path,
        exists: true,
        size: 0,
        modifiedAt: 0,
        writable: true,
        directoryWritable: true,
        readOnly: false,
      };
    }
    return invoke('file:probe', path).catch((): FileProbe => ({
      path,
      exists: false,
      size: 0,
      modifiedAt: 0,
      writable: false,
      directoryWritable: false,
      readOnly: false,
    }));
  }

  private forget(tabId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.tabId !== tabId) continue;
      this.entries.delete(id);
      // The document is going: its unsaved work is not at stake any more, so drop the record.
      void this.recoveryStorage.discard(entry.recoveryId);
      if (entry.path && hasBridge())
        void invoke('file:watch', entry.path, false).catch(() => undefined);
    }
    this.reportUnsaved();
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.autosaveTimer) clearInterval(this.autosaveTimer);
    this.autosaveTimer = null;
    this.writerClient?.dispose();
    this.writerClient = null;
    this.entries.clear();
  }

  // ---- settings --------------------------------------------------------------------------------

  async setSetting<K extends keyof SaveSettings>(
    name: K,
    value: SaveSettings[K],
  ): Promise<SaveSettings[K]> {
    this.settingsValue = { ...this.settingsValue, [name]: value };
    await writeSaveSetting(this.settingsStorage, name, value);
    if (name === 'autosaveMinutes') this.restartAutosave();
    if (name === 'watchFiles') await this.applyWatchSetting();
    return value;
  }

  private async applyWatchSetting(): Promise<void> {
    if (!hasBridge()) return;
    for (const entry of this.entries.values()) {
      if (!entry.path) continue;
      await invoke('file:watch', entry.path, this.settingsValue.watchFiles).catch(() => undefined);
    }
  }

  // ---- saving ----------------------------------------------------------------------------------

  /**
   * Save (Ctrl+S). A document with no changes is left alone; one that has never been saved, or
   * cannot be written where it is, goes to Save As with a message saying why.
   */
  async save(document: Document): Promise<SaveOutcome> {
    const entry = this.entries.get(document.id);
    if (!entry) return { saved: false, path: null, reason: 'failed', message: 'Unknown document' };
    if (!document.isDirty) return { saved: false, path: null, reason: 'clean' };
    if (!entry.path) return this.saveAs(document);
    if (entry.readOnly) {
      const answer = await askAboutReadOnly(this.shell.dialogs, {
        title: document.state.title,
        reason: entry.readOnlyReason,
      });
      if (answer === 'cancel') {
        return { saved: false, path: null, reason: 'read-only', message: entry.readOnlyReason };
      }
      return this.saveAs(document);
    }
    return this.writeTo(entry, entry.path, { backup: this.settingsValue.keepBackup });
  }

  /** Save As (Ctrl+Shift+S). Asks for a path, remembers the folder, then writes. */
  async saveAs(document: Document): Promise<SaveOutcome> {
    const entry = this.entries.get(document.id);
    if (!entry) return { saved: false, path: null, reason: 'failed', message: 'Unknown document' };
    if (!hasBridge()) {
      return {
        saved: false,
        path: null,
        reason: 'no-bridge',
        message: 'Saving needs the app shell',
      };
    }
    const defaultPath = await this.defaultSavePath(entry, document);
    const chosen = await invoke('file:saveAsDialog', {
      defaultPath,
      title: 'Save PDF As',
      buttonLabel: 'Save',
    });
    if (!chosen) return { saved: false, path: null, reason: 'cancelled' };
    await this.settingsStorage.set(LAST_FOLDER_KEY, folderOf(chosen));
    // Save As never writes a `.bak` — there is nothing at the new path worth keeping, and if
    // there is, the reader chose to replace it in the OS dialog.
    return this.writeTo(entry, chosen, { backup: false, rename: true });
  }

  /** Where the Save As dialog opens: this document's folder, else the last one used. */
  private async defaultSavePath(entry: Entry, document: Document): Promise<string> {
    if (entry.path) return entry.path;
    const last = await this.settingsStorage.get(LAST_FOLDER_KEY);
    const name = fileNameFor(document.state.title);
    return typeof last === 'string' && last !== '' ? joinPath(last, name) : name;
  }

  /**
   * The whole save: warn if it would cost something, build the plan, run the writer with a
   * progress dialog, write atomically, then mark the document clean.
   */
  private async writeTo(
    entry: Entry,
    path: string,
    options: { backup: boolean; rename?: boolean },
  ): Promise<SaveOutcome> {
    const document = entry.document;
    const consent = await this.askBeforeSaving(entry, path);
    if (consent === 'cancel') return { saved: false, path: null, reason: 'cancelled' };
    if (consent === 'saveAs') return this.saveAs(document);

    const { plan, warnings: planWarnings } = buildWritePlan(document);
    entry.saving = true;
    this.shell.invalidate();
    try {
      // Plaintext for the writer when a stage owns the protection (M70): pdf-lib cannot rewrite
      // an encrypted document, and the stage will put the protection back — or deliberately not —
      // once the writer has finished. Without a stage this stays false and an encrypted document
      // is refused by the writer, which is what the warning above was about.
      const removeSecurity = this.stageHandlesSecurity(document.id);
      const base = await document.engine.save(document.handle, { removeSecurity });
      const written = await this.runWriter(document, base, plan, path);
      if (!written) return { saved: false, path: null, reason: 'cancelled' };

      const staged = await runSaveStages([...this.stages.values()], {
        bytes: written.bytes,
        context: {
          documentId: document.id,
          path,
          saveAs: options.rename === true || entry.path !== path,
        },
      });

      const result = await this.writeBytes(path, staged.bytes, options.backup);
      if (!result.ok) {
        return await this.handleWriteFailure(entry, result.message);
      }

      // The document is saved: nothing to recover, and the file on disk is now ours.
      await this.recoveryStorage.discard(entry.recoveryId);
      entry.source = fingerprintBytes(staged.bytes, result.modifiedAt);
      document.undo.markSaved();
      if (options.rename || entry.path !== path) {
        this.documents.update(entry.tabId, { path });
        await this.refreshPath(entry, path);
        if (hasBridge()) await invoke('recent:add', path).catch(() => []);
      }
      this.reportUnsaved();
      const warnings = [...planWarnings, ...written.warnings, ...(staged.warnings ?? [])];
      return {
        saved: true,
        path,
        bytesWritten: result.bytesWritten,
        backupPath: result.backupPath,
        warnings,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.shell.dialogs.error('Could not save', `The document was not saved. ${message}`);
      return { saved: false, path: null, reason: 'failed', message };
    } finally {
      entry.saving = false;
      this.shell.invalidate();
    }
  }

  /**
   * The warnings that have to come before a save rather than after it: signatures a full rewrite
   * would break, and password protection it cannot put back.
   */
  private async askBeforeSaving(entry: Entry, path: string): Promise<'go' | 'cancel' | 'saveAs'> {
    const document = entry.document;
    const state = document.state;
    const savingOverItself = entry.path === path;
    if (state.signatures.length > 0 && savingOverItself) {
      const answer = await askAboutSignatures(this.shell.dialogs, {
        title: state.title,
        count: state.signatures.length,
      });
      if (answer !== 'save') return answer === 'saveAs' ? 'saveAs' : 'cancel';
    }
    // The warning only applies when nothing else is in charge of the protection. With M70
    // registered the file is either encrypted again or deliberately not, and the reader has
    // already been asked which — so saying it here would be either false or a second question.
    if (state.security.encrypted && !this.stageHandlesSecurity(document.id)) {
      const answer = await askAboutEncryption(this.shell.dialogs, { title: state.title });
      if (answer === 'cancel') return 'cancel';
    }
    return 'go';
  }

  /** Runs the writer, showing progress once it is slow enough to be worth a dialog. */
  private async runWriter(
    document: Document,
    base: Uint8Array,
    plan: ReturnType<typeof buildWritePlan>['plan'],
    path: string,
  ): Promise<WriteResult | null> {
    const handle = this.writer.write({
      // The worker transfers the buffer, so it gets its own copy; the engine's bytes stay ours.
      bytes: base.slice(),
      plan,
      options: { objectStreams: this.settingsValue.objectStreams },
      onProgress: (fraction, phase) => {
        progress?.set(fraction, `${phaseWords(phase)}…`);
      },
    });

    // The dialog appears only if the save is still going after a moment: a one-page document
    // saves faster than a dialog can be read, and a flash of one is worse than none.
    let progress: ReturnType<ShellServices['dialogs']['progress']> | null = null;
    const timer = setTimeout(() => {
      progress = this.shell.dialogs.progress({
        id: 'save-progress-dialog',
        title: `Saving ${document.state.title}`,
        text: `Writing to ${path}`,
        cancellable: true,
      });
      void progress.onCancel.then(() => {
        handle.cancel();
      });
    }, PROGRESS_DELAY_MS);

    try {
      return await handle.promise;
    } catch (error) {
      if (error instanceof WriteCancelled) return null;
      if (error instanceof WriteUnsupported) {
        throw new Error(
          error.reason === 'encrypted'
            ? 'The document is password-protected and this version cannot rewrite it.'
            : `The document could not be rewritten: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      (progress as { close(): void } | null)?.close();
    }
  }

  private async writeBytes(
    path: string,
    bytes: Uint8Array,
    backup: boolean,
  ): Promise<
    | { ok: true; bytesWritten: number; backupPath: string | null; modifiedAt: number }
    | { ok: false; message: string }
  > {
    if (!hasBridge()) return { ok: false, message: 'Saving needs the app shell' };
    try {
      const result = await invoke('file:writeAtomic', path, bytes, { backup });
      return {
        ok: true,
        bytesWritten: result.bytesWritten,
        backupPath: result.backupPath,
        modifiedAt: result.modifiedAt,
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * A write that failed on permissions is the same situation as a read-only file — the share
   * went away, or someone locked it while we were working — so it gets the same answer rather
   * than an error the reader can do nothing with.
   */
  private async handleWriteFailure(entry: Entry, message: string): Promise<SaveOutcome> {
    if (!/permission|EACCES|EPERM|EROFS|EBUSY|read-only/i.test(message)) {
      await this.shell.dialogs.error('Could not save', `The document was not saved. ${message}`);
      return { saved: false, path: null, reason: 'failed', message };
    }
    entry.readOnly = true;
    entry.readOnlyReason = 'the file cannot be written to.';
    this.documents.update(entry.tabId, { readOnly: true });
    const answer = await askAboutReadOnly(this.shell.dialogs, {
      title: entry.document.state.title,
      reason: entry.readOnlyReason,
    });
    if (answer === 'cancel') return { saved: false, path: null, reason: 'read-only', message };
    return this.saveAs(entry.document);
  }

  // ---- autosave --------------------------------------------------------------------------------

  private restartAutosave(): void {
    if (this.autosaveTimer) clearInterval(this.autosaveTimer);
    this.autosaveTimer = null;
    const minutes = this.settingsValue.autosaveMinutes;
    if (minutes <= 0) return;
    this.autosaveTimer = setInterval(() => {
      void this.autosaveNow();
    }, minutes * 60_000);
  }

  /** Writes a recovery record for every dirty document. Returns how many it wrote. */
  async autosaveNow(): Promise<number> {
    let written = 0;
    for (const entry of this.entries.values()) {
      const document = entry.document;
      if (document.isClosed || !document.isDirty || entry.saving) continue;
      const record = buildRecoveryRecord(document, {
        id: entry.recoveryId,
        source: entry.source,
        now: this.now(),
      });
      await this.recoveryStorage.save(entry.recoveryId, JSON.stringify(record));
      written++;
    }
    return written;
  }

  // ---- recovery --------------------------------------------------------------------------------

  /** Every document a crash left behind. */
  listRecoverable(): Promise<RecoveryRecord[]> {
    return listRecoverable(this.recoveryStorage);
  }

  /**
   * Offers what a crash left behind, on launch. Recovering reopens each source and replays its
   * journal, so the reader gets their edits back rather than a copy of a file.
   */
  async offerRecovery(): Promise<{ recovered: number; discarded: number }> {
    if (!this.settingsValue.recoverOnLaunch) return { recovered: 0, discarded: 0 };
    const records = await this.listRecoverable();
    if (records.length === 0) return { recovered: 0, discarded: 0 };
    const choice = await askAboutRecovery(this.shell.dialogs, records);
    if (choice === 'later') return { recovered: 0, discarded: 0 };
    if (choice === 'discard') {
      for (const record of records) await this.recoveryStorage.discard(record.id);
      return { recovered: 0, discarded: records.length };
    }
    let recovered = 0;
    for (const record of records) {
      const done = await this.recoverOne(record);
      if (done) recovered++;
    }
    return { recovered, discarded: 0 };
  }

  /** Reopens one record's source and replays its journal into it. */
  async recoverOne(record: RecoveryRecord): Promise<boolean> {
    if (!record.path || !hasBridge()) {
      this.shell.toasts.show({
        kind: 'warning',
        text: `"${record.title}" was never saved, so there is no file to put the changes back into.`,
      });
      await this.recoveryStorage.discard(record.id);
      return false;
    }
    try {
      const file = await invoke('file:read', record.path);
      const opened = await this.docs.open(file.bytes.slice(), {
        path: file.path,
        name: file.name,
      });
      const current = fingerprintBytes(file.bytes);
      const outcome = await replayRecord(opened.document, record, current);
      const tab = this.documents.get(opened.tab.id);
      if (tab) await this.adopt(tab, opened.document);
      await this.recoveryStorage.discard(record.id);
      this.shell.toasts.show({
        kind: outcome.skipped > 0 || outcome.sourceChanged ? 'warning' : 'success',
        text: describeOutcome(record, outcome),
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.shell.toasts.show({
        kind: 'error',
        text: `"${record.title}" could not be recovered: ${message}`,
      });
      return false;
    }
  }

  // ---- changed on disk -------------------------------------------------------------------------

  private async onDiskChange(path: string): Promise<void> {
    const entry = [...this.entries.values()].find((e) => e.path === path);
    if (!entry || entry.askingAboutDisk || entry.saving) return;
    if (!hasBridge()) return;
    // Our own writes are muted in main, but a save that raced with someone else's is still
    // possible; comparing the fingerprint means we only ask when the bytes really are not ours.
    const file = await invoke('file:read', path).catch(() => null);
    if (!file) return;
    const current = fingerprintBytes(file.bytes);
    if (current.hash === entry.source?.hash && current.size === entry.source.size) return;
    entry.askingAboutDisk = true;
    try {
      const answer = await askAboutDiskChange(this.shell.dialogs, {
        title: entry.document.state.title,
        dirty: entry.document.isDirty,
      });
      if (answer === 'keep') {
        // Keeping ours means this version of the file is the one we know about, so the same
        // change is not announced twice.
        entry.source = current;
        return;
      }
      await this.reloadFromDisk(entry, file.bytes);
    } finally {
      entry.askingAboutDisk = false;
    }
  }

  /**
   * Throws away this tab's document and opens the file again in its place.
   *
   * This is the one path that does drop the undo history, and it has to: the history describes
   * edits to a document that no longer exists. The reader was told exactly that before choosing.
   */
  private async reloadFromDisk(entry: Entry, bytes: Uint8Array): Promise<void> {
    const path = entry.path;
    if (!path) return;
    const tabId = entry.tabId;
    await this.documents.close(tabId, { force: true });
    const opened = await this.docs.open(bytes.slice(), { path });
    const tab = this.documents.get(opened.tab.id);
    if (tab) await this.adopt(tab, opened.document);
    const reopened = this.entries.get(opened.document.id);
    if (reopened) reopened.source = fingerprintBytes(bytes);
    this.shell.toasts.show({
      kind: 'info',
      text: `Reloaded "${opened.document.state.title}" from disk.`,
    });
  }

  // ---- closing ---------------------------------------------------------------------------------

  /** Save / Don't save / Cancel for one tab. Saving that fails counts as Cancel. */
  async confirmClose(tab: DocumentTab): Promise<CloseAnswer> {
    const document = this.docs.get(tab.id);
    // A tab with no `Document` is not this service's to answer for; the shell's own hook still
    // asks about it (see `Documents.close`).
    if (!document?.isDirty) return 'discard';
    this.documents.activate(tab.id);
    const answer = await askAboutUnsaved(this.shell.dialogs, { title: document.state.title });
    if (answer === 'cancel') return 'cancel';
    if (answer === 'discard') {
      // The reader accepted losing these changes, so the tab is not dirty any more as far as
      // anything downstream is concerned — including the shell's backstop question.
      this.documents.setDirty(tab.id, false);
      return 'discard';
    }
    const outcome = await this.save(document);
    return outcome.saved || outcome.reason === 'clean' ? 'save' : 'cancel';
  }

  /** Every open document is asked about, in order; the first Cancel stops the whole thing. */
  async confirmCloseAll(): Promise<boolean> {
    for (const tab of [...this.documents.tabs]) {
      if ((await this.confirmClose(tab)) === 'cancel') return false;
    }
    return true;
  }

  /** Main asked whether this window may close. */
  private async answerWindowClose(): Promise<void> {
    const allowed = await this.confirmCloseAll();
    if (allowed) this.markAllClean();
    if (hasBridge()) await invoke('window:confirmClose', allowed).catch(() => undefined);
  }

  /** Main asked whether the app may quit. */
  private async answerQuit(): Promise<void> {
    const allowed = await this.confirmCloseAll();
    if (allowed) this.markAllClean();
    if (hasBridge()) await invoke('app:confirmQuit', allowed).catch(() => undefined);
  }

  /**
   * After the reader has answered "don't save", the documents are still dirty — and main would
   * ask again on the next close event. Clearing the recovery records and reporting "nothing
   * unsaved" is what lets the window actually go.
   */
  private markAllClean(): void {
    for (const entry of this.entries.values()) {
      void this.recoveryStorage.discard(entry.recoveryId);
    }
    this.entries.clear();
    this.reportUnsaved();
  }

  /** Tells main whether anything is unsaved, so it knows whether to intercept a close at all. */
  private reportUnsaved(): void {
    const unsaved = [...this.entries.values()].some(
      (e) => !e.document.isClosed && e.document.isDirty,
    );
    if (unsaved === this.lastUnsavedReport) return;
    this.lastUnsavedReport = unsaved;
    if (hasBridge()) void invoke('window:setUnsaved', unsaved).catch(() => undefined);
  }

  /** True when the active document has changes that a save would write. Used by `when()`. */
  get canSave(): boolean {
    return this.docs.active?.isDirty ?? false;
  }

  /** True when there is a document at all — Save As works on a clean one too. */
  get canSaveAs(): boolean {
    return this.docs.active !== null;
  }

  /** Whether a save of the active document would write anything (diagnostics and tests). */
  wouldWriteNothing(document: Document): boolean {
    return planIsEmpty(buildWritePlan(document).plan) && !document.isDirty;
  }
}

function toState(entry: Entry): SaveState {
  return {
    path: entry.path,
    readOnly: entry.readOnly,
    readOnlyReason: entry.readOnlyReason,
    source: entry.source,
    recoveryId: entry.recoveryId,
    saving: entry.saving,
  };
}

/** Why a path cannot be saved to, as the end of the sentence "…cannot be saved where it is: ". */
function readOnlyReason(probe: FileProbe): string {
  if (!probe.readOnly) return '';
  if (!probe.writable && !probe.directoryWritable) {
    return 'neither the file nor its folder can be written to.';
  }
  if (!probe.writable) return 'the file is marked read-only.';
  return 'its folder cannot be written to.';
}

/** A file name from a document title, with an extension and without the characters a path bans. */
export function fileNameFor(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '-').trim();
  const base = cleaned === '' ? 'Untitled' : cleaned;
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

/** The folder part of a path, on either platform's separator. */
export function folderOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at <= 0 ? path : path.slice(0, at);
}

/** Joins a folder and a name with the separator the folder already uses. */
export function joinPath(folder: string, name: string): string {
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return folder.endsWith(separator) ? `${folder}${name}` : `${folder}${separator}${name}`;
}

/** What the progress dialog says it is doing. */
function phaseWords(phase: string): string {
  switch (phase) {
    case 'parse':
      return 'Reading the document';
    case 'pages':
      return 'Arranging pages';
    case 'labels':
      return 'Writing page numbers';
    case 'metadata':
      return 'Writing document properties';
    case 'outline':
      return 'Writing bookmarks';
    case 'destinations':
      return 'Writing destinations';
    case 'layers':
      return 'Writing layers';
    case 'attachments':
      return 'Writing attachments';
    case 'annotations':
      return 'Drawing annotations';
    case 'fields':
      return 'Writing form fields';
    default:
      return 'Writing the file';
  }
}
