/**
 * `SecurityClient` — how the renderer asks for security work to be done (M70, ADR 0011).
 *
 * The work happens in the **main process**: qpdf is 1.3 MB of WebAssembly that this build will
 * only load from a URL, and every URL a `file://` renderer can offer it takes the renderer process
 * down with it. Main is a Node environment where the module reads its own `.wasm` off disk, so it
 * simply works — and it is where M120's batch runs and M121's command line will want it anyway.
 * See `src/main/security.ts`.
 *
 * This class is therefore a thin wrapper over the typed `security:*` IPC channels, with one
 * addition that matters: when there is no bridge — a unit test in Node — the identical `Security`
 * runs in-process, so what the tests exercise is what ships.
 */

import type { Security } from '@engine/security/Security';
import { loadCertificates } from '@engine/security/pubsec/certificates';
import { toBase64 } from '@engine/security/pubsec/crypto';
import {
  SecurityError,
  type PermissionFlags,
  type SecurityInfo,
  type SecurityIntent,
  type Secrets,
} from '@engine/security/types';
import { hasBridge, invoke } from '@shared/ipc';

/** A certificate as the recipient list shows it, without its bytes crossing back and forth. */
export interface CertificateSummary {
  readonly name: string;
  readonly issuer: string;
  readonly serial: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly expired: boolean;
  /** Base64 DER, so the caller can build a `Recipient` without a second trip. */
  readonly certificateBase64: string;
}

export interface ProtectReply {
  readonly bytes: Uint8Array;
  readonly warnings: ReadonlyArray<string>;
}

export interface UnlockReply {
  readonly bytes: Uint8Array;
  readonly permissions: PermissionFlags;
  readonly openedAs: string;
}

export class SecurityClient {
  /** Set only when there is no IPC bridge: the same `Security`, on this thread. */
  private readonly local: Security | null;

  /**
   * The client the app uses, or one backed by `local` when there is no bridge.
   *
   * `local` is how a unit test supplies a `Security` built from the wasm on disk; the app never
   * passes one, so the app always goes through main.
   */
  static spawn(local?: Security): SecurityClient {
    return new SecurityClient(local ?? null);
  }

  constructor(local: Security | null = null) {
    this.local = local;
  }

  /** True when the work happens in another process rather than on this thread. */
  get offThread(): boolean {
    return hasBridge();
  }

  /**
   * The `Security` to run against when there is no bridge.
   *
   * A window with neither a bridge nor an injected `Security` cannot do this work at all, and says
   * so in a sentence rather than failing on an undefined property.
   */
  private get here(): Security {
    if (!this.local) {
      throw new SecurityError('failed', 'Document security is not available in this window.');
    }
    return this.local;
  }

  /** What a file's protection is. */
  async inspect(bytes: Uint8Array): Promise<SecurityInfo> {
    if (!hasBridge()) return this.here.inspect(bytes);
    return (await invoke('security:inspect', bytes)) as unknown as SecurityInfo;
  }

  /** Whether `password` is this file's owner password. */
  isOwnerPassword(bytes: Uint8Array, password: string): Promise<boolean> {
    if (!hasBridge()) return this.here.isOwnerPassword(bytes, password);
    return invoke('security:isOwnerPassword', bytes, password);
  }

  async protect(
    bytes: Uint8Array,
    intent: SecurityIntent,
    secrets: Secrets,
  ): Promise<ProtectReply> {
    if (!hasBridge()) {
      const result = await this.here.protect(bytes, intent, secrets);
      return { bytes: result.bytes, warnings: [...result.warnings] };
    }
    return invoke('security:protect', bytes, intent, { ...secrets });
  }

  async remove(bytes: Uint8Array, password: string): Promise<ProtectReply> {
    if (!hasBridge()) {
      const result = await this.here.remove(bytes, password);
      return { bytes: result.bytes, warnings: [...result.warnings] };
    }
    return invoke('security:remove', bytes, password);
  }

  async unlock(bytes: Uint8Array, p12: Uint8Array, password: string): Promise<UnlockReply> {
    if (!hasBridge()) return this.here.unlockWithDigitalId(bytes, p12, password);
    return (await invoke('security:unlock', bytes, p12, password)) as unknown as UnlockReply;
  }

  async readCertificates(
    bytes: Uint8Array,
    fileName: string,
  ): Promise<ReadonlyArray<CertificateSummary>> {
    if (!hasBridge()) {
      return loadCertificates(bytes, fileName).map((cert) => ({
        name: cert.name,
        issuer: cert.issuer,
        serial: cert.serial,
        validFrom: cert.validFrom,
        validTo: cert.validTo,
        expired: cert.expired,
        certificateBase64: toBase64(cert.der),
      }));
    }
    return invoke('security:readCertificates', bytes, fileName);
  }

  /** qpdf's version, for the About box and the e2e suite. */
  version(): Promise<string> {
    if (!hasBridge()) return this.here.version();
    return invoke('security:version');
  }

  dispose(): void {
    // Nothing to tear down: main owns the qpdf instance and outlives every window.
  }
}
