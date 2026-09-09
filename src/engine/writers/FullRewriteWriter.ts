/**
 * `FullRewriteWriter` — the pdf-lib writer (M21, ADR 0010).
 *
 * Takes the document as the engine holds it and applies what the engine could not: page order
 * and presence, page labels, the three boxes PDFium has no setter for, the information
 * dictionary and XMP, the outline, named destinations, layer visibility, annotation entries that
 * had to be *removed* rather than changed, cleared field values, and appearance streams.
 *
 * Everything it does not plan, it does not touch. Objects it has never heard of survive because
 * pdf-lib re-serialises the whole object graph rather than rebuilding it, and the trailer keeps
 * the file's `/ID` and the header its version — so a save with an empty plan is a
 * re-serialisation and a round-trip comparison of the two files reports nothing.
 *
 * Encrypted documents are refused (`WriteUnsupported('encrypted')`): pdf-lib does not decrypt
 * strings, so a rewrite would emit plaintext under a trailer that still claims encryption. The
 * caller decides what to offer instead; M70 will re-encrypt here.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFPageLeaf,
  PDFRef,
  PDFStream,
  PDFString,
  ParseSpeeds,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib';
import type { PdfPoint, PdfRect } from '@shared/pdf';
import {
  WriteCancelled,
  WriteUnsupported,
  WRITE_PHASES,
  type PlannedAnnotation,
  type PlannedAttachment,
  type PlannedDestination,
  type PlannedLayer,
  type PlannedOutlineItem,
  type PlannedPage,
  type PlannedXObject,
  type WritePhase,
  type WritePlan,
  type WriteProgressCallback,
  type WriteRequest,
  type WriteResult,
  type Writer,
} from '../Writer';
import { writePortfolio } from './portfolio';
import { defaultAppearanceService, type AppearanceService } from '../appearance';
import { pageLabelNums } from '../pageLabels';
import { num } from '../appearance/content';
import {
  isNonEmbeddedFont,
  type AppearanceFont,
  type AppearanceResources,
  type AppearanceStream,
} from '../appearance/types';
import type { DictValue } from '../appearance/dict';
import { yieldMacrotask } from '../yield';

const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const;

export interface FullRewriteWriterOptions {
  /** Generators for `/AP`. Defaults to the service M21 ships. */
  readonly appearances?: AppearanceService;
}

export class FullRewriteWriter implements Writer {
  readonly id = 'full-rewrite';
  private readonly appearances: AppearanceService;

  constructor(options: FullRewriteWriterOptions = {}) {
    this.appearances = options.appearances ?? defaultAppearanceService;
  }

  async write(request: WriteRequest): Promise<WriteResult> {
    const { bytes, plan, options = {}, progress, signal } = request;
    const state = new WriteState(progress, signal);

    state.phase('parse', 0);
    const doc = await load(bytes);
    const ctx = doc.context;
    state.phase('parse', 1);
    await state.checkpoint();

    // Shared XObjects are embedded once each (M31, ADR 0015). Images and PDF pages need
    // pdf-lib's own embedders, which are async, so every key a planned appearance names is
    // embedded up front, before the annotations are written.
    const xobjects = await embedXObjects(doc, plan, state, this.appearances);

    const basePages = collectPageRefs(doc);
    if (basePages.refs.length === 0) {
      throw new WriteUnsupported('corrupt', 'The document has no pages');
    }
    if (plan.pages.length === 0) {
      throw new WriteUnsupported('corrupt', 'The plan has no pages');
    }

    // ---- pages --------------------------------------------------------------------------------
    state.phase('pages', 0);
    const finalPages = resolvePages(plan, basePages.refs, state);
    if (!plan.pagesUnchanged) {
      // A page tree with no kids is not a PDF. If nothing in the plan resolved, the safe answer
      // is to refuse rather than to write a file that no reader can open.
      if (!finalPages.refs.some((r) => r !== undefined)) {
        throw new WriteUnsupported('corrupt', 'None of the planned pages is in the document');
      }
      reorderPages(doc, finalPages.refs, basePages);
      pruneOrphanFields(doc, state);
      state.applied('pages');
    }
    applyBoxes(ctx, plan.pages, finalPages.refs, state);
    state.phase('pages', 1);
    await state.checkpoint();

    // ---- page labels --------------------------------------------------------------------------
    if (plan.labels) {
      state.phase('labels', 0);
      writePageLabels(doc, plan.pages);
      state.applied('labels');
      state.phase('labels', 1);
      await state.checkpoint();
    }

    // ---- metadata -----------------------------------------------------------------------------
    // A repaired file can reach us with no information dictionary at all (PDFium rebuilds the
    // xref, reads `/Info` and then serialises without one), so the plan carries what the model
    // read as a fallback. On a healthy file there is an `/Info` and this does nothing.
    const fallback = ctx.lookupMaybe(ctx.trailerInfo.Info, PDFDict) ? null : plan.metadataFallback;
    const metadata = plan.metadata ?? fallback;
    if (metadata) {
      state.phase('metadata', 0);
      writeMetadata(doc, metadata, options.producer);
      state.applied('metadata');
      state.phase('metadata', 1);
      await state.checkpoint();
    }

    // Destinations are written before the outline so bookmarks can share the same page refs.
    const pageRefAt = (index: number): PDFRef | undefined => finalPages.refs[index];

    // ---- outline ------------------------------------------------------------------------------
    if (plan.outline) {
      state.phase('outline', 0);
      writeOutline(doc, plan.outline, pageRefAt, state);
      state.applied('outline');
      state.phase('outline', 1);
      await state.checkpoint();
    }

    // ---- named destinations -------------------------------------------------------------------
    if (plan.namedDestinations) {
      state.phase('destinations', 0);
      writeNamedDestinations(doc, plan.namedDestinations, pageRefAt, state);
      state.applied('destinations');
      state.phase('destinations', 1);
      await state.checkpoint();
    }

    // ---- layers -------------------------------------------------------------------------------
    if (plan.layers) {
      state.phase('layers', 0);
      writeLayers(doc, plan.layers, state);
      state.applied('layers');
      state.phase('layers', 1);
      await state.checkpoint();
    }

    // ---- embedded files -----------------------------------------------------------------------
    if (plan.attachments) {
      state.phase('attachments', 0);
      writeAttachments(doc, plan.attachments, state);
      state.applied('attachments');
      state.phase('attachments', 1);
      await state.checkpoint();
    }

    // ---- portfolio ----------------------------------------------------------------------------
    // The whole `/Collection`, `/Folders` and `/EmbeddedFiles` structure, rebuilt from the plan
    // (M42, ADR 0014). Every file the reader did not replace keeps the stream object the base
    // already held, so its bytes are the ones the file was opened with.
    if (plan.portfolio) {
      state.phase('portfolio', 0);
      if (
        writePortfolio(doc, plan.portfolio, {
          warn: (m) => {
            state.warn(m);
          },
        })
      ) {
        state.applied('portfolio');
      }
      state.phase('portfolio', 1);
      await state.checkpoint();
    }

    // ---- annotations and their appearances ----------------------------------------------------
    const withAnnotations = plan.pages
      .map((p, i) => ({ page: p, ref: finalPages.refs[i] }))
      .filter((entry) => (entry.page.annotations?.length ?? 0) > 0);
    if (withAnnotations.length > 0) {
      state.phase('annotations', 0);
      let done = 0;
      for (const { page, ref } of withAnnotations) {
        if (ref) {
          this.writeAnnotations(doc, ref, page.annotations ?? [], state, xobjects);
        }
        done++;
        state.phase('annotations', done / withAnnotations.length);
        await state.checkpoint();
      }
      state.applied('annotations');
    }

    // ---- fields -------------------------------------------------------------------------------
    if (plan.fields && plan.fields.length > 0) {
      state.phase('fields', 0);
      writeFieldValues(doc, plan.fields, state);
      state.applied('fields');
      state.phase('fields', 1);
      await state.checkpoint();
    }

    // ---- serialise ----------------------------------------------------------------------------
    state.phase('serialise', 0);
    state.throwIfCancelled();
    const out = await doc.save({
      useObjectStreams: options.objectStreams ?? true,
      addDefaultPage: false,
      updateFieldAppearances: false,
    });
    state.phase('serialise', 1);

    return {
      bytes: out,
      applied: state.appliedPhases,
      appearances: state.appearanceCount,
      warnings: state.warnings,
    };
  }

