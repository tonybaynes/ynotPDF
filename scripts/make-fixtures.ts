/**
 * Generates the synthetic PDF corpus in `test/fixtures/` (M00). Deterministic: pdf-lib is
 * given fixed dates/ids so re-running produces identical bytes. All content is invented.
 *
 *   blank.pdf        1 page, A4, no content
 *   multipage.pdf    5 pages, page number drawn on each, mixed sizes and a rotated page
 *   text.pdf         paragraphs in Helvetica / Times / Courier at several sizes
 *   image.pdf        an embedded PNG (generated here) and a JPEG-less raster
 *   form.pdf         AcroForm: text field, checkbox, radio group, dropdown, button
 *   annotated.pdf    Square, Circle, Highlight, Text (sticky note) and Ink annotations
 *   encrypted.pdf    RC4 128-bit standard security (user password "ynot", owner "owner")
 *   outline.pdf      3 pages with nested bookmarks
 *   layers.pdf       optional content groups "Base" (on) and "Overlay" (off)
 *   attachments.pdf  two embedded files (txt, csv)
 *
 * Usage: `node scripts/make-fixtures.ts` (writes into test/fixtures/).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { PDFDict } from 'pdf-lib';
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
  type PDFPage,
} from 'pdf-lib';

const OUT = join(process.cwd(), 'test', 'fixtures');
mkdirSync(OUT, { recursive: true });

const FIXED_DATE = new Date('2026-01-01T00:00:00Z');
const A4: [number, number] = [595.28, 841.89];
const LETTER: [number, number] = [612, 792];

function newDoc(title: string): Promise<PDFDocument> {
  return PDFDocument.create().then((doc) => {
    doc.setTitle(title);
    doc.setAuthor('ynotPDF fixtures');
    doc.setProducer('ynotPDF make-fixtures');
    doc.setCreator('ynotPDF make-fixtures');
    doc.setCreationDate(FIXED_DATE);
    doc.setModificationDate(FIXED_DATE);
    return doc;
  });
}

async function save(doc: PDFDocument, name: string): Promise<void> {
  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: true });
  writeFileSync(join(OUT, name), bytes);
  console.info(`fixtures: ${name} (${bytes.byteLength} bytes)`);
}

// ---- 1. blank ------------------------------------------------------------------------------
async function blank(): Promise<void> {
  const doc = await newDoc('Blank');
  doc.addPage(A4);
  await save(doc, 'blank.pdf');
}

// ---- 2. multipage --------------------------------------------------------------------------
async function multipage(): Promise<void> {
  const doc = await newDoc('Multi-page');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sizes: [number, number][] = [A4, A4, LETTER, [A4[1], A4[0]], A4];
  sizes.forEach((size, i) => {
    const page = doc.addPage(size);
    page.drawText(`Page ${i + 1} of ${sizes.length}`, { x: 72, y: size[1] - 100, size: 24, font });
    page.drawRectangle({ x: 36, y: 36, width: size[0] - 72, height: size[1] - 72, borderWidth: 1 });
    if (i === 4) page.setRotation(degrees(90));
  });
  await save(doc, 'multipage.pdf');
}

// ---- 3. text -------------------------------------------------------------------------------
async function text(): Promise<void> {
  const doc = await newDoc('Text sample');
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const cour = await doc.embedFont(StandardFonts.Courier);
  const page = doc.addPage(A4);
  const para =
    'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. ' +
    'Sphinx of black quartz, judge my vow. How vexingly quick daft zebras jump!';
  let y = A4[1] - 72;
  page.drawText('Heading in Helvetica 24 pt', { x: 72, y, size: 24, font: helv });
  y -= 40;
  page.drawText(para, { x: 72, y, size: 11, font: times, maxWidth: A4[0] - 144, lineHeight: 14 });
  y -= 80;
  page.drawText('Monospaced: const x = 42; // Courier 10 pt', { x: 72, y, size: 10, font: cour });
  y -= 30;
  page.drawText(para, { x: 72, y, size: 9, font: helv, maxWidth: A4[0] - 144, lineHeight: 12 });
  y -= 80;
  page.drawText('Rotated text', { x: 400, y, size: 14, font: helv, rotate: degrees(30) });
  await save(doc, 'text.pdf');
}

// ---- 4. image ------------------------------------------------------------------------------
/** Minimal PNG encoder (RGB, 8-bit) so we need no binary asset in the repo. */
function makePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc32 = (buf: Buffer): number => {
    let c = -1;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

async function image(): Promise<void> {
  const doc = await newDoc('Image sample');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const png = makePng(64, 64, (x, y) => [(x * 4) & 255, (y * 4) & 255, ((x ^ y) * 4) & 255]);
  const img = await doc.embedPng(png);
  const page = doc.addPage(A4);
  page.drawText('Embedded 64x64 PNG, scaled to 256 pt', { x: 72, y: A4[1] - 72, size: 12, font });
  page.drawImage(img, { x: 72, y: A4[1] - 72 - 20 - 256, width: 256, height: 256 });
  page.drawImage(img, { x: 360, y: 300, width: 128, height: 64, rotate: degrees(15) });
  await save(doc, 'image.pdf');
}

// ---- 5. form -------------------------------------------------------------------------------
async function form(): Promise<void> {
  const doc = await newDoc('Form sample');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(A4);
  const f = doc.getForm();
  let y = A4[1] - 100;
  page.drawText('Name', { x: 72, y: y + 4, size: 11, font });
  const name = f.createTextField('person.name');
  name.setText('Ada Lovelace');
  name.addToPage(page, { x: 160, y, width: 300, height: 22 });
  y -= 40;
  page.drawText('Subscribe', { x: 72, y: y + 4, size: 11, font });
  const cb = f.createCheckBox('person.subscribe');
  cb.check();
  cb.addToPage(page, { x: 160, y, width: 18, height: 18 });
  y -= 40;
  page.drawText('Size', { x: 72, y: y + 4, size: 11, font });
  const radio = f.createRadioGroup('person.size');
  radio.addOptionToPage('S', page, { x: 160, y, width: 18, height: 18 });
  radio.addOptionToPage('M', page, { x: 200, y, width: 18, height: 18 });
  radio.addOptionToPage('L', page, { x: 240, y, width: 18, height: 18 });
  radio.select('M');
  y -= 40;
  page.drawText('Country', { x: 72, y: y + 4, size: 11, font });
  const dd = f.createDropdown('person.country');
  dd.addOptions(['United Kingdom', 'Ireland', 'France', 'Germany']);
  dd.select('United Kingdom');
  dd.addToPage(page, { x: 160, y, width: 200, height: 22 });
  y -= 40;
  page.drawText('Notes', { x: 72, y: y + 4, size: 11, font });
  const notes = f.createTextField('person.notes');
  notes.enableMultiline();
  notes.addToPage(page, { x: 160, y: y - 60, width: 300, height: 80 });
  y -= 100;
  const btn = f.createButton('form.submit');
  btn.addToPage('Submit', page, { x: 160, y, width: 100, height: 26 });
  f.updateFieldAppearances(font);
  await save(doc, 'form.pdf');
}

// ---- 6. annotated --------------------------------------------------------------------------
function addAnnot(doc: PDFDocument, page: PDFPage, dict: Record<string, unknown>): void {
  const annot = doc.context.obj({
    Type: 'Annot',
    F: 4,
    M: PDFString.fromDate(FIXED_DATE),
    CreationDate: PDFString.fromDate(FIXED_DATE),
    T: PDFString.of('ynotPDF fixtures'),
    ...dict,
  });
  const ref = doc.context.register(annot);
  let annots = page.node.lookup(PDFName.of('Annots'));
  if (!(annots instanceof PDFArray)) {
    annots = doc.context.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
  }
  (annots as PDFArray).push(ref);
}

async function annotated(): Promise<void> {
  const doc = await newDoc('Annotated sample');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(A4);
  page.drawText('This sentence is highlighted in the annotation layer.', {
    x: 72,
    y: 700,
    size: 12,
    font,
  });
  const w = font.widthOfTextAtSize('This sentence is highlighted in the annotation layer.', 12);
  addAnnot(doc, page, {
    Subtype: 'Square',
    Rect: [72, 500, 272, 620],
    C: [0, 0, 1],
    IC: [0.9, 0.9, 1],
    BS: { W: 2 },
    Contents: PDFString.of('A square annotation'),
  });
  addAnnot(doc, page, {
    Subtype: 'Circle',
    Rect: [320, 500, 500, 620],
    C: [1, 0.5, 0],
    BS: { W: 3 },
    Contents: PDFString.of('A circle annotation'),
  });
  addAnnot(doc, page, {
    Subtype: 'Highlight',
    Rect: [72, 696, 72 + w, 714],
    C: [1, 1, 0],
    QuadPoints: [72, 714, 72 + w, 714, 72, 696, 72 + w, 696],
    Contents: PDFString.of('Highlighted text'),
  });
  addAnnot(doc, page, {
    Subtype: 'Text',
    Rect: [520, 690, 540, 710],
    C: [1, 1, 0],
    Name: 'Comment',
    Contents: PDFString.of('A sticky note. Second line.'),
    Open: false,
  });
  addAnnot(doc, page, {
    Subtype: 'Ink',
    Rect: [72, 300, 300, 420],
    C: [0.5, 0, 0.5],
    BS: { W: 2 },
    InkList: [[80, 310, 120, 400, 160, 320, 200, 410, 240, 330, 290, 415]],
    Contents: PDFString.of('Freehand ink'),
  });
  await save(doc, 'annotated.pdf');
}

// ---- 7. encrypted (hand-written writer with RC4 128-bit standard security, R3) -------------
const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function md5(...parts: Buffer[]): Buffer {
  const h = createHash('md5');
  for (const p of parts) h.update(p);
  return h.digest();
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + (s[i] ?? 0) + (key[i % key.length] ?? 0)) & 255;
    const t = s[i] ?? 0;
    s[i] = s[j] ?? 0;
    s[j] = t;
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + (s[i] ?? 0)) & 255;
    const t = s[i] ?? 0;
    s[i] = s[j] ?? 0;
    s[j] = t;
    out[k] = (data[k] ?? 0) ^ (s[((s[i] ?? 0) + (s[j] ?? 0)) & 255] ?? 0);
  }
  return out;
}

