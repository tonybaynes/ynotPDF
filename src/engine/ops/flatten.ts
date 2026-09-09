/**
 * Flatten — bake annotations and form fields into the page (M41). Pure over bytes.
 *
 * An annotation is drawn by its **appearance stream**: a form XObject, held under `/AP /N`, with
 * its own `/BBox` and `/Matrix`. Flattening is therefore not a rendering job at all — nothing is
 * rasterised, no text is re-encoded and no image is touched. The appearance stream is added to
 * the page's `/Resources /XObject` and invoked from the page's content with the transformation
 * PDF 12.5.5 specifies, and then the annotation is removed. What the page looked like before is
 * exactly what it looks like after, at any zoom, in any reader.
 *
 * The algorithm from 12.5.5, "Appearance streams", in the order the spec gives it:
 *
 * 1. Map the appearance's `/BBox` through its `/Matrix` and take the bounding box of the result.
 * 2. Work out the matrix `A` that maps that bounding box onto the annotation's `/Rect`.
 * 3. Draw with `A × Matrix` — here, `A` is concatenated by the `cm` and `/Matrix` is applied by
 *    the form XObject itself, so the content only needs `A`.
 *
 * What is *not* drawn: hidden annotations and NoView annotations, which are invisible on screen
 * and would appear out of nowhere; Popup windows, which are a viewer's note window rather than
 * a mark on the page; and Link annotations, which have no appearance and whose whole content is
 * the action — flattening a link would silently delete it, so links are kept.
 */

import type { PDFDocument } from 'pdf-lib';
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFPage,
} from 'pdf-lib';
import type { PdfRect } from '@shared/pdf';
import type { AnnotationSubtype } from '../PdfEngine';
import { appearanceInput, createAppearanceService } from '../appearance';
import { colorArrayToRgb } from '../pdfium/rawdoc';
import { loadPdf, savePdf } from './pdfdoc';
import { OpFailed, checkCancelled, type OpContext, type OpResult } from './types';

export interface FlattenOptions {
  /** Which pages, 0-based. Absent means every page. */
  readonly pages?: ReadonlyArray<number>;
  /** Bake markup annotations (notes, highlights, shapes, stamps, ink). Default true. */
  readonly annotations?: boolean;
  /** Bake form fields. Default true. */
  readonly forms?: boolean;
  /**
   * Remove instead of baking — Foxit's "remove annotations" option. The page loses the marks
   * rather than gaining them as content.
   */
  readonly remove?: boolean;
  /**
   * Regenerates the appearance stream of a widget that has none, when the host can (M61).
   * Without it, a field with no `/AP` is reported as skipped rather than silently lost.
   */
  readonly appearances?: (field: FieldNeedingAppearance) => Promise<Uint8Array | null>;
}

/** A widget the flattener could not draw because the file gave it no appearance stream (M61). */
export interface FieldNeedingAppearance {
  readonly page: number;
  readonly rect: PdfRect;
  readonly fieldName: string;
  readonly fieldType: string;
  readonly value: string;
}

export interface FlattenResult extends OpResult {
  /** How many annotations were baked into page content. */
  readonly flattened: number;
  /** How many were removed without being drawn (hidden, or `remove` was on). */
  readonly removed: number;
}

/** Subtypes that are never baked: a popup is a window, a link is an action, not a mark. */
const NEVER_FLATTEN = new Set(['/Popup', '/Link']);