  /** Writes the planned entries and appearance streams onto one page's annotations. */
  private writeAnnotations(
    doc: PDFDocument,
    pageRef: PDFRef,
    planned: ReadonlyArray<PlannedAnnotation>,
    state: WriteState,
    xobjects: EmbeddedXObjects,
  ): void {
    const ctx = doc.context;
    const leaf = ctx.lookupMaybe(pageRef, PDFDict);
    if (!leaf) {
      state.warn(
        `A page could not be found, so ${planned.length} annotations were left as they were`,
      );
      return;
    }
    let annots = ctx.lookupMaybe(leaf.get(PDFName.of('Annots')), PDFArray);
    // A page with no annotations at all still needs an array once something is added to it.
    if (!annots && planned.some((entry) => entry.insert)) {
      annots = ctx.obj([]);
      leaf.set(PDFName.of('Annots'), annots);
    }
    if (!annots) {
      state.warn(
        `A page's annotations could not be found, so ${planned.length} were left as they were`,
      );
      return;
    }
    // `/IRT` names another annotation on the page, which may itself be one of the inserts below,
    // so the references are collected here and resolved once every dictionary exists (ADR 0017).
    const references: Array<{ owner: PDFDict; key: string; name: string }> = [];
    for (const entry of planned) {
      const dict = entry.insert
        ? newAnnotation(ctx, annots, entry)
        : annotationAt(ctx, annots, entry);
      if (!dict) {
        state.warn(
          `A ${entry.subtype} annotation moved in the file and was left as it was, to avoid writing to the wrong one`,
        );
        continue;
      }
      if (entry.properties) applyAnnotationProperties(doc, dict, entry, state, references);
      if (entry.appearance) {
        const has = dict.get(PDFName.of('AP')) !== undefined;
        if (!has || entry.appearance.replace) {
          const stream = this.appearances.generate(entry.appearance.input);
          if (stream && xobjectsResolve(stream, xobjects, state)) {
            attachAppearance(ctx, dict, stream, xobjects);
            state.countAppearance();
          }
        }
      }
    }
    resolveAnnotationRefs(ctx, annots, references, state);
  }
}

// ---- shared XObjects (M31, ADR 0015) -------------------------------------------------------------

/** Key → the embedded object, plus its natural box for a form the appearance refers to. */
type EmbeddedXObjects = ReadonlyMap<string, PDFRef>;

/**
 * Embeds every planned XObject once, keyed. A form is a stream of our own content; an image
 * goes through pdf-lib's PNG/JPEG embedders; a PDF page through `embedPdf`, which copies the
 * page's resources with it. A key whose bytes will not decode is reported and skipped — the
 * annotations naming it keep whatever appearance they had rather than getting a broken one.
 */
