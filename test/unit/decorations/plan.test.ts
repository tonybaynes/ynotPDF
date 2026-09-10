/**
 * Links and decorations in the write plan (M53, ADR 0020 §3 and §5).
 *
 * Two things are pinned here. A link's action reaches the file as an `/A` dictionary the writer
 * can write, and its destination *inside* the document reaches it as `PlannedAnnotation.dest`,
 * which is the one thing the plan's entries could not carry. And a document nobody decorated
 * plans no decorations at all, which is what keeps a no-op save a re-serialisation.
 */

import { describe, expect, it } from 'vitest';
import type { Document } from '@core/Document';
import { AddAnnotationCommand, UpdateAnnotationCommand, draftAnnotation } from '@core/commands';
import { DEFAULT_ANNOTATION_FLAGS } from '@core/commands';
import type { ModelId } from '@core/Ids';
import { dictEntries, dictMapping, toDictValue } from '@engine/appearance/dict';
import { DEFAULT_MARGINS, type HeaderFooterSpec } from '@engine/decorations/types';
import { buildWritePlan } from '@modules/M21-save/plan';
import {
  SetDecorationsCommand,
  withDecoration,
} from '@modules/M53-headers-bates-watermarks-links/commands';
import { readDecorationsState } from '@modules/M53-headers-bates-watermarks-links/model';
import { actionExtra } from '@modules/M53-headers-bates-watermarks-links/links';
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

/** Adds a Link annotation to page 0 and returns its model id. */
async function addLink(doc: Document, extra: Record<string, unknown>): Promise<ModelId> {
  const page = doc.page(0);
  const draft = draftAnnotation(doc, page.id, {
    subtype: 'Link',
    rect: { x0: 10, y0: 10, x1: 100, y1: 30 },
    flags: DEFAULT_ANNOTATION_FLAGS,
    extra,
  });
  const command = new AddAnnotationCommand(doc, draft);
  await doc.apply(command);
  return command.annotationId;
}

describe('a link action as a dictionary', () => {
  it('writes a URI action', () => {
    const entries = dictEntries(actionExtra({ kind: 'uri', uri: 'https://example.com' }));
    expect(entries['A']).toEqual({
      kind: 'dict',
      value: {
        Type: { kind: 'name', value: 'Action' },
        S: { kind: 'name', value: 'URI' },
        URI: { kind: 'string', value: 'https://example.com' },
      },
    });
  });

  it('writes a remote go-to whose destination names its page by number', () => {
    const entries = dictEntries(actionExtra({ kind: 'file', path: 'other.pdf', page: 4 }));
    const action = entries['A'];
    expect(action?.kind).toBe('dict');
    if (action?.kind !== 'dict') return;
    expect(action.value['S']).toEqual({ kind: 'name', value: 'GoToR' });
    expect(action.value['D']).toEqual({
      kind: 'array',
      value: [
        { kind: 'number', value: 4 },
        { kind: 'name', value: 'Fit' },
      ],
    });
  });

  it('writes a launch action for a file to open', () => {
    const entries = dictEntries(actionExtra({ kind: 'open', path: 'report.docx' }));
    const action = entries['A'];
    expect(action?.kind).toBe('dict');
    if (action?.kind !== 'dict') return;
    expect(action.value['S']).toEqual({ kind: 'name', value: 'Launch' });
  });

  it('removes the action when there is nothing behind the link, and refuses a malformed one', () => {
    expect(dictEntries(actionExtra({ kind: 'none' }))['A']).toBeNull();
    const mapping = dictMapping('linkAction');
    expect(mapping).toBeDefined();
    if (!mapping) return;
    expect(toDictValue(mapping, { kind: 'uri', uri: '' })).toBeNull();
    expect(toDictValue(mapping, { kind: 'file', path: '' })).toBeNull();
    expect(toDictValue(mapping, { kind: 'open', path: '' })).toBeNull();
    expect(toDictValue(mapping, { kind: 'sausages' })).toBeNull();
    expect(toDictValue(mapping, 'not an object')).toBeNull();
  });
});