export async function flatten(
  bytes: Uint8Array,
  options: FlattenOptions = {},
  ctx: OpContext = {},
): Promise<FlattenResult> {
  const doc = await loadPdf(bytes, 'The document');
  const pages = doc.getPages();
  if (pages.length === 0) throw new OpFailed('The document has no pages to flatten');
  const doAnnotations = options.annotations !== false;
  const doForms = options.forms !== false;
  const wanted =
    options.pages && options.pages.length > 0
      ? [...new Set(options.pages)].filter((p) => p >= 0 && p < pages.length).sort((a, b) => a - b)
      : pages.map((_, i) => i);
  const warnings: string[] = [];
  let flattened = 0;
  let removed = 0;
  /** Widgets that survived, so `/AcroForm` is only dropped when none is left. */
  let widgetsLeft = 0;

  for (const [i, index] of wanted.entries()) {
    checkCancelled(ctx.signal);
    ctx.progress?.(i / wanted.length, `Flattening page ${String(index + 1)}`);
    const page = pages[index];
    if (!page) continue;
    const outcome = await flattenPage(doc, page, index, {
      annotations: doAnnotations,
      forms: doForms,
      remove: options.remove === true,
      ...(options.appearances ? { appearances: options.appearances } : {}),
    });
    flattened += outcome.flattened;
    removed += outcome.removed;
    widgetsLeft += outcome.widgetsLeft;
    warnings.push(...outcome.warnings);
  }

  // Pages outside the range may still carry widgets; only an empty document loses its form.
  if (doForms) {
    for (const [index, page] of pages.entries()) {
      if (wanted.includes(index)) continue;
      widgetsLeft += countWidgets(doc.context, page);
    }
    if (widgetsLeft === 0) {
      doc.catalog.delete(PDFName.of('AcroForm'));
      // `/NeedAppearances` without an `/AcroForm` is meaningless, and some readers trip on it.
      doc.catalog.delete(PDFName.of('NeedAppearances'));
    } else {
      pruneAcroFormFields(doc);
    }
  }

  ctx.progress?.(1, 'Done');
  return {
    bytes: await savePdf(doc),
    pageCount: pages.length,
    flattened,
    removed,
    warnings,
  };
}

interface PageOutcome {
  flattened: number;
  removed: number;
  widgetsLeft: number;
  warnings: string[];
}

async function flattenPage(
  doc: PDFDocument,
  page: PDFPage,
  pageIndex: number,
  options: {
    annotations: boolean;
    forms: boolean;
    remove: boolean;
    appearances?: (field: FieldNeedingAppearance) => Promise<Uint8Array | null>;
  },
): Promise<PageOutcome> {
  const ctx = doc.context;
  const out: PageOutcome = { flattened: 0, removed: 0, widgetsLeft: 0, warnings: [] };
  const annots = page.node.Annots();
  if (!annots || annots.size() === 0) return out;

  const survivors: Array<PDFRef | PDFDict> = [];
  const operators: string[] = [];
  const resources: Array<{ name: string; ref: PDFRef }> = [];
  let serial = 0;

  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i);
    const dict = ctx.lookupMaybe(raw, PDFDict);
    if (!dict) continue;
    const keep = (): void => {
      survivors.push(raw instanceof PDFRef ? raw : dict);
    };
    const subtype = ctx.lookupMaybe(dict.get(PDFName.of('Subtype')), PDFName)?.asString() ?? '';
    const isWidget = subtype === '/Widget';
    if (isWidget ? !options.forms : !options.annotations) {
      if (isWidget) out.widgetsLeft++;
      keep();
      continue;
    }
    if (NEVER_FLATTEN.has(subtype)) {
      // A popup goes with its parent note; a link stays a link.
      if (subtype === '/Popup' && options.annotations) out.removed++;
      else keep();
      continue;
    }

    const flags = ctx.lookupMaybe(dict.get(PDFName.of('F')), PDFNumber)?.asNumber() ?? 0;
    const hidden = (flags & 2) !== 0 || (flags & 32) !== 0;
    if (options.remove || hidden) {
      out.removed++;
      continue;
    }

    let appearance = normalAppearance(ctx, dict);
    if (appearance === 'nothing') {
      // An unticked box, or a state with nothing in it: the mark is already invisible, so
      // "bake what it looks like" is satisfied by removing it.
      out.removed++;
      continue;
    }
    if (!appearance && isWidget && options.appearances) {
      const drawn = await options.appearances(describeField(ctx, dict, pageIndex));
      if (drawn) appearance = embedAppearance(doc, dict, drawn);
    }
    if (!appearance && !isWidget) appearance = drawItOurselves(doc, dict, subtype);
    if (!appearance) {
      out.warnings.push(
        `An annotation on page ${String(pageIndex + 1)} has no drawing of its own, so it was left as it is`,
      );
      if (isWidget) out.widgetsLeft++;
      keep();
      continue;
    }

    const rect = rectOf(ctx, dict);
    if (!rect) {
      out.warnings.push(
        `An annotation on page ${String(pageIndex + 1)} has no position, so it was left as it is`,
      );
      if (isWidget) out.widgetsLeft++;
      keep();
      continue;
    }

    const name = `Fx${String(pageIndex)}_${String(serial++)}`;
    resources.push({ name, ref: appearance.ref });
    const m = placementMatrix(ctx, appearance.stream, rect);
    operators.push(
      `q ${num(m[0])} ${num(m[1])} ${num(m[2])} ${num(m[3])} ${num(m[4])} ${num(m[5])} cm /${name} Do Q`,
    );
    out.flattened++;
  }

  if (operators.length > 0) {
    for (const entry of resources) addXObject(page, entry.name, entry.ref);
    // Wrapped in its own q/Q pair as well, so an unbalanced page content stream cannot leak its
    // graphics state into the marks we are adding.
    appendContent(doc, page, `\nq\n${operators.join('\n')}\nQ\n`);
  }

  if (survivors.length !== annots.size()) {
    if (survivors.length === 0) page.node.delete(PDFName.of('Annots'));
    else page.node.set(PDFName.of('Annots'), ctx.obj(survivors));
  }
  return out;
}