async function embedXObjects(
  doc: PDFDocument,
  plan: WritePlan,
  state: WriteState,
  appearances: AppearanceService,
): Promise<EmbeddedXObjects> {
  const out = new Map<string, PDFRef>();
  const sources = plan.xobjects ?? null;
  if (!sources) return out;
  // Only the keys a stream will name are worth embedding; the rest may be stale sources the
  // model still carries for undo. Generating is pure and cheap, so the streams are simply built
  // once here to see what they ask for, and again when they are written.
  const named = new Set<string>();
  for (const page of plan.pages) {
    for (const a of page.annotations ?? []) {
      if (!a.appearance) continue;
      const stream = appearances.generate(a.appearance.input);
      for (const key of Object.values(stream?.resources.xobjects ?? {})) named.add(key);
    }
  }
  for (const [key, source] of Object.entries(sources)) {
    if (!named.has(key)) continue;
    try {
      out.set(key, await embedOne(doc, source));
    } catch (error) {
      state.warn(
        `A stamp's picture could not be embedded (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return out;
}

async function embedOne(doc: PDFDocument, source: PlannedXObject): Promise<PDFRef> {
  const ctx = doc.context;
  switch (source.kind) {
    case 'form': {
      const stream = ctx.flateStream(source.content, {
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
      });
      const b = source.bbox;
      stream.dict.set(PDFName.of('BBox'), ctx.obj([b.x0, b.y0, b.x1, b.y1]));
      stream.dict.set(PDFName.of('Matrix'), ctx.obj([1, 0, 0, 1, 0, 0]));
      stream.dict.set(
        PDFName.of('Resources'),
        resourcesDict(ctx, source.resources ?? { extGState: {}, fonts: {} }, new Map()),
      );
      return ctx.register(stream);
    }
    case 'image': {
      const image = await doc.embedPng(fromBase64(source.data));
      /*
       * An image XObject draws into the unit square; wrapping it in a form of the picture's own
       * size lets every placement use the same "fit this box into the rect" matrix a catalogue
       * stamp uses, and keeps the image itself embedded exactly once.
       */
      const form = ctx.flateStream(
        `q ${num(source.width)} 0 0 ${num(source.height)} 0 0 cm /Im1 Do Q`,
        { Type: 'XObject', Subtype: 'Form', FormType: 1 },
      );
      form.dict.set(PDFName.of('BBox'), ctx.obj([0, 0, source.width, source.height]));
      form.dict.set(PDFName.of('Matrix'), ctx.obj([1, 0, 0, 1, 0, 0]));
      const resources = ctx.obj({});
      const images = ctx.obj({});
      images.set(PDFName.of('Im1'), image.ref);
      resources.set(PDFName.of('XObject'), images);
      resources.set(PDFName.of('ProcSet'), ctx.obj([PDFName.of('PDF'), PDFName.of('ImageC')]));
      form.dict.set(PDFName.of('Resources'), resources);
      return ctx.register(form);
    }
  }
}

/** Whether every XObject a stream names was embedded; the missing ones are reported. */
function xobjectsResolve(
  stream: AppearanceStream,
  embedded: EmbeddedXObjects,
  state: WriteState,
): boolean {
  for (const key of Object.values(stream.resources.xobjects ?? {})) {
    if (!embedded.has(key)) {
      state.warn('A stamp was left as it was, because its picture is not in the document');
      return false;
    }
  }
  return true;
}

function fromBase64(data: string): Uint8Array {
  const clean = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- progress, cancellation and warnings -----------------------------------------------------

/** Tracks progress across phases, watches the abort signal and collects warnings. */
class WriteState {
  readonly warnings: string[] = [];
  private readonly applyied = new Set<WritePhase>();
  private readonly progress: WriteProgressCallback | undefined;
  private readonly signal: AbortSignal | undefined;
  private appearances = 0;

  constructor(progress: WriteProgressCallback | undefined, signal: AbortSignal | undefined) {
    this.progress = progress;
    this.signal = signal;
  }

  /** Reports `fraction` of one phase as a fraction of the whole write. */
  phase(name: WritePhase, fraction: number): void {
    if (!this.progress) return;
    const index = WRITE_PHASES.indexOf(name);
    const clamped = Math.max(0, Math.min(1, fraction));
    this.progress((index + clamped) / WRITE_PHASES.length, name);
  }

  applied(name: WritePhase): void {
    this.applyied.add(name);
  }

  get appliedPhases(): WritePhase[] {
    return WRITE_PHASES.filter((p) => this.applyied.has(p));
  }

  countAppearance(): void {
    this.appearances++;
  }

  get appearanceCount(): number {
    return this.appearances;
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  throwIfCancelled(): void {
    if (this.signal?.aborted) throw new WriteCancelled();
  }

  /** Yields to the event loop between phases so a cancel is seen and a worker stays responsive. */
  async checkpoint(): Promise<void> {
    this.throwIfCancelled();
    await yieldMacrotask();
    this.throwIfCancelled();
  }
}

// ---- loading ---------------------------------------------------------------------------------

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, {
      // Not `ignoreEncryption`: an encrypted document must fail here rather than be rewritten
      // into a file whose strings are plaintext under a trailer that still claims encryption.
      ignoreEncryption: false,
      updateMetadata: false,
      throwOnInvalidObject: false,
      parseSpeed: ParseSpeeds.Fastest,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/encrypt/i.test(message)) {
      throw new WriteUnsupported('encrypted', 'The document is password-protected');
    }
    throw new WriteUnsupported('corrupt', `The document could not be re-read: ${message}`);
  }
}

interface BasePages {
  readonly refs: ReadonlyArray<PDFRef>;
  /** Page-tree nodes between the root and the leaves; dropped when the tree is flattened. */
  readonly intermediates: ReadonlyArray<PDFRef>;
}

function collectPageRefs(doc: PDFDocument): BasePages {
  const refs: PDFRef[] = [];
  const intermediates: PDFRef[] = [];
  const root = doc.catalog.Pages();
  root.traverse((node, ref) => {
    if (node instanceof PDFPageLeaf) refs.push(ref);
    else if (node !== root) intermediates.push(ref);
  });
  return { refs, intermediates };
}

// ---- pages -----------------------------------------------------------------------------------

interface ResolvedPages {
  readonly refs: ReadonlyArray<PDFRef | undefined>;
}

/** Maps each planned page to its base ref, warning about anything that does not resolve. */
function resolvePages(
  plan: WritePlan,
  base: ReadonlyArray<PDFRef>,
  state: WriteState,
): ResolvedPages {
  const seen = new Set<string>();
  const refs = plan.pages.map((p) => {
    const ref = base[p.source];
    if (!ref) {
      state.warn(`A page of the plan is not in the file and was left out`);
      return undefined;
    }
    const key = ref.toString();
    if (seen.has(key)) {
      state.warn('A page appears twice in the plan; the copy was left out');
      return undefined;
    }
    seen.add(key);
    return ref;
  });
  return { refs };
}

/**
 * Flattens the page tree to the planned order. Inheritable attributes are pushed down onto each
 * leaf first, because a page that inherited its `/MediaBox` from a node we are about to drop
 * would otherwise lose it.
 */
function reorderPages(
  doc: PDFDocument,
  refs: ReadonlyArray<PDFRef | undefined>,
  base: BasePages,
): void {
  const ctx = doc.context;
  const kept = refs.filter((r): r is PDFRef => r !== undefined);
  for (const ref of kept) materialiseInherited(ctx, ref);

  const rootRef = doc.catalog.get(PDFName.of('Pages'));
  const root = doc.catalog.Pages();
  root.set(PDFName.of('Kids'), ctx.obj([...kept]));
  root.set(PDFName.of('Count'), PDFNumber.of(kept.length));
  if (rootRef instanceof PDFRef) {
    for (const ref of kept) {
      const leaf = ctx.lookupMaybe(ref, PDFDict);
      leaf?.set(PDFName.of('Parent'), rootRef);
    }
  }
  // The tree is flat now; the nodes that used to sit in the middle refer to nothing, and neither
  // does a page the plan left out — dropping both keeps a deleted page's bytes out of the file.
  const keptKeys = new Set(kept.map((r) => r.toString()));
  const dropped = base.refs.filter((r) => !keptKeys.has(r.toString()));
  // Anything still pointing at a page we are about to remove has to let go of it first, or the
  // file ends up with a bookmark whose destination is an object that is not there any more.
  pruneDeadPageReferences(doc, new Set(dropped.map((r) => r.toString())));
  for (const ref of base.intermediates) ctx.delete(ref);
  for (const ref of dropped) ctx.delete(ref);
}

/**
 * Removes every reference to a deleted page: the outline's `/Dest`, name-tree and catalogue
 * destinations, `/OpenAction`, and link annotations on the pages that remain.
 *
 * A bookmark whose destination has gone stays in the tree and simply does nothing — which is
 * what Foxit does, and is better than silently deleting a heading the reader put there.
 */
function pruneDeadPageReferences(doc: PDFDocument, dead: ReadonlySet<string>): void {
  if (dead.size === 0) return;
  const ctx = doc.context;
  const seen = new Set<string>();

  /** True when this destination (array, or a dict with `/D`) lands on a page that has gone. */
  const isDead = (value: PDFObject | undefined): boolean => {
    const array =
      value instanceof PDFArray
        ? value
        : ctx.lookupMaybe(value, PDFDict)?.lookupMaybe(PDFName.of('D'), PDFArray);
    const target = array?.get(0);
    return target instanceof PDFRef && dead.has(target.toString());
  };

  const clean = (dict: PDFDict): void => {
    if (isDead(dict.get(PDFName.of('Dest')))) dict.delete(PDFName.of('Dest'));
    const action = dict.lookupMaybe(PDFName.of('A'), PDFDict);
    if (action && isDead(action.get(PDFName.of('D')))) dict.delete(PDFName.of('A'));
  };

  /** Walks the outline's linked lists. */
  const walkOutline = (start: PDFObject | undefined): void => {
    let ref = start;
    while (ref instanceof PDFRef) {
      const key = ref.toString();
      if (seen.has(key)) return;
      seen.add(key);
      const dict = ctx.lookupMaybe(ref, PDFDict);
      if (!dict) return;
      clean(dict);
      walkOutline(dict.get(PDFName.of('First')));
      ref = dict.get(PDFName.of('Next'));
    }
  };
  const outlines = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  if (outlines) walkOutline(outlines.get(PDFName.of('First')));

  // Name-tree destinations, at any depth of the tree.
  const walkNameTree = (node: PDFDict | undefined): void => {
    if (!node) return;
    const names = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (names) {
      const survivors: PDFObject[] = [];
      for (let i = 0; i + 1 < names.size(); i += 2) {
        const name = names.get(i);
        const value = names.get(i + 1);
        if (!isDead(value)) survivors.push(name, value);
      }
      node.set(PDFName.of('Names'), ctx.obj(survivors));
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (!kids) return;
    for (let i = 0; i < kids.size(); i++) walkNameTree(ctx.lookupMaybe(kids.get(i), PDFDict));
  };
  walkNameTree(
    doc.catalog
      .lookupMaybe(PDFName.of('Names'), PDFDict)
      ?.lookupMaybe(PDFName.of('Dests'), PDFDict),
  );

  // Pre-1.2 catalogue `/Dests` dictionary.
  const legacy = doc.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict);
  if (legacy) {
    for (const key of legacy.keys()) if (isDead(legacy.get(key))) legacy.delete(key);
  }

  if (isDead(doc.catalog.get(PDFName.of('OpenAction')))) {
    doc.catalog.delete(PDFName.of('OpenAction'));
  }
  const openAction = doc.catalog.lookupMaybe(PDFName.of('OpenAction'), PDFDict);
  if (openAction && isDead(openAction.get(PDFName.of('D')))) {
    doc.catalog.delete(PDFName.of('OpenAction'));
  }

  // Links on the pages that remain.
  const root = doc.catalog.Pages();
  root.traverse((node) => {
    if (!(node instanceof PDFPageLeaf)) return;
    const annots = ctx.lookupMaybe(node.get(PDFName.of('Annots')), PDFArray);
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const dict = ctx.lookupMaybe(annots.get(i), PDFDict);
      if (dict) clean(dict);
    }
  });
}

/** Copies `/Resources`, `/MediaBox`, `/CropBox` and `/Rotate` from ancestors onto the leaf. */
function materialiseInherited(ctx: PDFContext, ref: PDFRef): void {
  const leaf = ctx.lookupMaybe(ref, PDFDict);
  if (!(leaf instanceof PDFPageLeaf)) return;
  for (const name of INHERITABLE) {
    const key = PDFName.of(name);
    if (leaf.get(key) !== undefined) continue;
    const inherited = leaf.getInheritableAttribute(key);
    if (inherited !== undefined) leaf.set(key, inherited);
  }
}

const BOX_KEYS = {
  media: 'MediaBox',
  crop: 'CropBox',
  bleed: 'BleedBox',
  trim: 'TrimBox',
  art: 'ArtBox',
} as const;

function applyBoxes(
  ctx: PDFContext,
  pages: ReadonlyArray<PlannedPage>,
  refs: ReadonlyArray<PDFRef | undefined>,
  state: WriteState,
): void {
  pages.forEach((page, index) => {
    if (!page.boxes) return;
    const ref = refs[index];
    const leaf = ref ? ctx.lookupMaybe(ref, PDFDict) : undefined;
    if (!leaf) return;
    for (const [key, name] of Object.entries(BOX_KEYS) as [keyof typeof BOX_KEYS, string][]) {
      const box = page.boxes[key];
      if (box === undefined) continue;
      if (box === null) leaf.delete(PDFName.of(name));
      else leaf.set(PDFName.of(name), rectArray(ctx, box));
    }
    state.applied('pages');
  });
}

function rectArray(ctx: PDFContext, r: PdfRect): PDFArray {
  return ctx.obj([r.x0, r.y0, r.x1, r.y1]);
}

// ---- page labels -----------------------------------------------------------------------------

/*
 * Page-label numbering moved to `src/engine/pageLabels.ts` when M40 gained a Page Numbering
 * dialog: the writer and that dialog have to agree exactly on what "i, ii, iii" means, and two
 * implementations of a numeral are two chances to disagree. `pageLabelNums` is re-exported here
 * because M21's tests import it from this file.
 */
export { pageLabelNums } from '../pageLabels';

function writePageLabels(doc: PDFDocument, pages: ReadonlyArray<PlannedPage>): void {
  const ctx = doc.context;
  const labels = pages.map((p) => p.label ?? '');
  const nums: PDFObject[] = [];
  for (const { index, entry: e } of pageLabelNums(labels)) {
    const dict = ctx.obj({});
    if (e.S !== undefined) dict.set(PDFName.of('S'), PDFName.of(e.S));
    if (e.P !== undefined) dict.set(PDFName.of('P'), PDFHexString.fromText(e.P));
    if (e.St !== undefined && e.St !== 1) dict.set(PDFName.of('St'), PDFNumber.of(e.St));
    nums.push(PDFNumber.of(index), dict);
  }
  const tree = ctx.obj({});
  tree.set(PDFName.of('Nums'), ctx.obj(nums));
  doc.catalog.set(PDFName.of('PageLabels'), ctx.register(tree));
}

// ---- metadata --------------------------------------------------------------------------------

/** ISO 8601 → `D:YYYYMMDDHHmmSS+HH'mm'`. Returns null when the input is not a date. Exported for the tests. */
export function isoToPdfDate(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const p = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, '0');
  const base =
    `D:${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
  return `${base}Z00'00'`;
}

const INFO_KEYS = {
  title: 'Title',
  author: 'Author',
  subject: 'Subject',
  keywords: 'Keywords',
  creator: 'Creator',
  producer: 'Producer',
} as const;

function writeMetadata(
  doc: PDFDocument,
  metadata: NonNullable<WritePlan['metadata']>,
  producer: string | undefined,
): void {
  const ctx = doc.context;
  let info = ctx.lookupMaybe(ctx.trailerInfo.Info, PDFDict);
  if (!info) {
    info = ctx.obj({});
    ctx.trailerInfo.Info = ctx.register(info);
  }
  for (const [key, name] of Object.entries(INFO_KEYS) as [keyof typeof INFO_KEYS, string][]) {
    const value = metadata[key];
    if (value === undefined) continue;
    if (value === null) info.delete(PDFName.of(name));
    else info.set(PDFName.of(name), PDFHexString.fromText(value));
  }
  for (const [key, name] of [
    ['created', 'CreationDate'],
    ['modified', 'ModDate'],
  ] as const) {
    const value = metadata[key];
    if (value === undefined) continue;
    if (value === null) {
      info.delete(PDFName.of(name));
      continue;
    }
    const pdfDate = isoToPdfDate(value);
    if (pdfDate) info.set(PDFName.of(name), PDFString.of(pdfDate));
  }
  if (producer !== undefined && metadata.producer === undefined) {
    info.set(PDFName.of('Producer'), PDFHexString.fromText(producer));
  }

  if (metadata.xmp !== undefined) {
    const key = PDFName.of('Metadata');
    if (metadata.xmp === null) {
      doc.catalog.delete(key);
    } else {
      // XMP must be readable without decoding the file, so it is never compressed.
      const stream = ctx.stream(metadata.xmp, { Type: 'Metadata', Subtype: 'XML' });
      doc.catalog.set(key, ctx.register(stream));
    }
  }
}

// ---- destinations ----------------------------------------------------------------------------

type PageRefAt = (index: number) => PDFRef | undefined;

/** `[pageRef /Fit …]` — the destination array a `/Dest` or a name tree entry holds. */
function destinationArray(
  ctx: PDFContext,
  dest: PlannedDestination,
  pageRefAt: PageRefAt,
): PDFArray | null {
  const page = pageRefAt(dest.page);
  if (!page) return null;
  const items: PDFObject[] = [page, PDFName.of(fitName(dest.fit))];
  // A missing coordinate is the `null` keyword — "leave this one as the reader found it".
  const push = (value: number | null | undefined): void => {
    items.push(typeof value === 'number' ? PDFNumber.of(value) : PDFNull);
  };
  switch (dest.fit) {
    case 'xyz':
      push(dest.left);
      push(dest.top);
      push(dest.zoom);
      break;
    case 'fitH':
    case 'fitBH':
      push(dest.top);
      break;
    case 'fitV':
    case 'fitBV':
      push(dest.left);
      break;
    case 'fitR': {
      const r = dest.rect;
      if (!r) return null;
      items.push(PDFNumber.of(r.x0), PDFNumber.of(r.y0), PDFNumber.of(r.x1), PDFNumber.of(r.y1));
      break;
    }
    default:
      break;
  }
  return ctx.obj(items);
}

function fitName(fit: PlannedDestination['fit']): string {
  switch (fit) {
    case 'xyz':
      return 'XYZ';
    case 'fit':
      return 'Fit';
    case 'fitH':
      return 'FitH';
    case 'fitV':
      return 'FitV';
    case 'fitR':
      return 'FitR';
    case 'fitB':
      return 'FitB';
    case 'fitBH':
      return 'FitBH';
    case 'fitBV':
      return 'FitBV';
    default:
      return 'Fit';
  }
}

function writeNamedDestinations(
  doc: PDFDocument,
  destinations: ReadonlyArray<{ name: string; dest: PlannedDestination }>,
  pageRefAt: PageRefAt,
  state: WriteState,
): void {
  const ctx = doc.context;
  // A name tree's Names array must be sorted by name, byte by byte, or a reader binary-searching
  // it will silently miss entries.
  const sorted = [...destinations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const names: PDFObject[] = [];
  for (const { name, dest } of sorted) {
    const array = destinationArray(ctx, dest, pageRefAt);
    if (!array) {
      state.warn(`The destination "${name}" pointed at a page that is no longer there`);
      continue;
    }
    const value = ctx.obj({});
    value.set(PDFName.of('D'), array);
    names.push(PDFString.of(name), value);
  }
  const namesKey = PDFName.of('Names');
  const destsKey = PDFName.of('Dests');
  if (names.length === 0) {
    const root = doc.catalog.lookupMaybe(namesKey, PDFDict);
    root?.delete(destsKey);
    doc.catalog.delete(destsKey);
    return;
  }
  const leaf = ctx.obj({});
  leaf.set(namesKey, ctx.obj(names));
  let root = doc.catalog.lookupMaybe(namesKey, PDFDict);
  if (!root) {
    root = ctx.obj({});
    doc.catalog.set(namesKey, ctx.register(root));
  }
  root.set(destsKey, ctx.register(leaf));
  // A pre-1.2 `/Dests` dictionary in the catalogue would shadow half of this; the name tree we
  // just wrote holds everything it held.
  doc.catalog.delete(destsKey);
}

/**
 * Drops `/AcroForm` fields that no surviving page carries a widget for.
 *
 * A field whose widgets went with the pages they were on is a field no reader can fill, no
 * viewer draws and every validator complains about — and it is exactly what is left behind when
 * pages are deleted (M40) or replaced by flattened copies (M41). The catalogue's `/AcroForm` is
 * not part of the page tree, so nothing else in this writer would notice.
 *
 * Only runs when the page set actually changed. A field is kept if it, or anything under it, is
 * still reachable from a page's `/Annots`.
 */
function pruneOrphanFields(doc: PDFDocument, state: WriteState): void {
  const ctx = doc.context;
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acroForm?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!acroForm || !fields || fields.size() === 0) return;

  // Every annotation, and every ancestor of one, that a surviving page still reaches.
  const live = new Set<string>();
  doc.catalog.Pages().traverse((node) => {
    if (!(node instanceof PDFPageLeaf)) return;
    const annots = ctx.lookupMaybe(node.get(PDFName.of('Annots')), PDFArray);
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      if (raw instanceof PDFRef) live.add(raw.toString());
      let parent = ctx.lookupMaybe(raw, PDFDict)?.get(PDFName.of('Parent'));
      for (let depth = 0; parent instanceof PDFRef && depth < 32; depth++) {
        if (live.has(parent.toString())) break;
        live.add(parent.toString());
        parent = ctx.lookupMaybe(parent, PDFDict)?.get(PDFName.of('Parent'));
      }
    }
  });

  const kept = [];
  for (let i = 0; i < fields.size(); i++) {
    const raw = fields.get(i);
    // A field written inline rather than as a reference cannot be matched, so it is kept: the
    // cost of keeping one too many is a validator warning, and of dropping one too many is a
    // form that has lost a field.
    if (!(raw instanceof PDFRef) || live.has(raw.toString())) kept.push(raw);
  }
  if (kept.length === fields.size()) return;
  if (kept.length === 0) {
    doc.catalog.delete(PDFName.of('AcroForm'));
    state.warn('The form was removed: none of its fields is on a page any more');
    return;
  }
  acroForm.set(PDFName.of('Fields'), ctx.obj(kept));
}

// ---- outline ---------------------------------------------------------------------------------

/** `/F` flags: bit 1 italic, bit 2 bold (PDF 12.3.3). */
function outlineFlags(item: PlannedOutlineItem): number {
  return (item.italic ? 1 : 0) | (item.bold ? 2 : 0);
}

function writeOutline(
  doc: PDFDocument,
  items: ReadonlyArray<PlannedOutlineItem>,
  pageRefAt: PageRefAt,
  state: WriteState,
): void {
  const ctx = doc.context;
  const key = PDFName.of('Outlines');
  if (items.length === 0) {
    doc.catalog.delete(key);
    return;
  }

  const rootDict = ctx.obj({});
  rootDict.set(PDFName.of('Type'), PDFName.of('Outlines'));
  const rootRef = ctx.register(rootDict);

  const refs = items.map(() => ctx.nextRef());
  const dicts = items.map(() => ctx.obj({}));
  const childrenOf = new Map<number, number[]>();
  const roots: number[] = [];
  items.forEach((item, i) => {
    if (item.parent === null || item.parent < 0 || item.parent >= items.length) roots.push(i);
    else childrenOf.set(item.parent, [...(childrenOf.get(item.parent) ?? []), i]);
  });

  /** Visible descendants of `i`: children, plus theirs when the child is open. */
  const visibleCount = (i: number): number => {
    const kids = childrenOf.get(i) ?? [];
    let n = kids.length;
    for (const kid of kids) if (items[kid]?.open) n += visibleCount(kid);
    return n;
  };

  items.forEach((item, i) => {
    const dict = dicts[i];
    const ref = refs[i];
    if (!dict || !ref) return;
    dict.set(PDFName.of('Title'), PDFHexString.fromText(item.title));
    const parentRef = item.parent === null ? rootRef : refs[item.parent];
    dict.set(PDFName.of('Parent'), parentRef ?? rootRef);

    if (item.dest) {
      const array = destinationArray(ctx, item.dest, pageRefAt);
      if (array) dict.set(PDFName.of('Dest'), array);
      else state.warn(`The bookmark "${item.title}" pointed at a page that is no longer there`);
    } else if (item.uri !== null) {
      const action = ctx.obj({});
      action.set(PDFName.of('S'), PDFName.of('URI'));
      action.set(PDFName.of('URI'), PDFString.of(item.uri));
      dict.set(PDFName.of('A'), action);
    }

    const flags = outlineFlags(item);
    if (flags !== 0) dict.set(PDFName.of('F'), PDFNumber.of(flags));
    if (item.color !== null) {
      dict.set(
        PDFName.of('C'),
        ctx.obj([
          ((item.color >> 16) & 0xff) / 255,
          ((item.color >> 8) & 0xff) / 255,
          (item.color & 0xff) / 255,
        ]),
      );
    }

    const kids = childrenOf.get(i) ?? [];
    if (kids.length > 0) {
      const firstKid = kids[0];
      const lastKid = kids[kids.length - 1];
      const first = firstKid === undefined ? undefined : refs[firstKid];
      const last = lastKid === undefined ? undefined : refs[lastKid];
      if (first) dict.set(PDFName.of('First'), first);
      if (last) dict.set(PDFName.of('Last'), last);
      // Positive when open (and it counts the visible descendants), negative when closed.
      const count = visibleCount(i);
      dict.set(PDFName.of('Count'), PDFNumber.of(item.open ? count : -kids.length));
    }
    ctx.assign(ref, dict);
  });

  // Siblings are a doubly linked list.
  const link = (siblings: ReadonlyArray<number>): void => {
    siblings.forEach((index, at) => {
      const dict = dicts[index];
      if (!dict) return;
      const prevIndex = siblings[at - 1];
      const nextIndex = siblings[at + 1];
      const prev = prevIndex === undefined ? undefined : refs[prevIndex];
      const next = nextIndex === undefined ? undefined : refs[nextIndex];
      if (prev) dict.set(PDFName.of('Prev'), prev);
      if (next) dict.set(PDFName.of('Next'), next);
    });
  };
  link(roots);
  for (const kids of childrenOf.values()) link(kids);

  const firstRoot = roots[0];
  const lastRoot = roots[roots.length - 1];
  const first = firstRoot === undefined ? undefined : refs[firstRoot];
  const last = lastRoot === undefined ? undefined : refs[lastRoot];
  if (first) rootDict.set(PDFName.of('First'), first);
  if (last) rootDict.set(PDFName.of('Last'), last);
  let total = roots.length;
  for (const root of roots) if (items[root]?.open) total += visibleCount(root);
  rootDict.set(PDFName.of('Count'), PDFNumber.of(total));
  doc.catalog.set(key, rootRef);
}

// ---- layers ----------------------------------------------------------------------------------

/**
 * Sets `/OCProperties /D /OFF` (and `/ON`) from the plan. Groups are found by name, falling back
 * to the position of the group in the same `/Order`-then-`/OCGs` walk the engine reported.
 */
function writeLayers(
  doc: PDFDocument,
  layers: ReadonlyArray<PlannedLayer>,
  state: WriteState,
): void {
  const ctx = doc.context;
  const ocProps = doc.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
  if (!ocProps) {
    state.warn('The file has no layers, so layer visibility could not be saved');
    return;
  }
  const order = walkOcgOrder(ctx, ocProps);
  const byName = new Map<string, PDFRef[]>();
  for (const entry of order) {
    byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry.ref]);
  }

  const off: PDFRef[] = [];
  const on: PDFRef[] = [];
  for (const layer of layers) {
    const matches = byName.get(layer.name) ?? [];
    const ref = matches.length === 1 ? matches[0] : order[layer.index]?.ref;
    if (!ref) {
      state.warn(`The layer "${layer.name}" could not be found, so its visibility was not saved`);
      continue;
    }
    (layer.visible ? on : off).push(ref);
  }

  let d = ocProps.lookupMaybe(PDFName.of('D'), PDFDict);
  if (!d) {
    d = ctx.obj({});
    ocProps.set(PDFName.of('D'), ctx.register(d));
  }
  if (off.length > 0) d.set(PDFName.of('OFF'), ctx.obj(off));
  else d.delete(PDFName.of('OFF'));
  if (on.length > 0) d.set(PDFName.of('ON'), ctx.obj(on));
  else d.delete(PDFName.of('ON'));
}

/**
 * Puts embedded-file metadata where a reader will find it (M12, ADR 0011).
 *
 * PDFium can embed a file but writes its description and MIME type into the embedded stream's
 * `/Params` dictionary, where nothing looks for them: PDF 7.11.3 puts the description on the
 * *file specification* as `/Desc` and the type on the stream as a `/Subtype` name. This walks
 * the `/EmbeddedFiles` name tree, matches each planned attachment by name, and moves them.
 */
function writeAttachments(
  doc: PDFDocument,
  attachments: ReadonlyArray<PlannedAttachment>,
  state: WriteState,
): void {
  const ctx = doc.context;
  const specs = new Map<string, PDFDict>();
  const collect = (node: PDFDict | undefined, depth: number): void => {
    if (!node || depth > 32) return;
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) {
      for (const kid of kids.asArray()) collect(ctx.lookupMaybe(kid, PDFDict), depth + 1);
      return;
    }
    const names = node.lookupMaybe(PDFName.of('Names'), PDFArray)?.asArray() ?? [];
    for (let i = 1; i < names.length; i += 2) {
      const key = names[i - 1];
      const spec = ctx.lookupMaybe(names[i], PDFDict);
      const name =
        key instanceof PDFString || key instanceof PDFHexString ? key.decodeText() : undefined;
      if (name !== undefined && spec) specs.set(name, spec);
    }
  };
  const root = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  collect(root?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict), 0);

  const descKey = PDFName.of('Desc');
  const subtypeKey = PDFName.of('Subtype');
  for (const planned of attachments) {
    // The name tree may hold the name as written or with pdf-lib's own text encoding; a spec
    // whose `/F` matches is the same file either way.
    const spec =
      specs.get(planned.name) ??
      [...specs.values()].find(
        (d) =>
          textValue(d.lookup(PDFName.of('UF'))) === planned.name ||
          textValue(d.lookup(PDFName.of('F'))) === planned.name,
      );
    if (!spec) {
      state.warn(
        `The attachment "${planned.name}" could not be found, so its description was not saved`,
      );
      continue;
    }
    if (planned.description === null) spec.delete(descKey);
    else spec.set(descKey, PDFString.of(planned.description));

    const ef = spec.lookupMaybe(PDFName.of('EF'), PDFDict);
    const streamRef = ef?.get(PDFName.of('F')) ?? ef?.get(PDFName.of('UF'));
    const stream = streamRef ? ctx.lookupMaybe(streamRef, PDFStream) : undefined;
    const params = stream?.dict.lookupMaybe(PDFName.of('Params'), PDFDict);
    // Whatever the description used to be, it lives on the specification now.
    params?.delete(descKey);
    if (stream) {
      if (planned.mimeType === null) stream.dict.delete(subtypeKey);
      // A MIME type is a name, and `/` has to be escaped inside one (PDF 7.3.5).
      else stream.dict.set(subtypeKey, PDFName.of(planned.mimeType));
      params?.delete(subtypeKey);
    }
  }
}