function padPassword(pw: string): Buffer {
  return Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
}

/** Algorithm 3 (owner password), R3, 128-bit. */
function computeO(owner: string, user: string): Buffer {
  let key = md5(padPassword(owner));
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, 16));
  key = key.subarray(0, 16);
  let o = rc4(key, padPassword(user));
  for (let i = 1; i <= 19; i++) {
    const k = Buffer.from(key.map((b) => b ^ i));
    o = rc4(k, o);
  }
  return o;
}

/** Algorithm 2 (file key), R3, 128-bit. */
function computeKey(user: string, o: Buffer, p: number, id0: Buffer): Buffer {
  const pBuf = Buffer.alloc(4);
  pBuf.writeInt32LE(p);
  let key = md5(padPassword(user), o, pBuf, id0);
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, 16));
  return key.subarray(0, 16);
}

/** Algorithm 5 (user password), R3. */
function computeU(key: Buffer, id0: Buffer): Buffer {
  let u = rc4(key, md5(PAD, id0));
  for (let i = 1; i <= 19; i++) {
    const k = Buffer.from(key.map((b) => b ^ i));
    u = rc4(k, u);
  }
  return Buffer.concat([u, Buffer.alloc(16, 0)]);
}

function objectKey(key: Buffer, num: number, gen: number): Buffer {
  const extra = Buffer.from([
    num & 255,
    (num >> 8) & 255,
    (num >> 16) & 255,
    gen & 255,
    (gen >> 8) & 255,
  ]);
  return md5(key, extra).subarray(0, Math.min(key.length + 5, 16));
}

