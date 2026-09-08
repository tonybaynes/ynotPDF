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
import type { SaveStageInput, SaveStageResult, SavePipelineStage } from '@engine/Writer';
import { fromEnginePermissions, permits, reasonFor } from '@engine/security/permissions';
import {
  ALL_ALLOWED,
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
   * True when the document was opened with the *owner* password, or with a digital ID, or is not
   * protected at all — in which case `/P` does not restrict this reader.
   */
  readonly unlocked: boolean;
  /** The certificate the document was opened with, when it was. */
  readonly openedAs: string | null;
  /** True when the intent differs from what is on disk, so a save has work to do. */
  readonly pending: boolean;
}

interface Entry {
  info: SecurityInfo;
  unlocked: boolean;
  openedAs: string | null;
  secrets: Secrets;
  /**
   * True when the file this document came from was certificate-protected.
   *
   * `info` cannot record it: a certificate-protected file is decrypted before PDFium ever sees
   * it, so from the engine's side the document is plaintext — which is the truth about the *tab*
   * and a dangerous thing to believe about the *file*. Without this flag a save would quietly
   * write the document out unprotected.
   */
  wasCertificateProtected: boolean;
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
        info: doc.state.security.encrypted
          ? {
              ...UNENCRYPTED,
              encrypted: true,
              handler: 'standard',
              permissions: fromEnginePermissions(doc.state.security.permissions),
            }
          : UNENCRYPTED,
        unlocked: !doc.state.security.encrypted,
        openedAs: null,
        secrets: {},
        wasCertificateProtected: false,
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

  /** Reads the file's real security from the engine's bytes. */
  async refresh(document: Document): Promise<void> {
    const entry = this.entries.get(document.id);
    if (!entry) return;
    try {
      const bytes = await document.engine.save(document.handle);
      entry.info = await this.client.inspect(bytes);
    } catch {
      // A document the engine cannot serialise is one we can say nothing about. The model's own
      // `encrypted` flag stands, which is the conservative answer.
      return;
    }
    if (!entry.info.encrypted) entry.unlocked = true;
    this.shell.invalidate();
  }

  // ---- what the app asks -----------------------------------------------------------------------

  /** What the service knows about a document. */
  securityOf(document: Document): DocumentSecurity {
    const entry = this.entries.get(document.id);
    const intent = intentOf(document);
    const info = entry?.info ?? UNENCRYPTED;
    return {
      info,
      intent,
      unlocked: entry?.unlocked ?? !info.encrypted,
      openedAs: entry?.openedAs ?? null,
      pending: intent.kind !== 'none' || (info.encrypted && intent.kind === 'none'),
    };
  }

  /**
   * Whether the reader may do something to the active document.
   *
   * `true` for an unprotected document, `true` for one opened with the owner password or a
   * digital ID, and otherwise whatever `/P` says. This is the single question every
   * permission-aware command asks, so a command cannot accidentally consult a different rule.
   */
  allows(action: ProtectedAction, document?: Document | null): boolean {
    const doc = document ?? this.docs.active;
    if (!doc) return true;
    const entry = this.entries.get(doc.id);
    if (!entry || !entry.info.encrypted || entry.unlocked) return true;
    return permits(entry.info.permissions, action);
  }

  /** Why an action is not allowed, for a tooltip. Empty when it is allowed. */
  reasonAgainst(action: ProtectedAction, document?: Document | null): string {
    return this.allows(action, document) ? '' : reasonFor(action);
  }

