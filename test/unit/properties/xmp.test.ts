/**
 * The XMP reader and patcher (M72, ADR 0017).
 *
 * The packets tested against are the shapes real producers emit — Acrobat's compact attribute
 * form, its element form, a PDF/A packet with several `rdf:Description`s, a packet whose prefixes
 * are not the conventional ones — because the only claim worth making about a patcher is that it
 * left everything it was not asked to change exactly where it was.
 */

import { describe, expect, it } from 'vitest';
import { patchXmp, readXmp, XMP_NS } from '@engine/xmp';

/** An Acrobat-shaped packet: element form, several namespaces, `xmpMM` provenance. */
const ACROBAT = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 9.1-c001">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Quarterly report</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>A Writer</rdf:li></rdf:Seq></dc:creator>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">Numbers</rdf:li></rdf:Alt></dc:description>
  </rdf:Description>
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreateDate>2026-01-01T09:00:00Z</xmp:CreateDate>
   <xmp:CreatorTool>Some Editor 3</xmp:CreatorTool>
  </rdf:Description>
  <rdf:Description rdf:about=""
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">
   <xmpMM:DocumentID>uuid:a0d0e0f0-0000-4000-8000-000000000000</xmpMM:DocumentID>
   <xmpMM:History><rdf:Seq><rdf:li>saved</rdf:li></rdf:Seq></xmpMM:History>
  </rdf:Description>
  <rdf:Description rdf:about=""
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    pdf:Producer="Some Producer 1.0" pdf:Keywords="alpha, beta"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

/** The PDF/A-1b fixture's packet: two descriptions, one of them nothing to do with us. */
const PDFA = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>1</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description>
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">PDF/A-1b structure sample</rdf:li></rdf:Alt></dc:title></rdf:Description>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;

describe('readXmp', () => {
  it('reads both the element and the attribute form', () => {
    const read = readXmp(ACROBAT);
    expect(read.title).toBe('Quarterly report');
    expect(read.author).toBe('A Writer');
    expect(read.subject).toBe('Numbers');
    expect(read.producer).toBe('Some Producer 1.0');
    expect(read.keywords).toBe('alpha, beta');
    expect(read.creator).toBe('Some Editor 3');
    expect(read.created).toBe('2026-01-01T09:00:00Z');
  });

  it('resolves namespaces by URI, not by prefix', () => {
    const odd = ACROBAT.replace(/dc:/g, 'dublin:').replace(/xmlns:dc=/g, 'xmlns:dublin=');
    expect(readXmp(odd).title).toBe('Quarterly report');
  });

  it('says nothing about a packet it cannot parse', () => {
    expect(readXmp('<not xml at all')).toEqual({ custom: {} });
    expect(readXmp(null)).toEqual({ custom: {} });
  });

  it('reads custom properties from pdfx', () => {
    const packet = patchXmp(null, { custom: { Department: 'Finance', 'Cost centre': 'x' } });
    expect(packet).not.toBeNull();
    expect(readXmp(packet).custom).toEqual({ Department: 'Finance' });
  });
});

describe('patchXmp', () => {
  it('changes only what it was asked to change', () => {
    const patched = patchXmp(ACROBAT, { title: 'New title' });
    expect(patched).not.toBeNull();
    const read = readXmp(patched);
    expect(read.title).toBe('New title');
    expect(read.author).toBe('A Writer');
    expect(read.producer).toBe('Some Producer 1.0');
    // Everything we do not own is still there, byte for byte in its own element.
    expect(patched).toContain('uuid:a0d0e0f0-0000-4000-8000-000000000000');
    expect(patched).toContain('application/pdf');
    expect(patched).toContain('xmpMM:History');
  });

  it('keeps a PDF/A identification block', () => {
    const patched = patchXmp(PDFA, { title: 'Renamed', author: 'Someone' });
    expect(patched).toContain('pdfaid:part');
    expect(patched).toContain('http://www.aiim.org/pdfa/ns/id/');
    expect(readXmp(patched).title).toBe('Renamed');
  });

  it('replaces the attribute form rather than leaving two values', () => {
    const patched = patchXmp(ACROBAT, { producer: 'ynotPDF' }) ?? '';
    expect(readXmp(patched).producer).toBe('ynotPDF');
    expect(patched).not.toContain('Some Producer 1.0');
  });

  it('removes a property set to null', () => {
    const patched = patchXmp(ACROBAT, { title: null });
    expect(readXmp(patched).title).toBeUndefined();
    // The rest of the Dublin Core description is untouched.
    expect(readXmp(patched).author).toBe('A Writer');
  });

  it('writes keywords as a string and as a bag', () => {
    const patched = patchXmp(null, { keywords: 'alpha; beta' }) ?? '';
    expect(patched).toContain('pdf:Keywords');
    expect(patched).toContain('rdf:Bag');
    expect(readXmp(patched).keywords).toBe('alpha; beta');
  });

  it('builds a packet from nothing when there are facts to write', () => {
    const packet = patchXmp(null, { title: 'Fresh', created: '2026-02-03T04:05:06Z' });
    expect(packet).not.toBeNull();
    expect(packet).toContain('<?xpacket begin=');
    expect(packet).toContain('<?xpacket end=');
    expect(packet).toContain(XMP_NS.dc);
    const read = readXmp(packet);
    expect(read.title).toBe('Fresh');
    expect(read.created).toBe('2026-02-03T04:05:06Z');
  });

  it('writes nothing when there is neither a packet nor a fact', () => {
    expect(patchXmp(null, {})).toBeNull();
    expect(patchXmp(undefined, { custom: {} })).toBeNull();
  });

  it('round-trips its own output unchanged', () => {
    const once = patchXmp(ACROBAT, { title: 'Stable', author: 'A; B' }) ?? '';
    const twice = patchXmp(once, { title: 'Stable', author: 'A; B' }) ?? '';
    expect(twice).toBe(once);
    expect(readXmp(twice).author).toBe('A; B');
  });

  it('treats the custom properties it is given as the complete set', () => {
    const first = patchXmp(null, { custom: { Department: 'Finance', Reviewer: 'Sam' } }) ?? '';
    // `pdfx` mirrors the information dictionary's custom entries, so one that is no longer in
    // the dictionary is stale — leaving it would put two answers in one file.
    const second = patchXmp(first, { custom: { Department: 'Finance' } }) ?? '';
    expect(readXmp(second).custom).toEqual({ Department: 'Finance' });
  });

  it('leaves every custom property alone when it is not told about any', () => {
    const first = patchXmp(null, { custom: { Department: 'Finance', Reviewer: 'Sam' } }) ?? '';
    const second = patchXmp(first, { title: 'Only the title changed' }) ?? '';
    expect(readXmp(second).custom).toEqual({ Department: 'Finance', Reviewer: 'Sam' });
  });

  it('escapes text that would otherwise break the XML', () => {
    const packet = patchXmp(null, { title: 'Fish & <chips>' }) ?? '';
    expect(readXmp(packet).title).toBe('Fish & <chips>');
    expect(packet).not.toContain('<chips>');
  });
});
