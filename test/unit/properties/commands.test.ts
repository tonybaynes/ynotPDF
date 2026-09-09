/**
 * M72's commands and the mapping around them: properties in, patch out, XMP kept in step, undo
 * exact (ADR 0017).
 *
 * `FakeEngine` rather than PDFium, like every other model test: what is under test is the model
 * change and the write intent it records, and the fake's `setMetadata: false` reproduces the real
 * adapter's refusal exactly.
 */

import { describe, expect, it } from 'vitest';
import type { Document } from '@core/Document';
import { isReplayable, replayJournal, serialiseJournal } from '@core/Journal';
import { readXmp } from '@engine/xmp';
import {
  SetInitialViewCommand,
  SetPropertiesCommand,
  registerPropertiesCodecs,
  xmpFactsOf,
} from '@modules/M72-properties-metadata/commands';
import {
  customNameProblem,
  customRecord,
  propertiesPatch,
  readInitialView,
  readProperties,
  viewPatch,
} from '@modules/M72-properties-metadata/properties';
import { openFake } from '../core/helpers';

async function document(): Promise<Document> {
  const { doc } = await openFake(undefined, { setMetadata: false });
  return doc;
}

describe('readProperties', () => {
  it('reads the model, with a missing entry as an empty box', async () => {
    const doc = await document();
    const properties = readProperties(doc);
    expect(properties.subject).toBe('');
    expect(properties.custom).toEqual([]);
    expect(properties.trapped).toBeNull();
  });

  it('lists custom properties by name', async () => {
    const doc = await document();
    doc.setMetadataRecord({ custom: { Reference: 'A-1', Department: 'Accounts' } });
    expect(readProperties(doc).custom).toEqual([
      { name: 'Department', value: 'Accounts' },
      { name: 'Reference', value: 'A-1' },
    ]);
  });
});

describe('propertiesPatch', () => {
  it('is null when nothing changed', async () => {
    const doc = await document();
    const before = readProperties(doc);
    expect(propertiesPatch(before, { ...before })).toBeNull();
  });

  it('turns an emptied box into a removal, not into an empty string', async () => {
    const doc = await document();
    doc.setMetadataRecord({ title: 'Something' });
    const before = readProperties(doc);
    expect(propertiesPatch(before, { ...before, title: '' })).toEqual({ title: null });
  });

  it('carries the whole custom set when one property changes', async () => {
    const doc = await document();
    doc.setMetadataRecord({ custom: { A: '1', B: '2' } });
    const before = readProperties(doc);
    const patch = propertiesPatch(before, {
      ...before,
      custom: [{ name: 'A', value: '1' }],
    });
    expect(patch).toEqual({ custom: { A: '1' } });
  });
});

describe('customRecord and customNameProblem', () => {
  it('drops a property with no name', () => {
    expect(
      customRecord([
        { name: '  ', value: 'x' },
        { name: 'A', value: '1' },
      ]),
    ).toEqual({
      A: '1',
    });
  });

  it('refuses a blank name, a standard name and a duplicate', () => {
    const list = [
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ];
    expect(customNameProblem('', list, 0)).toContain('needs a name');
    expect(customNameProblem('Title', list, 0)).toContain('standard properties');
    expect(customNameProblem('B', list, 0)).toContain('already a property');
    expect(customNameProblem('C', list, 0)).toBeNull();
    // Its own name is not a duplicate of itself.
    expect(customNameProblem('A', list, 0)).toBeNull();
  });
});

