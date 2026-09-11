/**
 * `SecurityService` — everything the reader can do to a document's protection, and everything the
 * app has to remember about it (M70).
 *
 * It owns: the Protect dialog and the intent it produces, the save-pipeline stage that actually
 * encrypts, the passwords held for the session, opening a certificate-protected file with a
 * `.p12`, unlocking a restricted document with its owner password, and the answer to "may the
 * reader do this?" that every permission-aware command asks.
 *
 * Registered as the service `"security"`.
 *
 * **Where the passwords are.** In `this.secrets`, a private `Map` keyed by document id, and
 * nowhere else — not in the store, not in a `toJSON`, not in a recovery record, not in a log
 * line. The model carries a `SecurityIntent`, which says *that* there is an open password without
 * saying what it is. After a crash the intent replays and {@link SecurityService.secretsFor} finds
 * nothing, so the save asks for the password again with the reason on screen. That is the whole
 * of the design, and it is why a `console.log` of any document state cannot leak one (ADR 0012).
 */

import type { ShellServices } from '@app/services';
import type { Documents } from '@app/tabs/Documents';
import type { Document } from '@core/Document';
import type { Registry } from '@core/Registry';
import { WriteCancelled } from '@engine/Writer';
import type { SaveStageInput, SaveStageResult, SavePipelineStage } from '@engine/Writer';
import { fromEnginePermissions, permits, reasonFor } from '@engine/security/permissions';
import {
  ALL_ALLOWED,
  NONE_ALLOWED,
  NO_SECURITY,
  SecurityError,
  UNENCRYPTED,
  type EncryptionAlgorithm,
  type EncryptionScope,
  type PermissionFlags,
  type ProtectedAction,
  type RecipientSummary,
  type SecurityInfo,
  type SecurityIntent,
  type Secrets,
} from '@engine/security/types';

import type { Security } from '@engine/security/Security';
import { DOCUMENT_SERVICE } from '@modules/M20-document-model/DocumentService';
import type { DocumentService } from '@modules/M20-document-model/DocumentService';
import { SAVE_SERVICE } from '@modules/M21-save/SaveService';
import type { SaveService } from '@modules/M21-save/SaveService';
import { hasBridge, invoke } from '@shared/ipc';
import { SetSecurityCommand } from './commands';
import {
  askAboutSecurity,
  askForDigitalIdPassword,
  askForPassword,
  confirmRemoveSecurity,
  showSecurityProperties,
} from './dialogs';
import { describeIntent, hasIntent, intentOf } from './intent';
import { SecurityClient } from './SecurityClient';

export const SECURITY_SERVICE = 'security';

/** Narrowings used only by `applyIntentDirectly`, where the arguments arrive as plain strings. */
type PasswordAlgorithm = EncryptionAlgorithm;
type PasswordScope = EncryptionScope;

/** The pipeline stage's id and its place in the order. Encryption is last, and should stay last. */
export const ENCRYPT_STAGE = 'M70.encrypt';
export const ENCRYPT_STAGE_ORDER = 100;

/** What the service knows about one open document. */
export interface DocumentSecurity {
  /** What the file on disk actually says. */
  readonly info: SecurityInfo;
  /** What it should become on the next save. */
  readonly intent: SecurityIntent;
  /**
   * True for owner-password authority or an unprotected source. A recipient's individual
   * rights never grant owner authority, even when that recipient may modify the document.
   */
  readonly unlocked: boolean;
  readonly authority: 'none' | 'user' | 'owner' | 'recipient';
  /** The certificate the document was opened with, when it was. */
  readonly openedAs: string | null;
  /** True when the intent differs from what is on disk, so a save has work to do. */
  readonly pending: boolean;
}

interface Entry {
  sourcePolicy: SecurityInfo;
  engineInfo: SecurityInfo;
  sourceCaptured: boolean;
  authority: DocumentSecurity['authority'];
  openedAs: string | null;
  secrets: Secrets;
}

/** M11 carries this result intact until the document is registered, before exposing its tab. */
export interface PreparedSecurityOpen {
  readonly bytes: Uint8Array;
  readonly openedAs: string | null;
  readonly sourceInfo?: SecurityInfo;
  readonly permissions?: PermissionFlags;
}

