/**
 * The writer's remaining sections (M21): named destinations, layers, field values, the outline
 * in detail, and what happens to references when a page goes.
 *
 * These are driven with hand-built plans against small documents built by pdf-lib, because each
 * one is a claim about the bytes rather than about the model — and because reaching, say, a
 * closed bookmark with a colour through the whole model would say less about the writer than it
 * would about the commands that got there.
 */

import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPageLeaf,
  PDFRef,
  PDFString,
} from 'pdf-lib';
import { emptyWritePlan, type WritePlan } from '@engine/Writer';
import { FullRewriteWriter, isoToPdfDate, pageLabelNums } from '@engine/writers/FullRewriteWriter';
import { engine } from '../engine/helpers';

/** A document of `pages` blank pages, uncompressed so a test can read it back easily. */
async function blank(pages: number): Promise<PDFDocument> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < pages; i++) pdf.addPage([300, 400]);
  return pdf;
}

const save = (pdf: PDFDocument): Promise<Uint8Array> =>
  pdf.save({ useObjectStreams: false, updateFieldAppearances: false });

const write = (bytes: Uint8Array, plan: WritePlan) =>
  new FullRewriteWriter().write({ bytes, plan, options: { objectStreams: false } });

/** Page leaves of a document, in order. */
function leaves(pdf: PDFDocument): PDFPageLeaf[] {
  const out: PDFPageLeaf[] = [];
  pdf.catalog.Pages().traverse((node) => {
    if (node instanceof PDFPageLeaf) out.push(node);
  });
  return out;
}

const reload = (bytes: Uint8Array): Promise<PDFDocument> =>
  PDFDocument.load(bytes, { updateMetadata: false });

const plan = (pageCount: number, over: Partial<WritePlan> = {}): WritePlan => ({
  ...emptyWritePlan(pageCount),
  ...over,
});

describe('page labels', () => {
  it('compresses a counting run and spells out anything else', () => {
    expect(pageLabelNums(['1', '2', '3'])).toEqual([{ index: 0, entry: { S: 'D', St: 1 } }]);
    expect(pageLabelNums(['A-1', 'A-2'])).toEqual([
      { index: 0, entry: { S: 'D', P: 'A-', St: 1 } },
    ]);
    expect(pageLabelNums(['i', 'ii'])).toEqual([
      { index: 0, entry: { P: 'i' } },
      { index: 1, entry: { P: 'ii' } },
    ]);
    // A run that skips a number is two runs, not one wrong one.
    expect(pageLabelNums(['1', '3'])).toEqual([
      { index: 0, entry: { S: 'D', St: 1 } },
      { index: 1, entry: { S: 'D', St: 3 } },
    ]);
    // A leading zero is not decimal numbering: "007" has to survive as itself.
    expect(pageLabelNums(['007'])).toEqual([{ index: 0, entry: { P: '007' } }]);
    expect(pageLabelNums([])).toEqual([]);
  });
});

describe('dates', () => {
  it('turns an ISO date into the form a PDF wants, and refuses anything else', () => {
    expect(isoToPdfDate('2026-09-08T12:34:56Z')).toBe("D:20260908123456Z00'00'");
    expect(isoToPdfDate('2026-01-01T00:00:00Z')).toBe("D:20260101000000Z00'00'");
    expect(isoToPdfDate('not a date')).toBeNull();
  });
});

