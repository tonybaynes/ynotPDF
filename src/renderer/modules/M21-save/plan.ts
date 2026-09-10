/**
 * `buildWritePlan` — the model, as instructions for the writer (M21).
 *
 * A pure function of the `Document`: no I/O, no clock, no UI. What it produces is JSON-shaped
 * data, which is why the same plan can be built in the renderer, sent to a Worker, and replayed
 * by a batch run later and still mean the same thing.
 *
 * It is **sparse on purpose**. A section is filled only when the document actually carries the
 * matching write intent, so a save that renamed one page plans `/PageLabels` and nothing else,
 * and a save of a document nobody has touched plans nothing at all. What the plan does not
 * mention, the writer does not touch — which is what makes a no-op save round-trip.
 */

import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import { serialiseCommand, type JournalEntry } from '@core/Journal';
import { COMPOSITE_COMMAND_ID } from '@core/Command';
import { COMMAND_ID } from '@core/commands';
import type { ModelAnnotation, ModelDestination, ModelOutlineItem, ModelPage } from '@core/model';
import { PDFIUM_GENERATES } from '@engine/appearance';
import {
  appearanceInput,
  type AppearanceInput,
  type AppearanceResources,
} from '@engine/appearance/types';
import { dictEntries, dictMapping, type DictValue } from '@engine/appearance/dict';
import {
  blobKey,
  COLUMN_SUBTYPE,
  orderFields,
  portfolioOf,
  PORTFOLIO_NAMESPACE,
  type Portfolio,
} from '@shared/portfolio';
import type {
  PlannedAnnotation,
  PlannedAttachment,
  PlannedAnnotationProperties,
  PlannedBoxes,
  PlannedDecorations,
  PlannedDestination,
  PlannedField,
  PlannedLayer,
  PlannedMetadata,
  PlannedNamedDestination,
  PlannedObjects,
  PlannedOutlineItem,
  PlannedPage,
  PlannedView,
  PlannedXObject,
  PlannedPortfolio,
  PlannedPortfolioFile,
  WritePlan,
} from '@engine/Writer';
import { plannedObjectsFor } from '@modules/M50-object-model/model';
import { plannedFormFor } from '@modules/M60-forms/plan';
import {
  documentContext,
  plannedDecorationsFor,
  sourceSizes,
} from '@modules/M53-headers-bates-watermarks-links/model';

/** What the plan could not express, for the caller to tell the user about. */
export interface PlanResult {
  readonly plan: WritePlan;
  readonly warnings: ReadonlyArray<string>;
}

