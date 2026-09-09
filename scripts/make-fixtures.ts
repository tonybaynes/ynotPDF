/**
 * Generates the synthetic PDF corpus in `test/fixtures/` (M00, extended by M10). Deterministic:
 * pdf-lib is given fixed dates/ids and every "random" byte is derived from a label, so
 * re-running produces identical bytes. All content is invented.
 *
 *   blank.pdf              1 page, A4, no content
 *   multipage.pdf          5 pages, page number drawn on each, mixed sizes and a rotated page
 *   text.pdf               paragraphs in Helvetica / Times / Courier at several sizes
 *   image.pdf              an embedded PNG (generated here) drawn twice
 *   form.pdf               AcroForm: text field, checkbox, radio group, dropdown, button
 *   annotated.pdf          Square, Circle, Highlight, Text (sticky note) and Ink annotations
 *   encrypted.pdf          RC4 128-bit standard security (user "ynot", owner "owner")
 *   outline.pdf            3 pages with nested bookmarks
 *   layers.pdf             optional content groups "Base" (on) and "Overlay" (off)
 *   attachments.pdf        two embedded files (txt, csv)
 *   --- M42 ---
 *   portfolio.pdf          a PDF Portfolio: /Collection + /Folders, 3 files at the root and
 *                          a folder holding 2 more, schema with a custom order column
 *   --- M10 ---
 *   encrypted-aes128.pdf   AESV2 / R4 (user "ynot", owner "owner")
 *   encrypted-aes256.pdf   AESV3 / R6 (user "ynot", owner "owner")
 *   encrypted-owner.pdf    RC4 R3, empty user password, owner "owner", printing/copying denied
 *   rotated.pdf            4 pages with /Rotate 0/90/180/270 and an arrow pointing "up"
 *   mixed-boxes.pdf        MediaBox ≠ CropBox, negative origins, reversed box coordinates
 *   page-labels.pdf        6 pages with /PageLabels (roman, prefixed decimal, letters)
 *   links.pdf              URI and GoTo link annotations (one with QuadPoints)
 *   forms-all.pdf          every AcroForm field type incl. listbox, password and signature
 *   annotations-all.pdf    every annotation subtype in PDF 32000-1 table 169 + a reply
 *   javascript.pdf         document-level JavaScript (OpenAction + /Names /JavaScript)
 *   xfa.pdf                AcroForm with an /XFA packet (must open with hasXfa = true)
 *   pdfa-1b.pdf            PDF/A-1b structure: XMP with pdfaid, OutputIntent (structure only)
 *   cjk-rtl.pdf            non-embedded CJK (Type0/UniGB-UCS2-H) and Hebrew (glyph names)
 *   broken-xref.pdf        blank.pdf with a wrong startxref offset (PDFium reconstructs)
 *   truncated.pdf          text.pdf cut off at 70 %
 *   corrupt.pdf            a PDF header followed by garbage
 *   huge-page-count.pdf    1000 tiny pages
 *   scanned.pdf            one full-page 150-dpi grayscale "scan" (for OCR later)
 *   --- M91 (test/fixtures/create/: inputs for "Create PDF from …") ---
 *   photo-landscape.jpg    300×200 baseline JPEG, JFIF density 72 dpi
 *   photo-exif-rotated.jpg 200×300 JPEG with EXIF Orientation 6 (rotate 90° CW), 150 dpi
 *   chart-300dpi.png       600×450 RGB PNG, pHYs 300 dpi, a bar chart
 *   logo-alpha.png         128×128 RGBA PNG: filled circle, transparent corners, soft edge
 *   scan-gray.png          200×280 8-bit grayscale PNG, pHYs 200 dpi, "text lines"
 *   pages-3.tif            3-page uncompressed RGB TIFF (120×80, 80×120, 100×100), 96 dpi
 *   deflate.tif            64×64 RGB TIFF, Compression 8 (Adobe deflate)
 *   tiny.bmp               32×24 24-bit bottom-up BMP
 *   not-an-image.png       64 bytes of ASCII text with a .png name (corrupt input)
 *   site/*.html            4 linked pages (index → about, contact#team; about → deep)
 *   notes.md               GitHub-flavoured Markdown: headings, lists, table, code, image
 *   long.txt               250 lines, every 10th very long with a 120-char token, tabs
 *   unicode.txt            12 lines: accents, curly quotes, €, one CJK + emoji line
 *
 * Usage: `node scripts/make-fixtures.ts` (writes into test/fixtures/).
 */

import { createCipheriv, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { encode as encodeJpeg } from 'jpeg-js';
import type { PDFDict } from 'pdf-lib';
import {
  PDFArray,
  PDFBool,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames as Ops,
  PDFString,
  StandardFonts,
  beginText,
  degrees,
  endText,
  moveText,
  rgb,
  setFontAndSize,
  showText,
  type PDFPage,
  type PDFRef,
} from 'pdf-lib';

const OUT = join(process.cwd(), 'test', 'fixtures');
mkdirSync(OUT, { recursive: true });

const FIXED_DATE = new Date('2026-01-01T00:00:00Z');
const A4: [number, number] = [595.28, 841.89];
const A5: [number, number] = [419.53, 595.28];
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

async function save(doc: PDFDocument, name: string): Promise<Uint8Array> {
  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: true });
  writeFileSync(join(OUT, name), bytes);
  console.info(`fixtures: ${name} (${bytes.byteLength} bytes)`);
  return bytes;
}

function writeRaw(name: string, bytes: Buffer): void {
  writeFileSync(join(OUT, name), bytes);
  console.info(`fixtures: ${name} (${bytes.byteLength} bytes)`);
}

/** Deterministic pseudo-random bytes for salts, ids and IVs. */
function det(label: string, length: number): Buffer {
  const out: Buffer[] = [];
  let n = 0;
  for (let i = 0; n < length; i++) {
    const h = createHash('sha256').update(`${label}:${i}`).digest();
    out.push(h);
    n += h.length;
  }
  return Buffer.concat(out).subarray(0, length);
}

// ---- 1. blank ------------------------------------------------------------------------------
async function blank(): Promise<Uint8Array> {
  const doc = await newDoc('Blank');
  doc.addPage(A4);
  return save(doc, 'blank.pdf');
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
async function text(): Promise<Uint8Array> {
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
  return save(doc, 'text.pdf');
}

// ---- 4. image ------------------------------------------------------------------------------
interface PngOptions {
  /** Physical resolution, written as a pHYs chunk (px per metre, unit 1) when present. */
  dpi?: number;
}

/** Minimal PNG encoder (RGB or 8-bit grayscale) so we need no binary asset in the repo. */
function makePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number] | number,
  gray = false,
  opts: PngOptions = {},
): Uint8Array {
  const bpp = gray ? 1 : 3;
  const raw = Buffer.alloc((width * bpp + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * bpp + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      const o = y * (width * bpp + 1) + 1 + x * bpp;
      if (typeof p === 'number') raw[o] = p;
      else {
        raw[o] = p[0];
        raw[o + 1] = p[1];
        raw[o + 2] = p[2];
      }
    }
  }
  return encodePng(width, height, gray ? 0 : 2, raw, opts);
}

/** RGBA (colour type 6) variant of `makePng`. */
function makePngRgba(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
  opts: PngOptions = {},
): Uint8Array {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      const o = y * (width * 4 + 1) + 1 + x * 4;
      raw[o] = p[0];
      raw[o + 1] = p[1];
      raw[o + 2] = p[2];
      raw[o + 3] = p[3];
    }
  }
  return encodePng(width, height, 6, raw, opts);
}

/** Wraps filtered scanlines (`raw` carries the per-row filter byte) in IHDR/[pHYs]/IDAT/IEND. */
function encodePng(
  width: number,
  height: number,
  colourType: 0 | 2 | 6,
  raw: Buffer,
  opts: PngOptions,
): Uint8Array {
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
  ihdr[9] = colourType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const chunks: Buffer[] = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ];
  if (opts.dpi !== undefined) {
    const phys = Buffer.alloc(9);
    const perMetre = Math.round(opts.dpi / 0.0254);
    phys.writeUInt32BE(perMetre, 0);
    phys.writeUInt32BE(perMetre, 4);
    phys[8] = 1; // unit: metre
    chunks.push(chunk('pHYs', phys));
  }
  chunks.push(chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(chunks));
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
  cb.addToPage(page, { x: 160, y, width: 18, height: 18 });
  cb.check(); // after addToPage so the widget's /AS matches /V
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
function addAnnot(doc: PDFDocument, page: PDFPage, dict: Record<string, unknown>): PDFRef {
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
  return ref;
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

// ---- 7. encrypted (hand-written writers: RC4 R3, AESV2 R4, AESV3 R6) ----------------------
const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function md5(...parts: Buffer[]): Buffer {
  const h = createHash('md5');
  for (const p of parts) h.update(p);
  return h.digest();
}

function sha(alg: 'sha256' | 'sha384' | 'sha512', ...parts: Buffer[]): Buffer {
  const h = createHash(alg);
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

/** Algorithm 3 (owner password), R3/R4, 128-bit. */
function computeO(owner: string, user: string): Buffer {
  let key = md5(padPassword(owner || user));
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, 16));
  key = key.subarray(0, 16);
  let o = rc4(key, padPassword(user));
  for (let i = 1; i <= 19; i++) {
    const k = Buffer.from(key.map((b) => b ^ i));
    o = rc4(k, o);
  }
  return o;
}