/**
 * What the file says an annotation looks like.
 *
 * Three answers, not two. `'nothing'` is the one that matters: an unticked checkbox names an
 * appearance state — usually `/Off` — that its `/AP /N` dictionary has no entry for, and that
 * means "draw nothing", not "we could not work it out". Treating the two the same would leave
 * every unticked box on the page as a live field after a flatten.
 */
type Appearance = { stream: PDFStream; ref: PDFRef } | 'nothing' | null;

function normalAppearance(ctx: PDFContext, annot: PDFDict): Appearance {
  const ap = ctx.lookupMaybe(annot.get(PDFName.of('AP')), PDFDict);
  if (!ap) return null;
  const raw = ap.get(PDFName.of('N'));
  if (raw === undefined) return null;
  const resolved = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
  if (resolved instanceof PDFStream) {
    return raw instanceof PDFRef ? { stream: resolved, ref: raw } : null;
  }
  if (!(resolved instanceof PDFDict)) return null;
  const state = ctx.lookupMaybe(annot.get(PDFName.of('AS')), PDFName);
  const entries = resolved.entries();
  if (state) {
    const chosen = entries.find(([key]) => key.asString() === state.asString());
    if (!chosen) return 'nothing';
    const value = chosen[1];
    if (!(value instanceof PDFRef)) return null;
    const stream = ctx.lookup(value);
    return stream instanceof PDFStream ? { stream, ref: value } : null;
  }
  if (entries.length === 0) return 'nothing';
  if (entries.length > 1) return null;
  const value = entries[0]?.[1];
  if (!(value instanceof PDFRef)) return null;
  const stream = ctx.lookup(value);
  return stream instanceof PDFStream ? { stream, ref: value } : null;
}

/** `/Rect`, normalised. */
function rectOf(ctx: PDFContext, annot: PDFDict): PdfRect | null {
  const array = ctx.lookupMaybe(annot.get(PDFName.of('Rect')), PDFArray);
  if (!array || array.size() < 4) return null;
  const at = (i: number): number =>
    ctx.lookupMaybe(array.get(i), PDFNumber)?.asNumber() ?? Number.NaN;
  const [left, right] = [at(0), at(2)];
  const [bottom, top] = [at(1), at(3)];
  if (![left, right, bottom, top].every((n) => Number.isFinite(n))) return null;
  return {
    x0: Math.min(left, right),
    x1: Math.max(left, right),
    y0: Math.min(bottom, top),
    y1: Math.max(bottom, top),
  };
}

/**
 * The matrix `A` of PDF 12.5.5: the appearance's transformed `/BBox` mapped onto `/Rect`.
 *
 * A degenerate bounding box (zero width or height, which a badly written stamp can have) maps to
 * a translation only, because scaling by infinity would put the mark somewhere absurd.
 */