export function buildWritePlan(doc: Document): PlanResult {
  const state = doc.state;
  const intents = new Set(state.writeIntents);
  const warnings: string[] = [];
  const touched = touchedEntities(doc);

  /*
   * The decorations are drawn from the same pure functions the live pages were drawn from, so
   * the file and the screen cannot disagree. Nothing here reads a clock: each decoration carries
   * the moment it was applied, so this stays a pure function of the document.
   */
  const decorationDocument = documentContext(doc);
  const decorationSources = sourceSizes(doc.custom(XOBJECTS_NAMESPACE));

  const pages: PlannedPage[] = [];
  state.pages.forEach((page) => {
    const source = doc.enginePage(page.id);
    if (source === undefined) {
      warnings.push(`The page "${page.label}" is not in the engine and could not be saved`);
      return;
    }
    const planned: {
      source: number;
      label?: string;
      boxes?: PlannedBoxes;
      annotations?: PlannedAnnotation[];
      objects?: PlannedObjects;
      decorations?: PlannedDecorations;
    } = { source };
    if (intents.has('page-labels')) planned.label = page.label;
    if (intents.has('page-boxes')) {
      const boxes = plannedBoxes(page);
      if (boxes) planned.boxes = boxes;
    }
    const annotations = plannedAnnotations(doc, page, touched.annotations);
    if (annotations.length > 0) planned.annotations = annotations;
    // Page-object edits replayed onto the original content stream (M50, ADR 0018).
    const objects = plannedObjectsFor(doc, page.id);
    if (objects) planned.objects = objects;
    // Headers, footers, Bates numbers, watermarks and backgrounds (M53, ADR 0020). Only when the
    // session actually changed them, so a document opened with decorations on it and saved
    // untouched still round-trips.
    if (intents.has('decorations')) {
      const decorations = plannedDecorationsFor(doc, page, decorationDocument, decorationSources);
      if (decorations) planned.decorations = decorations;
    }
    pages.push(planned);
  });

  const metadataFallback = plannedMetadata(doc);
  const portfolio = intents.has('portfolio')
    ? plannedPortfolio(doc, portfolioOf(doc.custom(PORTFOLIO_NAMESPACE)), warnings)
    : null;
  const plan: WritePlan = {
    pages,
    pagesUnchanged: !intents.has('page-order'),
    labels: intents.has('page-labels'),
    metadata: intents.has('metadata') ? metadataFallback : null,
    metadataFallback,
    // The initial view and the document-level properties beside it (M72, ADR 0017).
    view: intents.has('view') ? plannedView(doc) : null,
    outline: intents.has('outline') ? plannedOutline(state.outline, state.destinations, doc) : null,
    // Named destinations are rebuilt only when M12 has edited them; when a page merely goes, the
    // writer prunes the references to it rather than rebuilding the name tree, so nothing else
    // in it is lost.
    namedDestinations: intents.has('destinations') ? plannedNamedDestinations(state) : null,
    layers: intents.has('layers') ? plannedLayers(doc) : null,
    fields: intents.has('fields') ? plannedFields(doc, touched.fields) : null,
    // A portfolio's embedded files are written by the portfolio section, which rebuilds every
    // file specification anyway — planning both would move the same descriptions twice.
    attachments:
      intents.has('attachments') && portfolio === null ? plannedAttachments(state) : null,
    portfolio,
    xobjects: plannedXObjects(doc),
    // The designed form (M60, ADR 0019). `fields` above still covers a save that only filled a
    // form in; this rebuilds `/AcroForm` and every widget, and is on only when the structure
    // changed.
    form: intents.has('form')
      ? plannedFormFor(doc, (message) => {
          warnings.push(message);
        })
      : null,
  };
  return { plan, warnings };
}

/**
 * Shared XObjects an appearance stream may name (M31, ADR 0015), from the document's
 * `custom.xobjects` namespace — the one place a module puts a stamp's picture so it is
 * undoable, journalled and recovered with everything else. Every entry is offered; the writer
 * embeds only the keys a stream actually names, and each of those once.
 */