export interface SecurityServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
  /** Injected by tests so the identical code runs without a Worker. */
  readonly client?: SecurityClient;
  readonly local?: Security;
  /**
   * How a password is asked for. The default opens the dialog; a test supplies its own, because
   * the interesting behaviour — that a save with no password in memory *asks* rather than
   * quietly dropping the protection — should be testable without a DOM.
   */
  readonly askPassword?: (options: {
    readonly title: string;
    readonly reason: string;
    readonly retry?: boolean;
  }) => Promise<string | null>;
}

export class SecurityService {
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly documents: Documents;
  private clientValue: SecurityClient | null;
  private readonly local: Security | null;
  private readonly askPassword: NonNullable<SecurityServiceOptions['askPassword']>;
  private readonly entries = new Map<string, Entry>();
  private readonly disposers: Array<() => void> = [];

  constructor(options: SecurityServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.documents = options.shell.documents;
    this.clientValue = options.client ?? null;
    this.local = options.local ?? null;
    this.askPassword = options.askPassword ?? ((ask) => askForPassword(this.shell.dialogs, ask));
  }

  /**
   * The worker, spawned the first time something actually needs it.
   *
   * qpdf is 1.3 MB of WebAssembly and node-forge is most of another megabyte. A window that only
   * ever reads unprotected documents should not pay for either at startup, and this is the same
   * reasoning M21 applies to its writer.
   */
  private get client(): SecurityClient {
    this.clientValue ??= SecurityClient.spawn(this.local ?? undefined);
    return this.clientValue;
  }

  private get docs(): DocumentService {
    return this.registry.service<DocumentService>(DOCUMENT_SERVICE);
  }

