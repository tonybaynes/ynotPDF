/**
 * The decoration state (M53, ADR 0020) — what the module keeps in `Document.custom('M53')`, and
 * the pure functions over it.
 *
 * The model holds **specs, not geometry**: what the reader chose, and which pages it covers. The
 * drawing for a page is derived from that whenever it is needed, by `src/engine/decorations/`.
 * So undo is "put the previous settings back and re-apply", which is exact, small enough to
 * journal, and replays unchanged in a batch run.
 *
 * A decoration's pages are held as **model page ids**, not as the range text. The text is kept
 * beside them for the dialog to open on, but the ids are what count: a header on pages 3–5 stays
 * on the same three sheets of paper when the reader moves page 1 to the end.
 *
 * Everything here is JSON: it goes into the recovery file and comes back with undo intact.
 */

import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import type { ModelPage } from '@core/model';
import type { PlannedDecoration, PlannedDecorations, PlannedXObject } from '@engine/Writer';
import { batesFor, drawDecoration, type SourceSize } from '@engine/decorations/draw';
import {
  DEFAULT_MARGINS,
  type BatesSpec,
  type DecorationKind,
  type DecorationSpec,
  type DocumentContext,
  type HeaderFooterSpec,
  type PageContext,
  type WatermarkSpec,
} from '@engine/decorations/types';

export const DECORATIONS_NAMESPACE = 'M53';

/** One decoration as the model holds it. */
export interface ModelDecoration {
  /** `d1`, `d2`, … — the marker's `Id`, stable for the life of the decoration. */
  readonly id: string;
  readonly kind: DecorationKind;
  /** The page range as the reader typed it, so the dialog reopens on their own words. */
  readonly range: string;
  /** The pages it is on, as model ids, in document order at the time it was applied. */
  readonly pages: ReadonlyArray<ModelId>;
  readonly spec: DecorationSpec;
}

/** What was captured for one page before the first decoration went on it. */
export interface PageCapture {
  /** Base64 of the decoded content stream, as `PdfEngine.pageContent` gave it. */
  readonly original: string;
  /** The original `/Resources` in PDF syntax. */
  readonly resources: string;
}

export interface DecorationsState {
  /** In draw order: earlier entries are drawn first, so a later one sits over them. */
  readonly items: ReadonlyArray<ModelDecoration>;
  /** Per model page id, what the page's content was before we touched it. */
  readonly pages: Readonly<Record<string, PageCapture>>;
  /** The next number for a generated id, so ids never repeat in one document. */
  readonly seq: number;
}

export const EMPTY_DECORATIONS: DecorationsState = { items: [], pages: {}, seq: 1 };

// ---- reading back (a recovery record, a marker in a file someone else made) --------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function n(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function margins(value: unknown): HeaderFooterSpec['margins'] {
  if (!isRecord(value)) return DEFAULT_MARGINS;
  return {
    left: n(value['left'], DEFAULT_MARGINS.left),
    right: n(value['right'], DEFAULT_MARGINS.right),
    top: n(value['top'], DEFAULT_MARGINS.top),
    bottom: n(value['bottom'], DEFAULT_MARGINS.bottom),
  };
}

const FONTS = new Set<string>([
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
]);

function font(value: unknown): HeaderFooterSpec['font'] {
  const name = str(value);
  return FONTS.has(name) ? (name as HeaderFooterSpec['font']) : 'Helvetica';
}

const ZONE_NAMES = new Set<string>([
  'header-left',
  'header-centre',
  'header-right',
  'footer-left',
  'footer-centre',
  'footer-right',
]);

const POSITION_NAMES = new Set<string>([
  'top-left',
  'top-centre',
  'top-right',
  'middle-left',
  'centre',
  'middle-right',
  'bottom-left',
  'bottom-centre',
  'bottom-right',
]);

function readPosition(value: unknown): WatermarkSpec['position'] {
  const name = str(value);
  return POSITION_NAMES.has(name) ? (name as WatermarkSpec['position']) : 'centre';
}

function readSource(value: unknown): WatermarkSpec['source'] {
  if (!isRecord(value)) return { kind: 'text', text: '' };
  switch (value['kind']) {
    case 'image':
    case 'pdf':
      return { kind: value['kind'], key: str(value['key']) };
    case 'colour':
      return { kind: 'colour' };
    default:
      return { kind: 'text', text: str(value['text']) };
  }
}

