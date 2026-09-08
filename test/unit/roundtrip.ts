/**
 * Round-trip comparison harness (M21).
 *
 * Opens two documents in the real engine and reports every way they differ: page count, sizes,
 * rotation, boxes, text, annotations, form fields, the outline, named destinations, layers,
 * attachments and metadata. A save that changes nothing should produce zero differences, and a
 * save that changes one thing should produce exactly that one.
 *
 * This is the shared harness the brief asks for: **every later module adds cases to it** rather
 * than writing its own comparison. Add a field to a `describe*` function and the whole suite —
 * M21's writer, M40's page surgery, M80's incremental updates — starts checking it.
 *
 * Not a test file itself (no `.test.ts`), so vitest imports it rather than running it.
 */

import type {
  Annotation,
  Attachment,
  DocHandle,
  FormField,
  Layer,
  Metadata,
  NamedDestination,
  OutlineItem,
  PdfEngine,
} from '@engine/PdfEngine';
import type { PdfRect } from '@shared/pdf';

/** One way two documents differ. `path` is a dotted address into the description. */
export interface Difference {
  readonly path: string;
  readonly a: unknown;
  readonly b: unknown;
}

export interface CompareOptions {
  /** Password for `a`, if it needs one. */
  readonly passwordA?: string;
  readonly passwordB?: string;
  /**
   * Paths to skip, as prefixes. `"metadata.producer"` skips that field;
   * `"page.3"` skips everything about the fourth page.
   */
  readonly ignore?: ReadonlyArray<string>;
  /** Absolute tolerance for coordinates and sizes, in points. Default 0.01. */
  readonly tolerance?: number;
  /**
   * Per-field tolerance, keyed by the last named segment of a path. Defaults give colours ±1:
   * PDFium serialises `0.9` as `0.89999998`, which is 229 rather than 230 when a channel is
   * turned back into a byte. The drift is one count, invisible, and comes from the engine's own
   * float formatting rather than from anything we wrote.
   */
  readonly tolerances?: Readonly<Record<string, number>>;
  /** Compare page text as well (slower; on by default). */
  readonly text?: boolean;
}

/** Everything the harness knows how to look at, as plain JSON-comparable values. */
export interface DocumentDescription {
  readonly pageCount: number;
  readonly pages: ReadonlyArray<Record<string, unknown>>;
  readonly fields: ReadonlyArray<Record<string, unknown>>;
  readonly outline: ReadonlyArray<Record<string, unknown>>;
  readonly destinations: ReadonlyArray<Record<string, unknown>>;
  readonly layers: ReadonlyArray<Record<string, unknown>>;
  readonly attachments: ReadonlyArray<Record<string, unknown>>;
  readonly metadata: Record<string, unknown>;
}

const DEFAULT_TOLERANCE = 0.01;

/**
 * Fields measured with their own tolerance. Colours are compared channel by channel and allowed
 * to drift by one count: PDFium writes `0.9` as `0.89999998`, and a byte turned back from that is
 * 229 where it was 230. That is the engine's float formatting, not anything the writer did, and
 * it is invisible — but it is real, so it is stated here rather than hidden in a fuzzy match.
 */
const DEFAULT_TOLERANCES: Readonly<Record<string, number>> = { r: 1, g: 1, b: 1 };

