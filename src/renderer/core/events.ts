/**
 * Fine-grained document change events (M20, ADR 0007).
 *
 * The store already tells subscribers *that* the document changed. These events say *what*
 * changed and *which* entity, so a thumbnail strip repaints one thumbnail, a comments panel
 * moves one row, and a page overlay redraws one annotation instead of everything.
 *
 * Events fire after the store notification for the same change, so a handler that reads
 * `document.state` sees the new state. They are synchronous: a handler that throws is logged
 * and the remaining handlers still run, because one broken panel must not stop the others from
 * updating.
 *
 * Every type here is emitted by something in M20. A module that adds a kind of change adds its
 * event type in the same commit — a declared type nobody fires is a panel that silently never
 * updates, which is worse than no event at all.
 */

import type { ModelId } from './Ids';
import type { PageBoxName, WriteIntent } from './model';

/** What about a page changed. */
export type PageChange = 'rotation' | 'boxes' | 'label' | 'objects';

/** Every document event, discriminated by `type`. */
export type DocumentEvent =
  | { readonly type: 'page:added'; readonly pageId: ModelId; readonly index: number }
  | { readonly type: 'page:removed'; readonly pageId: ModelId; readonly index: number }
  | {
      readonly type: 'page:moved';
      readonly pageId: ModelId;
      readonly from: number;
      readonly to: number;
    }
  | {
      readonly type: 'page:changed';
      readonly pageId: ModelId;
      readonly what: PageChange;
      /** Set when `what` is `'boxes'`. */
      readonly box?: PageBoxName;
    }
  | {
      readonly type: 'annotation:added';
      readonly annotationId: ModelId;
      readonly pageId: ModelId;
    }
  | {
      readonly type: 'annotation:changed';
      readonly annotationId: ModelId;
      readonly pageId: ModelId;
    }
  | {
      readonly type: 'annotation:removed';
      readonly annotationId: ModelId;
      readonly pageId: ModelId;
    }
  | { readonly type: 'field:changed'; readonly fieldId: ModelId; readonly name: string }
  | { readonly type: 'outline:changed' }
  | { readonly type: 'layer:changed'; readonly layerId: ModelId }
  | { readonly type: 'metadata:changed' }
  | { readonly type: 'custom:changed'; readonly namespace: string }
  | { readonly type: 'writeIntent:added'; readonly intent: WriteIntent }
  | { readonly type: 'document:revision'; readonly revision: number };

export type DocumentEventType = DocumentEvent['type'];

/** A handler for one event type, receiving the narrowed event. */
export type DocumentEventHandler<T extends DocumentEventType> = (
  event: Extract<DocumentEvent, { type: T }>,
) => void;

export type AnyDocumentEventHandler = (event: DocumentEvent) => void;

export type Unsubscribe = () => void;

/** Typed synchronous emitter. One per document. */
export class DocumentEvents {
  private readonly byType = new Map<DocumentEventType, Set<(e: DocumentEvent) => void>>();
  private readonly any = new Set<AnyDocumentEventHandler>();

  /** Subscribes to one event type. */
  on<T extends DocumentEventType>(type: T, handler: DocumentEventHandler<T>): Unsubscribe {
    let set = this.byType.get(type);
    if (!set) {
      set = new Set();
      this.byType.set(type, set);
    }
    const fn = handler as (e: DocumentEvent) => void;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /** Subscribes to every event. */
  onAny(handler: AnyDocumentEventHandler): Unsubscribe {
    this.any.add(handler);
    return () => {
      this.any.delete(handler);
    };
  }

  /** Fires an event. A throwing handler is logged; the rest still run. */
  emit(event: DocumentEvent): void {
    const set = this.byType.get(event.type);
    if (set) {
      for (const h of Array.from(set)) safely(h, event);
    }
    for (const h of Array.from(this.any)) safely(h, event);
  }

  /** Number of live subscriptions (leak checks in tests). */
  get listenerCount(): number {
    let n = this.any.size;
    for (const set of this.byType.values()) n += set.size;
    return n;
  }

  /** Drops every subscription. Called when the document closes. */
  clear(): void {
    this.byType.clear();
    this.any.clear();
  }
}

function safely(handler: (e: DocumentEvent) => void, event: DocumentEvent): void {
  try {
    handler(event);
  } catch (error) {
    console.error(`document event ${event.type}: handler threw`, error);
  }
}