describe('metadata', () => {
  it('writes the information dictionary and the XMP packet', async () => {
    const bytes = await save(await blank(1));
    const result = await write(bytes, {
      ...plan(1),
      metadata: {
        title: 'A title',
        author: 'An author',
        created: '2026-09-08T00:00:00Z',
        xmp: '<?xpacket begin="" ?><x:xmpmeta xmlns:x="adobe:ns:meta/"/><?xpacket end="w"?>',
      },
    });
    expect(result.applied).toContain('metadata');

    const pdf = await reload(result.bytes);
    const info = pdf.context.lookupMaybe(pdf.context.trailerInfo.Info, PDFDict);
    expect(info?.lookupMaybe(PDFName.of('Title'), PDFString, PDFHexString)?.decodeText()).toBe(
      'A title',
    );
    expect(
      info?.lookupMaybe(PDFName.of('CreationDate'), PDFString, PDFHexString)?.decodeText(),
    ).toContain('D:20260908');
    // XMP is a stream on the catalogue, and it is never compressed.
    const meta = pdf.catalog.get(PDFName.of('Metadata'));
    expect(meta).toBeInstanceOf(PDFRef);
    const stream = pdf.context.lookup(meta) as unknown as { dict: PDFDict };
    expect(stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText()).toBe('XML');
    expect(stream.dict.get(PDFName.of('Filter'))).toBeUndefined();
  });

  it('a null removes the entry rather than writing the word "null"', async () => {
    const pdf = await blank(1);
    pdf.setTitle('Goes away');
    pdf.setAuthor('Stays');
    const result = await write(await save(pdf), {
      ...plan(1),
      metadata: { title: null, xmp: null },
    });
    const back = await reload(result.bytes);
    const info = back.context.lookupMaybe(back.context.trailerInfo.Info, PDFDict);
    expect(info?.get(PDFName.of('Title'))).toBeUndefined();
    expect(info?.lookupMaybe(PDFName.of('Author'), PDFString, PDFHexString)?.decodeText()).toBe(
      'Stays',
    );
    expect(back.catalog.get(PDFName.of('Metadata'))).toBeUndefined();
  });

  it('an unparsable date is left out rather than written as rubbish', async () => {
    const result = await write(await save(await blank(1)), {
      ...plan(1),
      metadata: { modified: 'the day before yesterday' },
    });
    const back = await reload(result.bytes);
    const info = back.context.lookupMaybe(back.context.trailerInfo.Info, PDFDict);
    expect(info?.get(PDFName.of('ModDate'))).toBeUndefined();
  });

  it('the producer option fills in only when the plan says nothing about it', async () => {
    const bytes = await save(await blank(1));
    const withOption = await new FullRewriteWriter().write({
      bytes,
      plan: { ...plan(1), metadata: { title: 'X' } },
      options: { producer: 'ynotPDF test', objectStreams: false },
    });
    const back = await reload(withOption.bytes);
    const info = back.context.lookupMaybe(back.context.trailerInfo.Info, PDFDict);
    expect(info?.lookupMaybe(PDFName.of('Producer'), PDFString, PDFHexString)?.decodeText()).toBe(
      'ynotPDF test',
    );
  });
});