/** `0xRRGGBB` as separate channels, so a per-channel tolerance means what it says. */
function colour(value: number | null | undefined): Record<string, number> | null {
  if (value === null || value === undefined) return null;
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

/** Describes one open document. Exported so a test can look at one side on its own. */
export async function describeDocument(
  engine: PdfEngine,
  handle: DocHandle,
  options: { readonly text?: boolean } = {},
): Promise<DocumentDescription> {
  const pageCount = await engine.pageCount(handle);
  const labels = await engine.pageLabels(handle).catch(() => [] as ReadonlyArray<string>);
  const pages: Record<string, unknown>[] = [];
  for (let i = 0; i < pageCount; i++) {
    const size = await engine.pageSize(handle, i);
    const annotations = await engine.annotations(handle, i).catch(() => [] as Annotation[]);
    const page: Record<string, unknown> = {
      label: labels[i] ?? String(i + 1),
      width: size.width,
      height: size.height,
      rotation: size.rotation,
      mediaBox: rect(size.mediaBox),
      cropBox: rect(size.cropBox),
      annotations: annotations.map(describeAnnotation),
    };
    if (options.text !== false) {
      const runs = await engine.textRuns(handle, i).catch(() => []);
      page['text'] = runs
        .map((r) => r.text)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
    }
    pages.push(page);
  }

  const fields = (await engine.formFields(handle).catch(() => [] as FormField[])).map(
    describeField,
  );
  const outline = flattenOutline(await engine.outline(handle).catch(() => [] as OutlineItem[]));
  const destinations = (
    await engine.namedDestinations(handle).catch(() => [] as NamedDestination[])
  )
    .map(describeNamedDestination)
    .sort((x, y) => String(x['name']).localeCompare(String(y['name'])));
  const layers = (await engine.layers(handle).catch(() => [] as Layer[])).map(describeLayer);
  const attachments = (await engine.attachments(handle).catch(() => [] as Attachment[])).map(
    describeAttachment,
  );
  const metadata = describeMetadata(await engine.metadata(handle));

  return { pageCount, pages, fields, outline, destinations, layers, attachments, metadata };
}

/** Opens both files and diffs them. An empty array means they are the same document. */
export async function compareDocuments(
  engine: PdfEngine,
  a: Uint8Array,
  b: Uint8Array,
  options: CompareOptions = {},
): Promise<Difference[]> {
  const handleA = await engine.open(a, {
    ...(options.passwordA === undefined ? {} : { password: options.passwordA }),
  });
  let handleB: DocHandle;
  try {
    handleB = await engine.open(b, {
      ...(options.passwordB === undefined ? {} : { password: options.passwordB }),
    });
  } catch (error) {
    await engine.close(handleA);
    throw error;
  }
  try {
    const left = await describeDocument(engine, handleA, {
      ...(options.text === undefined ? {} : { text: options.text }),
    });
    const right = await describeDocument(engine, handleB, {
      ...(options.text === undefined ? {} : { text: options.text }),
    });
    return diffDescriptions(left, right, options);
  } finally {
    await engine.close(handleA);
    await engine.close(handleB);
  }
}

/** Diffs two descriptions. Split out so a test can describe once and compare many times. */
export function diffDescriptions(
  a: DocumentDescription,
  b: DocumentDescription,
  options: CompareOptions = {},
): Difference[] {
  const differences: Difference[] = [];
  const ignore = options.ignore ?? [];
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const tolerances = { ...DEFAULT_TOLERANCES, ...options.tolerances };
  const ignored = (path: string): boolean =>
    ignore.some((prefix) => path === prefix || path.startsWith(`${prefix}.`));

  const walk = (path: string, left: unknown, right: unknown, field: string): void => {
    if (ignored(path)) return;
    if (typeof left === 'number' && typeof right === 'number') {
      const allowed = tolerances[field] ?? tolerance;
      if (Math.abs(left - right) > allowed) differences.push({ path, a: left, b: right });
      return;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) {
        differences.push({ path: `${path}.length`, a: left.length, b: right.length });
      }
      const n = Math.min(left.length, right.length);
      // An index is not a field name: `annotations.0.color` still measures as a colour.
      for (let i = 0; i < n; i++) walk(`${path}.${i}`, left[i], right[i], field);
      return;
    }
    if (isRecord(left) && isRecord(right)) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const key of [...keys].sort()) walk(`${path}.${key}`, left[key], right[key], key);
      return;
    }
    if (left !== right) differences.push({ path, a: left, b: right });
  };

  walk('pageCount', a.pageCount, b.pageCount, 'pageCount');
  walk('page', a.pages, b.pages, 'page');
  walk('fields', a.fields, b.fields, 'fields');
  walk('outline', a.outline, b.outline, 'outline');
  walk('destinations', a.destinations, b.destinations, 'destinations');
  walk('layers', a.layers, b.layers, 'layers');
  walk('attachments', a.attachments, b.attachments, 'attachments');
  walk('metadata', a.metadata, b.metadata, 'metadata');
  return differences;
}

