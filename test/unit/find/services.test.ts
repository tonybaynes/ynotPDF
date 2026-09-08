/**
 * `TextService` and `FindController` against a fake engine: the paths a real document does not
 * reach on its own — comments, form values, a mid-scan option change, the bookmark walk, and the
 * caches around all of it.
 *
 * A fake rather than PDFium, because these are about *bookkeeping*: how many times the engine is
 * asked, what happens when it refuses, and what the controller does with a second query while
 * the first is still running. `acceptance.test.ts` covers the same code against a real file.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  Annotation,
  DocHandle,
  FormField,
  OutlineItem,
  PdfEngine,
  TextRun,
} from '@engine/PdfEngine';
import { DEFAULT_FIND_OPTIONS } from '@modules/M13-select-find-print/find/search';
import { FindController } from '@modules/M13-select-find-print/find/FindController';
import { TextService } from '@modules/M13-select-find-print/TextService';
import { run } from './helpers';

interface FakeOptions {
  readonly pages?: ReadonlyArray<string>;
  readonly annotations?: ReadonlyArray<Partial<Annotation>>;
  readonly outline?: ReadonlyArray<OutlineItem>;
  readonly fields?: ReadonlyArray<Partial<FormField>>;
}

/** An engine that knows only the four things M13 asks it about. */
function fakeEngine(options: FakeOptions = {}): { engine: PdfEngine; textRuns: () => number } {
  const pages = options.pages ?? ['hello world'];
  let calls = 0;
  const engine = {
    textRuns: (_doc: DocHandle, page: number): Promise<ReadonlyArray<TextRun>> => {
      calls++;
      const text = pages[page];
      return Promise.resolve(text === undefined ? [] : [run({ text, x: 0, y: 100 }, 0)]);
    },
    annotations: (): Promise<ReadonlyArray<Annotation>> =>
      Promise.resolve((options.annotations ?? []) as ReadonlyArray<Annotation>),
    outline: (): Promise<ReadonlyArray<OutlineItem>> => Promise.resolve(options.outline ?? []),
    formFields: (): Promise<ReadonlyArray<FormField>> =>
      Promise.resolve((options.fields ?? []) as ReadonlyArray<FormField>),
  } as unknown as PdfEngine;
  return { engine, textRuns: () => calls };
}

const source = (
  pageCount: number,
  key = 'doc',
): { key: string; handle: DocHandle; pageCount: number } => ({
  key,
  handle: 1 as DocHandle,
  pageCount,
});

