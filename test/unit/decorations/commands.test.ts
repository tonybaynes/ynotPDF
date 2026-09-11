/**
 * The decoration command and the write plan it feeds (M53, ADR 0020), over the fake engine.
 *
 * What matters here is that one command expresses add, update and remove; that undo puts the
 * previous list back and re-applies; and that the plan is sparse — a document nobody decorated
 * plans nothing, so a no-op save still round-trips.
 */

import { describe, expect, it } from 'vitest';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import { DEFAULT_MARGINS, type HeaderFooterSpec } from '@engine/decorations/types';
import {
  SetDecorationsCommand,
  newDecorationId,
  withDecoration,
  withoutDecorations,
  type DecorationApplier,
} from '@modules/M53-headers-bates-watermarks-links/commands';
import {
  DECORATIONS_NAMESPACE,
  documentContext,
  plannedDecorationsFor,
  readDecorationsState,
  shrinkFor,
  type DecorationsState,
  type ModelDecoration,
} from '@modules/M53-headers-bates-watermarks-links/model';
import { openFake, pageIds } from '../core/helpers';

const HEADER: HeaderFooterSpec = {
  kind: 'header-footer',
  zones: { 'footer-centre': '<<1 of n>>' },
  font: 'Helvetica',
  size: 9,
  colour: 0,
  margins: DEFAULT_MARGINS,
  underline: false,
  shrink: 0,
  startNumber: 1,
  totalOverride: 0,
};

/** An applier that records what it was asked to do rather than touching an engine. */
function recorder(): DecorationApplier & { calls: number[][] } {
  const calls: number[][] = [];
  return {
    calls,
    reapply: (_doc: Document, pages: ReadonlyArray<number>) => {
      calls.push([...pages]);
      return Promise.resolve();
    },
  };
}

function decoration(pages: ReadonlyArray<ModelId>, id = 'd1'): ModelDecoration {
  return {
    id,
    kind: 'header-footer',
    range: '',
    pages,
    appliedAt: '2026-09-11T09:24:00.000Z',
    spec: HEADER,
  };
}

async function apply(
  doc: Document,
  next: DecorationsState,
  applier: DecorationApplier,
  touched: ReadonlyArray<number>,
): Promise<void> {
  await doc.apply(
    new SetDecorationsCommand({ doc, label: 'Add header and footer', next, applier, touched }),
  );
}

describe('SetDecorationsCommand', () => {
  it('adds, records the write intent, and undoes back to nothing', async () => {
    const { doc } = await openFake({ pageCount: 3 });
    const ids = pageIds(doc);
    const applier = recorder();
    const state = readDecorationsState(doc.custom(DECORATIONS_NAMESPACE));
    await apply(doc, withDecoration(state, decoration(ids)), applier, [0, 1, 2]);

    expect(readDecorationsState(doc.custom(DECORATIONS_NAMESPACE)).items).toHaveLength(1);
    expect(doc.state.writeIntents).toContain('decorations');
    expect(applier.calls).toEqual([[0, 1, 2]]);

    await doc.undoLast();
    expect(readDecorationsState(doc.custom(DECORATIONS_NAMESPACE)).items).toHaveLength(0);
    // Undo re-applies too: the pages have to lose the header, not only the model.
    expect(applier.calls).toHaveLength(2);

    await doc.redoLast();
    expect(readDecorationsState(doc.custom(DECORATIONS_NAMESPACE)).items).toHaveLength(1);
  });

  it('is the same command for a removal, and says which pages to clean', async () => {
    const { doc } = await openFake({ pageCount: 3 });
    const ids = pageIds(doc);
    const applier = recorder();
    const first = withDecoration(readDecorationsState({}), decoration(ids));
    await apply(doc, first, applier, [0, 1, 2]);
    await apply(doc, withoutDecorations(first, new Set(['d1'])), applier, [0, 1, 2]);
    expect(readDecorationsState(doc.custom(DECORATIONS_NAMESPACE)).items).toHaveLength(0);
    expect(applier.calls[1]).toEqual([0, 1, 2]);
  });

  it('serialises to data a batch run can replay', async () => {
    const { doc } = await openFake({ pageCount: 2 });
    const ids = pageIds(doc);
    const command = new SetDecorationsCommand({
      doc,
      label: 'Add header and footer',
      next: withDecoration(readDecorationsState({}), decoration(ids)),
      applier: recorder(),
      touched: [0, 1],
    });
    const json = command.toJSON();
    expect(json.id).toBe('decorate.set');
    expect(JSON.parse(JSON.stringify(json.data))).toMatchObject({
      label: 'Add header and footer',
      touched: [0, 1],
    });
  });

  it('mints ids that do not repeat', () => {
    let state = readDecorationsState({});
    const first = newDecorationId(state);
    state = withDecoration(state, decoration([], first));
    expect(newDecorationId(state)).not.toBe(first);
  });
});

describe('the write plan', () => {
  it('plans nothing for a page nobody decorated', async () => {
    const { doc } = await openFake({ pageCount: 2 });
    const page = doc.state.pages[0];
    expect(page).toBeDefined();
    if (!page) return;
    expect(plannedDecorationsFor(doc, page, documentContext(doc), {})).toBeUndefined();
  });

  it('plans the drawing and the page’s original content for a page that has one', async () => {
    const { doc } = await openFake({ pageCount: 2 });
    const ids = pageIds(doc);
    const state = withDecoration(readDecorationsState({}), decoration(ids));
    await apply(
      doc,
      { ...state, pages: { [String(ids[0])]: { original: 'AAAA', resources: '<< >>' } } },
      recorder(),
      [0, 1],
    );
    const page = doc.state.pages[0];
    if (!page) return;
    const planned = plannedDecorationsFor(doc, page, documentContext(doc), {});
    expect(planned).toBeDefined();
    expect(planned?.original).toEqual({ content: 'AAAA', resources: '<< >>' });
    expect(planned?.items).toHaveLength(1);
    expect(planned?.items[0]?.kind).toBe('header-footer');
    expect(planned?.items[0]?.content).toContain('1 of 2');
    // The second page counts as the second of the range.
    const second = doc.state.pages[1];
    if (!second) return;
    expect(
      plannedDecorationsFor(doc, second, documentContext(doc), {})?.items[0]?.content,
    ).toContain('2 of 2');
  });

  it('takes the smallest shrink any header on the page asks for', () => {
    const state: DecorationsState = {
      items: [
        { ...decoration(['p1' as ModelId], 'a'), spec: { ...HEADER, shrink: 0.95 } },
        { ...decoration(['p1' as ModelId], 'b'), spec: { ...HEADER, shrink: 0.8 } },
        { ...decoration(['p2' as ModelId], 'c'), spec: { ...HEADER, shrink: 0.5 } },
      ],
      pages: {},
      seq: 4,
    };
    expect(shrinkFor(state, 'p1' as ModelId)).toBeCloseTo(0.8, 5);
    expect(shrinkFor(state, 'p3' as ModelId)).toBe(0);
  });
});