/** Algorithm 2 (file key), R3/R4, 128-bit. */
function computeKey(user: string, o: Buffer, p: number, id0: Buffer): Buffer {
  const pBuf = Buffer.alloc(4);
  pBuf.writeInt32LE(p);
  let key = md5(padPassword(user), o, pBuf, id0);
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, 16));
  return key.subarray(0, 16);
}

/** Algorithm 5 (user password), R3/R4. */
function computeU(key: Buffer, id0: Buffer): Buffer {
  let u = rc4(key, md5(PAD, id0));
  for (let i = 1; i <= 19; i++) {
    const k = Buffer.from(key.map((b) => b ^ i));
    u = rc4(k, u);
  }
  return Buffer.concat([u, Buffer.alloc(16, 0)]);
}

function objectKey(key: Buffer, num: number, gen: number, aes: boolean): Buffer {
  const extra = Buffer.from([
    num & 255,
    (num >> 8) & 255,
    (num >> 16) & 255,
    gen & 255,
    (gen >> 8) & 255,
  ]);
  const salt = aes ? Buffer.from([0x73, 0x41, 0x6c, 0x54]) : Buffer.alloc(0);
  return md5(key, extra, salt).subarray(0, Math.min(key.length + 5, 16));
}

function aesCbc(
  alg: 'aes-128-cbc' | 'aes-256-cbc',
  key: Buffer,
  iv: Buffer,
  data: Buffer,
  pad = true,
): Buffer {
  const c = createCipheriv(alg, key, iv);
  c.setAutoPadding(pad);
  return Buffer.concat([c.update(data), c.final()]);
}

function hex(buf: Buffer): string {
  return `<${buf.toString('hex')}>`;
}

interface Encryptor {
  readonly dict: string;
  readonly version: string;
  encrypt(num: number, gen: number, data: Buffer): Buffer;
}

function rc4Encryptor(user: string, owner: string, p: number, id0: Buffer): Encryptor {
  const O = computeO(owner, user);
  const key = computeKey(user, O, p, id0);
  const U = computeU(key, id0);
  return {
    version: '1.4',
    dict: `<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${p} /O ${hex(O)} /U ${hex(U)} >>`,
    encrypt: (num, gen, data) => rc4(objectKey(key, num, gen, false), data),
  };
}

function aes128Encryptor(
  user: string,
  owner: string,
  p: number,
  id0: Buffer,
  label: string,
): Encryptor {
  const O = computeO(owner, user);
  const key = computeKey(user, O, p, id0);
  const U = computeU(key, id0);
  return {
    version: '1.6',
    dict:
      `<< /Filter /Standard /V 4 /R 4 /Length 128 /P ${p} /O ${hex(O)} /U ${hex(U)} ` +
      '/CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF >>',
    encrypt: (num, gen, data) => {
      const iv = det(`${label}:iv:${num}:${gen}`, 16);
      return Buffer.concat([iv, aesCbc('aes-128-cbc', objectKey(key, num, gen, true), iv, data)]);
    },
  };
}