describe('TextService', () => {
  it('asks the engine once per page and serves the rest from the cache', async () => {
    const fake = fakeEngine({ pages: ['one', 'two', 'three'] });
    const text = new TextService(fake.engine);
    const src = source(3);
    await text.all(src);
    await text.all(src);
    expect(fake.textRuns()).toBe(3);
    expect(text.isComplete(src)).toBe(true);
  });

  it('reports progress as it reads', async () => {
    const text = new TextService(fakeEngine({ pages: ['a', 'b'] }).engine);
    const seen: Array<[number, number]> = [];
    await text.all(source(2), (done, total) => seen.push([done, total]));
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('is not complete while a page is missing, and empty documents are complete', () => {
    const text = new TextService(fakeEngine().engine);
    expect(text.isComplete(source(2))).toBe(false);
    expect(text.isComplete(source(0))).toBe(true);
  });

  it('gives a lookup bound to one document', async () => {
    const text = new TextService(fakeEngine({ pages: ['only'] }).engine);
    const lookup = text.lookup('doc');
    expect(lookup(0)).toBeUndefined();
    await text.page(source(1), 0);
    expect(lookup(0)?.text).toBe('only\n');
  });

  it('clearing forgets everything', async () => {
    const text = new TextService(fakeEngine({ pages: ['only'] }).engine);
    await text.page(source(1), 0);
    text.clear();
    expect(text.peek('doc', 0)).toBeUndefined();
  });

  it('forgetting one document leaves the other alone', async () => {
    const text = new TextService(fakeEngine({ pages: ['only'] }).engine);
    await text.page(source(1, 'a'), 0);
    await text.page(source(1, 'b'), 0);
    text.forget('a');
    expect(text.peek('a', 0)).toBeUndefined();
    expect(text.peek('b', 0)).toBeDefined();
  });
});

describe('FindController', () => {
  const noop = (): void => undefined;

  it('finds comment text only when comments are included', async () => {
    const fake = fakeEngine({
      pages: ['nothing here'],
      annotations: [{ contents: 'a needle in the margin', author: 'Tony' }],
    });
    const text = new TextService(fake.engine);
    const controller = new FindController({ engine: fake.engine, text, onUpdate: noop });
    const without = await controller.run(source(1), 'needle', DEFAULT_FIND_OPTIONS);
    expect(without.hits).toHaveLength(0);
    const withComments = await controller.run(source(1), 'needle', {
      ...DEFAULT_FIND_OPTIONS,
      includeComments: true,
    });
    expect(withComments.hits).toHaveLength(1);
    expect(withComments.hits[0]?.source).toBe('comment');
    expect(withComments.hits[0]?.label).toBe('Tony');
  });

  it('finds form values and names the field', async () => {
    const fake = fakeEngine({
      pages: ['nothing here'],
      fields: [
        {
          name: 'surname',
          value: 'Baynes',
          widgets: [{ page: 0, rect: { x0: 0, y0: 0, x1: 1, y1: 1 } }],
        },
      ],
    });
    const text = new TextService(fake.engine);
    const controller = new FindController({ engine: fake.engine, text, onUpdate: noop });
    const progress = await controller.run(source(1), 'Baynes', {
      ...DEFAULT_FIND_OPTIONS,
      includeFormFields: true,
    });
    expect(progress.hits[0]).toMatchObject({ source: 'field', label: 'surname', page: 0 });
  });

  it('walks nested bookmarks', async () => {
    const child: OutlineItem = { title: 'Deep needle', children: [], open: false };
    const parent: OutlineItem = { title: 'Top', children: [child], open: true };
    const fake = fakeEngine({ pages: ['nothing'], outline: [parent] });
    const text = new TextService(fake.engine);
    const controller = new FindController({ engine: fake.engine, text, onUpdate: noop });
    const progress = await controller.run(source(1), 'needle', {
      ...DEFAULT_FIND_OPTIONS,
      includeBookmarks: true,
    });
    expect(progress.hits).toHaveLength(1);
    expect(progress.hits[0]?.label).toBe('Deep needle');
    expect(progress.hits[0]?.page).toBe(-1);
  });

  it('orders page hits before comments, bookmarks and fields', async () => {
    const fake = fakeEngine({
      pages: ['x needle x'],
      annotations: [{ contents: 'needle' }],
      outline: [{ title: 'needle', children: [], open: false }],
      fields: [{ name: 'f', value: 'needle', widgets: [] }],
    });
    const text = new TextService(fake.engine);
    const controller = new FindController({ engine: fake.engine, text, onUpdate: noop });
    const progress = await controller.run(source(1), 'needle', {
      ...DEFAULT_FIND_OPTIONS,
      includeBookmarks: true,
      includeComments: true,
      includeFormFields: true,
    });
    expect(progress.hits.map((h) => h.source)).toEqual(['bookmark', 'field', 'page', 'comment']);
  });

  it('reports an engine failure rather than pretending there were no hits', async () => {
    const fake = fakeEngine({ pages: ['needle'] });
    const engine = {
      ...fake.engine,
      annotations: () => Promise.reject(new Error('engine says no')),
    } as unknown as PdfEngine;
    const text = new TextService(engine);
    const controller = new FindController({ engine, text, onUpdate: noop });
    const progress = await controller.run(source(1), 'needle', {
      ...DEFAULT_FIND_OPTIONS,
      includeComments: true,
    });
    expect(progress.error).toBe('engine says no');
  });

  it('a second query abandons the first rather than mixing the two', async () => {
    const pages = Array.from({ length: 40 }, () => 'needle');
    const fake = fakeEngine({ pages });
    const text = new TextService(fake.engine);
    const controller = new FindController({ engine: fake.engine, text, onUpdate: noop });
    const first = controller.run(source(40), 'needle', DEFAULT_FIND_OPTIONS);
    const second = await controller.run(source(40), 'needle', DEFAULT_FIND_OPTIONS);
    await first;
    expect(second.hits).toHaveLength(40);
    expect(controller.progress.hits).toHaveLength(40);
  });

  it('reports progress while it scans', async () => {
    const pages = Array.from({ length: 12 }, (_, i) => `page ${i} needle`);
    const fake = fakeEngine({ pages });
    const text = new TextService(fake.engine);
    const updates = vi.fn();
    const controller = new FindController({ engine: fake.engine, text, onUpdate: updates });
    await controller.run(source(12), 'needle', DEFAULT_FIND_OPTIONS);
    expect(updates.mock.calls.length).toBeGreaterThan(2);
    expect(controller.progress.totalPages).toBe(12);
    expect(controller.progress.scannedPages).toBe(12);
  });

  it('selecting wraps round in both directions', async () => {
    const fake = fakeEngine({ pages: ['needle needle needle'] });
    const text = new TextService(fake.engine);
    const controller = new FindController({ engine: fake.engine, text, onUpdate: noop });
    await controller.run(source(1), 'needle', DEFAULT_FIND_OPTIONS);
    expect(controller.select(0)?.start).toBe(0);
    expect(controller.select(3)?.start).toBe(0);
    expect(controller.select(-1)?.start).toBe(14);
  });

  it('reset clears the hits and the query', async () => {
    const fake = fakeEngine({ pages: ['needle'] });
    const text = new TextService(fake.engine);
    const controller = new FindController({ engine: fake.engine, text, onUpdate: noop });
    await controller.run(source(1), 'needle', DEFAULT_FIND_OPTIONS);
    controller.reset();
    expect(controller.progress.query).toBe('');
    expect(controller.progress.hits).toEqual([]);
    expect(controller.currentHit).toBeNull();
  });
});