/** A one-line summary of the differences, for a test failure message. */
export function summarise(differences: ReadonlyArray<Difference>, limit = 12): string {
  if (differences.length === 0) return 'no differences';
  const shown = differences
    .slice(0, limit)
    .map((d) => `${d.path}: ${format(d.a)} → ${format(d.b)}`)
    .join('\n  ');
  const more = differences.length > limit ? `\n  …and ${differences.length - limit} more` : '';
  return `${differences.length} difference(s):\n  ${shown}${more}`;
}

function format(value: unknown): string {
  if (typeof value === 'string')
    return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value);
  return JSON.stringify(value) ?? String(value);
}

// ---- describing each part ----------------------------------------------------------------------

function rect(r: PdfRect): Record<string, number> {
  return { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 };
}

function describeAnnotation(a: Annotation): Record<string, unknown> {
  return {
    subtype: a.subtype,
    rect: rect(a.rect),
    contents: a.contents ?? null,
    author: a.author ?? null,
    subject: a.subject ?? null,
    color: colour(a.color),
    interiorColor: colour(a.interiorColor),
    opacity: a.opacity ?? null,
    borderWidth: a.borderWidth ?? null,
    appearanceState: a.appearanceState ?? null,
    flags: { ...a.flags },
    quadPoints: [...(a.quadPoints ?? [])],
    paths: (a.paths ?? []).map((p) => p.map((pt) => ({ x: pt.x, y: pt.y }))),
  };
}

function describeField(f: FormField): Record<string, unknown> {
  return {
    name: f.name,
    type: f.type,
    value: f.value,
    defaultValue: f.defaultValue ?? null,
    readOnly: f.readOnly,
    required: f.required,
    tooltip: f.tooltip ?? null,
    options: (f.options ?? []).map((o) => ({ value: o.value, label: o.label })),
    widgets: f.widgets.map((w) => ({ page: w.page, rect: rect(w.rect) })),
  };
}

function flattenOutline(items: ReadonlyArray<OutlineItem>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (list: ReadonlyArray<OutlineItem>, depth: number): void => {
    for (const item of list) {
      out.push({
        depth,
        title: item.title,
        open: item.open,
        bold: item.bold,
        italic: item.italic,
        color: colour(item.color),
        uri: item.uri ?? null,
        destPage: item.dest?.page ?? null,
        destFit: item.dest?.fit ?? null,
      });
      walk(item.children, depth + 1);
    }
  };
  walk(items, 0);
  return out;
}

function describeNamedDestination(d: NamedDestination): Record<string, unknown> {
  return { name: d.name, page: d.dest.page, fit: d.dest.fit };
}

function describeLayer(l: Layer): Record<string, unknown> {
  return { name: l.name, visible: l.visible, locked: l.locked, depth: l.depth };
}

function describeAttachment(a: Attachment): Record<string, unknown> {
  return {
    name: a.name,
    description: a.description ?? null,
    mimeType: a.mimeType ?? null,
    size: a.size ?? null,
    page: a.page ?? null,
  };
}

function describeMetadata(m: Metadata): Record<string, unknown> {
  return {
    title: m.title ?? null,
    author: m.author ?? null,
    subject: m.subject ?? null,
    keywords: m.keywords ?? null,
    creator: m.creator ?? null,
    producer: m.producer ?? null,
    created: m.created ?? null,
    modified: m.modified ?? null,
    version: m.version,
    tagged: m.tagged,
    hasForm: m.hasForm,
    hasXfa: m.hasXfa,
    encrypted: m.encrypted,
    // `linearized` deliberately absent: a rewrite is never linearised, and M100 owns that.
    xmp: m.xmp === undefined ? null : m.xmp.replace(/\s+/g, ' ').trim(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