/** ISO 32000-2 Algorithm 2.B (revision 6 hash). */
function hash2B(pw: Buffer, salt: Buffer, udata: Buffer): Buffer {
  let k = sha('sha256', pw, salt, udata);
  let i = 0;
  for (;;) {
    const k1 = Buffer.concat(Array<Buffer>(64).fill(Buffer.concat([pw, k, udata])));
    const e = aesCbc('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32), k1, false);
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += e[j] ?? 0;
    const mod = sum % 3;
    k = mod === 0 ? sha('sha256', e) : mod === 1 ? sha('sha384', e) : sha('sha512', e);
    i++;
    if (i >= 64 && (e[e.length - 1] ?? 0) <= i - 32) break;
  }
  return k.subarray(0, 32);
}

function aes256Encryptor(user: string, owner: string, p: number, label: string): Encryptor {
  const fileKey = det(`${label}:filekey`, 32);
  const upw = Buffer.from(user, 'utf8');
  const opw = Buffer.from(owner, 'utf8');
  const uvs = det(`${label}:uvs`, 8);
  const uks = det(`${label}:uks`, 8);
  const U = Buffer.concat([hash2B(upw, uvs, Buffer.alloc(0)), uvs, uks]);
  const UE = aesCbc(
    'aes-256-cbc',
    hash2B(upw, uks, Buffer.alloc(0)),
    Buffer.alloc(16, 0),
    fileKey,
    false,
  );
  const ovs = det(`${label}:ovs`, 8);
  const oks = det(`${label}:oks`, 8);
  const O = Buffer.concat([hash2B(opw, ovs, U), ovs, oks]);
  const OE = aesCbc('aes-256-cbc', hash2B(opw, oks, U), Buffer.alloc(16, 0), fileKey, false);
  const perms = Buffer.alloc(16);
  perms.writeInt32LE(p, 0);
  perms.writeUInt32LE(0xffffffff, 4);
  perms.write('Tadb', 8, 'latin1');
  det(`${label}:perms`, 4).copy(perms, 12);
  const ecb = createCipheriv('aes-256-ecb', fileKey, null);
  ecb.setAutoPadding(false);
  const Perms = Buffer.concat([ecb.update(perms), ecb.final()]);
  return {
    version: '1.7',
    dict:
      `<< /Filter /Standard /V 5 /R 6 /Length 256 /P ${p} /O ${hex(O)} /U ${hex(U)} /OE ${hex(OE)} /UE ${hex(UE)} ` +
      `/Perms ${hex(Perms)} /CF << /StdCF << /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >> /StmF /StdCF /StrF /StdCF >>`,
    encrypt: (num, gen, data) => {
      const iv = det(`${label}:iv:${num}:${gen}`, 16);
      return Buffer.concat([iv, aesCbc('aes-256-cbc', fileKey, iv, data)]);
    },
  };
}

/** Writes a one-page encrypted document with two lines of text through `enc`. */
function encryptedDoc(
  file: string,
  title: string,
  lines: [string, string],
  enc: Encryptor,
  id0: Buffer,
): void {
  const content = Buffer.from(
    `BT /F1 20 Tf 72 720 Td (${lines[0]}) Tj ET\nBT /F1 12 Tf 72 690 Td (${lines[1]}) Tj ET\n`,
    'latin1',
  );
  const encContent = enc.encrypt(4, 0, content);
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>';
  objects[4] = `<< /Length ${encContent.length} >>\nstream\n${encContent.toString('latin1')}\nendstream`;
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[6] =
    `<< /Title ${hex(enc.encrypt(6, 0, Buffer.from(title, 'latin1')))} ` +
    `/Producer ${hex(enc.encrypt(6, 0, Buffer.from('ynotPDF make-fixtures', 'latin1')))} >>`;
  objects[7] = enc.dict;

  let out = `%PDF-${enc.version}\n%\xe2\xe3\xcf\xd3\n`;
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
  writeRaw(file, Buffer.from(out, 'latin1'));
}

function encrypted(): void {
  const id0 = md5(Buffer.from('ynotPDF encrypted fixture id'));
  encryptedDoc(
    'encrypted.pdf',
    'Encrypted sample',
    [
      'Encrypted with RC4-128. User password: ynot',
      'Owner password: owner. Standard security handler, R3.',
    ],
    rc4Encryptor('ynot', 'owner', -1, id0),
    id0,
  );
  const idAes = md5(Buffer.from('ynotPDF aes128 fixture id'));
  encryptedDoc(
    'encrypted-aes128.pdf',
    'Encrypted AES-128 sample',
    [
      'Encrypted with AES-128 (AESV2). User password: ynot',
      'Owner password: owner. Standard security handler, R4.',
    ],
    aes128Encryptor('ynot', 'owner', -1, idAes, 'aes128'),
    idAes,
  );
  const idAes256 = md5(Buffer.from('ynotPDF aes256 fixture id'));
  encryptedDoc(
    'encrypted-aes256.pdf',
    'Encrypted AES-256 sample',
    [
      'Encrypted with AES-256 (AESV3). User password: ynot',
      'Owner password: owner. Standard security handler, R6.',
    ],
    aes256Encryptor('ynot', 'owner', -1, 'aes256'),
    idAes256,
  );
  const idOwner = md5(Buffer.from('ynotPDF owner-only fixture id'));
  // P = -3904: printing, modification, copying, annotating, form filling and assembly denied.
  encryptedDoc(
    'encrypted-owner.pdf',
    'Owner-only encrypted sample',
    [
      'Opens without a password; owner password: owner',
      'Printing and copying are denied by the permissions.',
    ],
    rc4Encryptor('', 'owner', -3904, idOwner),
    idOwner,
  );
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
  const res = page.node.Resources();
  res?.set(PDFName.of('Properties'), ctx.obj({ oc1: base, oc2: overlay }));
  const bdc = (name: string) =>
    PDFOperator.of(Ops.BeginMarkedContentSequence, [PDFName.of('OC'), PDFName.of(name)]);
  const emc = PDFOperator.of(Ops.EndMarkedContent);
  page.pushOperators(bdc('oc1'));
  page.drawText('Layer: Base (visible by default)', { x: 72, y: 760, size: 14, font });
  page.pushOperators(emc, bdc('oc2'));
  page.drawText('Layer: Overlay (hidden by default)', {
    x: 72,
    y: 720,
    size: 14,
    font,
    color: rgb(0, 0, 1),
  });
  page.pushOperators(emc);
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

// ---- M42: portfolio ------------------------------------------------------------------------
/**
 * A PDF Portfolio, written the way Foxit and Acrobat write one (M42, ADR 0014): a `/Collection`
 * in the catalogue, a `/Folders` linked tree, and `/EmbeddedFiles` keys of the form `<ID>name`
 * that say which folder each file is in. Five files — three at the root, two in "Statements" —
 * so CI can exercise folders, order and extraction without the operator's own file.
 *
 * Written with raw dictionaries rather than through our own writer, so a test that reads it is
 * reading something the reader did not produce.
 */
async function portfolio(): Promise<void> {
  const doc = await newDoc('Portfolio sample');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const cover = doc.addPage(A4);
  cover.drawText('Portfolio cover sheet', { x: 72, y: 760, size: 20, font });
  cover.drawText('This document is a PDF Portfolio containing five files.', {
    x: 72,
    y: 730,
    size: 12,
    font,
  });
  const ctx = doc.context;

  const p2 = (n: number, width = 2): string => String(n).padStart(width, '0');
  const stamp =
    `D:${p2(FIXED_DATE.getUTCFullYear(), 4)}${p2(FIXED_DATE.getUTCMonth() + 1)}` +
    `${p2(FIXED_DATE.getUTCDate())}${p2(FIXED_DATE.getUTCHours())}` +
    `${p2(FIXED_DATE.getUTCMinutes())}${p2(FIXED_DATE.getUTCSeconds())}Z`;

  interface PortfolioEntry {
    readonly name: string;
    readonly folderId: number;
    readonly body: Buffer;
    readonly mime: string;
    readonly description: string;
    readonly order: number;
  }
  const entries: PortfolioEntry[] = [
    {
      name: 'readme.txt',
      folderId: 0,
      body: Buffer.from('Read me first.\n'),
      mime: 'text/plain',
      description: 'What this pack is for',
      order: 0,
    },
    {
      name: 'instruction.pdf',
      folderId: 0,
      body: Buffer.from(await embeddedInstruction()),
      mime: 'application/pdf',
      description: 'The signed instruction',
      order: 1,
    },
    {
      name: 'people.csv',
      folderId: 0,
      body: Buffer.from('id,name\n1,Ada\n2,Grace\n'),
      mime: 'text/csv',
      description: 'Who is involved',
      order: 2,
    },
    {
      name: 'january.txt',
      folderId: 1,
      body: Buffer.from('January statement.\n'),
      mime: 'text/plain',
      description: 'January',
      order: 3,
    },
    {
      name: 'february.txt',
      folderId: 1,
      body: Buffer.from('February statement.\n'),
      mime: 'text/plain',
      description: 'February',
      order: 4,
    },
  ];

  const pairs: Array<[string, PDFRef]> = [];
  for (const entry of entries) {
    const params = ctx.obj({});
    params.set(PDFName.of('Size'), PDFNumber.of(entry.body.length));
    params.set(PDFName.of('CreationDate'), PDFString.of(stamp));
    params.set(PDFName.of('ModDate'), PDFString.of(stamp));
    params.set(
      PDFName.of('CheckSum'),
      PDFHexString.of(md5(entry.body).toString('hex').toUpperCase()),
    );
    const stream = ctx.flateStream(entry.body, { Type: 'EmbeddedFile' });
    stream.dict.set(PDFName.of('Subtype'), PDFName.of(entry.mime));
    stream.dict.set(PDFName.of('Params'), ctx.register(params));
    const streamRef = ctx.register(stream);

    const ef = ctx.obj({});
    ef.set(PDFName.of('F'), streamRef);
    ef.set(PDFName.of('UF'), streamRef);
    const ci = ctx.obj({});
    ci.set(PDFName.of('ynot:Order'), PDFString.of(String(entry.order)));
    const spec = ctx.obj({});
    spec.set(PDFName.of('Type'), PDFName.of('Filespec'));
    spec.set(PDFName.of('F'), PDFString.of(entry.name));
    spec.set(PDFName.of('UF'), PDFString.of(entry.name));
    spec.set(PDFName.of('Desc'), PDFString.of(entry.description));
    spec.set(PDFName.of('EF'), ctx.register(ef));
    spec.set(PDFName.of('CI'), ctx.register(ci));
    pairs.push([`<${String(entry.folderId)}>${entry.name}`, ctx.register(spec)]);
  }

  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const namesArray = PDFArray.withContext(ctx);
  for (const [key, ref] of pairs) {
    namesArray.push(PDFString.of(key));
    namesArray.push(ref);
  }
  const embedded = ctx.obj({});
  embedded.set(PDFName.of('Names'), namesArray);
  const names = ctx.obj({});
  names.set(PDFName.of('EmbeddedFiles'), ctx.register(embedded));
  doc.catalog.set(PDFName.of('Names'), ctx.register(names));

  // `/Folders`: a root with one child, "Statements".
  const root = ctx.obj({});
  const child = ctx.obj({});
  const rootRef = ctx.register(root);
  const childRef = ctx.register(child);
  root.set(PDFName.of('Type'), PDFName.of('Folder'));
  root.set(PDFName.of('ID'), PDFNumber.of(0));
  root.set(PDFName.of('Name'), PDFString.of(''));
  root.set(PDFName.of('CreationDate'), PDFString.of(stamp));
  root.set(PDFName.of('Child'), childRef);
  child.set(PDFName.of('Type'), PDFName.of('Folder'));
  child.set(PDFName.of('ID'), PDFNumber.of(1));
  child.set(PDFName.of('Name'), PDFString.of('Statements'));
  child.set(PDFName.of('Desc'), PDFString.of('Monthly statements'));
  child.set(PDFName.of('CreationDate'), PDFString.of(stamp));
  child.set(PDFName.of('Parent'), rootRef);

  const schema = ctx.obj({});
  const addField = (
    key: string,
    label: string,
    subtype: string,
    order: number,
    visible: boolean,
  ): void => {
    const dict = ctx.obj({});
    dict.set(PDFName.of('Type'), PDFName.of('CollectionField'));
    dict.set(PDFName.of('Subtype'), PDFName.of(subtype));
    dict.set(PDFName.of('N'), PDFString.of(label));
    dict.set(PDFName.of('O'), PDFNumber.of(order));
    dict.set(PDFName.of('V'), visible ? PDFBool.True : PDFBool.False);
    schema.set(PDFName.of(key), ctx.register(dict));
  };
  addField('FileName', 'Name', 'F', 0, true);
  addField('Description', 'Description', 'Desc', 1, true);
  addField('CreationDate', 'Created', 'CreationDate', 2, true);
  addField('ModDate', 'Modified', 'ModDate', 3, true);
  addField('Size', 'Size', 'Size', 4, true);
  addField('ynot:Order', 'Order', 'N', 90, false);

  const sort = ctx.obj({});
  sort.set(PDFName.of('S'), PDFName.of('ynot:Order'));
  sort.set(PDFName.of('A'), PDFBool.True);

  const collection = ctx.obj({});
  collection.set(PDFName.of('Type'), PDFName.of('Collection'));
  collection.set(PDFName.of('View'), PDFName.of('D'));
  collection.set(PDFName.of('Schema'), ctx.register(schema));
  collection.set(PDFName.of('Sort'), ctx.register(sort));
  collection.set(PDFName.of('Reorder'), PDFName.of('ynot:Order'));
  collection.set(PDFName.of('D'), PDFString.of('instruction.pdf'));
  collection.set(PDFName.of('Folders'), rootRef);
  doc.catalog.set(PDFName.of('Collection'), ctx.register(collection));

  await save(doc, 'portfolio.pdf');
}

/** A one-page PDF embedded in the portfolio, so it holds a real PDF as well as text files. */
async function embeddedInstruction(): Promise<Uint8Array> {
  const doc = await newDoc('Embedded instruction');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage(A5).drawText('Instruction', { x: 40, y: 500, size: 18, font });
  return await doc.save({ useObjectStreams: false });
}

// ---- M10: rotated --------------------------------------------------------------------------
async function rotated(): Promise<void> {
  const doc = await newDoc('Rotated pages');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const rot of [0, 90, 180, 270]) {
    const page = doc.addPage(A5);
    const [w, h] = A5;
    // Arrow pointing to the top of the *unrotated* page: displayed direction changes per page.
    page.drawLine({
      start: { x: w / 2, y: h * 0.3 },
      end: { x: w / 2, y: h * 0.75 },
      thickness: 6,
    });
    page.drawLine({
      start: { x: w / 2 - 40, y: h * 0.65 },
      end: { x: w / 2, y: h * 0.75 },
      thickness: 6,
    });
    page.drawLine({
      start: { x: w / 2 + 40, y: h * 0.65 },
      end: { x: w / 2, y: h * 0.75 },
      thickness: 6,
    });
    page.drawText(`/Rotate ${rot}`, { x: 40, y: 40, size: 18, font });
    page.drawRectangle({ x: 20, y: h - 60, width: 40, height: 40, color: rgb(0, 0, 0) });
    page.setRotation(degrees(rot));
  }
  await save(doc, 'rotated.pdf');
}

// ---- M10: mixed boxes ----------------------------------------------------------------------
async function mixedBoxes(): Promise<void> {
  const doc = await newDoc('Mixed page boxes');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // Page 1: large MediaBox with a negative origin, CropBox inset.
  const p1 = doc.addPage([700, 950]);
  p1.setMediaBox(-50, -50, 700, 950);
  p1.setCropBox(50, 100, 500, 700);
  p1.drawRectangle({ x: 50, y: 100, width: 500, height: 700, borderWidth: 2 });
  p1.drawText('CropBox origin (50, 100)', { x: 60, y: 780, size: 14, font });
  p1.drawText('Outside the crop box', { x: -40, y: -40, size: 14, font });
  // Page 2: CropBox larger than the MediaBox (viewer must clip to the MediaBox).
  const p2 = doc.addPage([400, 400]);
  p2.setCropBox(-100, -100, 600, 600);
  p2.drawText('CropBox exceeds MediaBox', { x: 30, y: 200, size: 14, font });
  // Page 3: box coordinates given in reverse order.
  const p3 = doc.addPage([600, 800]);
  p3.node.set(PDFName.of('MediaBox'), doc.context.obj([600, 800, 0, 0]));
  p3.node.set(PDFName.of('CropBox'), doc.context.obj([550, 750, 50, 50]));
  p3.drawText('Reversed box arrays', { x: 60, y: 700, size: 14, font });
  // Page 4: ArtBox / TrimBox / BleedBox present.
  const p4 = doc.addPage(A4);
  p4.setBleedBox(10, 10, A4[0] - 10, A4[1] - 10);
  p4.setTrimBox(20, 20, A4[0] - 20, A4[1] - 20);
  p4.setArtBox(40, 40, A4[0] - 40, A4[1] - 40);
  p4.drawText('Bleed, trim and art boxes', { x: 60, y: 760, size: 14, font });
  await save(doc, 'mixed-boxes.pdf');
}

// ---- M10: page labels ----------------------------------------------------------------------
async function pageLabels(): Promise<void> {
  const doc = await newDoc('Page labels');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 6; i++) {
    const page = doc.addPage(A5);
    page.drawText(`Physical page ${i + 1}`, { x: 40, y: 500, size: 16, font });
  }
  doc.catalog.set(
    PDFName.of('PageLabels'),
    doc.context.obj({
      Nums: [0, { S: 'r' }, 2, { S: 'D', P: PDFString.of('A-'), St: 5 }, 4, { S: 'a' }],
    }),
  );
  await save(doc, 'page-labels.pdf');
}

