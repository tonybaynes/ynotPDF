/**
 * M60's `Command`s: every change to a form, undoable and journalled.
 *
 * There are only four, because a form has only four kinds of change:
 *
 * - **add** a field (with its first widget), **delete** one, and their exact inverses;
 * - **update** a field wholesale — its name, role, flags, `/DA`, options, actions, and the
 *   geometry and appearance of each widget. A designer edit changes several of those at once,
 *   and a command per entry would let an undo put back a field that never existed, so the
 *   command carries the whole field before and after;
 * - **set the value**, which is what filling in a form is. M20's `SetFieldValueCommand` already
 *   does that and merges, so typing is one undo step; `FormValueCommand` here is the version for
 *   a field the designer created, which the engine has never heard of.
 * - **set a page's tab order**, which is `Document.custom` state and rides on M20's
 *   `SetCustomCommand`.
 *
 * A structural change carries the `'form'` write intent, which is what turns `WritePlan.form` on
 * and makes the writer rebuild `/AcroForm` (ADR 0019). A value change carries `'fields'` when the
 * engine could not take it, exactly as before.
 */

import type { Command, CommandJson } from '@core/Command';
import type { Document, DocumentCommand } from '@core/Document';
import type { ModelId } from '@core/Ids';
import { registerCommandCodec } from '@core/Journal';
import type { ModelField, WriteIntent } from '@core/model';

export const FORM_COMMAND_ID = {
  add: 'form.addField',
  remove: 'form.removeField',
  update: 'form.updateField',
  value: 'form.setValue',
} as const;

const STRUCTURE: ReadonlyArray<WriteIntent> = ['form'];

/** Adds a field. Undo takes it out again, parent link included. */
export class AddFieldCommand implements DocumentCommand {
  readonly id = FORM_COMMAND_ID.add;
  readonly label: string;
  readonly writeIntents = STRUCTURE;
  private readonly doc: Document;
  private readonly field: ModelField;
  private readonly index: number;

  constructor(doc: Document, field: ModelField, label = 'Add field', index?: number) {
    this.doc = doc;
    this.field = field;
    this.label = label;
    this.index = index ?? doc.state.fields.length;
  }

  do(): void {
    this.doc.insertFieldRecord(this.field, this.index);
  }

  undo(): void {
    this.doc.removeFieldRecord(this.field.id);
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { field: this.field, index: this.index, label: this.label } };
  }
}

/** Removes a field. Undo puts it back where it was. */
export class RemoveFieldCommand implements DocumentCommand {
  readonly id = FORM_COMMAND_ID.remove;
  readonly label: string;
  readonly writeIntents = STRUCTURE;
  private readonly doc: Document;
  private readonly fieldId: ModelId;
  private removed: { field: ModelField; index: number } | null = null;

  constructor(doc: Document, fieldId: ModelId, label = 'Delete field') {
    this.doc = doc;
    this.fieldId = fieldId;
    this.label = label;
  }

  do(): void {
    this.removed = this.doc.removeFieldRecord(this.fieldId);
  }

  undo(): void {
    if (this.removed) this.doc.putFieldRecord(this.removed.field, this.removed.index);
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { fieldId: this.fieldId, label: this.label } };
  }
}

/**
 * Replaces a field wholesale.
 *
 * Merging is on and keyed by the field id *and the label*, so dragging a widget across the page
 * is one undo step while a drag followed by a rename is two — the label is what the Undo menu
 * says, and two changes that would read as one entry are the two that should merge.
 */
export class UpdateFieldCommand implements DocumentCommand {
  readonly id = FORM_COMMAND_ID.update;
  readonly label: string;
  readonly writeIntents = STRUCTURE;
  readonly mergeable = true;
  private readonly doc: Document;
  private readonly fieldId: ModelId;
  private readonly next: ModelField;
  private previous: ModelField | null;

  constructor(
    doc: Document,
    next: ModelField,
    label = 'Change field',
    previous?: ModelField | null,
  ) {
    this.doc = doc;
    this.fieldId = next.id;
    this.next = next;
    this.label = label;
    this.previous = previous ?? null;
  }