describe('the outline', () => {
  it('writes a tree with the links a reader walks it by', async () => {
    const result = await write(await save(await blank(3)), {
      ...plan(3),
      outline: [
        {
          title: 'One',
          parent: null,
          dest: { page: 0, fit: 'xyz', left: 0, top: 400, zoom: null },
          uri: null,
          open: true,
          bold: true,
          italic: false,
          color: 0xff0000,
        },
        {
          title: 'One.a',
          parent: 0,
          dest: { page: 1, fit: 'fit' },
          uri: null,
          open: false,
          bold: false,
          italic: true,
          color: null,
        },
        {
          title: 'Two',
          parent: null,
          dest: null,
          uri: 'https://example.invalid/',
          open: true,
          bold: false,
          italic: false,
          color: null,
        },
      ],
    });
    expect(result.applied).toContain('outline');

    const pdf = await reload(result.bytes);
    const outlines = pdf.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
    if (!outlines) throw new Error('no /Outlines');
    // Two roots, and the visible count includes the open root's one child.
    expect(outlines.lookupMaybe(PDFName.of('Count'), PDFNumber)?.asNumber()).toBe(3);

    const first = pdf.context.lookupMaybe(outlines.get(PDFName.of('First')), PDFDict);
    expect(first?.lookupMaybe(PDFName.of('Title'), PDFString, PDFHexString)?.decodeText()).toBe(
      'One',
    );
    // Bold is bit 2 of /F, italic bit 1.
    expect(first?.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber()).toBe(2);
    expect(first?.lookupMaybe(PDFName.of('C'), PDFArray)?.size()).toBe(3);
    expect(first?.lookupMaybe(PDFName.of('Dest'), PDFArray)?.size()).toBe(5);

    const child = pdf.context.lookupMaybe(first?.get(PDFName.of('First')), PDFDict);
    expect(child?.lookupMaybe(PDFName.of('Title'), PDFString, PDFHexString)?.decodeText()).toBe(
      'One.a',
    );
    expect(child?.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber()).toBe(1);

    // Siblings are a doubly linked list, and the second root carries a URI action.
    const second = pdf.context.lookupMaybe(first?.get(PDFName.of('Next')), PDFDict);
    expect(second?.lookupMaybe(PDFName.of('Title'), PDFString, PDFHexString)?.decodeText()).toBe(
      'Two',
    );
    expect(pdf.context.lookupMaybe(second?.get(PDFName.of('Prev')), PDFDict)).toBe(first);
    const action = second?.lookupMaybe(PDFName.of('A'), PDFDict);
    expect(action?.lookupMaybe(PDFName.of('S'), PDFName)?.decodeText()).toBe('URI');
  });

  it('a closed bookmark counts its children negatively, as the spec asks', async () => {
    const result = await write(await save(await blank(2)), {
      ...plan(2),
      outline: [
        {
          title: 'Shut',
          parent: null,
          dest: null,
          uri: null,
          open: false,
          bold: false,
          italic: false,
          color: null,
        },
        {
          title: 'Inside',
          parent: 0,
          dest: null,
          uri: null,
          open: false,
          bold: false,
          italic: false,
          color: null,
        },
      ],
    });
    const pdf = await reload(result.bytes);
    const outlines = pdf.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
    const root = pdf.context.lookupMaybe(outlines?.get(PDFName.of('First')), PDFDict);
    expect(root?.lookupMaybe(PDFName.of('Count'), PDFNumber)?.asNumber()).toBe(-1);
  });

  it('an empty outline removes the tree', async () => {
    const pdf = await blank(1);
    pdf.catalog.set(PDFName.of('Outlines'), pdf.context.register(pdf.context.obj({})));
    const result = await write(await save(pdf), { ...plan(1), outline: [] });
    const back = await reload(result.bytes);
    expect(back.catalog.get(PDFName.of('Outlines'))).toBeUndefined();
  });

  it('a bookmark aimed at a page that is not there is reported, not written', async () => {
    const result = await write(await save(await blank(1)), {
      ...plan(1),
      outline: [
        {
          title: 'Nowhere',
          parent: null,
          dest: { page: 7, fit: 'fit' },
          uri: null,
          open: true,
          bold: false,
          italic: false,
          color: null,
        },
      ],
    });
    expect(result.warnings.join(' ')).toContain('no longer there');
    const pdf = await reload(result.bytes);
    const outlines = pdf.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
    const item = pdf.context.lookupMaybe(outlines?.get(PDFName.of('First')), PDFDict);
    expect(item?.get(PDFName.of('Dest'))).toBeUndefined();
  });
});