// ---- M10: links ----------------------------------------------------------------------------
async function links(): Promise<void> {
  const doc = await newDoc('Links');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage(A4);
  const p2 = doc.addPage(A4);
  p1.drawText('Visit example.com', { x: 72, y: 700, size: 14, font, color: rgb(0, 0, 1) });
  p1.drawText('Go to page 2', { x: 72, y: 650, size: 14, font, color: rgb(0, 0, 1) });
  p2.drawText('Second page (link target)', { x: 72, y: 700, size: 14, font });
  const w1 = font.widthOfTextAtSize('Visit example.com', 14);
  addAnnot(doc, p1, {
    Subtype: 'Link',
    Rect: [72, 696, 72 + w1, 714],
    Border: [0, 0, 0],
    A: { S: 'URI', URI: PDFString.of('https://example.com/') },
    QuadPoints: [72, 714, 72 + w1, 714, 72, 696, 72 + w1, 696],
  });
  addAnnot(doc, p1, {
    Subtype: 'Link',
    Rect: [72, 646, 200, 664],
    Border: [0, 0, 1],
    C: [0, 0, 1],
    Dest: [p2.ref, 'XYZ', 0, 720, 1.5],
  });
  addAnnot(doc, p1, {
    Subtype: 'Link',
    Rect: [72, 596, 200, 614],
    Border: [0, 0, 0],
    A: { S: 'GoTo', D: [p2.ref, 'Fit'] },
  });
  await save(doc, 'links.pdf');
}

// ---- M10: forms, every field type ----------------------------------------------------------
async function formsAll(): Promise<void> {
  const doc = await newDoc('All form field types');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(A4);
  const f = doc.getForm();
  let y = A4[1] - 80;
  const label = (t: string) => {
    page.drawText(t, { x: 60, y: y + 5, size: 10, font });
  };
  label('Text');
  const tf = f.createTextField('fields.text');
  tf.setText('Hello');
  tf.setMaxLength(40);
  tf.addToPage(page, { x: 180, y, width: 240, height: 20 });
  y -= 34;
  label('Multiline');
  const ml = f.createTextField('fields.multiline');
  ml.enableMultiline();
  ml.setText('Line one\nLine two');
  ml.addToPage(page, { x: 180, y: y - 30, width: 240, height: 50 });
  y -= 70;
  label('Password');
  const pw = f.createTextField('fields.password');
  pw.enablePassword();
  pw.addToPage(page, { x: 180, y, width: 240, height: 20 });
  y -= 34;
  label('Required + read-only');
  const ro = f.createTextField('fields.readonly');
  ro.setText('fixed');
  ro.enableReadOnly();
  ro.enableRequired();
  ro.addToPage(page, { x: 180, y, width: 240, height: 20 });
  y -= 34;
  label('Checkbox');
  const cb = f.createCheckBox('fields.checkbox');
  cb.addToPage(page, { x: 180, y, width: 16, height: 16 });
  cb.check();
  const cb2 = f.createCheckBox('fields.checkbox2');
  cb2.addToPage(page, { x: 210, y, width: 16, height: 16 });
  y -= 34;
  label('Radio');
  const radio = f.createRadioGroup('fields.radio');
  radio.addOptionToPage('red', page, { x: 180, y, width: 16, height: 16 });
  radio.addOptionToPage('green', page, { x: 210, y, width: 16, height: 16 });
  radio.addOptionToPage('blue', page, { x: 240, y, width: 16, height: 16 });
  radio.select('blue');
  y -= 34;
  label('Combo box');
  const combo = f.createDropdown('fields.combo');
  combo.addOptions(['Alpha', 'Beta', 'Gamma']);
  combo.enableEditing();
  combo.select('Beta');
  combo.addToPage(page, { x: 180, y, width: 160, height: 20 });
  y -= 34;
  label('List box (multi)');
  const list = f.createOptionList('fields.list');
  list.addOptions(['One', 'Two', 'Three', 'Four']);
  list.enableMultiselect();
  list.select(['Two', 'Four']);
  list.addToPage(page, { x: 180, y: y - 40, width: 160, height: 60 });
  y -= 80;
  label('Push button');
  const btn = f.createButton('fields.button');
  btn.addToPage('Press', page, { x: 180, y, width: 100, height: 24 });
  y -= 40;
  label('Signature');
  // pdf-lib has no signature fields: build the /FT /Sig field + widget by hand.
  const sig = doc.context.obj({
    FT: 'Sig',
    T: PDFString.of('fields.signature'),
    Type: 'Annot',
    Subtype: 'Widget',
    Rect: [180, y - 30, 420, y + 10],
    F: 4,
    P: page.ref,
    TU: PDFString.of('Sign here'),
  });
  const sigRef = doc.context.register(sig);
  const annots = page.node.lookup(PDFName.of('Annots'));
  if (annots instanceof PDFArray) annots.push(sigRef);
  const fields = f.acroForm.dict.lookup(PDFName.of('Fields'));
  if (fields instanceof PDFArray) fields.push(sigRef);
  page.drawRectangle({ x: 180, y: y - 30, width: 240, height: 40, borderWidth: 1 });
  f.updateFieldAppearances(font);
  await save(doc, 'forms-all.pdf');
}