describe('a link in the write plan', () => {
  it('carries the action, the border and no appearance of its own', async () => {
    const { doc } = await openFake({ pageCount: 2 });
    await addLink(doc, {
      ...actionExtra({ kind: 'uri', uri: 'https://example.com' }),
      linkBorderArray: [0, 0, 0],
      linkHighlight: 'I',
    });
    const planned = buildWritePlan(doc).plan.pages[0]?.annotations?.[0];
    expect(planned).toBeDefined();
    expect(planned?.subtype).toBe('Link');
    // A viewer draws a link's border itself; an `/AP` of ours would replace that with a picture.
    expect(planned?.appearance).toBeUndefined();
    expect(planned?.properties?.entries?.['A']).toBeDefined();
    expect(planned?.properties?.entries?.['Border']).toEqual({ kind: 'numbers', value: [0, 0, 0] });
    await doc.close();
  });

  it('resolves a go-to inside the document to the page’s place in the finished file', async () => {
    const { doc } = await openFake({ pageCount: 3 });
    const target = doc.page(2).id;
    await addLink(doc, actionExtra({ kind: 'page', page: target, fit: 'fitH' }));
    expect(buildWritePlan(doc).plan.pages[0]?.annotations?.[0]?.dest).toEqual({
      page: 2,
      fit: 'fitH',
    });
    await doc.close();
  });

  it('says null when the link points at a page that has gone', async () => {
    const { doc } = await openFake({ pageCount: 2 });
    const id = await addLink(doc, actionExtra({ kind: 'page', page: doc.page(1).id, fit: 'fit' }));
    // The page id is replaced by one no page has, which is what a deleted target leaves behind.
    await doc.apply(
      new UpdateAnnotationCommand(doc, id, {
        extra: actionExtra({ kind: 'page', page: 'gone' as ModelId, fit: 'fit' }),
      }),
    );
    expect(buildWritePlan(doc).plan.pages[0]?.annotations?.[0]?.dest).toBeNull();
    await doc.close();
  });

  it('falls back to Fit when the stored destination names a mode that is not one', async () => {
    const { doc } = await openFake({ pageCount: 2 });
    await addLink(doc, { linkDest: { page: doc.page(1).id, fit: 'sideways' } });
    expect(buildWritePlan(doc).plan.pages[0]?.annotations?.[0]?.dest).toEqual({
      page: 1,
      fit: 'fit',
    });
    await doc.close();
  });
});

describe('decorations in the write plan', () => {
  it('plans nothing for a document nobody decorated', async () => {
    const { doc } = await openFake({ pageCount: 2 });
    expect(buildWritePlan(doc).plan.pages.every((p) => p.decorations === undefined)).toBe(true);
    await doc.close();
  });

  it('plans the drawing for every decorated page once the session has changed them', async () => {
    const { doc } = await openFake({ pageCount: 2 });
    const ids = pageIds(doc);
    const state = withDecoration(readDecorationsState({}), {
      id: 'd1',
      kind: 'header-footer',
      range: '',
      pages: ids,
      appliedAt: '2026-09-11T09:24:00.000Z',
      spec: HEADER,
    });
    await doc.apply(
      new SetDecorationsCommand({
        doc,
        label: 'Add header and footer',
        next: { ...state, pages: { [String(ids[0])]: { original: 'AAAA', resources: '' } } },
        applier: { reapply: () => Promise.resolve() },
        touched: [0, 1],
      }),
    );
    const plan = buildWritePlan(doc).plan;
    expect(plan.pages[0]?.decorations?.items).toHaveLength(1);
    expect(plan.pages[0]?.decorations?.original?.content).toBe('AAAA');
    expect(plan.pages[1]?.decorations?.items[0]?.content).toContain('2 of 2');
    // The page whose original was never captured still gets its decoration.
    expect(plan.pages[1]?.decorations?.original).toBeUndefined();
    await doc.close();
  });
});
