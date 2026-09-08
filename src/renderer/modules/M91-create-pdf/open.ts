/**
 * Opening a created document (M91): the bytes go through `DocumentService.open` exactly as a
 * file's would — so M11 gives the tab a viewport and M21 adopts it — with no path, and then the
 * undo stack is marked unsaved so `Ctrl+S` and the close question both treat it as work the
 * reader has not kept yet (ADR 0011).
 */

import type { DocumentTab } from '@app/tabs/Documents';
import type { Document } from '@core/Document';
import type { Registry } from '@core/Registry';
import {
  DOCUMENT_SERVICE,
  type DocumentService,
} from '@modules/M20-document-model/DocumentService';
import { VIEWER_SERVICE, type ViewerService } from '@modules/M11-viewer/ViewerService';

export interface OpenedCreated {
  readonly tab: DocumentTab;
  readonly document: Document;
}

export async function openCreatedDocument(
  registry: Registry,
  bytes: Uint8Array,
  title: string,
): Promise<OpenedCreated> {
  const docs = registry.service<DocumentService>(DOCUMENT_SERVICE);
  const opened = await docs.open(bytes, { name: `${title}.pdf`, title });
  if (registry.hasService(VIEWER_SERVICE)) {
    await registry.service<ViewerService>(VIEWER_SERVICE).attach(opened.tab, opened.document);
  }
  opened.document.undo.markUnsaved();
  return opened;
}
