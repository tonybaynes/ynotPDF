/**
 * The two document commands M70 adds (M70).
 *
 * Changing a document's security is a change to the document, so it goes through the undo stack
 * like everything else: setting protection, changing a permission, adding a recipient and taking
 * protection off are all `SetSecurityCommand`, and all undo.
 *
 * **The journal never carries a password.** The command holds the passwords it was given, so undo
 * and redo work for the whole session; `toJSON` writes only the intent, which by construction has
 * no secret in it. Replaying a recovery record therefore restores the reader's settings and not
 * their passwords, and `SecurityService` asks for those again before the next save — which is the
 * only honest thing a file on disk can do (ADR 0012).
 */

import type { Command, CommandJson } from '@core/Command';
import type { Document, DocumentCommand } from '@core/Document';
import { registerCommandCodec } from '@core/Journal';
import type { WriteIntent } from '@core/model';
import { NO_SECURITY, type SecurityIntent, type Secrets } from '@engine/security/types';
import { describeIntent, isIntent, restoreSlice, sliceOf, writeIntent } from './intent';

export const M70_COMMAND_ID = {
  setSecurity: 'security.set',
} as const;

/**
 * Sets — or clears — the document's security intent.
 *
 * The whole `M70` slice is captured before the change and put back on undo, so undoing the very
 * first protection leaves no empty namespace behind and undoing a later one restores exactly what
 * was there.
 *
 * The `custom` write intent is what tells M21's save that something in a module's own state
 * changed; the pipeline stage then reads the intent and encrypts.
 */
export class SetSecurityCommand implements DocumentCommand {
  readonly id = M70_COMMAND_ID.setSecurity;
  readonly label: string;
  readonly writeIntents: ReadonlyArray<WriteIntent> = ['custom'];

  private readonly doc: Document;
  private readonly next: SecurityIntent;
  private readonly before: Readonly<Record<string, unknown>>;
  /** Held in memory for undo and redo, and deliberately absent from `toJSON`. */
  readonly secrets: Secrets;
  /** The secrets that were in force before, so undo puts those back too. */
  readonly previousSecrets: Secrets;

  constructor(
    doc: Document,
    next: SecurityIntent,
    secrets: Secrets = {},
    previousSecrets: Secrets = {},
  ) {
    this.doc = doc;
    this.next = next;
    this.secrets = secrets;
    this.previousSecrets = previousSecrets;
    this.before = sliceOf(doc);
    this.label =
      next.kind === 'none'
        ? 'Remove security'
        : `Set security: ${describeIntent(next).toLowerCase()}`;
  }

  /** What the document's intent was before this command ran. */
  get previousIntent(): SecurityIntent {
    const raw = this.before['intent'];
    return isIntent(raw) ? raw : NO_SECURITY;
  }

  get intent(): SecurityIntent {
    return this.next;
  }

  do(): Promise<void> {
    writeIntent(this.doc, this.next);
    return Promise.resolve();
  }

  undo(): Promise<void> {
    restoreSlice(this.doc, this.before);
    return Promise.resolve();
  }

  toJSON(): CommandJson {
    // The intent only. `Secrets` is not a field of it and never becomes one.
    return { id: this.id, data: { intent: this.next } };
  }
}

/**
 * Removing security is the same command with `{ kind: 'none' }`, and exists as its own name
 * because "Undo Remove security" reads better than "Undo Set security: no security".
 */
export function removeSecurityCommand(doc: Document): SetSecurityCommand {
  return new SetSecurityCommand(doc, NO_SECURITY);
}

registerCommandCodec(M70_COMMAND_ID.setSecurity, (doc, payload): Command | null => {
  const intent = (payload as { intent?: unknown } | null)?.intent;
  // A replayed intent has been on disk as JSON, so it is checked rather than trusted: an entry we
  // do not recognise replays as nothing rather than as protection we cannot describe.
  if (!isIntent(intent)) return null;
  // No passwords: a replay comes from a file on disk, which never held any. `SecurityService`
  // asks for them again before the next save, saying why.
  return new SetSecurityCommand(doc, intent);
});