  do(): void {
    this.previous ??= this.doc.field(this.fieldId);
    this.doc.updateFieldRecord(this.next);
  }

  undo(): void {
    if (this.previous) this.doc.updateFieldRecord(this.previous);
  }

  merge(next: Command): Command | null {
    if (!(next instanceof UpdateFieldCommand)) return null;
    if (next.fieldId !== this.fieldId || next.label !== this.label) return null;
    return new UpdateFieldCommand(this.doc, next.next, this.label, this.previous);
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { field: this.next, label: this.label } };
  }
}

/**
 * Sets the value of a field the engine does not have — one this session designed.
 *
 * M20's `SetFieldValueCommand` pushes the value into PDFium first, which throws for a field that
 * is not in the file. This is the same command without that step, and with the `'form'` intent
 * so the value reaches the file through the rebuild rather than through `/V` alone. Typing
 * merges, so a word is one undo.
 */
export class FormValueCommand implements DocumentCommand {
  readonly id = FORM_COMMAND_ID.value;
  readonly label = 'Change field value';
  readonly writeIntents = STRUCTURE;
  readonly mergeable = true;
  private readonly doc: Document;
  private readonly fieldId: ModelId;
  private readonly value: string;
  private before: string | undefined;

  constructor(doc: Document, fieldId: ModelId, value: string, before?: string) {
    this.doc = doc;
    this.fieldId = fieldId;
    this.value = value;
    this.before = before;
  }

  do(): void {
    const field = this.doc.field(this.fieldId);
    if (!field) return;
    this.before ??= field.value;
    this.doc.setFieldValueRecord(this.fieldId, this.value);
  }

  undo(): void {
    if (this.before !== undefined) this.doc.setFieldValueRecord(this.fieldId, this.before);
  }

  merge(next: Command): Command | null {
    if (!(next instanceof FormValueCommand) || next.fieldId !== this.fieldId) return null;
    return new FormValueCommand(this.doc, this.fieldId, next.value, this.before);
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { fieldId: this.fieldId, value: this.value } };
  }
}

/** Journal codecs, so a recovery file replays a designed form (M21). */
export function registerFormCodecs(): void {
  registerCommandCodec(FORM_COMMAND_ID.add, (doc, payload) => {
    const p = payload as Record<string, unknown>;
    const field = p['field'];
    if (!isField(field)) return null;
    return new AddFieldCommand(
      doc,
      field,
      typeof p['label'] === 'string' ? p['label'] : 'Add field',
      typeof p['index'] === 'number' ? p['index'] : undefined,
    );
  });
  registerCommandCodec(FORM_COMMAND_ID.remove, (doc, payload) => {
    const p = payload as Record<string, unknown>;
    if (typeof p['fieldId'] !== 'string') return null;
    return new RemoveFieldCommand(
      doc,
      p['fieldId'] as ModelId,
      typeof p['label'] === 'string' ? p['label'] : 'Delete field',
    );
  });
  registerCommandCodec(FORM_COMMAND_ID.update, (doc, payload) => {
    const p = payload as Record<string, unknown>;
    const field = p['field'];
    if (!isField(field)) return null;
    return new UpdateFieldCommand(
      doc,
      field,
      typeof p['label'] === 'string' ? p['label'] : 'Change field',
    );
  });
  registerCommandCodec(FORM_COMMAND_ID.value, (doc, payload) => {
    const p = payload as Record<string, unknown>;
    if (typeof p['fieldId'] !== 'string' || typeof p['value'] !== 'string') return null;
    return new FormValueCommand(doc, p['fieldId'] as ModelId, p['value']);
  });
}

/** Enough of a shape check that a corrupt recovery file cannot put nonsense in the model. */
function isField(value: unknown): value is ModelField {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Partial<ModelField>;
  return typeof f.id === 'string' && typeof f.name === 'string' && Array.isArray(f.widgets);
}