function plannedXObjects(doc: Document): Readonly<Record<string, PlannedXObject>> | null {
  const bag = doc.custom(XOBJECTS_NAMESPACE);
  const out: Record<string, PlannedXObject> = {};
  for (const [key, value] of Object.entries(bag)) {
    const x = asPlannedXObject(value);
    if (x) out[key] = x;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The `Document.custom` namespace shared XObjects live in. */
export const XOBJECTS_NAMESPACE = 'xobjects';

/** A stored entry as a planned XObject, or null when it is not one. */
export function asPlannedXObject(value: unknown): PlannedXObject | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  switch (r['kind']) {
    case 'form': {
      const bbox = r['bbox'];
      if (typeof r['content'] !== 'string' || !isRect(bbox)) return null;
      const resources = r['resources'];
      return {
        kind: 'form',
        content: r['content'],
        bbox,
        ...(resources && typeof resources === 'object'
          ? { resources: resources as AppearanceResources }
          : {}),
      };
    }
    case 'image':
      if (
        r['format'] !== 'png' ||
        typeof r['data'] !== 'string' ||
        typeof r['width'] !== 'number' ||
        typeof r['height'] !== 'number'
      ) {
        return null;
      }
      return {
        kind: 'image',
        format: 'png',
        data: r['data'],
        width: r['width'],
        height: r['height'],
      };
    // One page of another PDF: a watermark or a background made from a file (M53, ADR 0020 §4).
    case 'pdf':
      if (
        typeof r['data'] !== 'string' ||
        typeof r['page'] !== 'number' ||
        typeof r['width'] !== 'number' ||
        typeof r['height'] !== 'number'
      ) {
        return null;
      }
      return {
        kind: 'pdf',
        data: r['data'],
        page: r['page'],
        width: r['width'],
        height: r['height'],
      };
    default:
      return null;
  }
}

function isRect(value: unknown): value is PdfRectLike {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return ['x0', 'y0', 'x1', 'y1'].every((k) => typeof r[k] === 'number');
}

// ---- pages ---------------------------------------------------------------------------------

/**
 * The three boxes PDFium has no setter for. MediaBox and CropBox are already in the engine's
 * bytes, and a `null` here means "the model never read one", not "remove it" — so only boxes the
 * model actually holds are planned.
 */
function plannedBoxes(page: ModelPage): PlannedBoxes | null {
  const boxes: { bleed?: PdfRectLike; trim?: PdfRectLike; art?: PdfRectLike } = {};
  if (page.bleedBox) boxes.bleed = page.bleedBox;
  if (page.trimBox) boxes.trim = page.trimBox;
  if (page.artBox) boxes.art = page.artBox;
  return Object.keys(boxes).length > 0 ? boxes : null;
}

type PdfRectLike = ModelPage['mediaBox'];

// ---- annotations ---------------------------------------------------------------------------

/**
 * Annotation work for one page.
 *
 * Two kinds. **Changed** annotations — added or updated in this session — get their model values
 * written and their appearance regenerated, because an engine patch says what a value *becomes*
 * and can never say "and empty that one", and because an edited annotation's old appearance is
 * stale. **Every other** annotation on a loaded page is offered for appearance generation with
 * `replace: false`, so the writer fills a missing `/AP` and touches nothing that has one — which
 * repairs a Line or a FreeText that arrived from a viewer that never drew it.
 */
function plannedAnnotations(
  doc: Document,
  page: ModelPage,
  changed: ReadonlySet<string>,
): PlannedAnnotation[] {
  const list = doc.annotations(page.id);
  const out: PlannedAnnotation[] = [];
  list.forEach((annotation, index) => {
    const wasChanged = changed.has(annotation.id);
    // PDFium draws these subtypes itself as it loads a page, so the engine's bytes already carry
    // an `/AP` for them; the rest reach other viewers undrawn unless we draw them here.
    const needsRepair = !PDFIUM_GENERATES.has(annotation.subtype);
    if (!wasChanged && !needsRepair) return;
    const input = toAppearanceInput(annotation);
    // An annotation with no engine key is one PDFium refused to create — FreeText, Caret, Line,
    // Polygon and PolyLine are all outside the ten subtypes it makes (M30, ADR 0013). The writer
    // adds it to the page itself, from the whole model record rather than from a patch.
    const insert = doc.idTable.engineKey('annotation', annotation.id) === undefined;
    const entry: {
      index: number;
      subtype: ModelAnnotation['subtype'];
      rect: ModelAnnotation['rect'];
      insert?: boolean;
      properties?: PlannedAnnotationProperties;
      appearance?: { input: AppearanceInput; replace: boolean };
      dest?: PlannedDestination | null;
    } = { index, subtype: annotation.subtype, rect: annotation.rect };
    if (insert) entry.insert = true;
    if (wasChanged) {
      entry.properties = changedProperties(annotation, (id) => doc.annotation(id)?.name ?? null);
      /*
       * A link's `/Dest` (M53, ADR 0020 §5). The model holds the target as a page id; only the
       * plan can see both that and the page's place in the finished document, so it resolves it
       * here. A link that names no page inside the document says `null`, which removes any `/Dest`
       * the file had — the reader changed it to a URL.
       */
      if (annotation.subtype === 'Link') entry.dest = plannedLinkDest(doc, annotation);
    }
    // A Link has no appearance of its own: viewers draw its border from `/Border` and `/H`, and
    // an `/AP` we invented would replace that with a picture of a rectangle.
    if (annotation.subtype !== 'Link') entry.appearance = { input, replace: wasChanged };
    out.push(entry);
  });
  return out;
}

/**
 * Where a link goes inside this document, as the writer wants it (M53, ADR 0020 §5).
 *
 * `extra.linkDest` holds a **model page id**; the plan indexes `WritePlan.pages`, so a link still
 * points at the right page after a reorder. A target page that is no longer in the document
 * resolves to `null`, which removes the `/Dest` rather than pointing it at whatever is now in
 * that position.
 */
function plannedLinkDest(doc: Document, annotation: ModelAnnotation): PlannedDestination | null {
  const raw = annotation.extra['linkDest'];
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const pageId = record['page'];
  if (typeof pageId !== 'string') return null;
  const index = doc.state.pages.findIndex((p) => p.id === pageId);
  if (index < 0) return null;
  const fit = typeof record['fit'] === 'string' ? record['fit'] : 'fit';
  const allowed: ReadonlyArray<PlannedDestination['fit']> = [
    'xyz',
    'fit',
    'fitH',
    'fitV',
    'fitR',
    'fitB',
    'fitBH',
    'fitBV',
  ];
  return {
    page: index,
    fit: (allowed as ReadonlyArray<string>).includes(fit)
      ? (fit as PlannedDestination['fit'])
      : 'fit',
  };
}

/**
 * The whole dictionary of an annotation this session changed.
 *
 * M21 wrote only the *nulls* here, on the reasoning that a value the engine could set is already
 * in its bytes. Two things since have made that too narrow. PDFium's `FPDFAnnot_SetColor` refuses
 * outright while an annotation has an appearance stream — and it builds one itself for most
 * markup subtypes as a page loads — so a recoloured highlight never reached the file. And an
 * annotation PDFium cannot create at all has nothing in its bytes to build on (M30, ADR 0013).
 *
 * So for an annotation the session actually touched, the model is written in full. The risk the
 * original comment named — overwriting something the model reads less exactly than the file holds
 * it — does not apply to one the reader has just edited: there the model *is* the intent.
 */
function changedProperties(
  a: ModelAnnotation,
  nameOf: (id: ModelId) => string | null,
): PlannedAnnotationProperties {
  const props: Record<string, unknown> = {
    contents: a.contents,
    author: a.author,
    subject: a.subject,
    name: a.name,
    state: a.state,
    color: a.color,
    interiorColor: a.interiorColor,
    opacity: a.opacity,
    borderWidth: a.borderWidth,
    flags: packFlags(a.flags),
    created: a.created,
    modified: a.modified,
  };
  if ('quadPoints' in a) props['quadPoints'] = a.quadPoints.length > 0 ? a.quadPoints : null;
  if ('paths' in a) props['paths'] = a.paths.length > 0 ? a.paths : null;
  if ('vertices' in a) props['vertices'] = a.vertices.length > 0 ? a.vertices : null;
  // Dictionary entries the engine has no setter for — `/CL`, `/Q`, `/Rotate`, `/RD` — and the
  // ones it can only write as strings where the file wants a name.
  const entries: Record<string, DictValue | null> = dictEntries(a.extra);
  /*
   * `/IRT` is a reference to another annotation's object, which is the one thing the model holds
   * as an id and the file holds as a pointer (M32, ADR 0017). The plan is the last place that can
   * see both, so it looks the parent's `/NM` up here and the writer resolves the name once every
   * annotation on the page exists. A parent with no `/NM` cannot be pointed at; M32 gives one to
   * every annotation it replies to, so by save time there always is one.
   */
  const irt = dictMapping('inReplyTo');
  if (irt) {
    const parent = a.inReplyTo === null ? null : nameOf(a.inReplyTo);
    if (parent !== null && parent !== '') {
      entries[irt.pdfKey] = { kind: 'annotationRef', value: parent };
    } else if (a.inReplyTo === null) {
      entries[irt.pdfKey] = null;
    }
  }
  if (Object.keys(entries).length > 0) props['entries'] = entries;
  return props;
}

/** `AnnotationFlags` as the `/F` bit field (PDF 12.5.3). */
function packFlags(flags: ModelAnnotation['flags']): number {
  return (
    (flags.hidden ? 2 : 0) |
    (flags.print ? 4 : 0) |
    (flags.noView ? 32 : 0) |
    (flags.readOnly ? 64 : 0) |
    (flags.locked ? 128 : 0)
  );
}

/** The model annotation as the appearance generators want it. */
export function toAppearanceInput(a: ModelAnnotation): AppearanceInput {
  return appearanceInput({
    subtype: a.subtype,
    rect: a.rect,
    color: a.color,
    interiorColor: a.interiorColor,
    opacity: a.opacity,
    borderWidth: a.borderWidth,
    contents: a.contents,
    quadPoints: 'quadPoints' in a ? a.quadPoints : [],
    paths: 'paths' in a ? a.paths : [],
    vertices: 'vertices' in a ? a.vertices : [],
    extra: a.extra,
  });
}

// ---- metadata, outline, layers, fields -------------------------------------------------------

function plannedMetadata(doc: Document): PlannedMetadata {
  const m = doc.state.metadata;
  return {
    title: m.title,
    author: m.author,
    subject: m.subject,
    keywords: m.keywords,
    creator: m.creator,
    producer: m.producer,
    created: m.created,
    modified: m.modified,
    xmp: m.xmp,
    // The model read every custom entry the file had, so its set is the complete one and the
    // writer may treat it as such — which is what makes deleting a property in M72's dialog
    // actually delete it (ADR 0017).
    custom: m.custom,
    trapped: m.trapped,
  };
}

/** `/PageMode`, `/PageLayout`, `/OpenAction`, `/ViewerPreferences`, `/Lang`, base URL (M72). */
function plannedView(doc: Document): PlannedView {
  const state = doc.state;
  const view = state.view;
  /*
   * The open action is one entry expressing two choices — which page, and how much of it — and
   * a reader may make either without the other. "Fit page" with no page named means the first
   * page, and a page named with no magnification is `/XYZ` with no coordinates, which is the
   * PDF way of saying "go there and leave the view as it is" (ISO 32000-1 12.3.2.2). Only a
   * document that asks for neither has no open action at all.
   */
  const found =
    view.initialPageId === null ? -1 : state.pages.findIndex((p) => p.id === view.initialPageId);
  const page = found >= 0 ? found : view.initialFit === null ? -1 : 0;
  const openAction: PlannedDestination | null =
    page < 0
      ? null
      : {
          page,
          fit: view.initialFit ?? 'xyz',
          zoom: view.initialFit === 'xyz' ? view.initialZoom : null,
        };
  return {
    pageMode: view.pageMode,
    pageLayout: view.pageLayout,
    openAction,
    hideToolbar: view.hideToolbar,
    hideMenubar: view.hideMenubar,
    hideWindowUi: view.hideWindowUi,
    fitWindow: view.fitWindow,
    centreWindow: view.centreWindow,
    displayDocTitle: view.displayDocTitle,
    printScaling: view.printScaling,
    direction: view.direction,
    lang: state.metadata.lang,
    baseUrl: state.metadata.baseUrl,
  };
}

function plannedOutline(
  outline: ReadonlyArray<ModelOutlineItem>,
  destinations: ReadonlyArray<ModelDestination>,
  doc: Document,
): PlannedOutlineItem[] {
  const index = new Map(outline.map((o, i) => [o.id, i]));
  const destById = new Map(destinations.map((d) => [d.id, d]));
  return outline.map((item) => ({
    title: item.title,
    parent: item.parentId === null ? null : (index.get(item.parentId) ?? null),
    dest: item.destinationId
      ? plannedDestination(destById.get(item.destinationId) ?? null, doc)
      : null,
    uri: item.uri,
    open: item.open,
    bold: item.bold,
    italic: item.italic,
    color: item.color,
  }));
}

function plannedDestination(
  dest: ModelDestination | null,
  doc: Document,
): PlannedDestination | null {
  if (dest?.pageId == null) return null;
  const page = doc.pageIndex(dest.pageId);
  if (page < 0) return null;
  return {
    page,
    fit: dest.fit,
    left: dest.left,
    top: dest.top,
    zoom: dest.zoom,
    rect: dest.rect,
  };
}

/**
 * Every named destination in the model, for `/Names /Dests` (M12). Destinations without a name
 * belong to a bookmark and are written with the outline instead; one whose page has gone is
 * dropped, because a name tree entry pointing nowhere is worse than a missing one.
 */
function plannedNamedDestinations(state: Document['state']): PlannedNamedDestination[] {
  const pageIndex = new Map(state.pages.map((p, i) => [p.id, i]));
  const out: PlannedNamedDestination[] = [];
  for (const dest of state.destinations) {
    if (dest.name === null || dest.pageId === null) continue;
    const page = pageIndex.get(dest.pageId);
    if (page === undefined) continue;
    out.push({
      name: dest.name,
      dest: {
        page,
        fit: dest.fit,
        left: dest.left,
        top: dest.top,
        zoom: dest.zoom,
        rect: dest.rect,
      },
    });
  }
  return out;
}

/**
 * Embedded files whose description or type the writer has to move out of `/Params` (M12,
 * ADR 0011). Attachment *annotations* are M31's and are left alone.
 */
function plannedAttachments(state: Document['state']): PlannedAttachment[] {
  return state.attachments
    .filter((a) => a.pageId === null)
    .map((a) => ({
      name: a.name,
      description: a.description,
      mimeType: a.mimeType,
    }));
}

// ---- portfolio (M42, ADR 0014) ------------------------------------------------------------------

/**
 * The portfolio as the writer wants it.
 *
 * Two things happen here and nowhere else. The reader's own order is folded into the file's
 * custom fields under the order column, because the format has no order array and a viewer
 * shows what its sort column says. And a file added in this session is looked up in
 * `Document.blobs`: a file whose bytes are not there any more cannot be written, and dropping
 * it silently would lose it, so it is reported and left out of this save rather than of the
 * document.
 */
function plannedPortfolio(
  doc: Document,
  portfolio: Portfolio | null,
  warnings: string[],
): PlannedPortfolio | null {
  if (!portfolio) return null;
  const files: PlannedPortfolioFile[] = [];
  for (const file of [...portfolio.files].sort((a, b) => a.order - b.order)) {
    let source: PlannedPortfolioFile['source'];
    if (file.source.kind === 'embedded') {
      source = { kind: 'keep', treeKey: file.source.treeKey };
    } else {
      const bytes = doc.blobs.get(blobKey(file.id));
      if (!bytes) {
        warnings.push(`The bytes of "${file.name}" are no longer in memory, so it was not saved`);
        continue;
      }
      source = { kind: 'bytes', bytes, created: file.created, modified: file.modified };
    }
    files.push({
      name: file.name,
      folderId: file.folderId,
      description: file.description,
      mimeType: file.mimeType,
      fields: orderFields(file, portfolio.orderKey),
      source,
    });
  }
  return {
    view: portfolio.view,
    schema: portfolio.schema.map((column) => ({
      key: column.key,
      label: column.label,
      subtype: COLUMN_SUBTYPE[column.kind],
      order: column.order,
      visible: column.visible,
    })),
    sort: portfolio.sort,
    reorderKey: portfolio.orderKey,
    initialFile: portfolio.initialFile,
    folders: portfolio.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      description: folder.description,
      created: folder.created,
      modified: folder.modified,
    })),
    files,
  };
}