/** A text string entry, whichever of the two string forms the file used. */
function textValue(value: unknown): string | undefined {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  return undefined;
}

interface OcgEntry {
  readonly ref: PDFRef;
  readonly name: string;
}

/** The same traversal `rawdoc.ts` uses to number layers: `/D /Order` first, then `/OCGs`. */
function walkOcgOrder(ctx: PDFContext, ocProps: PDFDict): OcgEntry[] {
  const seen = new Set<string>();
  const out: OcgEntry[] = [];
  const add = (ref: PDFRef): void => {
    const key = ref.toString();
    if (seen.has(key)) return;
    const dict = ctx.lookupMaybe(ref, PDFDict);
    if (!dict || dict.lookupMaybe(PDFName.of('Type'), PDFName)?.decodeText() !== 'OCG') return;
    seen.add(key);
    const raw = dict.lookup(PDFName.of('Name'));
    const name =
      raw instanceof PDFString || raw instanceof PDFHexString
        ? raw.decodeText()
        : `Layer ${out.length + 1}`;
    out.push({ ref, name });
  };
  const walk = (array: PDFArray): void => {
    for (const item of array.asArray()) {
      if (item instanceof PDFRef) add(item);
      else if (item instanceof PDFArray) walk(item);
    }
  };
  const d = ocProps.lookupMaybe(PDFName.of('D'), PDFDict);
  const orderArray = d?.lookupMaybe(PDFName.of('Order'), PDFArray);
  if (orderArray) walk(orderArray);
  const ocgs = ocProps.lookupMaybe(PDFName.of('OCGs'), PDFArray);
  if (ocgs) walk(ocgs);
  return out;
}

