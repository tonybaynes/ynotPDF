/**
 * The model's pure conversions (M20): engine reads in, model entities out, and back again.
 * These are small enough to test directly, and every annotation family has to survive the round
 * trip — a subtype that loses its quad points or its ink strokes on the way to the engine is a
 * highlight that silently stops being a highlight.
 */

import { describe, expect, it } from 'vitest';
import type { Annotation, Attachment, Destination, Layer, Metadata } from '@engine/PdfEngine';
import type { ModelId } from '@core/Ids';
import {
  familyOf,
  flattenOutline,
  toEngineAnnotation,
  toModelAnnotation,
  toModelAttachment,
  toModelDestination,
  toModelLayer,
  toModelMetadata,
  type ModelAnnotation,
} from '@core/model';

const ID = 'an-1' as ModelId;
const PAGE = 'pg-1' as ModelId;
const FLAGS = {
  hidden: false,
  print: true,
  noView: false,
  readOnly: false,
  locked: false,
} as const;

function engineAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'a0.0',
    page: 0,
    subtype: 'Square',
    rect: { x0: 0, y0: 0, x1: 10, y1: 10 },
    flags: FLAGS,
    ...overrides,
  };
}

describe('toModelAnnotation', () => {
  it('defaults every optional field to null rather than leaving it absent', () => {
    const a = toModelAnnotation(ID, PAGE, engineAnnotation());
    expect(a.contents).toBeNull();
    expect(a.author).toBeNull();
    expect(a.created).toBeNull();
    expect(a.modified).toBeNull();
    expect(a.color).toBeNull();
    expect(a.interiorColor).toBeNull();
    expect(a.opacity).toBeNull();
    expect(a.borderWidth).toBeNull();
    expect(a.appearanceState).toBeNull();
    expect(a.name).toBeNull();
    expect(a.subject).toBeNull();
    expect(a.state).toBeNull();
    expect(a.inReplyTo).toBeNull();
    expect(a.extra).toEqual({});
  });

  it('builds each family with its own fields', () => {
    const markup = toModelAnnotation(
      ID,
      PAGE,
      engineAnnotation({ subtype: 'Highlight', quadPoints: [0, 1, 2, 3, 4, 5, 6, 7] }),
    );
    expect(markup.family === 'markup' && markup.quadPoints).toHaveLength(8);

    const ink = toModelAnnotation(
      ID,
      PAGE,
      engineAnnotation({ subtype: 'Ink', paths: [[{ x: 1, y: 2 }]] }),
    );
    expect(ink.family === 'ink' && ink.paths[0]).toHaveLength(1);

    const shape = toModelAnnotation(
      ID,
      PAGE,
      engineAnnotation({
        subtype: 'Polygon',
        paths: [
          [
            { x: 1, y: 2 },
            { x: 3, y: 4 },
          ],
        ],
      }),
    );
    expect(shape.family === 'shape' && shape.vertices).toHaveLength(2);

    const note = toModelAnnotation(
      ID,
      PAGE,
      engineAnnotation({ subtype: 'Text', extra: { icon: 'Comment' } }),
    );
    expect(note.family === 'note' && note.icon).toBe('Comment');

    const free = toModelAnnotation(
      ID,
      PAGE,
      engineAnnotation({ subtype: 'FreeText', extra: { richContents: '<p>hi</p>' } }),
    );
    expect(free.family === 'freeText' && free.richContents).toBe('<p>hi</p>');

    const stamp = toModelAnnotation(
      ID,
      PAGE,
      engineAnnotation({ subtype: 'Stamp', extra: { icon: 'Approved' } }),
    );
    expect(stamp.family === 'stamp' && stamp.icon).toBe('Approved');

    const widget = toModelAnnotation(
      ID,
      PAGE,
      engineAnnotation({ subtype: 'Widget', extra: { fieldName: 'person.name' } }),
    );
    expect(widget.family === 'widget' && widget.fieldName).toBe('person.name');
    expect(widget.family === 'widget' && widget.fieldId).toBeNull();

    const link = toModelAnnotation(
      ID,
      PAGE,
      engineAnnotation({ subtype: 'Link', extra: { uri: 'https://example.org' } }),
    );
    expect(link.family === 'link' && link.uri).toBe('https://example.org');

    const attachment = toModelAnnotation(
      ID,
      PAGE,
      engineAnnotation({ subtype: 'FileAttachment', extra: { icon: 'Paperclip' } }),
    );
    expect(attachment.family === 'fileAttachment' && attachment.icon).toBe('Paperclip');

    const other = toModelAnnotation(ID, PAGE, engineAnnotation({ subtype: 'Movie' }));
    expect(other.family).toBe('other');
  });

  it('leaves a family field null when the engine gave nothing', () => {
    const note = toModelAnnotation(ID, PAGE, engineAnnotation({ subtype: 'Text' }));
    expect(note.family === 'note' && note.icon).toBeNull();
    const markup = toModelAnnotation(ID, PAGE, engineAnnotation({ subtype: 'Underline' }));
    expect(markup.family === 'markup' && markup.quadPoints).toEqual([]);
    const shape = toModelAnnotation(ID, PAGE, engineAnnotation({ subtype: 'Circle' }));
    expect(shape.family === 'shape' && shape.vertices).toEqual([]);
  });

  it('resolves a reply target through the caller, and to null when it is unknown', () => {
    const resolved = toModelAnnotation(
      ID,
      PAGE,
      engineAnnotation({ inReplyTo: 'a0.3' }),
      () => 'an-9' as ModelId,
    );
    expect(resolved.inReplyTo).toBe('an-9');
    const unresolved = toModelAnnotation(ID, PAGE, engineAnnotation({ inReplyTo: 'a0.3' }));
    expect(unresolved.inReplyTo).toBeNull();
  });

  it('treats an empty string as absent, so a blank author is not "" everywhere', () => {
    const a = toModelAnnotation(
      ID,
      PAGE,
      engineAnnotation({ subtype: 'Text', extra: { icon: '' } }),
    );
    expect(a.family === 'note' && a.icon).toBeNull();
  });
});