  private get saves(): SaveService | null {
    return this.registry.hasService(SAVE_SERVICE)
      ? this.registry.service<SaveService>(SAVE_SERVICE)
      : null;
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  /** Installs the save stage and adopts whatever is already open. Called once from `activate`. */
  load(): void {
    const saves = this.saves;
    if (saves) this.disposers.push(saves.addStage(this.stage()));
    this.adoptOpenDocuments();
    this.disposers.push(
      this.documents.onAttached(() => {
        this.adoptOpenDocuments();
      }),
    );
  }

  dispose(): void {
    for (const stop of this.disposers.splice(0)) stop();
    this.entries.clear();
    this.clientValue?.dispose();
    this.clientValue = null;
  }

  private adoptOpenDocuments(): void {
    for (const doc of this.docs.all()) {
      if (this.entries.has(doc.id)) continue;
      this.entries.set(doc.id, {
        // The model already knows whether the file was encrypted, from PDFium; the full picture
        // arrives when `refresh` has asked the worker. Starting from the model rather than from
        // "unencrypted" means a protected document never briefly looks open.
        sourcePolicy: doc.state.security.encrypted
          ? {
              ...UNENCRYPTED,
              encrypted: true,
              handler: 'standard',
              permissions: fromEnginePermissions(doc.state.security.permissions),
            }
          : UNENCRYPTED,
        engineInfo: UNENCRYPTED,
        sourceCaptured: false,
        authority: doc.state.security.encrypted ? 'user' : 'none',
        openedAs: null,
        secrets: {},
      });
      void this.refresh(doc);
    }
    for (const id of [...this.entries.keys()]) {
      if (!this.docs.all().some((d) => d.id === id)) this.forget(id);
    }
  }

  /**
   * Forgets everything about a document, passwords first.
   *
   * Called when a tab closes. The passwords go even though the map entry would be dropped
   * anyway, because "the secrets are cleared when the document closes" should be a line of code
   * somebody can point at, not a consequence of garbage collection.
   */
  forget(documentId: string): void {
    const entry = this.entries.get(documentId);
    if (entry) entry.secrets = {};
    this.entries.delete(documentId);
  }

  /** Refreshes working-byte information without replacing a captured source policy. */
  async refresh(document: Document): Promise<void> {
    const entry = this.entries.get(document.id);
    if (!entry) return;
    try {
      const bytes = await document.engine.save(document.handle);
      entry.engineInfo = await this.client.inspect(bytes);
      // Direct model opens (without M11) have only PDFium's initial policy. Enrich it once,
      // but never downgrade a protected source because a working copy is now plaintext.
      // Check after await: M11 may have installed a recipient policy while this was pending.
      if (!entry.sourceCaptured) {
        if (entry.engineInfo.encrypted || !entry.sourcePolicy.encrypted) {
          entry.sourcePolicy = entry.engineInfo;
          entry.authority = entry.sourcePolicy.encrypted ? 'user' : 'none';
        }
        entry.sourceCaptured = true;
      }
    } catch {
      // A document the engine cannot serialise is one we can say nothing about. The model's own
      // `encrypted` flag stands, which is the conservative answer.
      return;
    }
    this.shell.invalidate();
  }

  // ---- what the app asks -----------------------------------------------------------------------

  /** What the service knows about a document. */
  securityOf(document: Document): DocumentSecurity {
    const entry = this.entries.get(document.id);
    const intent = intentOf(document);
    const info = entry?.sourcePolicy ?? UNENCRYPTED;
    return {
      info,
      intent,
      unlocked: !info.encrypted || entry?.authority === 'owner',
      authority: entry?.authority ?? 'none',
      openedAs: entry?.openedAs ?? null,
      pending: intent.kind !== 'none' || (info.encrypted && intent.kind === 'none'),
    };
  }

  /**
   * Whether the reader may do something to the active document.
   *
   * `true` for an unprotected document or verified owner-password authority, and otherwise the
   * source or recipient permissions. This is the question every
   * permission-aware command asks, so a command cannot accidentally consult a different rule.
   */
  allows(action: ProtectedAction, document?: Document | null): boolean {
    const doc = document ?? this.docs.active;
    if (!doc) return true;
    const entry = this.entries.get(doc.id);
    if (!entry || !entry.sourcePolicy.encrypted || entry.authority === 'owner') return true;
    return permits(entry.sourcePolicy.permissions, action);
  }

  /** Why an action is not allowed, for a tooltip. Empty when it is allowed. */
  reasonAgainst(action: ProtectedAction, document?: Document | null): string {
    const doc = document ?? this.docs.active;
    const recipient = doc && this.entries.get(doc.id)?.sourcePolicy.handler === 'public-key';
    return this.allows(action, doc) ? '' : reasonFor(action, recipient ? 'recipient' : 'password');
  }

  /** The permissions in force for the reader — everything, when the document is unlocked. */
  permissionsFor(document: Document): PermissionFlags {
    const entry = this.entries.get(document.id);
    if (!entry || !entry.sourcePolicy.encrypted || entry.authority === 'owner') return ALL_ALLOWED;
    return entry.sourcePolicy.permissions;
  }

  // ---- the commands ------------------------------------------------------------------------------

  /**
   * Opens the Protect dialog and records what it produced as an undoable command.
   *
   * Nothing is written here. The intent goes on the model, the passwords into the private map,
   * and the file changes the next time it is saved — which is what the dialog says, and what lets
   * Undo mean something.
   */
  async protect(document: Document): Promise<SecurityIntent | null> {
    const entry = this.ensure(document);
    const result = await askAboutSecurity({
      dialogs: this.shell.dialogs,
      title: document.state.title,
      intent: intentOf(document),
      secrets: entry.secrets,
      addRecipients: () => this.pickRecipients(),
    });
    if (!result) return null;
    const command = new SetSecurityCommand(document, result.intent, result.secrets, entry.secrets);
    await document.apply(command);
    entry.secrets = result.secrets;
    this.shell.toasts.show({
      kind: 'info',
      text: `${describeIntent(result.intent)} — applied when you save.`,
    });
    this.shell.invalidate();
    return result.intent;
  }

  /** Takes protection off, after saying what that costs. Undoable; applied on the next save. */
  async removeSecurity(document: Document): Promise<boolean> {
    const entry = this.ensure(document);
    const intent = intentOf(document);
    if (!entry.sourcePolicy.encrypted && intent.kind === 'none') {
      await this.shell.dialogs.info(
        'Not protected',
        `"${document.state.title}" has no security to remove.`,
      );
      return false;
    }
    const confirmed = await confirmRemoveSecurity(this.shell.dialogs, {
      title: document.state.title,
      info: entry.sourcePolicy,
    });
    if (!confirmed) return false;

    // Removing protection from a file that is protected *on disk* needs the owner password, and
    // asking for it now rather than mid-save is the difference between a question and a
    // surprise. A file whose protection was only ever an unsaved intent needs nothing.
    if (
      entry.sourcePolicy.encrypted &&
      entry.sourcePolicy.handler === 'standard' &&
      entry.authority !== 'owner'
    ) {
      const password = await this.askAndVerify(document, {
        reason: 'Removing protection needs the password that controls permissions.',
      });
      if (password === null) return false;
    }
    await document.apply(new SetSecurityCommand(document, NO_SECURITY, {}, entry.secrets));
    entry.secrets = {};
    this.shell.invalidate();
    return true;
  }

  /**
   * Unlocks a restricted document for this session with its owner password.
   *
   * The permissions in the file do not change — this is not "remove security". What changes is
   * that the app stops enforcing them, which is what an owner password is for and what every
   * other viewer does.
   */
  async unlock(document: Document): Promise<boolean> {
    const entry = this.ensure(document);
    if (entry.sourcePolicy.handler === 'public-key') return false;
    if (!entry.sourcePolicy.encrypted) return true;
    if (entry.authority === 'owner') {
      await this.shell.dialogs.info(
        'Already unlocked',
        `"${document.state.title}" is already open with full permissions.`,
      );
      return true;
    }
    const password = await this.askAndVerify(document, {
      reason: 'The owner password lifts the restrictions on printing, copying and editing.',
    });
    if (password === null) return false;
    this.shell.toasts.show({
      kind: 'success',
      text: 'Document unlocked for this session.',
    });
    this.shell.invalidate();
    return true;
  }

  /**
   * Asks for a password, checks it against the file, and remembers it when it is right.
   *
   * Loops on a wrong password with a worded retry rather than a red field, and returns `null`
   * when the reader cancels — which is not a failure and produces no error.
   */
  private async askAndVerify(
    document: Document,
    options: { readonly reason: string },
  ): Promise<string | null> {
    const entry = this.ensure(document);
    if (entry.sourcePolicy.handler !== 'standard') return null;
    const bytes = await document.engine.save(document.handle);
    for (let attempt = 0; ; attempt++) {
      const password = await this.askPassword({
        title: document.state.title,
        reason: options.reason,
        ...(attempt > 0 ? { retry: true } : {}),
      });
      if (password === null) return null;
      if (await this.client.isOwnerPassword(bytes, password)) {
        entry.secrets = { ...entry.secrets, owner: password };
        entry.authority = 'owner';
        return password;
      }
    }
  }

  // ---- certificates ------------------------------------------------------------------------------

  /** Opens the certificate picker and reads whatever the reader chose. */
  async pickRecipients(): Promise<ReadonlyArray<RecipientSummary>> {
    if (!hasBridge()) return [];
    const files = await invoke('file:pickFile', 'certificate', {
      title: 'Choose certificates for the people who may open this document',
      multiple: true,
    });
    const out: RecipientSummary[] = [];
    for (const file of files) {
      try {
        const certificates = await this.client.readCertificates(file.bytes, file.name);
        for (const cert of certificates) {
          out.push({
            id: `${cert.serial}-${String(out.length)}`,
            name: cert.name,
            issuer: cert.issuer,
            serial: cert.serial,
            validFrom: cert.validFrom,
            validTo: cert.validTo,
            certificateBase64: cert.certificateBase64,
            permissions: ALL_ALLOWED,
          });
          if (cert.expired) {
            this.shell.toasts.show({
              kind: 'warning',
              text: `${cert.name}'s certificate has expired. It will still encrypt, but their software may refuse it.`,
            });
          }
        }
      } catch (error) {
        await this.shell.dialogs.error(
          'Certificate not read',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return out;
  }

  /**
   * The whole digital-ID flow over a set of bytes: choose the file, ask for its password, retry
   * on a wrong one, and say plainly when the key is simply not one of the recipients.
   */
  async unlockBytesWithDigitalId(
    bytes: Uint8Array,
    title: string,
  ): Promise<{ bytes: Uint8Array; permissions: PermissionFlags; openedAs: string } | null> {
    if (!hasBridge()) return null;
    const files = await invoke('file:pickFile', 'digital-id', {
      title: `Choose the digital ID that can open "${title}"`,
    });
    const file = files[0];
    if (!file) return null;
    for (let attempt = 0; ; attempt++) {
      const password = await askForDigitalIdPassword(this.shell.dialogs, {
        fileName: file.name,
        ...(attempt > 0 ? { retry: true } : {}),
      });
      if (password === null) return null;
      try {
        const result = await this.client.unlock(bytes, file.bytes, password);
        return { bytes: result.bytes, permissions: result.permissions, openedAs: result.openedAs };
      } catch (error) {
        if (error instanceof SecurityError && error.code === 'bad-key-file') continue;
        await this.shell.dialogs.error(
          'Could not open the document',
          error instanceof Error ? error.message : String(error),
        );
        return null;
      }
    }
  }

  /**
   * The hook M11 calls before handing bytes to the engine.
   *
   * PDFium cannot open a certificate-protected file at all — it knows only the standard security
   * handler — so this is where such a document is decrypted, with the reader's `.p12`, before the
   * engine ever sees it. Everything else passes straight through untouched.
   */
  async prepareForOpen(bytes: Uint8Array, name: string): Promise<PreparedSecurityOpen | null> {
    let sourceInfo: SecurityInfo;
    try {
      sourceInfo = await this.client.inspect(bytes);
    } catch {
      return { bytes, openedAs: null };
    }
    if (sourceInfo.handler !== 'public-key') return { bytes, openedAs: null, sourceInfo };
    await this.shell.dialogs.info(
      'Digital ID needed',
      `"${name}" is protected with certificates. Choose the digital ID (.p12 or .pfx) belonging to one of its recipients.`,
    );
    const opened = await this.unlockBytesWithDigitalId(bytes, name);
    // Cancelling is not a failure: no tab is left behind and no error is shown.
    return opened ? { ...opened, sourceInfo } : null;
  }

  /** Installed before tab attachment, so listeners and commands never see unrestricted plaintext. */
  noteSource(document: Document, prepared: PreparedSecurityOpen): void {
    const entry = this.ensure(document);
    if (prepared.sourceInfo) {
      entry.sourcePolicy =
        !prepared.sourceInfo.encrypted && document.state.security.encrypted
          ? {
              ...prepared.sourceInfo,
              encrypted: true,
              handler: 'standard',
              permissions: fromEnginePermissions(document.state.security.permissions),
            }
          : prepared.sourceInfo;
      entry.sourceCaptured = true;
      entry.authority = entry.sourcePolicy.encrypted ? 'user' : 'none';
    }
    if (prepared.openedAs !== null) {
      this.noteOpenedAs(document.id, prepared.openedAs, prepared.permissions);
    }
  }

  /** Records how a document was opened, once M11 has made a tab for it. */
  noteOpenedAs(documentId: string, openedAs: string | null, permissions?: PermissionFlags): void {
    const entry = this.entries.get(documentId) ?? this.blank();
    entry.openedAs = openedAs;
    if (openedAs !== null) {
      // Opened with a digital ID, so the file it came from was certificate-protected — which the
      // engine's bytes no longer show, because they are the decrypted ones.
      // A recipient's own envelope says what they may do, and it is not `/P` — so it is kept
      // rather than derived. Even unrestricted recipient permissions are not owner authority.
      entry.authority = 'recipient';
      entry.sourceCaptured = true;
      entry.sourcePolicy = {
        ...entry.sourcePolicy,
        encrypted: true,
        handler: 'public-key',
        opensWithoutPassword: false,
        rawPermissions: null,
        permissions: { ...(permissions ?? NONE_ALLOWED) },
      };
    }
    this.entries.set(documentId, entry);
    this.shell.invalidate();
  }

  // ---- the save stage ------------------------------------------------------------------------------

  /**
   * The pipeline stage M21 runs over the writer's output.
   *
   * By the time this runs the writer has produced an unencrypted document — PDFium decrypts on
   * the way out and pdf-lib cannot write ciphertext — so this is the only place the file is
   * protected, and it happens before a single byte reaches the disk.
   */
  stage(): SavePipelineStage {
    return {
      id: ENCRYPT_STAGE,
      order: ENCRYPT_STAGE_ORDER,
      handlesSecurity: (documentId) => this.entries.has(documentId),
      run: (input) => this.runStage(input),
    };
  }

  /**
   * Whether the next save of this document will produce a protected file.
   *
   * Not the same question as {@link SavePipelineStage.handlesSecurity}, which asks who is in
   * charge. This one is used by the status item and the tests, where what matters is the outcome.
   */
  willProtect(documentId: string): boolean {
    const doc = this.docs.all().find((d) => d.id === documentId);
    if (!doc) return false;
    // An explicit intent wins, including one that says "no security": Remove Security has to mean
    // what it says, and `{ kind: 'none' }` recorded on the document is not the same thing as no
    // intent at all.
    if (hasIntent(doc)) return intentOf(doc).kind !== 'none';
    // Nothing was asked for, but the file on disk is protected: the save keeps it that way, using
    // the passwords held for the session.
    const entry = this.entries.get(documentId);
    return entry?.sourcePolicy.encrypted === true && this.canReprotect(entry);
  }

  private canReprotect(entry: Entry): boolean {
    if (entry.sourcePolicy.handler === 'public-key') return false;
    return entry.secrets.user !== undefined || entry.secrets.owner !== undefined;
  }

  private async runStage(input: SaveStageInput): Promise<SaveStageResult> {
    const doc = this.docs.all().find((d) => d.id === input.context.documentId);
    if (!doc) return { bytes: input.bytes };
    const entry = this.entries.get(doc.id);
    const intent = this.intentForSave(doc, entry);
    if (intent.kind === 'none') {
      return { bytes: input.bytes, warnings: this.certificateWarning(doc, entry) };
    }

    // `secretsForSave` throws `WriteCancelled` when the reader cancels a password prompt, which
    // stops the save before any bytes reach the disk. `null` is the other thing entirely: an
    // intent that names no password at all, so there is nothing to protect the file with and
    // nobody was asked anything.
    const secrets = await this.secretsForSave(doc, intent, entry);
    if (secrets === null) {
      return {
        bytes: input.bytes,
        warnings: [
          'The document was saved without protection: its security settings name no password.',
        ],
      };
    }
    const result = await this.client.protect(input.bytes, intent, secrets);
    return { bytes: result.bytes, warnings: result.warnings };
  }

  /**
   * The one thing a save cannot put back, said in words rather than left to be discovered.
   *
   * A public-key file names its recipients by issuer and serial number inside sealed envelopes; it
   * does not carry their certificates. Nothing can encrypt to a certificate it does not have, so a
   * document opened with a digital ID and saved without being protected again comes out in the
   * clear — and the reader has to be told that, before they send the file to someone.
   */
  private certificateWarning(doc: Document, entry: Entry | undefined): string[] {
    if (entry?.sourcePolicy.handler !== 'public-key' || hasIntent(doc)) return [];
    return [
      'This document was protected with certificates, and the saved copy is not: a protected file ' +
        'names its recipients but does not contain their certificates, so the protection cannot be ' +
        'put back on its own. Use Protect to choose the recipients again.',
    ];
  }

  /**
   * What the file being written should be protected with.
   *
   * An explicit intent wins. Otherwise a document that was *opened* protected keeps what it had —
   * which is what a reader expects from "save" and what M21 could not do on its own.
   */
  private intentForSave(doc: Document, entry: Entry | undefined): SecurityIntent {
    // `hasIntent` rather than a truthiness check on the kind: a document the reader asked to
    // *unprotect* carries `{ kind: 'none' }`, and treating that as "nothing was asked for" would
    // put the protection straight back on — which is the one thing Remove Security must not do.
    if (hasIntent(doc)) return intentOf(doc);
    if (!entry?.sourcePolicy.encrypted) return NO_SECURITY;
    if (entry.sourcePolicy.handler === 'public-key') {
      // Source envelopes identify recipients but contain no certificates to encrypt to.
      // An explicit certificate intent above supplies those; otherwise the warning gates Save.
      return NO_SECURITY;
    }
    return {
      kind: 'password',
      algorithm: entry.sourcePolicy.algorithm ?? 'aes-256',
      scope: entry.sourcePolicy.metadataEncrypted ? 'all' : 'except-metadata',
      permissions: entry.sourcePolicy.permissions,
      hasUserPassword: !entry.sourcePolicy.opensWithoutPassword,
      hasOwnerPassword: true,
    };
  }

  /**
   * The passwords for a save, asking for them when they are not in memory.
   *
   * They will not be in memory after a crash recovery, because a recovery record never held one.
   * Asking here — before the bytes are written, with the reason on screen — is the honest place;
   * the alternative is a file that quietly lost its protection.
   *
   * Cancelling one of those prompts throws `WriteCancelled`, which stops the save. It used to
   * return null and let the save write the document in the clear, on the reasoning that losing
   * the reader's edits would be worse. That reasoning was wrong: nothing is lost by stopping,
   * because the edits stay in the model and the recovery record stays on disk — while the file
   * written in the clear was a real loss, and a silent one (Codex audit finding 1, 2026-09-11).
   * Cancelling a question is not an instruction to remove the protection.
   *
   * Null is kept for the one case that is not a cancellation: an intent naming no password at
   * all, where there is nothing to ask for and nothing to protect the file with.
   */
  private async secretsForSave(
    doc: Document,
    intent: SecurityIntent,
    entry: Entry | undefined,
  ): Promise<Secrets | null> {
    if (intent.kind !== 'password') return {};
    const held = entry?.secrets ?? {};
    if (held.user !== undefined || held.owner !== undefined) return held;

    // One prompt per password the intent says the document has, each naming which one it wants.
    // Asking once and guessing where the answer belongs would produce a file protected differently
    // from the one the reader set up, which is worse than asking twice.
    const preamble =
      'This document is protected, and its passwords are not held in this session — they are never saved to disk.';
    const cancelled = new WriteCancelled(
      'The document was not saved, and its password protection is unchanged.',
    );
    const secrets: { user?: string; owner?: string } = {};
    if (intent.hasUserPassword) {
      const user = await this.askPassword({
        title: doc.state.title,
        reason: `${preamble} Enter the password needed to open it.`,
      });
      if (user === null) throw cancelled;
      secrets.user = user;
    }
    if (intent.hasOwnerPassword) {
      const owner = await this.askPassword({
        title: doc.state.title,
        reason: `${preamble} Enter the password that controls permissions.`,
      });
      // The answer already given is deliberately *not* kept. It is tempting to save the reader
      // retyping it, but `secrets` is only written back once both prompts are answered, and the
      // check at the top of this method treats any held password as the complete set — so half an
      // answer left behind would make the next save protect the file with the open password and
      // silently without the permissions one. Asking twice is a small cost; a file protected
      // differently from the way the reader set it up is not.
      if (owner === null) throw cancelled;
      secrets.owner = owner;
    }
    if (secrets.user === undefined && secrets.owner === undefined) return null;
    if (entry) entry.secrets = secrets;
    return secrets;
  }

  // ---- properties ----------------------------------------------------------------------------------

  /** The Security tab, as its own dialog until M72 exists to host it. */
  showProperties(document: Document): void {
    const state = this.securityOf(document);
    showSecurityProperties(this.shell.dialogs, {
      title: document.state.title,
      info: state.info,
      intent: state.intent,
      openedAs: state.openedAs,
      pending: state.intent.kind !== 'none',
    });
  }

  /**
   * Verifies an owner password and unlocks the document, without the dialog.
   *
   * The dialog's own loop is `askAndVerify`; this is the same check with the password supplied,
   * so the e2e suite can drive the real unlock without typing into a `<dialog>`.
   */
  async unlockWithPassword(document: Document, password: string): Promise<boolean> {
    const entry = this.ensure(document);
    if (entry.sourcePolicy.handler !== 'standard') return false;
    const bytes = await document.engine.save(document.handle);
    if (!(await this.client.isOwnerPassword(bytes, password))) return false;
    entry.secrets = { ...entry.secrets, owner: password };
    entry.authority = 'owner';
    this.shell.invalidate();
    return true;
  }

  /**
   * Opens a certificate-protected document with a digital ID named by path, skipping only the two
   * native file dialogs.
   *
   * Those dialogs are OS windows rather than DOM ones, so Playwright cannot drive them — and a
   * certificate-protected file cannot be opened first and unlocked afterwards, because PDFium
   * cannot read one at all. Everything between the files being chosen and the tab appearing is the
   * real path: the same envelope, the same key, the same qpdf.
   */
  async openWithDigitalIdAt(
    path: string,
    p12Path: string,
    password: string,
  ): Promise<{ openedAs: string; permissions: PermissionFlags; title: string }> {
    const file = await invoke('file:read', path);
    const id = await invoke('file:read', p12Path);
    const opened = await this.client.unlock(file.bytes, id.bytes, password);
    const sourceInfo = await this.client.inspect(file.bytes);
    const viewer = this.registry.service<{
      open(
        f: { path: string; name: string; bytes: Uint8Array },
        prepared: PreparedSecurityOpen,
      ): Promise<{ id: string } | null>;
    }>('viewer');
    const tab = await viewer.open(
      { path, name: file.name, bytes: file.bytes },
      { ...opened, sourceInfo },
    );
    if (!tab) throw new SecurityError('failed', 'The document was unlocked but did not open.');
    const active = this.docs.get(tab.id);
    return {
      openedAs: opened.openedAs,
      permissions: opened.permissions,
      title: active?.state.title ?? file.name,
    };
  }

  /** qpdf's version, for the About box and the e2e suite. */
  engineVersion(): Promise<string> {
    return this.client.version();
  }

  /**
   * Applies a security intent without the dialog, from plain arguments.
   *
   * This is how the e2e suite protects a document through the running app: the dialog is proved
   * separately by driving its controls, and a test that wants to check what lands *on disk*
   * should not have to type into four password fields to get there. It goes through the same
   * `SetSecurityCommand` as the dialog, so it undoes and journals identically.
   */
  async applyIntentDirectly(
    document: Document,
    args: Readonly<Record<string, unknown>>,
  ): Promise<SecurityIntent> {
    const entry = this.ensure(document);
    const str = (key: string, fallback: string): string =>
      typeof args[key] === 'string' ? args[key] : fallback;
    const bool = (key: string, fallback: boolean): boolean =>
      typeof args[key] === 'boolean' ? args[key] : fallback;

    const kind = str('kind', 'password');
    let intent: SecurityIntent;
    if (kind === 'none') {
      intent = NO_SECURITY;
    } else if (kind === 'certificate') {
      const recipients = Array.isArray(args['recipients'])
        ? (args['recipients'] as RecipientSummary[])
        : [];
      intent = {
        kind: 'certificate',
        algorithm: 'aes-256',
        scope: str('scope', 'all') as PasswordScope,
        recipients,
      };
    } else {
      const permissions: PermissionFlags = {
        print: str('print', 'high') as PermissionFlags['print'],
        modify: str('modify', 'all') as PermissionFlags['modify'],
        copy: bool('copy', true),
        accessibility: bool('accessibility', true),
      };
      intent = {
        kind: 'password',
        algorithm: str('algorithm', 'aes-256') as PasswordAlgorithm,
        scope: str('scope', 'all') as PasswordScope,
        permissions,
        hasUserPassword: str('user', '') !== '',
        hasOwnerPassword: str('owner', '') !== '',
      };
    }
    const secrets: Secrets = {
      ...(str('user', '') === '' ? {} : { user: str('user', '') }),
      ...(str('owner', '') === '' ? {} : { owner: str('owner', '') }),
    };
    await document.apply(new SetSecurityCommand(document, intent, secrets, entry.secrets));
    entry.secrets = secrets;
    this.shell.invalidate();
    return intent;
  }

  // ---- internals -------------------------------------------------------------------------------

  private ensure(document: Document): Entry {
    let entry = this.entries.get(document.id);
    if (!entry) {
      entry = this.blank();
      this.entries.set(document.id, entry);
    }
    return entry;
  }

  private blank(): Entry {
    return {
      sourcePolicy: UNENCRYPTED,
      engineInfo: UNENCRYPTED,
      sourceCaptured: false,
      authority: 'none',
      openedAs: null,
      secrets: {},
    };
  }
}
