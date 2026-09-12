/** Shared interactive opening for normal Open, recovery and reload (audit 22). */
import type { Dialogs } from '@app/dialog/Dialogs';
import type { Document } from '@core/Document';
import type { Registry } from '@core/Registry';
import type { DocumentService, OpenedDocument } from '@modules/M20-document-model/DocumentService';
import type {
  PreparedSecurityOpen,
  SecurityService,
} from '@modules/M70-encryption/SecurityService';
import { openWithPassword } from './password';

export async function prepareDocumentBytes(
  registry: Registry,
  bytes: Uint8Array,
  name: string,
): Promise<PreparedSecurityOpen | null> {
  return registry.hasService('security')
    ? registry.service<SecurityService>('security').prepareForOpen(bytes, name)
    : { bytes, openedAs: null };
}
export async function openAuthenticatedDocument(options: {
  docs: DocumentService;
  registry: Registry;
  dialogs: Dialogs;
  file: { bytes: Uint8Array; path: string | null; name: string };
  prepared?: PreparedSecurityOpen;
  beforeAttach?: (document: Document) => void;
}): Promise<OpenedDocument | null> {
  const { docs, registry, dialogs, file } = options;
  const prepared =
    options.prepared ?? (await prepareDocumentBytes(registry, file.bytes, file.name));
  if (!prepared) return null;
  return openWithPassword(
    (password) =>
      docs.open(prepared.bytes.slice(), {
        path: file.path,
        name: file.name,
        ...(password === undefined ? {} : { password }),
        beforeAttach: (document) => {
          if (
            registry.hasService('security') &&
            (prepared.sourceInfo || prepared.openedAs !== null)
          )
            registry.service<SecurityService>('security').noteSource(document, prepared);
          options.beforeAttach?.(document);
        },
      }),
    { dialogs, name: file.name },
  );
}