describe('toEngineAnnotation', () => {
  const round = (source: Annotation): Omit<Annotation, 'id'> =>
    toEngineAnnotation(toModelAnnotation(ID, PAGE, source), 3);

  it('carries the page index the caller gives, not the one it came from', () => {
    expect(round(engineAnnotation()).page).toBe(3);
  });

  it('drops fields the annotation does not have, rather than writing nulls', () => {
    const out = round(engineAnnotation()) as Record<string, unknown>;
    expect('contents' in out).toBe(false);
    expect('color' in out).toBe(false);
    expect('quadPoints' in out).toBe(false);
  });

  it('keeps every field that was set', () => {
    const out = round(
      engineAnnotation({
        contents: 'note',
        author: 'Tester',
        created: '2026-01-01T00:00:00Z',
        modified: '2026-01-02T00:00:00Z',
        color: 0x112233,
        interiorColor: 0x445566,
        opacity: 0.5,
        borderWidth: 2,
        appearanceState: 'Yes',
        name: 'nm',
        subject: 'subj',
        state: 'Accepted',
      }),
    );
    expect(out.contents).toBe('note');
    expect(out.author).toBe('Tester');
    expect(out.color).toBe(0x112233);
    expect(out.interiorColor).toBe(0x445566);
    expect(out.opacity).toBe(0.5);
    expect(out.borderWidth).toBe(2);
    expect(out.appearanceState).toBe('Yes');
    expect(out.name).toBe('nm');
    expect(out.subject).toBe('subj');
    expect(out.state).toBe('Accepted');
  });

  it('round-trips markup quads, ink strokes and shape vertices', () => {
    const quads = [0, 1, 2, 3, 4, 5, 6, 7];
    expect(round(engineAnnotation({ subtype: 'Highlight', quadPoints: quads })).quadPoints).toEqual(
      quads,
    );
    expect(round(engineAnnotation({ subtype: 'Link', quadPoints: quads })).quadPoints).toEqual(
      quads,
    );
    const strokes = [[{ x: 1, y: 2 }], [{ x: 3, y: 4 }]];
    expect(round(engineAnnotation({ subtype: 'Ink', paths: strokes })).paths).toEqual(strokes);
    const vertices = [
      { x: 5, y: 6 },
      { x: 7, y: 8 },
    ];
    expect(round(engineAnnotation({ subtype: 'Polygon', paths: [vertices] })).paths).toEqual([
      vertices,
    ]);
  });

  it('passes the extras through, so an adapter can keep what it knows', () => {
    const out = round(engineAnnotation({ subtype: 'Text', extra: { icon: 'Note' } }));
    expect(out.extra).toEqual({ icon: 'Note' });
  });

  it('omits empty geometry rather than writing an empty array', () => {
    const out = round(engineAnnotation({ subtype: 'Ink' })) as Record<string, unknown>;
    expect('paths' in out).toBe(false);
  });
});

