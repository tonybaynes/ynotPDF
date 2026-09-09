/**
 * M31's own `Command`: attaching a file to a page.
 *
 * Everything else the module does is an `AddAnnotationCommand`, an `UpdateAnnotationCommand`,
 * a `DeleteAnnotationCommand` or a `SetCustomCommand` from M20, grouped by `document.batch`. The
 * one thing those cannot do is put a file *into* the document: that is `PdfEngine.addAttachment`,
 * and M12's `AddAttachmentCommand` wraps it for the name tree. This one does the same for a page —
 * the record it makes carries the page's id, so the attachments panel lists the file under the
 * page it is pinned to, and the writer later moves the file's specification from the name tree
 * on to the annotation (ADR 0015).
 */

import { EngineError } from '@engine/PdfEngine';
import type { Command, CommandJson } from '@core/Command';
import type { Document, DocumentCommand } from '@core/Document';
import type { ModelId } from '@core/Ids';
import { registerCommandCodec } from '@core/Journal';
import type { ModelAttachment, WriteIntent } from '@core/model';

export const ATTACH_FILE_COMMAND_ID = 'draw.attachFile';

function isUnsupported(error: unknown): boolean {
  return error instanceof EngineError && error.code === 'not-implemented';
}

/** Engine keys of the files in the name tree, in order — what `Document.rebindAttachments` needs. */
async function engineAttachmentIds(doc: Document): Promise<string[]> {
  const list = await doc.engine.attachments(doc.handle);
  return list.filter((a) => a.page === undefined).map((a) => a.id);
}

/** Embeds a file and records it as belonging to a page. */
export class AttachFileCommand implements DocumentCommand {
  readonly id = ATTACH_FILE_COMMAND_ID;
  readonly label: string;
  private readonly doc: Document;
  private readonly pageId: ModelId;
  private readonly file: {
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly description: string | null;
    readonly mimeType: string | null;
  };
  private readonly attachmentId: ModelId;
  private intents: WriteIntent[] = [];

  constructor(
    doc: Document,
    pageId: ModelId,
    file: {
      readonly name: string;
      readonly bytes: Uint8Array;
      readonly description?: string | null;
      readonly mimeType?: string | null;
    },
    attachmentId?: ModelId,
  ) {
    this.doc = doc;
    this.pageId = pageId;
    this.file = {
      name: file.name,
      // The engine transfers the buffer into its worker, which detaches it here — so the command
      // keeps its own copy, or a redo and `toJSON()` would both be reading an empty array.
      bytes: file.bytes.slice(),
      description: file.description ?? null,
      mimeType: file.mimeType ?? null,
    };
    this.label = `Attach ${file.name}`;
    this.attachmentId = attachmentId ?? doc.ids.next('attachment');
  }

  get newId(): ModelId {
    return this.attachmentId;
  }

  get writeIntents(): ReadonlyArray<WriteIntent> {
    return this.intents;
  }

  async do(): Promise<void> {
    const added = await this.doc.engine.addAttachment(this.doc.handle, {
      name: this.file.name,
      bytes: this.file.bytes.slice(),
      ...(this.file.description === null ? {} : { description: this.file.description }),
      ...(this.file.mimeType === null ? {} : { mimeType: this.file.mimeType }),
      modified: new Date().toISOString(),
    });
    const record: ModelAttachment = {
      id: this.attachmentId,
      engineId: added.id,
      name: added.name,
      description: added.description ?? this.file.description,
      mimeType: added.mimeType ?? this.file.mimeType,
      size: added.size ?? this.file.bytes.length,
      modified: added.modified ?? null,
      created: added.created ?? null,
      collectionFields: added.collectionFields ?? {},
      pageId: this.pageId,
    };
    this.doc.putAttachmentRecord(record);
    this.doc.idTable.bind('attachment', this.attachmentId, added.id);
    this.doc.rebindAttachments(await engineAttachmentIds(this.doc));
    this.intents = ['attachments', 'annotations'];
  }

  async undo(): Promise<void> {
    const record = this.doc.attachment(this.attachmentId);
    if (!record) return;
    try {
      await this.doc.engine.deleteAttachment(this.doc.handle, record.engineId);
    } catch (error) {
      if (!isUnsupported(error)) throw error;
    }
    this.doc.removeAttachmentRecord(this.attachmentId);
    this.doc.rebindAttachments(await engineAttachmentIds(this.doc));
  }

  merge(_next: Command): Command | null {
    return null;
  }

  toJSON(): CommandJson {
    // The bytes travel as an array of numbers: a journal entry has to be JSON, and a recovery
    // that could not restore an attached file would be a recovery that lost work.
    return {
      id: this.id,
      data: {
        pageId: this.pageId,
        name: this.file.name,
        bytes: Array.from(this.file.bytes),
        description: this.file.description,
        mimeType: this.file.mimeType,
        attachmentId: this.attachmentId,
      },
    };
  }
}

let registered = false;

/** Registers the journal codec, so a recovery file replays an attachment. Idempotent. */
export function registerDrawingCodecs(): void {
  if (registered) return;
  registered = true;
  registerCommandCodec(ATTACH_FILE_COMMAND_ID, (doc, payload) => {
    if (!payload || typeof payload !== 'object') return null;
    const d = payload as Record<string, unknown>;
    const bytes = d['bytes'];
    if (
      typeof d['pageId'] !== 'string' ||
      typeof d['name'] !== 'string' ||
      !Array.isArray(bytes) ||
      typeof d['attachmentId'] !== 'string'
    ) {
      return null;
    }
    doc.ids.reserve(d['attachmentId'] as ModelId);
    return new AttachFileCommand(
      doc,
      d['pageId'] as ModelId,
      {
        name: d['name'],
        bytes: Uint8Array.from(bytes.filter((n): n is number => typeof n === 'number')),
        description: typeof d['description'] === 'string' ? d['description'] : null,
        mimeType: typeof d['mimeType'] === 'string' ? d['mimeType'] : null,
      },
      d['attachmentId'] as ModelId,
    );
  });
}