// ---- annotations -----------------------------------------------------------------------------

const RECT_TOLERANCE = 0.5;

/**
 * The annotation dictionary a planned entry names. The index is checked against the subtype and
 * rectangle before anything is written; when they disagree the array is searched for a single
 * unambiguous match, and if that fails nothing is written at all — a wrong write is worse than
 * a missing one.
 */
function annotationAt(
  ctx: PDFContext,
  annots: PDFArray,
  entry: PlannedAnnotation,
): PDFDict | undefined {
  const at = (index: number): PDFDict | undefined => {
    if (index < 0 || index >= annots.size()) return undefined;
    return ctx.lookupMaybe(annots.get(index), PDFDict);
  };
  const matches = (dict: PDFDict | undefined): boolean => {
    if (!dict) return false;
    const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
    if (subtype !== entry.subtype) return false;
    const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
    if (!rect || rect.size() < 4) return false;
    const values = [0, 1, 2, 3].map((i) => {
      const n = ctx.lookupMaybe(rect.get(i), PDFNumber);
      return n ? n.asNumber() : Number.NaN;
    });
    const [a = Number.NaN, b = Number.NaN, c = Number.NaN, d = Number.NaN] = values;
    const x0 = Math.min(a, c);
    const y0 = Math.min(b, d);
    const x1 = Math.max(a, c);
    const y1 = Math.max(b, d);
    return (
      Math.abs(x0 - entry.rect.x0) <= RECT_TOLERANCE &&
      Math.abs(y0 - entry.rect.y0) <= RECT_TOLERANCE &&
      Math.abs(x1 - entry.rect.x1) <= RECT_TOLERANCE &&
      Math.abs(y1 - entry.rect.y1) <= RECT_TOLERANCE
    );
  };

  const direct = at(entry.index);
  if (matches(direct)) return direct;
  let found: PDFDict | undefined;
  for (let i = 0; i < annots.size(); i++) {
    const candidate = at(i);
    if (!matches(candidate)) continue;
    if (found) return undefined; // ambiguous
    found = candidate;
  }
  return found;
}