// ---- M10: every annotation subtype ---------------------------------------------------------
async function annotationsAll(): Promise<void> {
  const doc = await newDoc('All annotation subtypes');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(A4);
  const ctx = doc.context;
  const subtypes: Array<[string, Record<string, unknown>]> = [
    [
      'Text',
      { Name: 'Note', Open: true, Contents: PDFString.of('Root note'), NM: PDFString.of('note-1') },
    ],
    ['Link', { A: { S: 'URI', URI: PDFString.of('https://example.com/annots') } }],
    ['FreeText', { DA: PDFString.of('/Helv 12 Tf 0 g'), Contents: PDFString.of('Free text') }],
    ['Line', { L: [60, 620, 260, 660], C: [1, 0, 0], BS: { W: 2 }, LE: ['OpenArrow', 'None'] }],
    ['Square', { C: [0, 0, 1], IC: [0.8, 0.8, 1], BS: { W: 1.5 } }],
    ['Circle', { C: [0, 0.5, 0], BS: { W: 1 } }],
    ['Polygon', { Vertices: [300, 620, 380, 660, 460, 620, 420, 580, 340, 580], C: [0.5, 0, 0.5] }],
    ['PolyLine', { Vertices: [60, 540, 120, 570, 180, 540, 240, 570], C: [0, 0.5, 0.5] }],
    ['Highlight', { QuadPoints: [300, 570, 460, 570, 300, 550, 460, 550], C: [1, 1, 0] }],
    ['Underline', { QuadPoints: [300, 530, 460, 530, 300, 510, 460, 510], C: [0, 0, 1] }],
    ['Squiggly', { QuadPoints: [300, 490, 460, 490, 300, 470, 460, 470], C: [0, 1, 0] }],
    ['StrikeOut', { QuadPoints: [300, 450, 460, 450, 300, 430, 460, 430], C: [1, 0, 0] }],
    ['Stamp', { Name: 'Draft', C: [1, 0, 0] }],
    ['Caret', { Sy: 'P', C: [0, 0, 1] }],
    [
      'Ink',
      { InkList: [[60, 420, 100, 460, 140, 420, 180, 460]], C: [0.2, 0.2, 0.2], BS: { W: 3 } },
    ],
    ['FileAttachment', { Name: 'PushPin', Contents: PDFString.of('Attached file') }],
    ['Sound', { Name: 'Speaker' }],
    ['Movie', { T: PDFString.of('movie') }],
    ['Screen', { T: PDFString.of('screen') }],
    ['PrinterMark', {}],
    ['TrapNet', {}],
    ['Watermark', {}],
    ['3D', {}],
    [
      'Redact',
      {
        QuadPoints: [60, 330, 240, 330, 60, 310, 240, 310],
        IC: [0, 0, 0],
        OverlayText: PDFString.of('REDACTED'),
      },
    ],
  ];
  const rects: Record<string, number[]> = {
    Text: [60, 740, 80, 760],
    Link: [100, 740, 220, 760],
    FreeText: [240, 720, 400, 760],
    Line: [60, 620, 260, 660],
    Square: [60, 670, 160, 710],
    Circle: [180, 670, 280, 710],
    Polygon: [300, 580, 460, 660],
    PolyLine: [60, 540, 240, 570],
    Highlight: [300, 550, 460, 570],
    Underline: [300, 510, 460, 530],
    Squiggly: [300, 470, 460, 490],
    StrikeOut: [300, 430, 460, 450],
    Stamp: [60, 470, 200, 520],
    Caret: [220, 480, 240, 500],
    Ink: [60, 410, 190, 470],
    FileAttachment: [220, 410, 240, 430],
    Sound: [260, 410, 280, 430],
    Movie: [300, 380, 400, 420],
    Screen: [420, 380, 520, 420],
    PrinterMark: [60, 370, 90, 400],
    TrapNet: [100, 370, 130, 400],
    Watermark: [140, 370, 260, 400],
    '3D': [300, 330, 400, 370],
    Redact: [60, 310, 240, 330],
  };
  page.drawText('Highlight  Underline  Squiggly  StrikeOut', { x: 300, y: 555, size: 9, font });
  page.drawText('Redacted words here', { x: 62, y: 315, size: 11, font });
  // The attachment's embedded file specification.
  const fileStream = ctx.flateStream(Buffer.from('attached bytes\n'), {
    Type: 'EmbeddedFile',
    Subtype: 'text/plain',
  });
  const fileRef = ctx.register(fileStream);
  const fs = ctx.register(
    ctx.obj({
      Type: 'Filespec',
      F: PDFString.of('attached.txt'),
      UF: PDFString.of('attached.txt'),
      EF: { F: fileRef },
    }),
  );
  let rootNote: PDFRef | null = null;
  for (const [subtype, extra] of subtypes) {
    const dict: Record<string, unknown> = {
      Subtype: subtype,
      Rect: rects[subtype] ?? [0, 0, 10, 10],
      ...extra,
    };
    if (subtype === 'FileAttachment') dict['FS'] = fs;
    if (!('Contents' in dict)) dict['Contents'] = PDFString.of(`${subtype} annotation`);
    const ref = addAnnot(doc, page, dict);
    if (subtype === 'Text') rootNote = ref;
  }
  // A popup for the note and a reply to it (review state "Accepted").
  if (rootNote) {
    const popup = addAnnot(doc, page, {
      Subtype: 'Popup',
      Rect: [420, 700, 580, 780],
      Parent: rootNote,
      Open: false,
    });
    (ctx.lookup(rootNote) as PDFDict).set(PDFName.of('Popup'), popup);
    addAnnot(doc, page, {
      Subtype: 'Text',
      Rect: [60, 700, 80, 720],
      IRT: rootNote,
      RT: 'R',
      State: PDFString.of('Accepted'),
      StateModel: PDFString.of('Review'),
      Contents: PDFString.of('Accepted by reviewer'),
      T: PDFString.of('Reviewer'),
      Subj: PDFString.of('Review'),
      CA: 0.75,
    });
  }
  await save(doc, 'annotations-all.pdf');
}

// ---- M10: JavaScript -----------------------------------------------------------------------
async function javascript(): Promise<void> {
  const doc = await newDoc('JavaScript-bearing');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(A4);
  page.drawText('This file carries document-level JavaScript.', { x: 72, y: 740, size: 14, font });
  const ctx = doc.context;
  const open = ctx.register(
    ctx.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("Hello from ynotPDF fixtures");') }),
  );
  doc.catalog.set(PDFName.of('OpenAction'), open);
  const named = ctx.register(ctx.obj({ S: 'JavaScript', JS: PDFString.of('var total = 0;') }));
  doc.catalog.set(
    PDFName.of('Names'),
    ctx.obj({ JavaScript: { Names: [PDFString.of('init'), named] } }),
  );
  const f = doc.getForm();
  const tf = f.createTextField('calc.total');
  tf.addToPage(page, { x: 72, y: 680, width: 200, height: 22 });
  tf.acroField.dict.set(
    PDFName.of('AA'),
    ctx.obj({ F: { S: 'JavaScript', JS: PDFString.of('AFNumber_Format(2, 0, 0, 0, "", true);') } }),
  );
  f.updateFieldAppearances(font);
  await save(doc, 'javascript.pdf');
}

// ---- M10: XFA ------------------------------------------------------------------------------
async function xfa(): Promise<void> {
  const doc = await newDoc('XFA form');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(A4);
  page.drawText('AcroForm fallback for an XFA form', { x: 72, y: 740, size: 14, font });
  const f = doc.getForm();
  const tf = f.createTextField('xfa.name');
  tf.setText('fallback value');
  tf.addToPage(page, { x: 72, y: 680, width: 240, height: 22 });
  f.updateFieldAppearances(font);
  const xdp =
    '<?xml version="1.0" encoding="UTF-8"?>\n<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">\n' +
    '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1">' +
    '<field name="name"><ui><textEdit/></ui><value><text>fallback value</text></value></field>' +
    '</subform></template>\n</xdp:xdp>\n';
  const stream = doc.context.register(doc.context.flateStream(Buffer.from(xdp)));
  f.acroForm.dict.set(PDFName.of('XFA'), stream);
  // pdf-lib's getForm() strips /XFA, and save(updateFieldAppearances) calls it: save without.
  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  writeRaw('xfa.pdf', Buffer.from(bytes));
}

