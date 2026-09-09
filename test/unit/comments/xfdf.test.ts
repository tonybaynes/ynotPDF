/**
 * M32: the comment exchange layer. Pure text and bytes in, pure records out — no engine, no DOM.
 *
 * The fixtures in `test/fixtures/xfdf/` are written to the shapes Acrobat and Foxit produce (page
 * numbers 0-based, `coords` for quads, `<inklist><gesture>` for ink, `start`/`end` for a line,
 * `<contents-richtext>` for `/RC`, a nested `<popup>` that is not a comment of its own) so that
 * "imports with all fields" is a claim about the formats and not about our own writer.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  formatOfName,
  readComments,
  readFdf,
  readXfdf,
  writeFdf,
  writeXfdf,
  XfdfError,
  type XfdfAnnotation,
  type XfdfDocument,
} from '../../../src/engine/xfdf/index';
import { EMPTY_XFDF_ANNOTATION } from '../../../src/engine/xfdf/types';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../fixtures/xfdf/${name}`, import.meta.url));

const readText = (name: string): string => readFileSync(fixture(name), 'utf8');
const readBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(fixture(name)));

const byName = (doc: XfdfDocument, name: string): XfdfAnnotation => {
  const found = doc.annotations.find((a) => a.name === name);
  if (!found) throw new Error(`no annotation named ${name}`);
  return found;
};

describe('readXfdf — an Acrobat-shaped export', () => {
  const doc = readXfdf(readText('acrobat.xfdf'));

  it('reads the file reference and the source ids', () => {
    expect(doc.href).toBe('report.pdf');
    expect(doc.ids?.original).toBe('9A2B4C6D8E0F1122334455667788990A');
  });

  it('reads every comment and no popups', () => {
    expect(doc.annotations).toHaveLength(9);
    expect(doc.annotations.some((a) => a.subtype === 'Popup')).toBe(false);
  });

  it('reads a highlight with its quads, colour, author and dates', () => {
    const h = byName(doc, 'acr-0001');
    expect(h.subtype).toBe('Highlight');
    expect(h.page).toBe(0);
    expect(h.rect).toEqual({ x0: 72, y0: 700, x1: 240, y1: 714 });
    expect(h.color).toBe(0xffff00);
    expect(h.quadPoints).toEqual([72, 714, 240, 714, 72, 700, 240, 700]);
    expect(h.author).toBe('A. Reviewer');
    expect(h.subject).toBe('Highlight');
    expect(h.contents).toBe('Check this figure');
    expect(h.created).toBe('2026-09-01T10:15:00Z');
    expect(h.modified).toBe('2026-09-01T10:15:30Z');
    expect(h.flags).toEqual({
      hidden: false,
      print: true,
      noView: false,
      readOnly: false,
      locked: false,
    });
  });

  it('keeps rich text as markup and plain text as text', () => {
    const note = byName(doc, 'acr-0002');
    expect(note.icon).toBe('Comment');
    expect(note.contents).toBe('The margin looks wrong on this page.');
    expect(note.richContents).toContain('<b>wrong</b>');
  });

  it('reads a reply with its target, reply type and status', () => {
    const reply = byName(doc, 'acr-0003');
    expect(reply.inReplyTo).toBe('acr-0002');
    expect(reply.replyType).toBe('R');
    expect(reply.state).toBe('Accepted');
    expect(reply.stateModel).toBe('Review');
    expect(reply.author).toBe('B. Author');
  });

  it('reads a callout with its leader, intent, DA and DS', () => {
    const callout = byName(doc, 'acr-0004');
    expect(callout.subtype).toBe('FreeText');
    expect(callout.intent).toBe('FreeTextCallout');
    expect(callout.callout).toEqual([40, 380, 120, 400, 160, 420]);
    expect(callout.lineEnding).toBe('OpenArrow');
    expect(callout.align).toBe(0);
    expect(callout.defaultAppearance).toBe('0 0 0 rg /Helv 11 Tf');
    expect(callout.defaultStyle).toContain('Helvetica');
    expect(callout.borderWidth).toBe(1);
  });

  it('reads ink as one point list per gesture', () => {
    const ink = byName(doc, 'acr-0005');
    expect(ink.paths).toEqual([
      [
        { x: 100, y: 200 },
        { x: 120, y: 240 },
        { x: 140, y: 210 },
      ],
      [
        { x: 150, y: 220 },
        { x: 180, y: 260 },
      ],
    ]);
    expect(ink.borderWidth).toBe(2);
  });

  it('reads a line as its two ends and both line endings', () => {
    const line = byName(doc, 'acr-0006');
    expect(line.paths).toEqual([
      [
        { x: 200, y: 300 },
        { x: 400, y: 320 },
      ],
    ]);
    expect(line.lineEndings).toEqual(['None', 'OpenArrow']);
  });

  it('reads a polygon with vertices, an interior colour and a cloud', () => {
    const polygon = byName(doc, 'acr-0007');
    expect(polygon.paths[0]).toHaveLength(3);
    expect(polygon.interiorColor).toBe(0xeeeeee);
    expect(polygon.cloudy).toBe(2);
  });

  it('takes a stamp by name and keeps its /NM separate', () => {
    const stamp = byName(doc, 'acr-0008');
    expect(stamp.icon).toBe('SBApproved');
    expect(stamp.name).toBe('acr-0008');
  });

  it('reads a dash pattern', () => {
    expect(byName(doc, 'acr-0009').dashArray).toEqual([3, 2]);
  });
});

describe('readXfdf — a Foxit-shaped export', () => {
  const doc = readXfdf(readText('foxit.xfdf'));

  it('reads every comment across both pages', () => {
    expect(doc.annotations).toHaveLength(11);
    expect(new Set(doc.annotations.map((a) => a.page))).toEqual(new Set([0, 1]));
  });

  it('reads the markup family with its quads', () => {
    expect(byName(doc, 'fx-1001').quadPoints).toHaveLength(8);
    expect(byName(doc, 'fx-1002').subtype).toBe('Underline');
    expect(byName(doc, 'fx-1003').subtype).toBe('Squiggly');
  });

  it('reads a date with a real time-zone offset', () => {
    expect(byName(doc, 'fx-1001').created).toBe('2026-09-02T09:00:00+01:00');
  });

  it('reads a circle with its interior colour and border width', () => {
    const circle = byName(doc, 'fx-1004');
    expect(circle.interiorColor).toBe(0xfff2cc);
    expect(circle.borderWidth).toBe(3);
  });

  it('reads a polyline and a caret', () => {
    expect(byName(doc, 'fx-1005').paths[0]).toHaveLength(3);
    expect(byName(doc, 'fx-1006').subtype).toBe('Caret');
    expect(byName(doc, 'fx-1006').padding).toEqual([0, 0, 0, 0]);
  });

  it('reads a file attachment by the name of its file', () => {
    expect(byName(doc, 'fx-1007').attachmentName).toBe('notes.txt');
    expect(byName(doc, 'fx-1007').icon).toBe('PushPin');
  });

  it('reads a two-reply thread, one of which carries a status', () => {
    expect(byName(doc, 'fx-1009').inReplyTo).toBe('fx-1008');
    expect(byName(doc, 'fx-1010').state).toBe('Completed');
    expect(byName(doc, 'fx-1010').contents).toBeNull();
  });

  it('sees more than one author', () => {
    const authors = new Set(doc.annotations.map((a) => a.author));
    expect(authors).toEqual(new Set(['C. Editor', 'D. Second Reader']));
  });
});

describe('writeXfdf', () => {
  it('round-trips every field of an Acrobat-shaped export', () => {
    const original = readXfdf(readText('acrobat.xfdf'));
    const again = readXfdf(writeXfdf(original));
    expect(again.annotations).toEqual(original.annotations);
    expect(again.href).toBe(original.href);
    expect(again.ids).toEqual(original.ids);
  });

  it('round-trips a Foxit-shaped export, normalising its dates to UTC', () => {
    const original = readXfdf(readText('foxit.xfdf'));
    const again = readXfdf(writeXfdf(original));
    // A PDF date carries an offset and the app stores instants, so `+01:00` comes back as `Z` —
    // the same moment, written the way everything else in the app writes it.
    const instants = (doc: XfdfDocument): unknown =>
      doc.annotations.map((a) => ({
        ...a,
        created: a.created === null ? null : Date.parse(a.created),
        modified: a.modified === null ? null : Date.parse(a.modified),
      }));
    expect(instants(again)).toEqual(instants(original));
    expect(again.annotations[0]?.created).toMatch(/Z$/);
  });

  it('is stable: writing the same document twice gives the same bytes', () => {
    const doc = readXfdf(readText('acrobat.xfdf'));
    expect(writeXfdf(doc)).toBe(writeXfdf(doc));
  });

  it('declares UTF-8 and survives text that needs it', () => {
    const doc: XfdfDocument = {
      href: 'ünïcode.pdf',
      ids: null,
      fields: [],
      annotations: [
        {
          ...EMPTY_XFDF_ANNOTATION,
          subtype: 'Text',
          name: 'u1',
          contents: 'Ελληνικά — “quoted” & <angled>\nsecond line',
          author: 'Ä. Reviewer',
        },
      ],
    };
    const text = writeXfdf(doc);
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(text).not.toContain('<angled>');
    const back = readXfdf(text);
    expect(back.annotations[0]?.contents).toBe(doc.annotations[0]?.contents);
    expect(back.annotations[0]?.author).toBe('Ä. Reviewer');
    expect(back.href).toBe('ünïcode.pdf');
  });

  it('writes form fields when it is given them', () => {
    const text = writeXfdf({
      href: null,
      ids: null,
      annotations: [],
      fields: [{ name: 'name.first', value: 'Ada' }],
    });
    expect(readXfdf(text).fields).toEqual([{ name: 'name.first', value: 'Ada' }]);
  });

  it('refuses a file that is not XFDF', () => {
    expect(() => readXfdf('<html><body>no</body></html>')).toThrow(XfdfError);
  });
});

describe('FDF', () => {
  const doc = readFdf(readBytes('acrobat.fdf'));

  it('reads the annotations through the object map', () => {
    expect(doc.annotations).toHaveLength(4);
    expect(doc.href).toBe('report.pdf');
  });

  it('reads a highlight with quads and a packed /F flag field', () => {
    const h = byName(doc, 'fdf-0001');
    expect(h.subtype).toBe('Highlight');
    expect(h.quadPoints).toEqual([72, 714, 240, 714, 72, 700, 240, 700]);
    expect(h.color).toBe(0xffff00);
    expect(h.flags.print).toBe(true);
    expect(h.flags.hidden).toBe(false);
  });

  it('decodes a UTF-16BE hex string', () => {
    expect(byName(doc, 'fdf-0002').contents).toBe('The copy says “élan”');
  });

  it('follows an /IRT reference to the parent’s /NM', () => {
    const reply = byName(doc, 'fdf-0003');
    expect(reply.inReplyTo).toBe('fdf-0002');
    expect(reply.replyType).toBe('R');
    expect(reply.state).toBe('Rejected');
  });

  it('reads ink strokes and a border width', () => {
    const ink = byName(doc, 'fdf-0004');
    expect(ink.paths).toHaveLength(2);
    expect(ink.borderWidth).toBe(2);
  });

  it('reads form fields', () => {
    expect(doc.fields).toEqual([{ name: 'name.first', value: 'Ada' }]);
  });

  it('round-trips through the writer', () => {
    const again = readFdf(writeFdf(doc));
    expect(again.annotations).toEqual(doc.annotations);
    expect(again.fields).toEqual(doc.fields);
    expect(again.href).toBe(doc.href);
  });

  it('round-trips an XFDF document through FDF without losing a field', () => {
    const source = readXfdf(readText('acrobat.xfdf'));
    const again = readFdf(writeFdf(source));
    // FDF has no place for a stamp name that is not a `/Name`, and nothing else differs.
    expect(again.annotations).toEqual(source.annotations);
  });

  it('refuses a file that is not FDF', () => {
    expect(() => readFdf(new TextEncoder().encode('%PDF-1.7\n'))).toThrow(XfdfError);
  });
});

describe('readComments', () => {
  it('sniffs the format rather than trusting the extension', () => {
    expect(readComments(readBytes('acrobat.fdf'), 'xfdf').annotations).toHaveLength(4);
    expect(
      readComments(new TextEncoder().encode(readText('foxit.xfdf')), 'fdf').annotations,
    ).toHaveLength(11);
  });

  it('names the format a file name implies', () => {
    expect(formatOfName('comments.XFDF')).toBe('xfdf');
    expect(formatOfName('comments.fdf')).toBe('fdf');
    expect(formatOfName('comments.pdf')).toBeNull();
  });

  it('says plainly when a file is neither', () => {
    expect(() => readComments(new TextEncoder().encode('just words'))).toThrow(
      /not an FDF or XFDF/,
    );
  });
});