/**
 * A spec as stored, validated. Returns null when it is not one at all — a recovery file or a
 * marker written by some future version must never stop a document opening.
 */
export function readSpec(value: unknown): DecorationSpec | null {
  if (!isRecord(value)) return null;
  switch (value['kind']) {
    case 'header-footer': {
      const zones: Record<string, string> = {};
      const raw = value['zones'];
      if (isRecord(raw)) {
        for (const [k, v] of Object.entries(raw)) {
          if (ZONE_NAMES.has(k) && typeof v === 'string') zones[k] = v;
        }
      }
      return {
        kind: 'header-footer',
        zones: zones as HeaderFooterSpec['zones'],
        font: font(value['font']),
        size: n(value['size'], 10),
        colour: n(value['colour'], 0x000000),
        margins: margins(value['margins']),
        underline: bool(value['underline'], false),
        shrink: n(value['shrink'], 0),
        startNumber: n(value['startNumber'], 1),
        totalOverride: n(value['totalOverride'], 0),
      };
    }
    case 'bates': {
      const zone = str(value['zone']);
      return {
        kind: 'bates',
        prefix: str(value['prefix']),
        suffix: str(value['suffix']),
        digits: Math.max(1, Math.min(15, Math.round(n(value['digits'], 6)))),
        startAt: Math.max(0, Math.round(n(value['startAt'], 1))),
        zone: ZONE_NAMES.has(zone) ? (zone as BatesSpec['zone']) : 'footer-right',
        font: font(value['font']),
        size: n(value['size'], 9),
        colour: n(value['colour'], 0x000000),
        margins: margins(value['margins']),
      };
    }
    case 'watermark':
    case 'background':
      return {
        kind: value['kind'],
        source: readSource(value['source']),
        font: font(value['font']),
        size: n(value['size'], 48),
        colour: n(value['colour'], 0x808080),
        rotation: n(value['rotation'], 45),
        scale: n(value['scale'], 0.6),
        position: readPosition(value['position']),
        offsetX: n(value['offsetX'], 0),
        offsetY: n(value['offsetY'], 0),
        behind: bool(value['behind'], value['kind'] === 'background'),
        print: bool(value['print'], true),
        screen: bool(value['screen'], true),
      };
    default:
      return null;
  }
}

const KINDS = new Set<string>(['header-footer', 'bates', 'watermark', 'background']);

function readDecoration(value: unknown): ModelDecoration | null {
  if (!isRecord(value)) return null;
  const spec = readSpec(value['spec']);
  const kind = str(value['kind']);
  const id = str(value['id']);
  if (!spec || !KINDS.has(kind) || id === '') return null;
  const pages = Array.isArray(value['pages'])
    ? value['pages'].filter((v): v is ModelId => typeof v === 'string')
    : [];
  return { id, kind: kind as DecorationKind, range: str(value['range']), pages, spec };
}

/** The module's state as stored, validated. */
export function readDecorationsState(bag: Readonly<Record<string, unknown>>): DecorationsState {
  const items: ModelDecoration[] = [];
  const raw = bag['items'];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const decoration = readDecoration(entry);
      if (decoration) items.push(decoration);
    }
  }
  const pages: Record<string, PageCapture> = {};
  const rawPages = bag['pages'];
  if (isRecord(rawPages)) {
    for (const [id, value] of Object.entries(rawPages)) {
      if (!isRecord(value) || typeof value['original'] !== 'string') continue;
      pages[id] = { original: value['original'], resources: str(value['resources']) };
    }
  }
  return { items, pages, seq: Math.max(1, Math.round(n(bag['seq'], 1))) };
}

// ---- derived facts ----------------------------------------------------------------------------

/** The Bates decoration on a document, if there is one. Only one is ever kept. */
export function batesOf(state: DecorationsState): ModelDecoration | null {
  return state.items.find((d) => d.kind === 'bates') ?? null;
}

/** Every page id any decoration touches. */
export function decoratedPages(state: DecorationsState): Set<ModelId> {
  const out = new Set<ModelId>();
  for (const item of state.items) for (const id of item.pages) out.add(id);
  return out;
}

/**
 * How much a page's own content is squeezed, from whichever header/footer on it asks for it.
 *
 * The largest ask wins rather than the last: two decorations both wanting room should not fight,
 * and the smaller page is the one that satisfies both.
 */