// ---- M10: PDF/A-1b structure ---------------------------------------------------------------
async function pdfa(): Promise<void> {
  const doc = await newDoc('PDF/A-1b structure sample');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(A4);
  page.drawText('PDF/A-1b structural sample (XMP + OutputIntent).', {
    x: 72,
    y: 740,
    size: 14,
    font,
  });
  const ctx = doc.context;
  const xmp =
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>1</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description>\n' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">PDF/A-1b structure sample</rdf:li></rdf:Alt></dc:title></rdf:Description>\n' +
    '</rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>';
  const meta = ctx.register(
    ctx.stream(Buffer.from(xmp, 'utf8'), { Type: 'Metadata', Subtype: 'XML' }),
  );
  doc.catalog.set(PDFName.of('Metadata'), meta);
  // A placeholder ICC stream: enough structure for readers, not a real colour profile.
  const icc = ctx.register(ctx.flateStream(det('fake icc profile', 512), { N: 3 }));
  doc.catalog.set(
    PDFName.of('OutputIntents'),
    ctx.obj([
      {
        Type: 'OutputIntent',
        S: 'GTS_PDFA1',
        OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
        Info: PDFString.of('sRGB IEC61966-2.1'),
        DestOutputProfile: icc,
      },
    ]),
  );
  doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
  await save(doc, 'pdfa-1b.pdf');
}

// ---- M10: CJK and RTL text -----------------------------------------------------------------
async function cjkRtl(): Promise<void> {
  const doc = await newDoc('CJK and RTL text');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(A4);
  page.drawText('Non-embedded CJK (Type0 / UniGB-UCS2-H) and Hebrew (glyph names):', {
    x: 72,
    y: 760,
    size: 11,
    font,
  });
  const ctx = doc.context;
  const cid = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'CIDFontType0',
      BaseFont: 'STSong-Light',
      CIDSystemInfo: {
        Registry: PDFString.of('Adobe'),
        Ordering: PDFString.of('GB1'),
        Supplement: 2,
      },
      FontDescriptor: ctx.register(
        ctx.obj({
          Type: 'FontDescriptor',
          FontName: 'STSong-Light',
          Flags: 4,
          FontBBox: [-25, -254, 1000, 880],
          ItalicAngle: 0,
          Ascent: 880,
          Descent: -120,
          CapHeight: 626,
          StemV: 78,
        }),
      ),
      DW: 1000,
    }),
  );
  const type0 = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: 'STSong-Light-UniGB-UCS2-H',
      Encoding: 'UniGB-UCS2-H',
      DescendantFonts: [cid],
    }),
  );
  // Hebrew through a ToUnicode CMap: codes A-D → shin, lamed, vav, final mem (U+05E9 05DC 05D5 05DD).
  const toUnicode = ctx.register(
    ctx.stream(
      Buffer.from(
        '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /Custom-Hebrew def\n' +
          '1 begincodespacerange\n<00> <FF>\nendcodespacerange\n4 beginbfchar\n<41> <05E9>\n<42> <05DC>\n<43> <05D5>\n<44> <05DD>\nendbfchar\n' +
          'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n',
      ),
    ),
  );
  const hebrew = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
      Encoding: {
        Type: 'Encoding',
        Differences: [65, 'afii57689', 'afii57676', 'afii57669', 'afii57677'],
      },
      ToUnicode: toUnicode,
    }),
  );
  page.node.setFontDictionary(PDFName.of('FCJK'), type0);
  page.node.setFontDictionary(PDFName.of('FHeb'), hebrew);
  const cjk = '中文测试'; // UTF-16BE code units are the UniGB-UCS2-H codes
  const cjkHex = Array.from(cjk, (c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  page.pushOperators(
    beginText(),
    setFontAndSize(PDFName.of('FCJK'), 24),
    moveText(72, 700),
    showText(PDFHexString.of(cjkHex)),
    endText(),
    beginText(),
    setFontAndSize(PDFName.of('FHeb'), 24),
    moveText(72, 640),
    // Glyphs are laid out visually left→right, so RTL text is stored reversed: D C B A puts
    // final-mem leftmost and shin rightmost; readers reorder it back to שלום.
    showText(PDFHexString.of('44434241')),
    endText(),
  );
  await save(doc, 'cjk-rtl.pdf');
}

// ---- M10: damaged files --------------------------------------------------------------------
function damaged(blankBytes: Uint8Array, textBytes: Uint8Array): void {
  const blankText = Buffer.from(blankBytes).toString('latin1');
  const broken = blankText.replace(
    /startxref\n(\d+)/,
    (_m, digits: string) => `startxref\n${'9'.repeat(digits.length)}`,
  );
  writeRaw('broken-xref.pdf', Buffer.from(broken, 'latin1'));
  writeRaw('truncated.pdf', Buffer.from(textBytes.subarray(0, Math.floor(textBytes.length * 0.7))));
  writeRaw(
    'corrupt.pdf',
    Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), det('corrupt garbage', 2048)]),
  );
}

// ---- M10: huge page count ------------------------------------------------------------------
async function hugePageCount(): Promise<void> {
  const doc = await newDoc('One thousand pages');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 1000; i++) {
    const page = doc.addPage([200, 280]);
    page.drawText(`${i + 1}`, { x: 20, y: 240, size: 14, font });
  }
  await save(doc, 'huge-page-count.pdf');
}

// ---- M10: scanned page ---------------------------------------------------------------------
async function scanned(): Promise<void> {
  const doc = await newDoc('Scanned page (synthetic)');
  const w = 1240; // A4 at 150 dpi
  const h = 1754;
  // Rows of "words": black blocks on off-white paper with a light speckle.
  const rows: Array<{ y: number; words: Array<[number, number]> }> = [];
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let y = 160; y < h - 160; y += 44) {
    const words: Array<[number, number]> = [];
    let x = 140;
    while (x < w - 200) {
      const len = 40 + Math.floor(rnd() * 120);
      words.push([x, x + len]);
      x += len + 22;
    }
    rows.push({ y, words });
  }
  const png = makePng(
    w,
    h,
    (x, y) => {
      for (const row of rows) {
        if (y >= row.y && y < row.y + 18) {
          for (const [x0, x1] of row.words)
            if (x >= x0 && x < x1) return (x + y) % 9 === 0 ? 40 : 15;
        }
      }
      return (x * 7 + y * 13) % 97 === 0 ? 225 : 248;
    },
    true,
  );
  const img = await doc.embedPng(png);
  const page = doc.addPage(A4);
  page.drawImage(img, { x: 0, y: 0, width: A4[0], height: A4[1] });
  await save(doc, 'scanned.pdf');
}

// ---- M91: inputs for "Create PDF from images / web / Markdown / text" (create/) -----------
const CREATE = join(OUT, 'create');
mkdirSync(join(CREATE, 'site'), { recursive: true });

function writeCreate(name: string, content: Buffer | string): void {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  writeFileSync(join(CREATE, name), bytes);
  console.info(`fixtures: create/${name} (${bytes.byteLength} bytes)`);
}

/** RGBA pixel buffer from a pixel function (alpha 255 unless the function returns 4 values). */
function rgbaBuffer(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number] | [number, number, number, number],
): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      const o = (y * width + x) * 4;
      out[o] = p[0];
      out[o + 1] = p[1];
      out[o + 2] = p[2];
      out[o + 3] = p.length === 4 ? p[3] : 255;
    }
  return out;
}

/** RGB (3 bytes per pixel) buffer, the TIFF/BMP strip layout. */
function rgbBuffer(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Buffer {
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      const o = (y * width + x) * 3;
      out[o] = p[0];
      out[o + 1] = p[1];
      out[o + 2] = p[2];
    }
  return out;
}

/** Baseline JPEG through jpeg-js; the JFIF APP0 is patched to carry a dpi density. */
function makeJpeg(rgba: Buffer, width: number, height: number, dpi: number): Buffer {
  const jpg = Buffer.from(encodeJpeg({ data: rgba, width, height }, 85).data);
  // APP0: FF E0, length(2), "JFIF\0", version(2), units(1), Xdensity(2), Ydensity(2), thumb(2).
  const app0 = jpg.indexOf(Buffer.from([0xff, 0xe0]), 2);
  if (app0 < 0 || jpg.toString('latin1', app0 + 4, app0 + 9) !== 'JFIF\0')
    throw new Error('jpeg-js did not write a JFIF APP0');
  jpg[app0 + 11] = 1; // units: dots per inch
  jpg.writeUInt16BE(dpi, app0 + 12);
  jpg.writeUInt16BE(dpi, app0 + 14);
  return jpg;
}