  /** The permissions in force for the reader — everything, when the document is unlocked. */
  permissionsFor(document: Document): PermissionFlags {
    const entry = this.entries.get(document.id);
    if (!entry || !entry.info.encrypted || entry.unlocked) return ALL_ALLOWED;
    return entry.info.permissions;
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
    if (!entry.info.encrypted && intent.kind === 'none') {
      await this.shell.dialogs.info(
        'Not protected',
        `"${document.state.title}" has no security to remove.`,
      );
      return false;
    }
    const confirmed = await confirmRemoveSecurity(this.shell.dialogs, {
      title: document.state.title,
      info: entry.info,
    });
    if (!confirmed) return false;

    // Removing protection from a file that is protected *on disk* needs the owner password, and
    // asking for it now rather than mid-save is the difference between a question and a
    // surprise. A file whose protection was only ever an unsaved intent needs nothing.
    if (entry.info.encrypted && entry.info.handler === 'standard' && !entry.unlocked) {
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
    if (!entry.info.encrypted) return true;
    if (entry.unlocked) {
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
        entry.unlocked = true;
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
  async prepareForOpen(
    bytes: Uint8Array,
    name: string,
  ): Promise<{ bytes: Uint8Array; openedAs: string | null } | null> {
    let certificateProtected: boolean;
    try {
      certificateProtected = (await this.client.inspect(bytes)).handler === 'public-key';
    } catch {
      return { bytes, openedAs: null };
    }
    if (!certificateProtected) return { bytes, openedAs: null };
    await this.shell.dialogs.info(
      'Digital ID needed',
      `"${name}" is protected with certificates. Choose the digital ID (.p12 or .pfx) belonging to one of its recipients.`,
    );
    const opened = await this.unlockBytesWithDigitalId(bytes, name);
    // Cancelling is not a failure: no tab is left behind and no error is shown.
    return opened ? { bytes: opened.bytes, openedAs: opened.openedAs } : null;
  }

  /** Records how a document was opened, once M11 has made a tab for it. */
  noteOpenedAs(documentId: string, openedAs: string | null, permissions?: PermissionFlags): void {
    const entry = this.entries.get(documentId) ?? this.blank();
    entry.openedAs = openedAs;
    if (openedAs !== null) {
      // Opened with a digital ID, so the file it came from was certificate-protected — which the
      // engine's bytes no longer show, because they are the decrypted ones.
      entry.wasCertificateProtected = true;
      // A recipient's own envelope says what they may do, and it is not `/P` — so it is kept
      // rather than derived, and the document is *not* treated as unlocked unless it says so.
      entry.unlocked = permissions === undefined || permits(permissions, 'modify');
      if (permissions) entry.info = { ...entry.info, permissions };
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
    return entry?.info.encrypted === true && this.canReprotect(entry);
  }

  private canReprotect(entry: Entry): boolean {
    if (entry.info.handler === 'public-key') return entry.info.recipients.length > 0;
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

    const secrets = await this.secretsForSave(doc, intent, entry);
    if (secrets === null) {
      return {
        bytes: input.bytes,
        warnings: [
          'The document was saved without its password protection, because the password was not given.',
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
    if (!entry?.wasCertificateProtected || hasIntent(doc)) return [];
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
    if (!entry?.info.encrypted) return NO_SECURITY;
    if (entry.info.handler === 'public-key') {
      return entry.info.recipients.length === 0
        ? NO_SECURITY
        : {
            kind: 'certificate',
            algorithm: 'aes-256',
            scope: entry.info.metadataEncrypted ? 'all' : 'except-metadata',
            recipients: entry.info.recipients,
          };
    }
    return {
      kind: 'password',
      algorithm: entry.info.algorithm ?? 'aes-256',
      scope: entry.info.metadataEncrypted ? 'all' : 'except-metadata',
      permissions: entry.info.permissions,
      hasUserPassword: !entry.info.opensWithoutPassword,
      hasOwnerPassword: true,
    };
  }

  /**
   * The passwords for a save, asking for them when they are not in memory.
   *
   * They will not be in memory after a crash recovery, because a recovery record never held one.
   * Asking here — before the bytes are written, with the reason on screen — is the honest place;
   * the alternative is a file that quietly lost its protection.
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
    const secrets: { user?: string; owner?: string } = {};
    if (intent.hasUserPassword) {
      const user = await this.askPassword({
        title: doc.state.title,
        reason: `${preamble} Enter the password needed to open it.`,
      });
      if (user === null) return null;
      secrets.user = user;
    }
    if (intent.hasOwnerPassword) {
      const owner = await this.askPassword({
        title: doc.state.title,
        reason: `${preamble} Enter the password that controls permissions.`,
      });
      if (owner === null) return null;
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
    const bytes = await document.engine.save(document.handle);
    if (!(await this.client.isOwnerPassword(bytes, password))) return false;
    entry.secrets = { ...entry.secrets, owner: password };
    entry.unlocked = true;
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
    const viewer = this.registry.service<{
      open(f: { path: string; name: string; bytes: Uint8Array }): Promise<{ id: string } | null>;
    }>('viewer');
    const tab = await viewer.open({ path, name: file.name, bytes: opened.bytes });
    if (!tab) throw new SecurityError('failed', 'The document was unlocked but did not open.');
    const active = this.docs.active;
    if (active) this.noteOpenedAs(active.id, opened.openedAs, opened.permissions);
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
      info: UNENCRYPTED,
      unlocked: true,
      openedAs: null,
      secrets: {},
      wasCertificateProtected: false,
    };
  }
}