describe('named destinations', () => {
  it('writes a sorted name tree that the engine can read back', async () => {
    const result = await write(await save(await blank(3)), {
      ...plan(3),
      namedDestinations: [
        { name: 'zebra', dest: { page: 2, fit: 'fit' } },
        { name: 'apple', dest: { page: 0, fit: 'xyz', left: 10, top: 390, zoom: 2 } },
        { name: 'middle', dest: { page: 1, fit: 'fitH', top: 200 } },
      ],
    });
    expect(result.applied).toContain('destinations');

    const pdf = await reload(result.bytes);
    const names = pdf.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
    const dests = names?.lookupMaybe(PDFName.of('Dests'), PDFDict);
    const array = dests?.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (!array) throw new Error('no name tree');
    // Sorted by name: a reader binary-searches this array.
    const keys = [0, 2, 4].map((i) =>
      pdf.context.lookupMaybe(array.get(i), PDFString, PDFHexString)?.decodeText(),
    );
    expect(keys).toEqual(['apple', 'middle', 'zebra']);

    const eng = await engine();
    const handle = await eng.open(result.bytes.slice());
    const read = await eng.namedDestinations(handle);
    await eng.close(handle);
    expect(read.map((d) => d.name).sort()).toEqual(['apple', 'middle', 'zebra']);
    expect(read.find((d) => d.name === 'zebra')?.dest.page).toBe(2);
  });

  it('every fit mode writes the number of parameters the spec gives it', async () => {
    const fits = [
      ['fit', 2],
      ['fitB', 2],
      ['fitH', 3],
      ['fitBH', 3],
      ['fitV', 3],
      ['fitBV', 3],
      ['xyz', 5],
      ['fitR', 6],
    ] as const;
    const result = await write(await save(await blank(1)), {
      ...plan(1),
      namedDestinations: fits.map(([fit]) => ({
        name: fit,
        dest: {
          page: 0,
          fit,
          left: 1,
          top: 2,
          zoom: 3,
          rect: { x0: 0, y0: 0, x1: 10, y1: 10 },
        },
      })),
    });
    const pdf = await reload(result.bytes);
    const array = pdf.catalog
      .lookupMaybe(PDFName.of('Names'), PDFDict)
      ?.lookupMaybe(PDFName.of('Dests'), PDFDict)
      ?.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (!array) throw new Error('no name tree');
    for (let i = 0; i + 1 < array.size(); i += 2) {
      const name = pdf.context.lookupMaybe(array.get(i), PDFString, PDFHexString)?.decodeText();
      const dest = pdf.context
        .lookupMaybe(array.get(i + 1), PDFDict)
        ?.lookupMaybe(PDFName.of('D'), PDFArray);
      const expected = fits.find(([fit]) => fit === name)?.[1];
      expect(dest?.size(), name).toBe(expected);
    }
  });

  it('a fitR with no rectangle is dropped rather than written short', async () => {
    const result = await write(await save(await blank(1)), {
      ...plan(1),
      namedDestinations: [{ name: 'bad', dest: { page: 0, fit: 'fitR' } }],
    });
    expect(result.warnings.join(' ')).toContain('no longer there');
  });

  it('an empty list removes the tree and any pre-1.2 catalogue dictionary', async () => {
    const pdf = await blank(1);
    const legacy = pdf.context.obj({});
    legacy.set(PDFName.of('old'), pdf.context.obj([]));
    pdf.catalog.set(PDFName.of('Dests'), pdf.context.register(legacy));
    const result = await write(await save(pdf), { ...plan(1), namedDestinations: [] });
    const back = await reload(result.bytes);
    expect(back.catalog.get(PDFName.of('Dests'))).toBeUndefined();
  });
});