/**
 * A fresh annotation dictionary, appended to the page's `/Annots` (M30, ADR 0013).
 *
 * Only `/Type`, `/Subtype` and `/Rect` are set here; everything else comes from the entry's
 * properties, entries and appearance, exactly as it does for one that already existed.
 */
function newAnnotation(ctx: PDFContext, annots: PDFArray, entry: PlannedAnnotation): PDFDict {
  const dict = ctx.obj({});
  dict.set(PDFName.of('Type'), PDFName.of('Annot'));
  dict.set(PDFName.of('Subtype'), PDFName.of(entry.subtype));
  const r = entry.rect;
  dict.set(PDFName.of('Rect'), ctx.obj([r.x0, r.y0, r.x1, r.y1]));
  annots.push(ctx.register(dict));
  return dict;
}

function applyAnnotationProperties(
  doc: PDFDocument,
  dict: PDFDict,
  entry: PlannedAnnotation,
  state: WriteState,
  references: Array<{ owner: PDFDict; key: string; name: string }> = [],
): void {
  const ctx = doc.context;
  const props = entry.properties;
  if (!props) return;
  const setText = (name: string, value: string | null | undefined): void => {
    if (value === undefined) return;
    if (value === null) dict.delete(PDFName.of(name));
    else dict.set(PDFName.of(name), PDFHexString.fromText(value));
  };
  setText('Contents', props.contents);
  setText('T', props.author);
  setText('Subj', props.subject);
  setText('NM', props.name);
  setText('State', props.state);

  const setColor = (name: string, value: number | null | undefined): void => {
    if (value === undefined) return;
    if (value === null) dict.delete(PDFName.of(name));
    else {
      dict.set(
        PDFName.of(name),
        ctx.obj([((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255]),
      );
    }
  };
  setColor('C', props.color);
  setColor('IC', props.interiorColor);

  if (props.flags !== undefined) dict.set(PDFName.of('F'), PDFNumber.of(props.flags));
  for (const [key, value] of [
    ['CreationDate', props.created],
    ['M', props.modified],
  ] as const) {
    if (value === undefined) continue;
    if (value === null) dict.delete(PDFName.of(key));
    else dict.set(PDFName.of(key), PDFString.of(isoToPdfDate(value) ?? value));
  }

  if (props.opacity !== undefined) {
    if (props.opacity === null) dict.delete(PDFName.of('CA'));
    else dict.set(PDFName.of('CA'), PDFNumber.of(props.opacity));
  }
  if (props.borderWidth !== undefined) {
    if (props.borderWidth === null) {
      dict.delete(PDFName.of('BS'));
    } else {
      const bs = dict.lookupMaybe(PDFName.of('BS'), PDFDict) ?? ctx.obj({});
      bs.set(PDFName.of('Type'), PDFName.of('Border'));
      bs.set(PDFName.of('W'), PDFNumber.of(props.borderWidth));
      dict.set(PDFName.of('BS'), bs);
    }
  }
  if (props.quadPoints !== undefined) {
    if (props.quadPoints === null) dict.delete(PDFName.of('QuadPoints'));
    else dict.set(PDFName.of('QuadPoints'), ctx.obj([...props.quadPoints]));
  }
  if (props.paths !== undefined) {
    if (props.paths === null) dict.delete(PDFName.of('InkList'));
    else {
      dict.set(
        PDFName.of('InkList'),
        ctx.obj(props.paths.map((path) => ctx.obj(flattenPoints(path)))),
      );
    }
  }
  if (props.vertices !== undefined) {
    const name = entry.subtype === 'Line' ? 'L' : 'Vertices';
    if (props.vertices === null) dict.delete(PDFName.of(name));
    else dict.set(PDFName.of(name), ctx.obj(flattenPoints(props.vertices)));
  }
  for (const [key, value] of Object.entries(props.entries ?? {})) {
    if (value === null) {
      dict.delete(PDFName.of(key));
      continue;
    }
    if (value.kind === 'dict') {
      // Merged, not replaced: `/BS /W` from the border width above has to survive a `/BS /D`.
      const existing = dictAt(ctx, dict, key) ?? ctx.obj({});
      mergeDict(ctx, existing, value.value);
      dict.set(PDFName.of(key), existing);
      continue;
    }
    if (value.kind === 'embeddedFile') {
      const spec = takeEmbeddedFile(doc, value.value);
      if (spec) dict.set(PDFName.of(key), spec);
      else state.warn(`The attached file "${value.value}" is not in the document`);
      continue;
    }
    if (value.kind === 'annotationRef') {
      // Deferred: the annotation it names may not exist yet (M32, ADR 0017).
      references.push({ owner: dict, key, name: value.value });
      continue;
    }
    dict.set(PDFName.of(key), dictValue(ctx, value));
  }
}

/**
 * Points every deferred `/IRT`-style entry at the annotation its `/NM` names (M32, ADR 0017).
 *
 * Run after the whole page has been written, so a reply to an annotation inserted in the same
 * save resolves. A name that matches nothing leaves the entry out and says so: an annotation in
 * the right place beats one carrying a reference to an object that is not there.
 */
function resolveAnnotationRefs(
  ctx: PDFContext,
  annots: PDFArray,
  references: ReadonlyArray<{ owner: PDFDict; key: string; name: string }>,
  state: WriteState,
): void {
  if (references.length === 0) return;
  const byName = new Map<string, PDFRef>();
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i);
    if (!(ref instanceof PDFRef)) continue;
    const dict = ctx.lookupMaybe(ref, PDFDict);
    const nm: unknown = dict?.get(PDFName.of('NM'));
    const name =
      nm instanceof PDFHexString || nm instanceof PDFString ? nm.decodeText() : undefined;
    if (name !== undefined && name !== '' && !byName.has(name)) byName.set(name, ref);
  }
  for (const { owner, key, name } of references) {
    const target = byName.get(name);
    if (target) owner.set(PDFName.of(key), target);
    else state.warn(`A reply's target comment "${name}" is not on the page, so it was left loose`);
  }
}

