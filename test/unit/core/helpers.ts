/** Shared fixtures for the document-model tests (M20). */

import { Document } from '@core/Document';
import { DEFAULT_ANNOTATION_FLAGS } from '@core/commands';
import type { ModelId } from '@core/Ids';
import type { Annotation, FormField, Layer, OutlineItem } from '@engine/PdfEngine';
import { FakeEngine, type FakeDocumentSpec, type FakeSupport } from './fakeEngine';

/** A document with pages, annotations, a form, an outline, layers and a signature. */
export const RICH_SPEC: FakeDocumentSpec = {
  pageCount: 4,
  labels: ['i', 'ii', '1', '2'],
  annotations: {
    0: [
      {
        subtype: 'Highlight',
        rect: { x0: 10, y0: 10, x1: 100, y1: 30 },
        flags: DEFAULT_ANNOTATION_FLAGS,
        contents: 'first note',
        author: 'Tester',
        quadPoints: [10, 30, 100, 30, 10, 10, 100, 10],
      },
      {
        subtype: 'Ink',
        rect: { x0: 0, y0: 0, x1: 50, y1: 50 },
        flags: DEFAULT_ANNOTATION_FLAGS,
        paths: [
          [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
          ],
        ],
      },
    ],
    2: [
      {
        subtype: 'Square',
        rect: { x0: 20, y0: 20, x1: 80, y1: 60 },
        flags: DEFAULT_ANNOTATION_FLAGS,
        color: 0x3392ff,
      },
    ],
  },
  fields: [
    {
      name: 'address.city',
      type: 'text',
      value: 'York',
      readOnly: false,
      required: true,
      widgets: [{ page: 0, rect: { x0: 100, y0: 700, x1: 300, y1: 720 } }],
    },
    {
      name: 'address.postcode',
      type: 'text',
      value: 'YO1',
      readOnly: false,
      required: false,
      widgets: [{ page: 0, rect: { x0: 100, y0: 660, x1: 300, y1: 680 } }],
    },
    {
      name: 'agree',
      type: 'checkbox',
      value: 'Off',
      readOnly: false,
      required: false,
      widgets: [{ page: 1, rect: { x0: 100, y0: 600, x1: 120, y1: 620 } }],
    },
  ] satisfies FormField[],
  outline: [
    {
      title: 'Chapter 1',
      dest: { page: 0, fit: 'xyz', left: 0, top: 800, zoom: 1 },
      open: true,
      children: [
        { title: 'Section 1.1', dest: { page: 1, fit: 'fit' }, open: false, children: [] },
      ],
    },
  ] satisfies OutlineItem[],
  layers: [
    { id: 'ocg.1', name: 'Watermark', visible: true, locked: false, depth: 0 },
    { id: 'ocg.2', name: 'Notes', visible: false, locked: false, depth: 0 },
  ] satisfies Layer[],
  attachments: [{ id: 'att.1', name: 'data.csv', mimeType: 'text/csv', size: 42 }],
  namedDestinations: [{ name: 'top', dest: { page: 0, fit: 'fit' } }],
  signatures: [
    { byteRange: [0, 100, 200, 300], reason: 'I approve', subFilter: 'adbe.pkcs7.detached' },
  ],
  metadata: { title: 'Rich fixture', author: 'M20' },
};

/** Opens a fake document. `support` narrows what the engine claims it can do. */
export async function openFake(
  spec: FakeDocumentSpec = RICH_SPEC,
  support: Partial<FakeSupport> = {},
): Promise<{ doc: Document; engine: FakeEngine }> {
  const engine = new FakeEngine(support);
  const handle = engine.create(spec);
  const doc = await Document.fromHandle(engine, handle, { name: 'fixture.pdf' });
  // Merging is otherwise governed by a wall-clock idle gap, which would make "these two edits
  // collapse into one undo step" depend on how busy the machine is. Tests that want a break ask
  // for one with `breakMerge()`; the idle barrier itself has its own test with a fake clock.
  doc.mergeIdleMs = Number.POSITIVE_INFINITY;
  return { doc, engine };
}

/** Loads every page's annotations into the model, as a viewer would as pages come into view. */
export async function loadAllAnnotations(doc: Document): Promise<void> {
  for (const page of doc.state.pages) await doc.loadAnnotations(page.id);
}

/** The ids of every page, in document order. */
export function pageIds(doc: Document): ModelId[] {
  return doc.state.pages.map((p) => p.id);
}

/** A plain engine annotation, for `draftAnnotation`. */
export function annotationSource(
  subtype: Annotation['subtype'] = 'Square',
  overrides: Partial<Omit<Annotation, 'id' | 'page'>> = {},
): Omit<Annotation, 'id' | 'page'> {
  return {
    subtype,
    rect: { x0: 5, y0: 5, x1: 55, y1: 45 },
    flags: DEFAULT_ANNOTATION_FLAGS,
    ...overrides,
  };
}

/**
 * Asserts a value the fixture guarantees. These tests index into arrays and follow optional
 * chains constantly; this narrows the type and fails with a useful message rather than an
 * inscrutable "undefined" three assertions later. The lint rules forbid `!`, and rightly so.
 */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`the fixture has no ${what}`);
  return value;
}