export function placementMatrix(
  ctx: PDFContext,
  stream: PDFStream,
  rect: PdfRect,
): [number, number, number, number, number, number] {
  const dict = stream.dict;
  const bboxArray = ctx.lookupMaybe(dict.get(PDFName.of('BBox')), PDFArray);
  if (!bboxArray || bboxArray.size() < 4) return [1, 0, 0, 1, 0, 0];
  const n = (i: number): number => ctx.lookupMaybe(bboxArray.get(i), PDFNumber)?.asNumber() ?? 0;
  const bbox: PdfRect = {
    x0: Math.min(n(0), n(2)),
    y0: Math.min(n(1), n(3)),
    x1: Math.max(n(0), n(2)),
    y1: Math.max(n(1), n(3)),
  };
  const matrixArray = ctx.lookupMaybe(dict.get(PDFName.of('Matrix')), PDFArray);
  const m: number[] = matrixArray
    ? Array.from(
        { length: 6 },
        (_, i) =>
          ctx.lookupMaybe(matrixArray.get(i), PDFNumber)?.asNumber() ??
          (i === 0 || i === 3 ? 1 : 0),
      )
    : [1, 0, 0, 1, 0, 0];

  const at = (i: number): number => m[i] ?? 0;
  const corners: Array<[number, number]> = (
    [
      [bbox.x0, bbox.y0],
      [bbox.x1, bbox.y0],
      [bbox.x1, bbox.y1],
      [bbox.x0, bbox.y1],
    ] as Array<[number, number]>
  ).map(([x, y]): [number, number] => [
    at(0) * x + at(2) * y + at(4),
    at(1) * x + at(3) * y + at(5),
  ]);
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const sx = width > 1e-6 ? (rect.x1 - rect.x0) / width : 1;
  const sy = height > 1e-6 ? (rect.y1 - rect.y0) / height : 1;
  return [sx, 0, 0, sy, rect.x0 - Math.min(...xs) * sx, rect.y0 - Math.min(...ys) * sy];
}

/** Registers an XObject on a page under a name, creating `/Resources /XObject` if needed. */
function addXObject(page: PDFPage, name: string, ref: PDFRef): void {
  const ctx = page.doc.context;
  const leaf = page.node;
  let resources = ctx.lookupMaybe(leaf.get(PDFName.of('Resources')), PDFDict);
  if (!resources) {
    // Do not write into an inherited `/Resources`: it belongs to every page under that node.
    const inherited = ctx.lookupMaybe(
      leaf.getInheritableAttribute(PDFName.of('Resources')),
      PDFDict,
    );
    resources = ctx.obj({});
    if (inherited) for (const [key, value] of inherited.entries()) resources.set(key, value);
    leaf.set(PDFName.of('Resources'), resources);
  }
  let xobjects = ctx.lookupMaybe(resources.get(PDFName.of('XObject')), PDFDict);
  if (!xobjects) {
    xobjects = ctx.obj({});
    resources.set(PDFName.of('XObject'), xobjects);
  }
  xobjects.set(PDFName.of(name), ref);
}

/** Appends a content stream to a page, turning a single `/Contents` stream into an array first. */
export function appendContent(doc: PDFDocument, page: PDFPage, content: string): void {
  const ctx = doc.context;
  const ref = ctx.register(ctx.flateStream(content));
  const key = PDFName.of('Contents');
  const existing = page.node.get(key);
  const asArray = ctx.lookupMaybe(existing, PDFArray);
  if (asArray) {
    asArray.push(ref);
    return;
  }
  page.node.set(key, existing === undefined ? ctx.obj([ref]) : ctx.obj([existing, ref]));
}

/**
 * Draws an annotation the file never drew, using the same generators M21's writer uses.
 *
 * Plenty of files — including ones this app has not saved yet — carry a highlight or a square
 * with no `/AP` at all, and leave the drawing to the viewer. Flattening such a file has to draw
 * it, or "flatten" means "leave most of the marks as marks". Using the shared generators means
 * what gets baked is exactly what M21 would have written into the file on the next save, so a
 * flatten and a save do not disagree about what a highlight looks like.
 *
 * Only streams whose resources are `/ExtGState` are taken: fonts and shared XObjects are the
 * writer's business (it embeds and de-duplicates them across the whole document, ADR 0015), and
 * half-embedding one here would be a second, worse implementation. Those annotations are kept
 * and reported instead.
 */