function plannedLayers(doc: Document): PlannedLayer[] {
  return doc.state.layers.map((l, index) => ({
    id: l.engineId,
    name: l.name,
    index,
    visible: l.visible,
  }));
}

/** Cleared field values. An empty string is a cleared field, which is a removed `/V`. */
function plannedFields(doc: Document, changed: ReadonlySet<string>): PlannedField[] {
  const out: PlannedField[] = [];
  for (const field of doc.state.fields) {
    if (!changed.has(field.id)) continue;
    out.push({ name: field.name, value: field.value === '' ? null : field.value });
  }
  return out;
}

// ---- what this session touched ---------------------------------------------------------------

interface Touched {
  readonly annotations: ReadonlySet<string>;
  readonly fields: ReadonlySet<string>;
}

/**
 * The entities this session edited, read from the journal.
 *
 * The write intents say *what kind* of thing the engine could not do; they cannot say *which*
 * one. Walking the journal can, because every command serialises to plain data naming its
 * target — so clearing one note's text plans that note, not every annotation in the document.
 */
export function touchedEntities(doc: Document): Touched {
  const annotations = new Set<string>();
  const fields = new Set<string>();
  const visit = (entry: JournalEntry): void => {
    if (entry.type === COMPOSITE_COMMAND_ID) {
      const { children } = (entry.payload ?? {}) as {
        children?: ReadonlyArray<JournalEntry | null>;
      };
      for (const child of children ?? []) if (child) visit(child);
      return;
    }
    const payload = (entry.payload ?? {}) as Record<string, unknown>;
    switch (entry.type) {
      case COMMAND_ID.addAnnotation: {
        const annotation = payload['annotation'] as { id?: unknown } | undefined;
        if (typeof annotation?.id === 'string') annotations.add(annotation.id);
        break;
      }
      case COMMAND_ID.updateAnnotation: {
        const id = payload['annotationId'];
        if (typeof id === 'string') annotations.add(id);
        break;
      }
      case COMMAND_ID.setFieldValue: {
        const id = payload['fieldId'];
        if (typeof id === 'string') fields.add(id);
        break;
      }
      default:
        break;
    }
  };
  for (const command of doc.undo.journal) visit(serialiseCommand(command));
  return { annotations, fields };
}

/** True when the id names an entity this session changed (exported for tests). */
export function wasTouched(touched: ReadonlySet<string>, id: ModelId): boolean {
  return touched.has(id);
}