/** Writes each entry of a planned dictionary into `target`; `null` removes. */
function mergeDict(
  ctx: PDFContext,
  target: PDFDict,
  entries: Readonly<Record<string, DictValue | null>>,
): void {
  for (const [key, value] of Object.entries(entries)) {
    if (value === null) {
      target.delete(PDFName.of(key));
      continue;
    }
    if (value.kind === 'dict') {
      const nested = dictAt(ctx, target, key) ?? ctx.obj({});
      mergeDict(ctx, nested, value.value);
      target.set(PDFName.of(key), nested);
      continue;
    }
    // Both resolve against something else in the document, and only at the top level: `/FS` on
    // the annotation itself, `/IRT` on the annotation itself (M32, ADR 0017).
    if (value.kind === 'embeddedFile' || value.kind === 'annotationRef') continue;
    target.set(PDFName.of(key), dictValue(ctx, value));
  }
}

/**
 * The dictionary an entry holds, or undefined when there is none or it is something else.
 * `lookupMaybe(key, PDFDict)` would throw on the something else, and a stray `/BS 3` in a
 * file from elsewhere must not fail the whole save.
 */
function dictAt(ctx: PDFContext, owner: PDFDict, key: string): PDFDict | undefined {
  const value: unknown = ctx.lookup(owner.get(PDFName.of(key)));
  return value instanceof PDFDict ? value : undefined;
}

/** One planned dictionary entry as a pdf-lib object (M30, ADR 0013; M31 added the arrays of names). */
function dictValue(
  ctx: PDFContext,
  value: Exclude<
    DictValue,
    { kind: 'dict' } | { kind: 'embeddedFile' } | { kind: 'annotationRef' }
  >,
): PDFArray | PDFHexString | PDFName | PDFNumber {
  switch (value.kind) {
    case 'string':
      return PDFHexString.fromText(value.value);
    case 'name':
      return PDFName.of(value.value);
    case 'number':
      return PDFNumber.of(value.value);
    case 'numbers':
      return ctx.obj([...value.value]);
    case 'names':
      return ctx.obj(value.value.map((n) => PDFName.of(n)));
  }
}

/**
 * The file specification of an embedded file, taken **out of** the `/EmbeddedFiles` name tree
 * (M31, ADR 0015).
 *
 * The engine embedded the file there because that is the only place PDFium can put one; a
 * FileAttachment annotation wants it on its own `/FS` instead, and a file listed in both would
 * appear twice in every attachments panel, ours included. So the entry is removed from the tree
 * as its specification moves to the annotation. Matched by the tree's key, then by `/UF` or `/F`,
 * for the same reason `writeAttachments` does.
 */
function takeEmbeddedFile(doc: PDFDocument, name: string): PDFRef | PDFDict | null {
  const ctx = doc.context;
  const root = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const tree = root?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  if (!tree) return null;
  let found: PDFRef | PDFDict | null = null;
  const visit = (node: PDFDict, depth: number): boolean => {
    if (depth > 32) return false;
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) {
      for (const kid of kids.asArray()) {
        const child = ctx.lookupMaybe(kid, PDFDict);
        if (child && visit(child, depth + 1)) return true;
      }
      return false;
    }
    const names = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (!names) return false;
    const items = names.asArray();
    const matches = (i: number, exact: boolean): boolean => {
      const key = textValue(items[i - 1]);
      const spec = ctx.lookupMaybe(items[i], PDFDict);
      if (exact) return key === name;
      return (
        spec !== undefined &&
        (textValue(spec.lookup(PDFName.of('UF'))) === name ||
          textValue(spec.lookup(PDFName.of('F'))) === name)
      );
    };
    for (const exact of [true, false]) {
      for (let i = 1; i < items.length; i += 2) {
        if (!matches(i, exact)) continue;
        const value = items[i];
        found = value instanceof PDFRef ? value : (ctx.lookupMaybe(value, PDFDict) ?? null);
        if (found === null) return false;
        const survivors = items.filter((_v, index) => index !== i - 1 && index !== i);
        node.set(PDFName.of('Names'), ctx.obj(survivors));
        /*
         * The same tidy-up `writeAttachments` does for a tree entry (M12, ADR 0011): PDFium wrote
         * the description and the type into `/Params`, and a reader looks for them on the
         * specification and the stream. They are *copied* rather than moved, because PDFium's own
         * attachment API reads an annotation's file through `/Params` — so this app, reopening
         * the file, would otherwise lose the description it had just written.
         */
        const specValue: unknown = ctx.lookup(found);
        const spec = specValue instanceof PDFDict ? specValue : undefined;
        const ef = spec ? dictAt(ctx, spec, 'EF') : undefined;
        const streamRef = ef?.get(PDFName.of('F')) ?? ef?.get(PDFName.of('UF'));
        const streamValue: unknown = streamRef ? ctx.lookup(streamRef) : undefined;
        const stream = streamValue instanceof PDFStream ? streamValue : undefined;
        const params = stream ? dictAt(ctx, stream.dict, 'Params') : undefined;
        if (spec && params) {
          const desc = params.get(PDFName.of('Desc'));
          if (desc && spec.get(PDFName.of('Desc')) === undefined) {
            spec.set(PDFName.of('Desc'), desc);
          }
          const mime = textValue(params.lookup(PDFName.of('Subtype')));
          if (
            stream &&
            mime !== undefined &&
            mime !== '' &&
            stream.dict.get(PDFName.of('Subtype')) === undefined
          ) {
            stream.dict.set(PDFName.of('Subtype'), PDFName.of(mime));
          }
        }
        return true;
      }
    }
    return false;
  };
  visit(tree, 0);
  return found;
}