export function shrinkFor(state: DecorationsState, pageId: ModelId): number {
  let smallest = 1;
  for (const item of state.items) {
    if (item.spec.kind !== 'header-footer') continue;
    if (!item.pages.includes(pageId)) continue;
    const f = item.spec.shrink;
    if (f > 0 && f < 1) smallest = Math.min(smallest, f);
  }
  return smallest === 1 ? 0 : smallest;
}

/** The document facts the macros can name. */
export function documentContext(doc: Document, now: string): DocumentContext {
  const state = doc.state;
  const path = state.path ?? '';
  const separator = path.includes('\\') ? '\\' : '/';
  return {
    fileName: path === '' ? state.title : (path.split(separator).pop() ?? state.title),
    fullPath: path,
    title: state.metadata.title ?? '',
    author: state.metadata.author ?? '',
    subject: state.metadata.subject ?? '',
    pageCount: state.pages.length,
    labels: state.pages.map((p) => p.label),
    now,
  };
}

/** A4 in points, for a page whose box the model has not read yet. */
const FALLBACK_BOX = { x0: 0, y0: 0, x1: 595.28, y1: 841.89 };

/** The page facts a draw needs, from the model alone — no engine call, so the plan stays pure. */
export function pageContextFor(
  doc: Document,
  page: ModelPage,
  ordinal: number,
  rangeCount: number,
  document: DocumentContext,
): PageContext {
  const index = doc.pageIndex(page.id);
  return {
    index: index < 0 ? 0 : index,
    ordinal,
    rangeCount,
    box: page.cropBox ?? page.mediaBox ?? FALLBACK_BOX,
    rotation: page.rotation,
    document,
  };
}

/**
 * Every decoration drawn for one page, in draw order.
 *
 * Pure, and used by both the service (to put them on the live page) and the plan builder (to put
 * them in the file), so the two cannot drift apart.
 */
export function drawsForPage(
  doc: Document,
  state: DecorationsState,
  page: ModelPage,
  document: DocumentContext,
  sources: Readonly<Record<string, SourceSize>>,
): PlannedDecoration[] {
  const out: PlannedDecoration[] = [];
  for (const item of state.items) {
    const ordinal = item.pages.indexOf(page.id) + 1;
    if (ordinal === 0) continue;
    const bates = batesOf(state);
    const withBates: DocumentContext =
      bates && bates.spec.kind === 'bates'
        ? {
            ...document,
            bates: batesFor(bates.spec, Math.max(1, bates.pages.indexOf(page.id) + 1)),
          }
        : document;
    const context = pageContextFor(doc, page, ordinal, item.pages.length, withBates);
    const { draw } = drawDecoration(item.id, item.spec, { page: context, sources });
    if (draw) out.push(draw);
  }
  return out;
}

/**
 * What the write plan carries for one page (M21's `buildWritePlan` calls this).
 *
 * Sparse, like every other section: a page nobody decorated plans nothing, so a no-op save still
 * round-trips.
 */
export function plannedDecorationsFor(
  doc: Document,
  page: ModelPage,
  document: DocumentContext,
  sources: Readonly<Record<string, SourceSize>>,
): PlannedDecorations | undefined {
  const state = readDecorationsState(doc.custom(DECORATIONS_NAMESPACE));
  const capture = state.pages[page.id];
  const items = drawsForPage(doc, state, page, document, sources);
  const shrink = shrinkFor(state, page.id);
  if (!capture && items.length === 0 && shrink === 0) return undefined;
  return {
    ...(capture ? { original: { content: capture.original, resources: capture.resources } } : {}),
    items,
    ...(shrink > 0 ? { shrink } : {}),
  };
}

/** Natural sizes of the picture and PDF sources a document holds, by key. */
export function sourceSizes(
  bag: Readonly<Record<string, unknown>>,
): Record<string, SourceSize> {
  const out: Record<string, SourceSize> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (!isRecord(value)) continue;
    const width = n(value['width'], 0);
    const height = n(value['height'], 0);
    if (width > 0 && height > 0) out[key] = { width, height };
  }
  return out;
}

/** The sources a set of draws names, so only those are sent to the engine. */
export function sourcesUsed(
  items: ReadonlyArray<PlannedDecoration>,
  bag: Readonly<Record<string, PlannedXObject>>,
): Record<string, PlannedXObject> {
  const out: Record<string, PlannedXObject> = {};
  for (const item of items) {
    for (const key of Object.values(item.resources.xobjects ?? {})) {
      const source = bag[key];
      if (source) out[key] = source;
    }
  }
  return out;
}