describe('the other conversions', () => {
  it('maps metadata, defaulting absent strings to null', () => {
    const m: Metadata = {
      version: '1.7',
      encrypted: false,
      linearized: true,
      tagged: true,
      hasForm: false,
      hasXfa: false,
      pageCount: 2,
      title: 'T',
    };
    const out = toModelMetadata(m);
    expect(out.title).toBe('T');
    expect(out.author).toBeNull();
    expect(out.xmp).toBeNull();
    expect(out.linearized).toBe(true);
  });

  it('maps a layer and an attachment, keeping the engine id for later calls', () => {
    const layer: Layer = { id: 'ocg.4', name: 'Ink', visible: true, locked: true, depth: 2 };
    expect(toModelLayer('ly-1' as ModelId, layer)).toEqual({
      id: 'ly-1',
      engineId: 'ocg.4',
      name: 'Ink',
      visible: true,
      locked: true,
      depth: 2,
    });
    const attachment: Attachment = { id: 'att.2', name: 'notes.txt' };
    const model = toModelAttachment('at-1' as ModelId, attachment, PAGE);
    expect(model.engineId).toBe('att.2');
    expect(model.pageId).toBe(PAGE);
    expect(model.mimeType).toBeNull();
  });

  it('maps a destination, keeping its fit mode and nulling what it omits', () => {
    const dest: Destination = { page: 0, fit: 'fitH', top: 700 };
    const model = toModelDestination('ds-1' as ModelId, dest, PAGE, 'chapter1');
    expect(model.name).toBe('chapter1');
    expect(model.fit).toBe('fitH');
    expect(model.top).toBe(700);
    expect(model.left).toBeNull();
    expect(model.zoom).toBeNull();
    expect(model.rect).toBeNull();
  });
});

describe('flattenOutline', () => {
  it('links parents and children by id and keeps document order', () => {
    let n = 0;
    const nextId = (): ModelId => `ol-${++n}` as ModelId;
    const flat = flattenOutline(
      [
        {
          title: 'One',
          open: true,
          children: [
            { title: 'One.a', open: false, children: [] },
            { title: 'One.b', open: false, children: [] },
          ],
        },
        { title: 'Two', open: false, children: [], bold: true, italic: true, color: 0xff0000 },
      ],
      nextId,
      () => null,
    );
    expect(flat.map((o) => o.title)).toEqual(['One', 'One.a', 'One.b', 'Two']);
    const [one, a, b, two] = flat;
    expect(one?.childIds).toEqual([a?.id, b?.id]);
    expect(a?.parentId).toBe(one?.id);
    expect(two?.parentId).toBeNull();
    expect(two?.bold).toBe(true);
    expect(two?.italic).toBe(true);
    expect(two?.color).toBe(0xff0000);
    expect(one?.uri).toBeNull();
  });

  it('asks the caller for a destination id and records it', () => {
    let n = 0;
    const flat = flattenOutline(
      [{ title: 'One', open: true, children: [], dest: { page: 1, fit: 'fit' } }],
      () => `ol-${++n}` as ModelId,
      () => 'ds-7' as ModelId,
    );
    expect(flat[0]?.destinationId).toBe('ds-7');
  });

  it('handles an empty outline', () => {
    expect(
      flattenOutline(
        [],
        () => 'ol-1' as ModelId,
        () => null,
      ),
    ).toEqual([]);
  });
});

describe('familyOf covers every subtype the engine can report', () => {
  it('never throws and always returns a family', () => {
    const subtypes: Annotation['subtype'][] = [
      'Text',
      'Link',
      'FreeText',
      'Line',
      'Square',
      'Circle',
      'Polygon',
      'PolyLine',
      'Highlight',
      'Underline',
      'Squiggly',
      'StrikeOut',
      'Stamp',
      'Caret',
      'Ink',
      'Popup',
      'FileAttachment',
      'Sound',
      'Movie',
      'Widget',
      'Screen',
      'PrinterMark',
      'TrapNet',
      'Watermark',
      '3D',
      'Redact',
      'Unknown',
    ];
    for (const subtype of subtypes) {
      const family = familyOf(subtype);
      expect(family, subtype).toBeTruthy();
      const model: ModelAnnotation = toModelAnnotation(ID, PAGE, engineAnnotation({ subtype }));
      expect(model.family).toBe(family);
    }
  });
});