function hex(buf: Buffer): string {
  return `<${buf.toString('hex')}>`;
}

function encrypted(): void {
  const user = 'ynot';
  const owner = 'owner';
  const P = -1; // all permissions
  const id0 = md5(Buffer.from('ynotPDF encrypted fixture id'));
  const O = computeO(owner, user);
  const key = computeKey(user, O, P, id0);
  const U = computeU(key, id0);

  const content = Buffer.from(
    'BT /F1 24 Tf 72 720 Td (Encrypted with RC4-128. User password: ynot) Tj ET\n' +
      'BT /F1 12 Tf 72 690 Td (Owner password: owner. Standard security handler, R3.) Tj ET\n',
    'latin1',
  );
  const encContent = rc4(objectKey(key, 4, 0), content);
  const infoTitle = rc4(objectKey(key, 6, 0), Buffer.from('Encrypted sample', 'latin1'));

  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>';
  objects[4] = `<< /Length ${encContent.length} >>\nstream\n${encContent.toString('latin1')}\nendstream`;
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[6] = `<< /Title ${hex(infoTitle)} /Producer ${hex(rc4(objectKey(key, 6, 0), Buffer.from('ynotPDF make-fixtures', 'latin1')))} >>`;
  objects[7] = `<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${P} /O ${hex(O)} /U ${hex(U)} >>`;

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${i} 0 obj\n${objects[i] ?? ''}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++)
    out += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 6 0 R /Encrypt 7 0 R /ID [${hex(id0)} ${hex(id0)}] >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = Buffer.from(out, 'latin1');
  writeFileSync(join(OUT, 'encrypted.pdf'), bytes);
  console.info(`fixtures: encrypted.pdf (${bytes.byteLength} bytes)`);
}