function photoLandscape(): void {
  const w = 300;
  const h = 200;
  const rgba = rgbaBuffer(w, h, (x, y) => {
    // Dark diagonal band over a smooth two-axis gradient.
    if (Math.abs(x - y * 1.5 - 20) < 18) return [30, 30, 40];
    return [Math.round((255 * x) / (w - 1)), Math.round((255 * y) / (h - 1)), 160];
  });
  writeCreate('photo-landscape.jpg', makeJpeg(rgba, w, h, 72));
}

/**
 * EXIF APP1 (little-endian TIFF, one IFD): Orientation, XResolution, YResolution,
 * ResolutionUnit. Rational values follow the IFD.
 */
function exifApp1(orientation: number, dpi: number): Buffer {
  const entries: Array<[tag: number, type: number, value: number]> = [
    [0x0112, 3, orientation], // Orientation SHORT
    [0x011a, 5, 0], // XResolution RATIONAL (offset filled below)
    [0x011b, 5, 0], // YResolution RATIONAL
    [0x0128, 3, 2], // ResolutionUnit SHORT: inch
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const tiff = Buffer.alloc(8 + ifdSize + 16);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(entries.length, 8);
  let rational = 8 + ifdSize;
  entries.forEach(([tag, type, value], i) => {
    const o = 10 + i * 12;
    tiff.writeUInt16LE(tag, o);
    tiff.writeUInt16LE(type, o + 2);
    tiff.writeUInt32LE(1, o + 4);
    if (type === 3) tiff.writeUInt16LE(value, o + 8);
    else {
      tiff.writeUInt32LE(rational, o + 8);
      tiff.writeUInt32LE(dpi, rational);
      tiff.writeUInt32LE(1, rational + 4);
      rational += 8;
    }
  });
  tiff.writeUInt32LE(0, 10 + entries.length * 12); // next IFD: none
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function photoExifRotated(): void {
  const w = 200;
  const h = 300;
  // An arrow pointing to the top of the *stored* pixels; Orientation 6 displays it pointing right.
  const rgba = rgbaBuffer(w, h, (x, y) => {
    const shaft = x >= 88 && x < 112 && y >= 100 && y < 250;
    const head = y >= 40 && y < 100 && Math.abs(x - 100) <= y - 40;
    if (shaft || head) return [20, 40, 120];
    return [230 - (y >> 3), 232, 240];
  });
  const jpg = makeJpeg(rgba, w, h, 150);
  writeCreate(
    'photo-exif-rotated.jpg',
    Buffer.concat([jpg.subarray(0, 2), exifApp1(6, 150), jpg.subarray(2)]),
  );
}

function chart300dpi(): void {
  const w = 600;
  const h = 450;
  const bars: Array<[height: number, colour: [number, number, number]]> = [
    [120, [31, 119, 180]],
    [260, [255, 127, 14]],
    [180, [44, 160, 44]],
    [320, [214, 39, 40]],
    [90, [148, 103, 189]],
    [230, [140, 86, 75]],
    [300, [227, 119, 194]],
    [150, [127, 127, 127]],
  ];
  const png = makePng(
    w,
    h,
    (x, y) => {
      if ((x >= 58 && x <= 60 && y <= 400) || (y >= 398 && y <= 400 && x >= 58)) return [0, 0, 0];
      if (x > 60 && y < 398) {
        const i = Math.floor((x - 80) / 62);
        const bar = x >= 80 && (x - 80) % 62 < 44 ? bars[i] : undefined;
        if (bar && y >= 398 - bar[0]) return bar[1];
        if (x % 50 === 0 || y % 50 === 0) return [220, 220, 220];
      }
      return [255, 255, 255];
    },
    false,
    { dpi: 300 },
  );
  writeCreate('chart-300dpi.png', Buffer.from(png));
}

function logoAlpha(): void {
  const png = makePngRgba(128, 128, (x, y) => {
    const d = Math.hypot(x + 0.5 - 64, y + 0.5 - 64);
    const a = d <= 52 ? 255 : d >= 58 ? 0 : Math.round((255 * (58 - d)) / 6);
    if (d < 28) return [250, 250, 250, a];
    return [30 + (x >> 2), 90, 200 - (y >> 2), a];
  });
  writeCreate('logo-alpha.png', Buffer.from(png));
}

function scanGray(): void {
  const w = 200;
  const h = 280;
  // Rows of "words" 6 px tall every 14 px, word lengths from a labelled LCG.
  const rows: Array<{ y: number; words: Array<[number, number]> }> = [];
  let seed = 11;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let y = 30; y < h - 30; y += 14) {
    const words: Array<[number, number]> = [];
    let x = 20 + (rows.length % 5 === 0 ? 24 : 0);
    while (x < w - 30) {
      const len = 8 + Math.floor(rnd() * 24);
      words.push([x, Math.min(x + len, w - 20)]);
      x += len + 5;
    }
    rows.push({ y, words });
  }
  const png = makePng(
    w,
    h,
    (x, y) => {
      for (const row of rows)
        if (y >= row.y && y < row.y + 6)
          for (const [x0, x1] of row.words) if (x >= x0 && x < x1) return 20;
      return (x * 7 + y * 13) % 89 === 0 ? 215 : 245;
    },
    true,
    { dpi: 200 },
  );
  writeCreate('scan-gray.png', Buffer.from(png));
}

interface TiffPage {
  width: number;
  height: number;
  /** Packed RGB scanlines (3 bytes per pixel). */
  rgb: Buffer;
  /** 1 = none, 8 = Adobe deflate (zlib stream). */
  compression: 1 | 8;
}

/**
 * Little-endian multi-page TIFF writer: RGB, 8 bits per sample, one strip per page.
 * Layout per page: IFD, BitsPerSample values, XResolution, YResolution, strip data.
 */
function makeTiff(pages: TiffPage[], dpi: number): Buffer {
  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4);
  const parts: Buffer[] = [header];
  let pos = 8;
  pages.forEach((page, index) => {
    const strip = page.compression === 8 ? deflateSync(page.rgb, { level: 9 }) : page.rgb;
    const entries: Array<[tag: number, type: number, count: number, value: number]> = [
      [256, 4, 1, page.width], // ImageWidth
      [257, 4, 1, page.height], // ImageLength
      [258, 3, 3, 0], // BitsPerSample → offset
      [259, 3, 1, page.compression], // Compression
      [262, 3, 1, 2], // PhotometricInterpretation: RGB
      [273, 4, 1, 0], // StripOffsets → strip
      [277, 3, 1, 3], // SamplesPerPixel
      [278, 4, 1, page.height], // RowsPerStrip
      [279, 4, 1, strip.length], // StripByteCounts
      [282, 5, 1, 0], // XResolution → rational
      [283, 5, 1, 0], // YResolution → rational
      [284, 3, 1, 1], // PlanarConfiguration: chunky
      [296, 3, 1, 2], // ResolutionUnit: inch
    ];
    const ifdSize = 2 + entries.length * 12 + 4;
    const bpsOffset = pos + ifdSize;
    const xresOffset = bpsOffset + 8;
    const yresOffset = xresOffset + 8;
    const stripOffset = yresOffset + 8;
    const block = Buffer.alloc(ifdSize + 24);
    block.writeUInt16LE(entries.length, 0);
    entries.forEach(([tag, type, count, value], i) => {
      const o = 2 + i * 12;
      block.writeUInt16LE(tag, o);
      block.writeUInt16LE(type, o + 2);
      block.writeUInt32LE(count, o + 4);
      if (tag === 258) block.writeUInt32LE(bpsOffset, o + 8);
      else if (tag === 273) block.writeUInt32LE(stripOffset, o + 8);
      else if (tag === 282) block.writeUInt32LE(xresOffset, o + 8);
      else if (tag === 283) block.writeUInt32LE(yresOffset, o + 8);
      else if (type === 3) block.writeUInt16LE(value, o + 8);
      else block.writeUInt32LE(value, o + 8);
    });
    const padded = stripOffset + strip.length + (strip.length % 2); // word-align the next IFD
    block.writeUInt32LE(index < pages.length - 1 ? padded : 0, 2 + entries.length * 12);
    block.writeUInt16LE(8, ifdSize);
    block.writeUInt16LE(8, ifdSize + 2);
    block.writeUInt16LE(8, ifdSize + 4);
    block.writeUInt32LE(dpi, ifdSize + 8);
    block.writeUInt32LE(1, ifdSize + 12);
    block.writeUInt32LE(dpi, ifdSize + 16);
    block.writeUInt32LE(1, ifdSize + 20);
    parts.push(block, strip);
    if (strip.length % 2) parts.push(Buffer.alloc(1));
    pos = padded;
  });
  return Buffer.concat(parts);
}