function drawItOurselves(
  doc: PDFDocument,
  annot: PDFDict,
  subtype: string,
): { stream: PDFStream; ref: PDFRef } | null {
  const ctx = doc.context;
  const rect = rectOf(ctx, annot);
  if (!rect) return null;
  const kind = subtype.replace(/^\//, '') as AnnotationSubtype;
  if (!APPEARANCES.has(kind)) return null;
  const generated = APPEARANCES.generate(
    appearanceInput({
      subtype: kind,
      rect,
      color: readColorEntry(ctx, annot, 'C'),
      interiorColor: readColorEntry(ctx, annot, 'IC'),
      opacity: ctx.lookupMaybe(annot.get(PDFName.of('CA')), PDFNumber)?.asNumber() ?? null,
      borderWidth: borderWidthOf(ctx, annot),
      quadPoints: numbersOf(ctx, annot, 'QuadPoints'),
      vertices: pointsOf(numbersOf(ctx, annot, 'Vertices')),
      paths: inkPathsOf(ctx, annot),
      contents: null,
    }),
  );
  if (!generated) return null;
  const { fonts, xobjects } = generated.resources;
  if (Object.keys(fonts).length > 0 || Object.keys(xobjects ?? {}).length > 0) return null;

  const extGState = ctx.obj({});
  for (const [name, spec] of Object.entries(generated.resources.extGState)) {
    const entries: Record<string, number | string> = {};
    if (spec.fillAlpha !== undefined) entries['ca'] = spec.fillAlpha;
    if (spec.strokeAlpha !== undefined) entries['CA'] = spec.strokeAlpha;
    if (spec.blendMode !== undefined) entries['BM'] = spec.blendMode;
    extGState.set(PDFName.of(name), ctx.obj(entries));
  }
  const stream = ctx.flateStream(generated.content, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [generated.bbox.x0, generated.bbox.y0, generated.bbox.x1, generated.bbox.y1],
    ...(generated.matrix ? { Matrix: [...generated.matrix] } : {}),
    Resources: ctx.obj({ ExtGState: extGState }),
  });
  return { stream, ref: ctx.register(stream) };
}

const APPEARANCES = /* @__PURE__ */ createAppearanceService();

/** A `/C`- or `/IC`-style colour array as `0xRRGGBB`. */
function readColorEntry(ctx: PDFContext, annot: PDFDict, key: string): number | null {
  const array = ctx.lookupMaybe(annot.get(PDFName.of(key)), PDFArray);
  if (!array) return null;
  const components: number[] = [];
  for (let i = 0; i < array.size(); i++) {
    components.push(ctx.lookupMaybe(array.get(i), PDFNumber)?.asNumber() ?? 0);
  }
  return colorArrayToRgb(components) ?? null;
}

/** `/BS /W`, falling back to the old `/Border` array's third number. */
function borderWidthOf(ctx: PDFContext, annot: PDFDict): number | null {
  const bs = ctx.lookupMaybe(annot.get(PDFName.of('BS')), PDFDict);
  const width = bs ? ctx.lookupMaybe(bs.get(PDFName.of('W')), PDFNumber) : undefined;
  if (width) return width.asNumber();
  const border = ctx.lookupMaybe(annot.get(PDFName.of('Border')), PDFArray);
  if (!border || border.size() < 3) return null;
  return ctx.lookupMaybe(border.get(2), PDFNumber)?.asNumber() ?? null;
}

function numbersOf(ctx: PDFContext, annot: PDFDict, key: string): number[] {
  const array = ctx.lookupMaybe(annot.get(PDFName.of(key)), PDFArray);
  if (!array) return [];
  const out: number[] = [];
  for (let i = 0; i < array.size(); i++) {
    out.push(ctx.lookupMaybe(array.get(i), PDFNumber)?.asNumber() ?? 0);
  }
  return out;
}

function pointsOf(numbers: ReadonlyArray<number>): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    out.push({ x: numbers[i] ?? 0, y: numbers[i + 1] ?? 0 });
  }
  return out;
}