describe('layers', () => {
  /** A document with two optional-content groups. */
  async function withLayers(): Promise<PDFDocument> {
    const pdf = await blank(1);
    const make = (name: string): PDFRef => {
      const ocg = pdf.context.obj({});
      ocg.set(PDFName.of('Type'), PDFName.of('OCG'));
      ocg.set(PDFName.of('Name'), PDFHexString.fromText(name));
      return pdf.context.register(ocg);
    };
    const a = make('Background');
    const b = make('Notes');
    const props = pdf.context.obj({});
    props.set(PDFName.of('OCGs'), pdf.context.obj([a, b]));
    props.set(PDFName.of('D'), pdf.context.register(pdf.context.obj({})));
    pdf.catalog.set(PDFName.of('OCProperties'), pdf.context.register(props));
    return pdf;
  }

  it('turns a named group off and leaves the other on', async () => {
    const result = await write(await save(await withLayers()), {
      ...plan(1),
      layers: [
        { id: 'ocg.1', name: 'Background', index: 0, visible: true },
        { id: 'ocg.2', name: 'Notes', index: 1, visible: false },
      ],
    });
    expect(result.applied).toContain('layers');

    const eng = await engine();
    const handle = await eng.open(result.bytes.slice());
    const read = await eng.layers(handle);
    await eng.close(handle);
    expect(read.map((l) => [l.name, l.visible])).toEqual([
      ['Background', true],
      ['Notes', false],
    ]);
  });

  it('falls back to the position when two groups share a name', async () => {
    const pdf = await blank(1);
    const make = (): PDFRef => {
      const ocg = pdf.context.obj({});
      ocg.set(PDFName.of('Type'), PDFName.of('OCG'));
      ocg.set(PDFName.of('Name'), PDFHexString.fromText('Layer'));
      return pdf.context.register(ocg);
    };
    const props = pdf.context.obj({});
    props.set(PDFName.of('OCGs'), pdf.context.obj([make(), make()]));
    pdf.catalog.set(PDFName.of('OCProperties'), pdf.context.register(props));

    const result = await write(await save(pdf), {
      ...plan(1),
      layers: [
        { id: 'ocg.1', name: 'Layer', index: 0, visible: true },
        { id: 'ocg.2', name: 'Layer', index: 1, visible: false },
      ],
    });
    expect(result.warnings).toEqual([]);
    const eng = await engine();
    const handle = await eng.open(result.bytes.slice());
    const read = await eng.layers(handle);
    await eng.close(handle);
    expect(read.map((l) => l.visible)).toEqual([true, false]);
  });

  it('says so when the file has no layers to set', async () => {
    const result = await write(await save(await blank(1)), {
      ...plan(1),
      layers: [{ id: 'ocg.1', name: 'Nope', index: 0, visible: false }],
    });
    expect(result.warnings.join(' ')).toContain('no layers');
  });

  it('a layer that cannot be found is reported rather than guessed at', async () => {
    const result = await write(await save(await withLayers()), {
      ...plan(1),
      layers: [{ id: 'ocg.9', name: 'Missing', index: 9, visible: false }],
    });
    expect(result.warnings.join(' ')).toContain('could not be found');
  });
});

describe('form fields', () => {
  /** A one-page document with a text field and its widget. */
  async function withField(value: string): Promise<PDFDocument> {
    const pdf = await blank(1);
    const page = leaves(pdf)[0];
    if (!page) throw new Error('no page');
    const widget = pdf.context.obj({});
    widget.set(PDFName.of('Type'), PDFName.of('Annot'));
    widget.set(PDFName.of('Subtype'), PDFName.of('Widget'));
    widget.set(PDFName.of('FT'), PDFName.of('Tx'));
    widget.set(PDFName.of('T'), PDFHexString.fromText('name'));
    widget.set(PDFName.of('V'), PDFHexString.fromText(value));
    widget.set(PDFName.of('Rect'), pdf.context.obj([10, 10, 200, 30]));
    widget.set(PDFName.of('AP'), pdf.context.obj({}));
    const ref = pdf.context.register(widget);
    page.set(PDFName.of('Annots'), pdf.context.obj([ref]));
    const acro = pdf.context.obj({});
    acro.set(PDFName.of('Fields'), pdf.context.obj([ref]));
    pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.register(acro));
    return pdf;
  }

  it('writes a value the engine reads back', async () => {
    const result = await write(await save(await withField('before')), {
      ...plan(1),
      fields: [{ name: 'name', value: 'after' }],
    });
    expect(result.applied).toContain('fields');
    const eng = await engine();
    const handle = await eng.open(result.bytes.slice());
    const fields = await eng.formFields(handle);
    await eng.close(handle);
    expect(fields.find((f) => f.name === 'name')?.value).toBe('after');
  });

  it('clearing drops /V, drops the stale appearance and asks viewers to redraw', async () => {
    const result = await write(await save(await withField('to be cleared')), {
      ...plan(1),
      fields: [{ name: 'name', value: null }],
    });
    const pdf = await reload(result.bytes);
    const acro = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
    const field = pdf.context.lookupMaybe(fields?.get(0), PDFDict);
    expect(field?.get(PDFName.of('V'))).toBeUndefined();
    // The appearance stream said "to be cleared"; leaving it would go on saying so.
    expect(field?.get(PDFName.of('AP'))).toBeUndefined();
    expect(acro?.get(PDFName.of('NeedAppearances'))).toBeDefined();
  });

  it('a field that is not in the file is reported, not invented', async () => {
    const result = await write(await save(await withField('x')), {
      ...plan(1),
      fields: [{ name: 'nowhere', value: 'y' }],
    });
    expect(result.warnings.join(' ')).toContain('not in the file');
  });

  it('a file with no form says so rather than failing the save', async () => {
    const result = await write(await save(await blank(1)), {
      ...plan(1),
      fields: [{ name: 'any', value: 'y' }],
    });
    expect(result.warnings.join(' ')).toContain('no form');
    expect(result.bytes.byteLength).toBeGreaterThan(0);
  });
});