function pages3Tif(): void {
  const sizes: Array<[number, number, [number, number, number]]> = [
    [120, 80, [200, 60, 60]],
    [80, 120, [60, 160, 80]],
    [100, 100, [60, 90, 200]],
  ];
  const pages = sizes.map(([width, height, colour], i): TiffPage => {
    // A dark bar along the top holding (page number) white squares.
    const rgb = rgbBuffer(width, height, (x, y) => {
      if (y < 12) {
        const k = Math.floor((x - 4) / 12);
        return x >= 4 && k <= i && (x - 4) % 12 < 8 && y >= 2 && y < 10
          ? [255, 255, 255]
          : [0, 0, 0];
      }
      return colour;
    });
    return { width, height, rgb, compression: 1 };
  });
  writeCreate('pages-3.tif', makeTiff(pages, 96));
}

function deflateTif(): void {
  const rgb = rgbBuffer(64, 64, (x, y) => [x * 4, y * 4, ((x ^ y) * 4) & 255]);
  writeCreate('deflate.tif', makeTiff([{ width: 64, height: 64, rgb, compression: 8 }], 96));
}

/** 24-bit bottom-up BMP with a 54-byte header; rows padded to 4 bytes, BGR order. */
function tinyBmp(): void {
  const w = 32;
  const h = 24;
  const stride = Math.ceil((w * 3) / 4) * 4;
  const pixels = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (h - 1 - y) * stride + x * 3; // bottom-up: last image row first
      const onDiagonal = Math.abs(x - y * (w / h)) < 2;
      pixels[o] = onDiagonal ? 0 : 200; // B
      pixels[o + 1] = onDiagonal ? 0 : Math.round((255 * y) / (h - 1)); // G
      pixels[o + 2] = onDiagonal ? 0 : Math.round((255 * x) / (w - 1)); // R
    }
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10); // bfOffBits
  header.writeUInt32LE(40, 14); // biSize
  header.writeInt32LE(w, 18);
  header.writeInt32LE(h, 22); // positive: bottom-up
  header.writeUInt16LE(1, 26); // planes
  header.writeUInt16LE(24, 28); // bits per pixel
  header.writeUInt32LE(0, 30); // BI_RGB
  header.writeUInt32LE(pixels.length, 34);
  header.writeInt32LE(2835, 38); // 72 dpi in px/m
  header.writeInt32LE(2835, 42);
  writeCreate('tiny.bmp', Buffer.concat([header, pixels]));
}

function notAnImage(): void {
  const text = 'this is not a png. '.repeat(4).slice(0, 63) + '\n';
  writeCreate('not-an-image.png', Buffer.from(text, 'ascii'));
}

function sitePage(title: string, body: string): string {
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    `<title>Fixture site — ${title}</title>\n` +
    '<style>\n' +
    '  body { font-family: Georgia, serif; margin: 2em; max-width: 40em; }\n' +
    '  .banner { background: #1e5aa8; color: #ffffff; padding: 1em; }\n' +
    '  nav a { margin-right: 1em; }\n' +
    '  @media print {\n' +
    '    .banner { background: #dddddd; color: #000000; }\n' +
    '    .no-print { display: none; }\n' +
    '  }\n' +
    '</style>\n</head>\n<body>\n' +
    body +
    '</body>\n</html>\n'
  );
}

function site(): void {
  writeCreate(
    'site/index.html',
    sitePage(
      'Home',
      '<h1 id="top">Fixture site</h1>\n' +
        '<div class="banner">A banner with a background colour.</div>\n' +
        '<p>This is the home page of a tiny static site used to test "Create PDF from web page". ' +
        'It links to two internal pages, one external page and an in-page anchor.</p>\n' +
        '<p class="no-print">This paragraph is hidden by the print stylesheet.</p>\n' +
        '<img src="../logo-alpha.png" alt="logo" width="64" height="64">\n' +
        '<nav>\n' +
        '  <a href="about.html">About</a>\n' +
        '  <a href="contact.html#team">Contact team</a>\n' +
        '  <a href="https://example.com/outside">Outside</a>\n' +
        '  <a href="#top">Top</a>\n' +
        '</nav>\n',
    ),
  );
  writeCreate(
    'site/about.html',
    sitePage(
      'About',
      '<h1>About</h1>\n' +
        '<p>The about page is one hop from the home page; the deep page is two.</p>\n' +
        '<nav>\n' +
        '  <a href="index.html">Home</a>\n' +
        '  <a href="contact.html">Contact</a>\n' +
        '  <a href="deep.html">Deep</a>\n' +
        '</nav>\n',
    ),
  );
  let contact = '<h1>Contact</h1>\n<h2 id="team">The team</h2>\n';
  for (let i = 1; i <= 60; i++)
    contact +=
      `<p>Paragraph ${i} of 60. The contact page is deliberately long so that it prints ` +
      'to more than one A4 page; each paragraph repeats the same two sentences.</p>\n';
  contact +=
    '<nav>\n  <a href="index.html">Home</a>\n  <a href="mailto:test@example.com">Email us</a>\n</nav>\n';
  writeCreate('site/contact.html', sitePage('Contact', contact));
  writeCreate(
    'site/deep.html',
    sitePage(
      'Deep',
      '<h1>Deep</h1>\n<p>Only reachable from the about page (depth 2 from home).</p>\n' +
        '<nav>\n  <a href="index.html">Home</a>\n</nav>\n',
    ),
  );
}

function notesMd(): void {
  const lines = [
    '# Heading 1',
    '',
    'A paragraph with **bold**, *italic*, `inline code` and a [link](https://example.com/notes).',
    '',
    '## Heading 2',
    '',
    '1. First ordered item',
    '2. Second ordered item',
    '3. Third ordered item',
    '',
    '- An unordered item',
    '- Another unordered item',
    '  - A nested item',
    '',
    '> A blockquote spanning',
    '> two lines.',
    '',
    '### Heading 3',
    '',
    '```ts',
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '```',
    '',
    '| Name  | Quantity | Price |',
    '| :---- | :------: | ----: |',
    '| Apple |    3     |  0.50 |',
    '| Pear  |   12     |  0.75 |',
    '| Plum  |    7     |  1.25 |',
    '',
    '---',
    '',
    '![logo](logo-alpha.png)',
    '',
    '- [x] Done task',
    '- [ ] Open task',
    '',
  ];
  writeCreate('notes.md', lines.join('\n'));
}

function longTxt(): void {
  const pangrams = [
    'The quick brown fox jumps over the lazy dog.',
    'Pack my box with five dozen liquor jugs.',
    'Sphinx of black quartz, judge my vow.',
    'How vexingly quick daft zebras jump!',
  ];
  const token = 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(4).slice(0, 120);
  const lines: string[] = [];
  for (let i = 1; i <= 250; i++) {
    const n = String(i).padStart(3, '0');
    const p = pangrams[(i - 1) % pangrams.length] ?? '';
    if (i % 50 === 13) lines.push('');
    else if (i % 10 === 0)
      lines.push(
        `Line ${n}: unbreakable token follows ${token} then ordinary words resume: ${p} ${p} ${p}`,
      );
    else if (i % 37 === 0) lines.push(`Line ${n}:\tindented with a tab\t${p}`);
    else lines.push(`Line ${n}: ${p}`);
  }
  writeCreate('long.txt', `${lines.join('\n')}\n`);
}

function unicodeTxt(): void {
  const lines = [
    'ASCII only: a plain line of text.',
    'Accents: café, naïve, résumé, Zoë.',
    'Curly quotes: “double” and ‘single’.',
    'Dashes: an em dash — and an en dash – in one line.',
    'Currency: €12.50, £8, ¥1000, $3.',
    'Symbols: © 2026 ynotPDF fixtures ® ™ … • § ¶',
    'Ligatures and specials: Œ œ Æ æ ß',
    'Spanish and German: ¿Qué? ¡Hola! Straße Ärger Übung',
    'CJK and emoji: 漢字 日本語 🙂',
    'Fractions and degrees: ½ ¼ ¾ 90° ±5 × ÷',
    'Nordic: Ørsted Åland Æsir smørrebrød',
    'Last line — the end.',
  ];
  writeCreate('unicode.txt', `${lines.join('\n')}\n`);
}

function createFixtures(): void {
  photoLandscape();
  photoExifRotated();
  chart300dpi();
  logoAlpha();
  scanGray();
  pages3Tif();
  deflateTif();
  tinyBmp();
  notAnImage();
  site();
  notesMd();
  longTxt();
  unicodeTxt();
}

const blankBytes = await blank();
await multipage();
const textBytes = await text();
await image();
await form();
await annotated();
encrypted();
await outline();
await layers();
await attachments();
await portfolio();
await rotated();
await mixedBoxes();
await pageLabels();
await links();
await formsAll();
await annotationsAll();
await javascript();
await xfa();
await pdfa();
await cjkRtl();
damaged(blankBytes, textBytes);
await hugePageCount();
await scanned();
createFixtures();
console.info('fixtures: done');