function inkPathsOf(ctx: PDFContext, annot: PDFDict): Array<Array<{ x: number; y: number }>> {
  const list = ctx.lookupMaybe(annot.get(PDFName.of('InkList')), PDFArray);
  if (!list) return [];
  const out: Array<Array<{ x: number; y: number }>> = [];
  for (let i = 0; i < list.size(); i++) {
    const path = ctx.lookupMaybe(list.get(i), PDFArray);
    if (!path) continue;
    const numbers: number[] = [];
    for (let j = 0; j < path.size(); j++) {
      numbers.push(ctx.lookupMaybe(path.get(j), PDFNumber)?.asNumber() ?? 0);
    }
    out.push(pointsOf(numbers));
  }
  return out;
}

/** Puts a caller-supplied appearance stream on a widget and returns it (M61's hook). */
function embedAppearance(
  doc: PDFDocument,
  annot: PDFDict,
  content: Uint8Array,
): { stream: PDFStream; ref: PDFRef } | null {
  const ctx = doc.context;
  const rect = rectOf(ctx, annot);
  if (!rect) return null;
  const stream = ctx.flateStream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, rect.x1 - rect.x0, rect.y1 - rect.y0],
    Resources: ctx.obj({}),
  });
  const ref = ctx.register(stream);
  const ap = ctx.obj({});
  ap.set(PDFName.of('N'), ref);
  annot.set(PDFName.of('AP'), ap);
  return { stream, ref };
}

function describeField(ctx: PDFContext, annot: PDFDict, page: number): FieldNeedingAppearance {
  const text = (key: string): string => {
    const value = annot.get(PDFName.of(key));
    const resolved = value instanceof PDFRef ? ctx.lookup(value) : value;
    return resolved && 'decodeText' in resolved && typeof resolved.decodeText === 'function'
      ? (resolved as { decodeText(): string }).decodeText()
      : '';
  };
  return {
    page,
    rect: rectOf(ctx, annot) ?? { x0: 0, y0: 0, x1: 0, y1: 0 },
    fieldName: text('T'),
    fieldType: ctx.lookupMaybe(annot.get(PDFName.of('FT')), PDFName)?.asString() ?? '',
    value: text('V'),
  };
}

function countWidgets(ctx: PDFContext, page: PDFPage): number {
  const annots = page.node.Annots();
  if (!annots) return 0;
  let n = 0;
  for (let i = 0; i < annots.size(); i++) {
    const dict = ctx.lookupMaybe(annots.get(i), PDFDict);
    if (!dict) continue;
    if (ctx.lookupMaybe(dict.get(PDFName.of('Subtype')), PDFName)?.asString() === '/Widget') n++;
  }
  return n;
}

/**
 * Drops `/AcroForm /Fields` entries whose widgets have all gone.
 *
 * A field left in the tree with no widget is a field no reader can fill and every validator
 * complains about; leaving it would be the difference between "flattened" and "looks flattened".
 */
function pruneAcroFormFields(doc: PDFDocument): void {
  const ctx = doc.context;
  const form = ctx.lookupMaybe(doc.catalog.get(PDFName.of('AcroForm')), PDFDict);
  if (!form) return;
  const fields = ctx.lookupMaybe(form.get(PDFName.of('Fields')), PDFArray);
  if (!fields) return;
  const live = new Set<string>();
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      if (raw instanceof PDFRef) live.add(raw.toString());
      const dict = ctx.lookupMaybe(raw, PDFDict);
      const parent = dict?.get(PDFName.of('Parent'));
      if (parent instanceof PDFRef) live.add(parent.toString());
    }
  }
  const kept = [];
  for (let i = 0; i < fields.size(); i++) {
    const raw = fields.get(i);
    if (raw instanceof PDFRef && !live.has(raw.toString())) continue;
    kept.push(raw);
  }
  if (kept.length === fields.size()) return;
  if (kept.length === 0) {
    doc.catalog.delete(PDFName.of('AcroForm'));
    return;
  }
  form.set(PDFName.of('Fields'), ctx.obj(kept));
}

/** A number as a content stream wants it: no exponent, no more precision than a point needs. */
function num(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 1e6) / 1e6;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(6).replace(/0+$/, '');
}