describe('when a page goes', () => {
  /** Three pages, a bookmark and a named destination on the last, and a link to it on the first. */
  async function crossReferenced(): Promise<PDFDocument> {
    const pdf = await blank(3);
    const pages = leaves(pdf);
    const last = pages[2];
    const first = pages[0];
    if (!last || !first) throw new Error('no pages');
    const lastRef = pdf.context.getObjectRef(last);
    if (!lastRef) throw new Error('no ref');
    const dest = pdf.context.obj([lastRef, PDFName.of('Fit')]);

    const item = pdf.context.obj({});
    item.set(PDFName.of('Title'), PDFHexString.fromText('The end'));
    item.set(PDFName.of('Dest'), dest);
    const itemRef = pdf.context.register(item);
    const outlines = pdf.context.obj({});
    outlines.set(PDFName.of('Type'), PDFName.of('Outlines'));
    outlines.set(PDFName.of('First'), itemRef);
    outlines.set(PDFName.of('Last'), itemRef);
    pdf.catalog.set(PDFName.of('Outlines'), pdf.context.register(outlines));

    const leaf = pdf.context.obj({});
    leaf.set(PDFName.of('Names'), pdf.context.obj([PDFString.of('end'), dest]));
    const names = pdf.context.obj({});
    names.set(PDFName.of('Dests'), pdf.context.register(leaf));
    pdf.catalog.set(PDFName.of('Names'), pdf.context.register(names));
    pdf.catalog.set(PDFName.of('OpenAction'), dest);

    const link = pdf.context.obj({});
    link.set(PDFName.of('Type'), PDFName.of('Annot'));
    link.set(PDFName.of('Subtype'), PDFName.of('Link'));
    link.set(PDFName.of('Rect'), pdf.context.obj([0, 0, 100, 20]));
    link.set(PDFName.of('Dest'), dest);
    first.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(link)]));
    return pdf;
  }

  it('everything that pointed at it lets go, and the rest survives', async () => {
    const result = await write(await save(await crossReferenced()), {
      ...plan(3),
      pagesUnchanged: false,
      pages: [{ source: 0 }, { source: 1 }],
    });
    expect(result.applied).toContain('pages');

    const pdf = await reload(result.bytes);
    expect(leaves(pdf)).toHaveLength(2);

    // The bookmark is still there — a heading the reader wrote is not deleted with a page — but
    // it no longer points at an object that has gone.
    const outlines = pdf.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
    const item = pdf.context.lookupMaybe(outlines?.get(PDFName.of('First')), PDFDict);
    expect(item?.lookupMaybe(PDFName.of('Title'), PDFString, PDFHexString)?.decodeText()).toBe(
      'The end',
    );
    expect(item?.get(PDFName.of('Dest'))).toBeUndefined();

    // The name-tree entry and the document's opening view are gone with it.
    const dests = pdf.catalog
      .lookupMaybe(PDFName.of('Names'), PDFDict)
      ?.lookupMaybe(PDFName.of('Dests'), PDFDict)
      ?.lookupMaybe(PDFName.of('Names'), PDFArray);
    expect(dests?.size()).toBe(0);
    expect(pdf.catalog.get(PDFName.of('OpenAction'))).toBeUndefined();

    // And the link on the surviving page is inert rather than dangling.
    const annots = leaves(pdf)[0]?.lookupMaybe(PDFName.of('Annots'), PDFArray);
    const link = pdf.context.lookupMaybe(annots?.get(0), PDFDict);
    expect(link?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText()).toBe('Link');
    expect(link?.get(PDFName.of('Dest'))).toBeUndefined();

    // The file still opens.
    const eng = await engine();
    const handle = await eng.open(result.bytes.slice());
    expect(await eng.pageCount(handle)).toBe(2);
    await eng.close(handle);
  });

  it('reordering keeps every page and its cross-references', async () => {
    const result = await write(await save(await crossReferenced()), {
      ...plan(3),
      pagesUnchanged: false,
      pages: [{ source: 2 }, { source: 1 }, { source: 0 }],
    });
    const pdf = await reload(result.bytes);
    expect(leaves(pdf)).toHaveLength(3);
    // Nothing was deleted, so the bookmark still points somewhere.
    const outlines = pdf.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
    const item = pdf.context.lookupMaybe(outlines?.get(PDFName.of('First')), PDFDict);
    expect(item?.get(PDFName.of('Dest'))).toBeDefined();
  });

  it('a page named twice is written once, and said so', async () => {
    const result = await write(await save(await blank(2)), {
      ...plan(2),
      pagesUnchanged: false,
      pages: [{ source: 0 }, { source: 0 }, { source: 1 }],
    });
    expect(result.warnings.join(' ')).toContain('twice');
    const pdf = await reload(result.bytes);
    expect(leaves(pdf)).toHaveLength(2);
  });

  it('a page the plan names but the file does not have is reported', async () => {
    const result = await write(await save(await blank(2)), {
      ...plan(2),
      pagesUnchanged: false,
      pages: [{ source: 0 }, { source: 5 }],
    });
    expect(result.warnings.join(' ')).toContain('not in the file');
    const pdf = await reload(result.bytes);
    expect(leaves(pdf)).toHaveLength(1);
  });

  it('a page that inherited its size keeps it when the tree is flattened', async () => {
    const pdf = await blank(2);
    // Move MediaBox up to the tree root, as a file written by another tool may well have it.
    const root = pdf.catalog.Pages();
    const box = pdf.context.obj([0, 0, 300, 400]);
    root.set(PDFName.of('MediaBox'), box);
    for (const leaf of leaves(pdf)) leaf.delete(PDFName.of('MediaBox'));

    const result = await write(await save(pdf), {
      ...plan(2),
      pagesUnchanged: false,
      pages: [{ source: 1 }, { source: 0 }],
    });
    const eng = await engine();
    const handle = await eng.open(result.bytes.slice());
    const size = await eng.pageSize(handle, 0);
    await eng.close(handle);
    expect([size.width, size.height]).toEqual([300, 400]);
  });
});

describe('boxes', () => {
  it('sets what it is given and removes what is null', async () => {
    const pdf = await blank(1);
    const leaf = leaves(pdf)[0];
    leaf?.set(PDFName.of('TrimBox'), pdf.context.obj([1, 1, 2, 2]));
    const result = await write(await save(pdf), {
      ...plan(1),
      pages: [
        {
          source: 0,
          boxes: {
            bleed: { x0: 5, y0: 5, x1: 295, y1: 395 },
            trim: null,
            art: { x0: 10, y0: 10, x1: 290, y1: 390 },
          },
        },
      ],
    });
    const back = await reload(result.bytes);
    const page = leaves(back)[0];
    expect(page?.lookupMaybe(PDFName.of('BleedBox'), PDFArray)?.size()).toBe(4);
    expect(page?.get(PDFName.of('TrimBox'))).toBeUndefined();
    expect(page?.lookupMaybe(PDFName.of('ArtBox'), PDFArray)?.size()).toBe(4);
  });
});
