/**
 * The document's security *intent*, and where it lives (M70, ADR 0012).
 *
 * The model already has a place for this: M20's custom bag, one namespace per module, journalled
 * and undone with everything else. So M70 adds no field to `Document` and no contract change —
 * `document.custom('M70')` is the whole of it.
 *
 * What is *not* here is any password. `SecurityIntent` says what the protection should be and
 * whether passwords were set; the passwords themselves are held in `SecurityService`'s private
 * map and never reach the store, so the journal that autosave writes to
 * `<userData>/recovery/<id>.ynot` cannot contain one however it is inspected. After a crash the
 * intent comes back and the reader is asked for the passwords again, which is the only honest
 * thing a recovery file can do.
 */

import type { Document } from '@core/Document';
import {
  ALL_ALLOWED,
  NO_SECURITY,
  type EncryptionAlgorithm,
  type EncryptionScope,
  type PermissionFlags,
  type RecipientSummary,
  type SecurityIntent,
} from '@engine/security/types';

/** The custom-bag namespace. Must match the module id. */
export const M70 = 'M70';

/** The key inside that namespace. */
const KEY = 'intent';

/** The document's security intent, or "none" when nothing has asked for any. */
export function intentOf(document: Document): SecurityIntent {
  const raw = document.custom(M70)[KEY];
  return isIntent(raw) ? raw : NO_SECURITY;
}

/** Whether the document carries an intent at all — as against one that says "no security". */
export function hasIntent(document: Document): boolean {
  return isIntent(document.custom(M70)[KEY]);
}

/** Writes the intent. Only `SetSecurityCommand` should call this, so undo stays honest. */
export function writeIntent(document: Document, intent: SecurityIntent | undefined): void {
  if (intent === undefined) {
    document.deleteCustomRecord(M70);
    return;
  }
  document.setCustomRecord(M70, { [KEY]: intent });
}

/** The module's whole slice, for a command to put back on undo. */
export function sliceOf(document: Document): Readonly<Record<string, unknown>> {
  return { ...document.custom(M70) };
}

export function restoreSlice(document: Document, slice: Readonly<Record<string, unknown>>): void {
  if (Object.keys(slice).length === 0) {
    document.deleteCustomRecord(M70);
    return;
  }
  document.replaceCustomRecord(M70, slice);
}

/**
 * Whether a value read back out of a journal is an intent we recognise.
 *
 * A recovery record is JSON that has been on disk, so it is checked rather than trusted: a
 * malformed one is treated as no intent, which loses the reader's protection settings but cannot
 * make the app write a file with security it does not understand.
 */
export function isIntent(value: unknown): value is SecurityIntent {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'none') return true;
  if (kind === 'password') {
    const v = value as Partial<Extract<SecurityIntent, { kind: 'password' }>>;
    return (
      isAlgorithm(v.algorithm) &&
      isScope(v.scope) &&
      isPermissions(v.permissions) &&
      typeof v.hasUserPassword === 'boolean' &&
      typeof v.hasOwnerPassword === 'boolean'
    );
  }
  if (kind === 'certificate') {
    const v = value as Partial<Extract<SecurityIntent, { kind: 'certificate' }>>;
    return isScope(v.scope) && Array.isArray(v.recipients) && v.recipients.every(isRecipient);
  }
  return false;
}

function isAlgorithm(value: unknown): value is EncryptionAlgorithm {
  return value === 'aes-256' || value === 'aes-128' || value === 'rc4-128' || value === 'rc4-40';
}

function isScope(value: unknown): value is EncryptionScope {
  return value === 'all' || value === 'except-metadata' || value === 'attachments-only';
}

function isPermissions(value: unknown): value is PermissionFlags {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<PermissionFlags>;
  return (
    (v.print === 'none' || v.print === 'low' || v.print === 'high') &&
    (v.modify === 'none' ||
      v.modify === 'assemble' ||
      v.modify === 'fill-and-sign' ||
      v.modify === 'comment-fill-and-sign' ||
      v.modify === 'all') &&
    typeof v.copy === 'boolean' &&
    typeof v.accessibility === 'boolean'
  );
}

function isRecipient(value: unknown): value is RecipientSummary {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<RecipientSummary>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.certificateBase64 === 'string' &&
    v.certificateBase64 !== '' &&
    isPermissions(v.permissions)
  );
}

/** The intent a fresh Protect dialog starts from. */
export function defaultPasswordIntent(): SecurityIntent {
  return {
    kind: 'password',
    algorithm: 'aes-256',
    scope: 'all',
    permissions: ALL_ALLOWED,
    hasUserPassword: false,
    hasOwnerPassword: false,
  };
}

/** One line saying what an intent will do, for the ribbon and the status item. */
export function describeIntent(intent: SecurityIntent): string {
  switch (intent.kind) {
    case 'none':
      return 'No security';
    case 'certificate':
      return `Certificate security, ${String(intent.recipients.length)} recipient${
        intent.recipients.length === 1 ? '' : 's'
      }`;
    default: {
      const which =
        intent.hasUserPassword && intent.hasOwnerPassword
          ? 'open and permissions passwords'
          : intent.hasUserPassword
            ? 'an open password'
            : 'a permissions password';
      return `Password security with ${which}`;
    }
  }
}