// ---- 8. outline ----------------------------------------------------------------------------
async function outline(): Promise<void> {
  const doc = await newDoc('Outline sample');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [0, 1, 2].map((i) => {
    const p = doc.addPage(A4);
    p.drawText(`Chapter ${i + 1}`, { x: 72, y: 760, size: 20, font });
    p.drawText(`Section ${i + 1}.1`, { x: 72, y: 400, size: 14, font });
    return p;
  });
  const ctx = doc.context;
  const outlines = ctx.obj({ Type: 'Outlines' });
  const outlinesRef = ctx.register(outlines);

  const item = (title: string, page: PDFPage, top: number, parent: PDFDict) => {
    const d = ctx.obj({
      Title: PDFString.of(title),
      Parent: parent,
      Dest: [page.ref, 'XYZ', null, top, null],
    });
    return { dict: d, ref: ctx.register(d) };
  };
  interface Node {
    dict: PDFDict;
    ref: ReturnType<typeof ctx.register>;
  }
  let prevTop: Node | null = null;
  let firstTop: Node | null = null;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (!page) continue;
    const chapter = item(`Chapter ${i + 1}`, page, 800, outlines);
    const section = item(`Section ${i + 1}.1`, page, 420, chapter.dict);
    chapter.dict.set(PDFName.of('First'), section.ref);
    chapter.dict.set(PDFName.of('Last'), section.ref);
    chapter.dict.set(PDFName.of('Count'), PDFNumber.of(i === 0 ? 1 : -1));
    if (prevTop) {
      prevTop.dict.set(PDFName.of('Next'), chapter.ref);
      chapter.dict.set(PDFName.of('Prev'), prevTop.ref);
    } else {
      firstTop = chapter;
    }
    prevTop = chapter;
  }
  if (firstTop && prevTop) {
    outlines.set(PDFName.of('First'), firstTop.ref);
    outlines.set(PDFName.of('Last'), prevTop.ref);
    outlines.set(PDFName.of('Count'), PDFNumber.of(4));
  }
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
  await save(doc, 'outline.pdf');
}

// ---- 9. layers -----------------------------------------------------------------------------
async function layers(): Promise<void> {
  const doc = await newDoc('Layers sample');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(A4);
  const ctx = doc.context;
  const base = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Base') }));
  const overlay = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Overlay') }));
  doc.catalog.set(
    PDFName.of('OCProperties'),
    ctx.obj({
      OCGs: [base, overlay],
      D: { Order: [base, overlay], ON: [base], OFF: [overlay] },
    }),
  );
  page.drawText('Layer: Base (visible by default)', { x: 72, y: 760, size: 14, font });
  // Wrap the drawn content in marked-content blocks by editing the content stream directly.
  page.drawText('Layer: Overlay (hidden by default)', {
    x: 72,
    y: 720,
    size: 14,
    font,
    color: rgb(0, 0, 1),
  });
  const res = page.node.Resources();
  if (res) {
    res.set(PDFName.of('Properties'), ctx.obj({ oc1: base, oc2: overlay }));
  }
  // Rebuild the content stream with BDC/EMC wrappers around the two text operators.
  const contentsRef = page.node.get(PDFName.of('Contents'));
  const stream = contentsRef ? ctx.lookup(contentsRef) : undefined;
  if (stream && 'contents' in stream) {
    const s = stream as { contents: Uint8Array };
    const src = Buffer.from(s.contents).toString('latin1');
    const parts = src.split(/(?=BT)/);
    const wrapped = parts
      .map((p, i) => (p.startsWith('BT') ? `/OC /oc${i === 1 ? 1 : 2} BDC\n${p}EMC\n` : p))
      .join('');
    const buf = Buffer.from(wrapped, 'latin1');
    s.contents = new Uint8Array(buf);
    (stream as unknown as PDFDict).set(PDFName.of('Length'), PDFNumber.of(buf.length));
  }
  await save(doc, 'layers.pdf');
}

// ---- 10. attachments -----------------------------------------------------------------------
async function attachments(): Promise<void> {
  const doc = await newDoc('Attachments sample');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(A4);
  page.drawText('This document carries two embedded files.', { x: 72, y: 760, size: 14, font });
  await doc.attach(Buffer.from('Hello from an attachment.\n'), 'note.txt', {
    mimeType: 'text/plain',
    description: 'A plain-text note',
    creationDate: FIXED_DATE,
    modificationDate: FIXED_DATE,
  });
  await doc.attach(Buffer.from('id,name\n1,Ada\n2,Grace\n'), 'people.csv', {
    mimeType: 'text/csv',
    description: 'A tiny CSV',
    creationDate: FIXED_DATE,
    modificationDate: FIXED_DATE,
  });
  await save(doc, 'attachments.pdf');
}

await blank();
await multipage();
await text();
await image();
await form();
await annotated();
encrypted();
await outline();
await layers();
await attachments();
console.info('fixtures: done');
