/**
 * The page-object edit state (M50, ADR 0018) — what the module keeps in
 * `Document.custom('M50')`, and the pure functions over it.
 *
 * Per page there is a **live list**: one entry per object the engine currently holds, in the
 * engine's z-order, so `live[i]` *is* engine index `i`. A baseline entry remembers which object
 * of the original content it is and what has been done to it (a composed transform, a style); a
 * pasted entry carries the one-page PDF it came from and where it was put. The page's original
 * content stream, PDFium's object kinds for it and the text matrices are captured before the
 * first edit, because that is what the writer replays onto (see `plannedObjectsFor`).
 *
 * Everything here is JSON: it goes into the recovery file and comes back with undo intact.
 */

import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import type { PageObject } from '@engine/PdfEngine';
import type { PlannedObjectEdit, PlannedObjects } from '@engine/Writer';
import type { ObjectStyle, PdfMatrix } from '@shared/pdf';

export const OBJECTS_NAMESPACE = 'M50';

/** One object the engine holds, by its position in the page's current z-order. */
export type LiveObject =
  | {
      readonly kind: 'base';
      /** `b<index in the original content>`, stable for the life of the document. */
      readonly id: string;
      /** Index in the original content stream (what the writer edits). */
      readonly index: number;
      /** Every transform so far, composed. */
      readonly transform?: PdfMatrix;
      readonly style?: ObjectStyle;
    }
  | {
      readonly kind: 'pasted';
      /** `p<n>`. */
      readonly id: string;
      /** Base64 one-page PDF (`PdfEngine.objectAsPdf`). */
      readonly pdf: string;
      /** Where it was put, page space; later moves compose into it. */
      readonly matrix: PdfMatrix;
      /** What kind of object it was copied from, for the panel and the filter. */
      readonly from: PageObject['kind'];
    };

export interface PageEditState {
  readonly original: string;
  /** The original `/Resources` in PDF syntax, restored beside the stream (ADR 0018). */
  readonly resources: string;
  readonly kinds: ReadonlyArray<string>;
  readonly textMatrices: Readonly<Record<string, PdfMatrix>>;
  readonly live: ReadonlyArray<LiveObject>;
  /** Pasted objects so far, for the next `p<n>` id. */
  readonly pasted: number;
}

/** Groups by page id: group id → member object ids. Groups have no PDF representation. */
export type PageGroups = Readonly<Record<string, ReadonlyArray<string>>>;

export interface ObjectsState {
  readonly pages: Readonly<Record<string, PageEditState>>;
  readonly groups: Readonly<Record<string, PageGroups>>;
}

export const EMPTY_STATE: ObjectsState = { pages: {}, groups: {} };

/** The id a baseline object has before any edit state exists for its page. */
export function baseId(index: number): string {
  return `b${index}`;
}

function isMatrix(v: unknown): v is PdfMatrix {
  return Array.isArray(v) && v.length === 6 && v.every((n) => typeof n === 'number');
}

function isStyle(v: unknown): v is ObjectStyle {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    ['fillColor', 'strokeColor', 'strokeWidth'].every(
      (k) => r[k] === undefined || typeof r[k] === 'number',
    ) &&
    (r['dash'] === undefined ||
      (Array.isArray(r['dash']) && r['dash'].every((n) => typeof n === 'number')))
  );
}

function asLive(v: unknown): LiveObject | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r['id'] !== 'string') return null;
  if (r['kind'] === 'base' && typeof r['index'] === 'number') {
    return {
      kind: 'base',
      id: r['id'],
      index: r['index'],
      ...(isMatrix(r['transform']) ? { transform: r['transform'] } : {}),
      ...(isStyle(r['style']) ? { style: r['style'] } : {}),
    };
  }
  if (r['kind'] === 'pasted' && typeof r['pdf'] === 'string' && isMatrix(r['matrix'])) {
    const from = r['from'];
    return {
      kind: 'pasted',
      id: r['id'],
      pdf: r['pdf'],
      matrix: r['matrix'],
      from:
        from === 'text' || from === 'path' || from === 'image' || from === 'shading'
          ? from
          : 'form',
    };
  }
  return null;
}

