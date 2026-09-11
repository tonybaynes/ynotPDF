/**
 * The undoable changes M53 makes (ADR 0020).
 *
 * There is only one decoration command, and that is the point: `SetDecorationsCommand` swaps the
 * whole list of decorations for another one and re-applies. Add, update, remove and "remove them
 * all" are the same operation with a different list, so there is one path to get right, undo is
 * exact by construction, and a batch run replays the same data.
 *
 * Links are ordinary annotations and use M20's own `AddAnnotationCommand` /
 * `UpdateAnnotationCommand` / `DeleteAnnotationCommand`; nothing new is needed for them here.
 */

import type { CommandJson } from '@core/Command';
import type { Document } from '@core/Document';
import type { DocumentCommand } from '@core/Document';
import type { WriteIntent } from '@core/model';
import { registerCommandCodec } from '@core/Journal';
import {
  DECORATIONS_NAMESPACE,
  readDecorationsState,
  type DecorationsState,
  type ModelDecoration,
} from './model';

/** What a command needs from the service: how to put the decorations on the pages. */
export interface DecorationApplier {
  /**
   * Re-draws whatever the model now says, on every page any decoration touches — plus the pages
   * named here, which is how a removed decoration's pages get cleaned up.
   */
  reapply(doc: Document, alsoPages: ReadonlyArray<number>): Promise<void>;
}

export const DECORATION_COMMAND_ID = 'decorate.set';

/**
 * Replaces the document's decorations.
 *
 * `do` and `undo` are the same code with different lists, so redo cannot drift from do. The
 * pages the *old* list covered are re-applied too: taking a watermark off pages 3–5 has to clean
 * pages 3–5, and the new list does not mention them.
 */
export class SetDecorationsCommand implements DocumentCommand {
  readonly id = DECORATION_COMMAND_ID;
  readonly label: string;
  readonly writeIntents: ReadonlyArray<WriteIntent> = ['decorations'];
  private readonly doc: Document;
  private readonly next: DecorationsState;
  private readonly applier: DecorationApplier;
  private readonly touched: ReadonlyArray<number>;
  private before: DecorationsState | null = null;

  constructor(options: {
    readonly doc: Document;
    readonly label: string;
    readonly next: DecorationsState;
    readonly applier: DecorationApplier;
    /** Pages the change affects that the new state may not mention (a removal's pages). */
    readonly touched: ReadonlyArray<number>;
  }) {
    this.doc = options.doc;
    this.label = options.label;
    this.next = options.next;
    this.applier = options.applier;
    this.touched = options.touched;
  }

  async do(): Promise<void> {
    this.before ??= readDecorationsState(this.doc.custom(DECORATIONS_NAMESPACE));
    await this.write(this.next);
  }

  async undo(): Promise<void> {
    if (this.before) await this.write(this.before);
  }

  private async write(state: DecorationsState): Promise<void> {
    this.doc.replaceCustomRecord(DECORATIONS_NAMESPACE, {
      items: state.items,
      pages: state.pages,
      seq: state.seq,
    });
    await this.applier.reapply(this.doc, this.touched);
  }

  toJSON(): CommandJson {
    return {
      id: this.id,
      data: {
        label: this.label,
        items: this.next.items,
        pages: this.next.pages,
        seq: this.next.seq,
        touched: this.touched,
      },
    };
  }
}

/**
 * Teaches the journal to replay a decoration change (M21's recovery, M120's batch).
 *
 * The applier is resolved when the codec is registered, so a replay puts the decorations back on
 * the pages rather than only into the model — a recovered document has to *look* recovered.
 */
export function registerDecorationCodec(applier: DecorationApplier): void {
  registerCommandCodec(DECORATION_COMMAND_ID, (doc, data) => {
    const d = data as {
      label?: unknown;
      items?: unknown;
      pages?: unknown;
      seq?: unknown;
      touched?: unknown;
    };
    const next = readDecorationsState({
      items: d.items,
      pages: d.pages,
      seq: d.seq,
    });
    return new SetDecorationsCommand({
      doc,
      label: typeof d.label === 'string' ? d.label : 'Change decorations',
      next,
      applier,
      touched: Array.isArray(d.touched)
        ? d.touched.filter((v): v is number => typeof v === 'number')
        : [],
    });
  });
}

/** The state with one decoration added or replaced, keeping the list's order. */
export function withDecoration(
  state: DecorationsState,
  decoration: ModelDecoration,
): DecorationsState {
  const index = state.items.findIndex((d) => d.id === decoration.id);
  const items =
    index < 0
      ? [...state.items, decoration]
      : state.items.map((d) => (d.id === decoration.id ? decoration : d));
  return { ...state, items, seq: Math.max(state.seq, nextSeq(decoration.id, state.seq)) };
}

/** The state with some decorations gone. */
export function withoutDecorations(
  state: DecorationsState,
  ids: ReadonlySet<string>,
): DecorationsState {
  return { ...state, items: state.items.filter((d) => !ids.has(d.id)) };
}

/** A fresh decoration id, and the sequence number that follows it. */
export function newDecorationId(state: DecorationsState): string {
  return `d${String(state.seq)}`;
}

function nextSeq(id: string, seq: number): number {
  const digits = /^d(\d+)$/.exec(id)?.[1];
  return digits === undefined ? seq : Number(digits) + 1;
}
