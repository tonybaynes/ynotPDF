/**
 * `security.*` settings (M70).
 *
 * Deliberately few. Security is a per-document decision, not a preference, and a default that
 * silently protected every file would be worse than no default at all. What is here is the two
 * things a reader might reasonably want the same way every time — which algorithm the dialog
 * starts on, and whether protecting a document should be offered when saving a copy — plus the
 * one that keeps the operator's own workflow honest.
 */

import type { SettingsSchema } from '@shared/module';
import type { EncryptionAlgorithm } from '@engine/security/types';

export interface SecuritySettings {
  /** The algorithm the Protect dialog starts on. */
  readonly defaultAlgorithm: EncryptionAlgorithm;
  /**
   * Whether a document opened with only the user password has its `/P` flags enforced.
   *
   * On by default and the honest behaviour: a file that says "no printing" should not print.
   * Turning it off is a deliberate act by someone who owns the document and finds the
   * restrictions in their own way — which is a legitimate position, and the reason this is a
   * setting rather than a hard rule.
   */
  readonly enforcePermissions: boolean;
  /** Warn before saving a document whose protection would be weaker than AES-256. */
  readonly warnOnWeakAlgorithm: boolean;
}

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  defaultAlgorithm: 'aes-256',
  enforcePermissions: true,
  warnOnWeakAlgorithm: true,
};

export const SECURITY_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'security',
  properties: {
    defaultAlgorithm: {
      type: 'enum',
      title: 'Default encryption',
      default: 'aes-256',
      options: [
        { value: 'aes-256', label: '256-bit AES' },
        { value: 'aes-128', label: '128-bit AES' },
        { value: 'rc4-128', label: '128-bit RC4 (compatibility)' },
        { value: 'rc4-40', label: '40-bit RC4 (compatibility)' },
      ],
    },
    enforcePermissions: {
      type: 'boolean',
      title: 'Respect a document’s permission restrictions',
      default: true,
    },
    warnOnWeakAlgorithm: {
      type: 'boolean',
      title: 'Warn before using an outdated encryption method',
      default: true,
    },
  },
};