function flattenPoints(points: ReadonlyArray<PdfPoint>): number[] {
  const out: number[] = [];
  for (const p of points) out.push(p.x, p.y);
  return out;
}

/** The `/Resources` dictionary an appearance stream's content needs. */
function resourcesDict(
  ctx: PDFContext,
  spec: AppearanceResources,
  xobjects: EmbeddedXObjects,
): PDFDict {
  const resources = ctx.obj({});
  resources.set(PDFName.of('ProcSet'), ctx.obj([PDFName.of('PDF'), PDFName.of('Text')]));
  const gsNames = Object.entries(spec.extGState);
  if (gsNames.length > 0) {
    const gs = ctx.obj({});
    for (const [name, g] of gsNames) {
      const state = ctx.obj({});
      state.set(PDFName.of('Type'), PDFName.of('ExtGState'));
      if (g.fillAlpha !== undefined) state.set(PDFName.of('ca'), PDFNumber.of(g.fillAlpha));
      if (g.strokeAlpha !== undefined) state.set(PDFName.of('CA'), PDFNumber.of(g.strokeAlpha));
      if (g.blendMode !== undefined) state.set(PDFName.of('BM'), PDFName.of(g.blendMode));
      gs.set(PDFName.of(name), state);
    }
    resources.set(PDFName.of('ExtGState'), gs);
  }
  const fontNames = Object.entries(spec.fonts);
  if (fontNames.length > 0) {
    const fonts = ctx.obj({});
    for (const [name, font] of fontNames) {
      fonts.set(PDFName.of(name), ctx.register(fontDict(ctx, font)));
    }
    resources.set(PDFName.of('Font'), fonts);
  }
  const xobjectNames = Object.entries(spec.xobjects ?? {});
  if (xobjectNames.length > 0) {
    const forms = ctx.obj({});
    for (const [name, key] of xobjectNames) {
      const ref = xobjects.get(key);
      // Every stream reaching here was checked by `xobjectsResolve`; the guard is for the types.
      if (ref) forms.set(PDFName.of(name), ref);
    }
    resources.set(PDFName.of('XObject'), forms);
  }
  return resources;
}

/** Writes a generated stream as the annotation's `/AP /N`. */
function attachAppearance(
  ctx: PDFContext,
  dict: PDFDict,
  stream: AppearanceStream,
  xobjects: EmbeddedXObjects,
): void {
  const resources = resourcesDict(ctx, stream.resources, xobjects);
  const bbox = stream.bbox;
  const form = ctx.flateStream(stream.content, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
  });
  form.dict.set(PDFName.of('BBox'), ctx.obj([bbox.x0, bbox.y0, bbox.x1, bbox.y1]));
  form.dict.set(PDFName.of('Matrix'), ctx.obj([...(stream.matrix ?? [1, 0, 0, 1, 0, 0])]));
  form.dict.set(PDFName.of('Resources'), resources);

  const ap = ctx.obj({});
  ap.set(PDFName.of('N'), ctx.register(form));
  dict.set(PDFName.of('AP'), ap);
  // An `/AS` naming a state that our single `/N` stream does not have would hide the appearance.
  dict.delete(PDFName.of('AS'));
}

/**
 * A font resource for an appearance stream: one of the standard 14 as a Type1, or a family the
 * reader chose from the system list as a non-embedded TrueType (M30, ADR 0013). Nothing is
 * embedded — there is no subsetter here before M51 — so a viewer resolves the name through its
 * own substitution table, which for PDFium (ours and Chrome's) is the bundled Liberation/DejaVu
 * set.
 */
function fontDict(ctx: PDFContext, font: AppearanceFont): PDFDict {
  const dict = ctx.obj({});
  dict.set(PDFName.of('Type'), PDFName.of('Font'));
  if (isNonEmbeddedFont(font)) {
    dict.set(PDFName.of('Subtype'), PDFName.of('TrueType'));
    dict.set(PDFName.of('BaseFont'), PDFName.of(pdfNameOf(font.baseFont)));
    dict.set(PDFName.of('Encoding'), PDFName.of('WinAnsiEncoding'));
    return dict;
  }
  dict.set(PDFName.of('Subtype'), PDFName.of('Type1'));
  dict.set(PDFName.of('BaseFont'), PDFName.of(font));
  // Symbol and ZapfDingbats carry their own built-in encoding and must not be re-encoded.
  if (font !== 'Symbol' && font !== 'ZapfDingbats') {
    dict.set(PDFName.of('Encoding'), PDFName.of('WinAnsiEncoding'));
  }
  return dict;
}

/** A family name as a PDF name: no delimiters, no whitespace, never empty. */
function pdfNameOf(family: string): string {
  const cleaned = family.replace(/[^A-Za-z0-9+.-]/g, '');
  return cleaned === '' ? 'Helvetica' : cleaned;
}

// ---- form fields -----------------------------------------------------------------------------

/**
 * Writes `/V` on the named fields. Clearing a value drops the widgets' `/AP` and sets
 * `/NeedAppearances`, because a stale appearance stream would go on showing the text that is no
 * longer there.
 */
function writeFieldValues(
  doc: PDFDocument,
  fields: ReadonlyArray<{ name: string; value: string | null }>,
  state: WriteState,
): void {
  const ctx = doc.context;
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acroForm) {
    state.warn('The file has no form, so field values could not be saved');
    return;
  }
  const byName = new Map<string, PDFDict>();
  const walk = (array: PDFArray | undefined, prefix: string): void => {
    if (!array) return;
    for (let i = 0; i < array.size(); i++) {
      const dict = ctx.lookupMaybe(array.get(i), PDFDict);
      if (!dict) continue;
      const raw = dict.lookup(PDFName.of('T'));
      const partial =
        raw instanceof PDFString || raw instanceof PDFHexString ? raw.decodeText() : '';
      const name = partial === '' ? prefix : prefix === '' ? partial : `${prefix}.${partial}`;
      if (partial !== '' && !byName.has(name)) byName.set(name, dict);
      walk(dict.lookupMaybe(PDFName.of('Kids'), PDFArray), name);
    }
  };
  walk(acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray), '');

  let cleared = false;
  for (const field of fields) {
    const dict = byName.get(field.name);
    if (!dict) {
      state.warn(`The field "${field.name}" is not in the file, so its value was not saved`);
      continue;
    }
    if (field.value === null) {
      dict.delete(PDFName.of('V'));
      cleared = true;
      dropWidgetAppearances(ctx, dict);
    } else {
      dict.set(PDFName.of('V'), PDFHexString.fromText(field.value));
    }
  }
  if (cleared) acroForm.set(PDFName.of('NeedAppearances'), ctx.obj(true));
}

function dropWidgetAppearances(ctx: PDFContext, field: PDFDict): void {
  const drop = (dict: PDFDict): void => {
    const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
    if (subtype === 'Widget' || dict.get(PDFName.of('Rect')) !== undefined) {
      dict.delete(PDFName.of('AP'));
    }
    const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (!kids) return;
    for (let i = 0; i < kids.size(); i++) {
      const kid = ctx.lookupMaybe(kids.get(i), PDFDict);
      if (kid) drop(kid);
    }
  };
  drop(field);
}