describe('SetPropertiesCommand', () => {
  it('records a metadata write intent, because PDFium has no setter', async () => {
    const doc = await document();
    await doc.apply(new SetPropertiesCommand(doc, { title: 'Quarterly report' }));
    expect(doc.state.metadata.title).toBe('Quarterly report');
    expect(doc.state.writeIntents).toContain('metadata');
  });

  it('keeps the XMP packet in step with the information dictionary', async () => {
    const doc = await document();
    await doc.apply(
      new SetPropertiesCommand(doc, { title: 'A title', author: 'A Writer', keywords: 'x; y' }),
    );
    const xmp = readXmp(doc.state.metadata.xmp);
    expect(xmp.title).toBe('A title');
    expect(xmp.author).toBe('A Writer');
    expect(xmp.keywords).toBe('x; y');
  });

  it('mirrors custom properties into the pdfx namespace', async () => {
    const doc = await document();
    await doc.apply(new SetPropertiesCommand(doc, { custom: { Department: 'Accounts' } }));
    expect(doc.state.metadata.xmp).toContain('http://ns.adobe.com/pdfx/1.3/');
    expect(readXmp(doc.state.metadata.xmp).custom).toEqual({ Department: 'Accounts' });
  });

  it('leaves everything else in an existing packet alone', async () => {
    const doc = await document();
    doc.setMetadataRecord({
      xmp: `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>1</pdfaid:part></rdf:Description>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`,
    });
    await doc.apply(new SetPropertiesCommand(doc, { title: 'Renamed' }));
    expect(doc.state.metadata.xmp).toContain('pdfaid:part');
    expect(readXmp(doc.state.metadata.xmp).title).toBe('Renamed');
  });

  it('undoes to the packet it started from, not to a re-derived one', async () => {
    const doc = await document();
    doc.setMetadataRecord({ title: 'Before' });
    const original = doc.state.metadata.xmp;
    await doc.apply(new SetPropertiesCommand(doc, { title: 'After' }));
    expect(doc.state.metadata.xmp).not.toBe(original);
    await doc.undoLast();
    expect(doc.state.metadata.title).toBe('Before');
    expect(doc.state.metadata.xmp).toBe(original);
  });

  it('merges a run of edits into one undo step', async () => {
    const doc = await document();
    doc.setMetadataRecord({ title: 'Start' });
    await doc.apply(new SetPropertiesCommand(doc, { title: 'One' }));
    await doc.apply(new SetPropertiesCommand(doc, { title: 'Two' }));
    expect(doc.state.metadata.title).toBe('Two');
    expect(doc.undo.state.length).toBe(1);
    await doc.undoLast();
    expect(doc.state.metadata.title).toBe('Start');
  });
});

describe('SetInitialViewCommand', () => {
  it('changes the view and records the view intent', async () => {
    const doc = await document();
    await doc.apply(
      new SetInitialViewCommand(doc, { pageMode: 'outlines', pageLayout: 'two-page-left' }),
    );
    expect(doc.state.view.pageMode).toBe('outlines');
    expect(doc.state.writeIntents).toContain('view');
  });

  it('undoes exactly the fields it set', async () => {
    const doc = await document();
    await doc.apply(new SetInitialViewCommand(doc, { hideToolbar: true, direction: 'r2l' }));
    await doc.undoLast();
    expect(doc.state.view.hideToolbar).toBe(false);
    expect(doc.state.view.direction).toBe('l2r');
  });

  it('is not an edit when nothing differs', async () => {
    const doc = await document();
    const before = readInitialView(doc);
    expect(viewPatch(before, { ...before })).toBeNull();
    expect(viewPatch(before, { ...before, fitWindow: true })).toEqual({ fitWindow: true });
  });
});

describe('journal codecs', () => {
  it('rebuild both commands from their serialised form', async () => {
    registerPropertiesCodecs();
    const doc = await document();
    await doc.apply(new SetPropertiesCommand(doc, { title: 'Recovered' }));
    await doc.apply(new SetInitialViewCommand(doc, { pageMode: 'thumbnails' }));
    // Through JSON, as the recovery file is: a codec that only works on live objects is no use.
    const file = JSON.parse(JSON.stringify(serialiseJournal(doc))) as ReturnType<
      typeof serialiseJournal
    >;
    expect(file.entries.every((entry) => isReplayable(entry))).toBe(true);

    const fresh = await document();
    const result = await replayJournal(fresh, file.entries);
    expect(result.skipped).toBe(0);
    expect(fresh.state.metadata.title).toBe('Recovered');
    expect(fresh.state.view.pageMode).toBe('thumbnails');
  });
});

describe('xmpFactsOf', () => {
  it('turns an empty field into a removal', async () => {
    const doc = await document();
    doc.setMetadataRecord({ title: '', author: null, producer: 'ynotPDF' });
    const facts = xmpFactsOf(doc.state.metadata);
    expect(facts.title).toBeNull();
    expect(facts.author).toBeNull();
    expect(facts.producer).toBe('ynotPDF');
  });
});