function asPageState(v: unknown): PageEditState | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (
    typeof r['original'] !== 'string' ||
    !Array.isArray(r['kinds']) ||
    !Array.isArray(r['live'])
  ) {
    return null;
  }
  const textMatrices: Record<string, PdfMatrix> = {};
  if (r['textMatrices'] && typeof r['textMatrices'] === 'object') {
    for (const [k, m] of Object.entries(r['textMatrices'] as Record<string, unknown>)) {
      if (isMatrix(m)) textMatrices[k] = m;
    }
  }
  const live = r['live'].map(asLive).filter((o): o is LiveObject => o !== null);
  return {
    original: r['original'],
    resources: typeof r['resources'] === 'string' ? r['resources'] : '',
    kinds: r['kinds'].filter((k): k is string => typeof k === 'string'),
    textMatrices,
    live,
    pasted: typeof r['pasted'] === 'number' ? r['pasted'] : 0,
  };
}

/** The module's state from the custom bag, validated field by field. */
export function readObjectsState(bag: Readonly<Record<string, unknown>>): ObjectsState {
  const pages: Record<string, PageEditState> = {};
  const rawPages = bag['pages'];
  if (rawPages && typeof rawPages === 'object') {
    for (const [pageId, v] of Object.entries(rawPages as Record<string, unknown>)) {
      const s = asPageState(v);
      if (s) pages[pageId] = s;
    }
  }
  const groups: Record<string, PageGroups> = {};
  const rawGroups = bag['groups'];
  if (rawGroups && typeof rawGroups === 'object') {
    for (const [pageId, v] of Object.entries(rawGroups as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const out: Record<string, string[]> = {};
      for (const [groupId, members] of Object.entries(v as Record<string, unknown>)) {
        if (Array.isArray(members)) {
          out[groupId] = members.filter((m): m is string => typeof m === 'string');
        }
      }
      groups[pageId] = out;
    }
  }
  return { pages, groups };
}

/** The ids of the objects the engine holds, by engine index. */
export function liveIds(state: PageEditState | null, count: number): string[] {
  if (state) return state.live.map((o) => o.id);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(baseId(i));
  return ids;
}

/**
 * Whether the live order is anything other than "the original objects in their original order,
 * then the pasted ones in the order they arrived". Only that order can be replayed onto the
 * original stream; anything else was regenerated by PDFium and the writer leaves it alone
 * (ADR 0018 §3).
 */
export function isReordered(live: ReadonlyArray<LiveObject>): boolean {
  let lastBase = -1;
  let seenPasted = false;
  let lastPasted = -1;
  for (const o of live) {
    if (o.kind === 'base') {
      if (seenPasted || o.index <= lastBase) return true;
      lastBase = o.index;
    } else {
      seenPasted = true;
      const n = Number(o.id.slice(1));
      if (n <= lastPasted) return true;
      lastPasted = n;
    }
  }
  return false;
}

/** The writer's edits for a page whose order can be replayed. */
export function plannedEdits(state: PageEditState): PlannedObjectEdit[] {
  const out: PlannedObjectEdit[] = [];
  const present = new Set<number>();
  for (const o of state.live) {
    if (o.kind === 'base') {
      present.add(o.index);
      if (o.transform) out.push({ kind: 'transform', index: o.index, matrix: o.transform });
      if (o.style) out.push({ kind: 'style', index: o.index, style: o.style });
    } else {
      out.push({ kind: 'insert', pdf: o.pdf, matrix: o.matrix });
    }
  }
  state.kinds.forEach((_k, index) => {
    if (!present.has(index)) out.push({ kind: 'remove', index });
  });
  return out;
}

/**
 * What the write plan carries for a page (M21's `buildWritePlan` calls this): the original
 * stream and the replayable edits, or nothing when the page's order was rewritten by PDFium.
 * A page with edit state and no remaining edits still plans its original stream, so a full undo
 * saves the file's own bytes rather than PDFium's regeneration of them.
 */
export function plannedObjectsFor(doc: Document, pageId: ModelId): PlannedObjects | undefined {
  const state = readObjectsState(doc.custom(OBJECTS_NAMESPACE)).pages[pageId];
  if (!state || isReordered(state.live)) return undefined;
  return {
    original: state.original,
    resources: state.resources,
    kinds: state.kinds,
    textMatrices: state.textMatrices,
    edits: plannedEdits(state),
  };
}

/** The engine index of an object id in a live list, or -1. */
export function indexOfId(live: ReadonlyArray<LiveObject>, id: string): number {
  return live.findIndex((o) => o.id === id);
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
