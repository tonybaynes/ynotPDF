/**
 * FDF reader and writer (M32). Pure: bytes in, {@link XfdfDocument} out, and back.
 *
 * FDF is the older of the two exchange formats and Acrobat still offers it, so an import that
 * only took XFDF would turn away half the files a reviewer is sent. The content is the same
 * comments; only the syntax differs — PDF objects instead of XML — so both formats read into and
 * write from the one record in `types.ts`, and everything above this layer is format-blind.
 *
 * Reading does not trust the cross-reference table: FDF files are frequently produced by hand or
 * by tools that leave the offsets stale, and every object in one is small. Every `N G obj … endobj`
 * in the file is collected, then `/Root → /FDF` is resolved through that map. A file with no
 * usable `/FDF` dictionary but with annotation objects in it still imports them, because a
 * broken container is not a reason to lose the comments.
 */

import type { AnnotationSubtype } from '@engine/PdfEngine';
import type { PdfPoint } from '@shared/pdf';
import {
  EMPTY_XFDF_ANNOTATION,
  XfdfError,
  XFDF_SUBTYPES,
  type XfdfAnnotation,
  type XfdfDocument,
  type XfdfField,
} from './types';
import {
  asArray,
  asDict,
  asName,
  asNumber,
  asNumbers,
  asString,
  binaryToBytes,
  bytesToBinary,
  dict,
  pdfArray,
  pdfName,
  pdfNumber,
  pdfNumbers,
  pdfString,
  PdfLexer,
  writeValue,
  type PdfValue,
} from './pdfsyntax';
import {
  colorComponents,
  isoToPdfDate,
  packColorComponents,
  packFlagBits,
  pdfDateToIso,
  unpackFlagBits,
} from './values';

const KNOWN_SUBTYPES = new Set<string>(XFDF_SUBTYPES);

type Objects = Map<number, PdfValue>;

/** Resolves a reference through the object map; anything else is returned unchanged. */
function resolve(objects: Objects, value: PdfValue | undefined, depth = 0): PdfValue | undefined {
  if (value?.kind !== 'ref' || depth > 32) return value;
  return resolve(objects, objects.get(value.number), depth + 1);
}

function entry(
  objects: Objects,
  owner: ReadonlyMap<string, PdfValue> | null,
  key: string,
): PdfValue | undefined {
  return owner ? resolve(objects, owner.get(key)) : undefined;
}

/** Every `N G obj … endobj` body in the file, by object number. */
function collectObjects(text: string): Objects {
  const objects: Objects = new Map();
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const number = Number(match[1]);
    const lexer = new PdfLexer(text);
    lexer.position = match.index + match[0].length;
    const value = lexer.readValue();
    if (value) objects.set(number, value);
  }
  return objects;
}

/**
 * Reads an FDF file. Throws {@link XfdfError} only when the bytes are not an FDF at all; a file
 * with nothing in it reads as an empty result.
 */
export function readFdf(bytes: Uint8Array): XfdfDocument {
  const text = bytesToBinary(bytes);
  if (!/%FDF-\d/.test(text.slice(0, 1024))) {
    throw new XfdfError('not-fdf', 'This file is not an FDF comment file');
  }
  const objects = collectObjects(text);

  // `/Root` lives in the trailer; some producers leave it out, in which case the one object that
  // has an `/FDF` key is the root by construction.
  let fdf: ReadonlyMap<string, PdfValue> | null = null;
  const trailerAt = text.lastIndexOf('trailer');
  if (trailerAt >= 0) {
    const lexer = new PdfLexer(text);
    lexer.position = trailerAt + 'trailer'.length;
    const trailer = asDict(lexer.readValue() ?? undefined);
    fdf = asDict(entry(objects, asDict(entry(objects, trailer, 'Root')), 'FDF'));
  }
  if (!fdf) {
    for (const value of objects.values()) {
      const found = asDict(entry(objects, asDict(value), 'FDF'));
      if (found) {
        fdf = found;
        break;
      }
    }
  }

  const href = asString(entry(objects, fdf, 'F'));
  const idArray = asArray(entry(objects, fdf, 'ID'));
  const ids =
    idArray.length >= 2
      ? {
          original: hexOf(idArray[0]),
          modified: hexOf(idArray[1]),
        }
      : null;

  const annotationValues = asArray(entry(objects, fdf, 'Annots'));
  const annotations: XfdfAnnotation[] = [];
  const seen = new Set<PdfValue>();
  for (const item of annotationValues) {
    const resolved = resolve(objects, item);
    const map = asDict(resolved);
    if (!map || !resolved) continue;
    seen.add(resolved);
    const read = readAnnotationDict(objects, map);
    if (read) annotations.push(read);
  }
  if (annotations.length === 0) {
    // No usable `/Annots` array: take every object that looks like an annotation instead.
    for (const value of objects.values()) {
      if (seen.has(value)) continue;
      const map = asDict(value);
      if (!map) continue;
      const read = readAnnotationDict(objects, map);
      if (read) annotations.push(read);
    }
  }

  const fields: XfdfField[] = [];
  readFieldArray(objects, asArray(entry(objects, fdf, 'Fields')), '', fields);

  return { href: href === '' ? null : href, ids, annotations, fields };
}

function hexOf(value: PdfValue | undefined): string {
  const text = asString(value);
  if (text === null) return '';
  let out = '';
  for (let i = 0; i < text.length; i++) out += text.charCodeAt(i).toString(16).padStart(2, '0');
  return out.toUpperCase();
}

function readFieldArray(
  objects: Objects,
  values: ReadonlyArray<PdfValue>,
  prefix: string,
  out: XfdfField[],
): void {
  for (const item of values) {
    const map = asDict(resolve(objects, item));
    if (!map) continue;
    const own = asString(entry(objects, map, 'T')) ?? '';
    const name = prefix === '' ? own : `${prefix}.${own}`;
    const value = entry(objects, map, 'V');
    if (value) {
      const text =
        value.kind === 'string'
          ? value.value
          : value.kind === 'name'
            ? value.value
            : value.kind === 'number'
              ? String(value.value)
              : null;
      if (text !== null) out.push({ name, value: text });
    }
    readFieldArray(objects, asArray(entry(objects, map, 'Kids')), name, out);
  }
}

function readAnnotationDict(
  objects: Objects,
  map: ReadonlyMap<string, PdfValue>,
): XfdfAnnotation | null {
  const subtype = asName(entry(objects, map, 'Subtype'));
  if (subtype === null || !KNOWN_SUBTYPES.has(subtype)) return null;
  const rectNumbers = asNumbers(entry(objects, map, 'Rect'));
  if (rectNumbers.length < 4) return null;
  const [a = 0, b = 0, c = 0, d = 0] = rectNumbers;
  const rect = {
    x0: Math.min(a, c),
    y0: Math.min(b, d),
    x1: Math.max(a, c),
    y1: Math.max(b, d),
  };

  const border = asDict(entry(objects, map, 'BS'));
  const dashes = asNumbers(entry(objects, border ?? null, 'D'));
  const effect = asDict(entry(objects, map, 'BE'));
  const cloudy =
    asName(entry(objects, effect ?? null, 'S')) === 'C'
      ? (asNumber(entry(objects, effect ?? null, 'I')) ?? 1)
      : null;

  const lineEndValue = entry(objects, map, 'LE');
  const lineEndings =
    lineEndValue?.kind === 'array'
      ? lineEndValue.value.map((v) => (v.kind === 'name' ? v.value : 'None'))
      : null;

  const flagBits = asNumber(entry(objects, map, 'F'));

  return {
    ...EMPTY_XFDF_ANNOTATION,
    subtype: subtype as AnnotationSubtype,
    page: Math.max(0, Math.trunc(asNumber(entry(objects, map, 'Page')) ?? 0)),
    rect,
    name: asString(entry(objects, map, 'NM')),
    contents: asString(entry(objects, map, 'Contents')),
    richContents: asString(entry(objects, map, 'RC')),
    author: asString(entry(objects, map, 'T')),
    subject: asString(entry(objects, map, 'Subj')),
    created: pdfDateToIso(asString(entry(objects, map, 'CreationDate'))),
    modified: pdfDateToIso(asString(entry(objects, map, 'M'))),
    color: packColorComponents(asNumbers(entry(objects, map, 'C'))),
    interiorColor: packColorComponents(asNumbers(entry(objects, map, 'IC'))),
    opacity: asNumber(entry(objects, map, 'CA')),
    borderWidth: asNumber(entry(objects, border ?? null, 'W')),
    flags: flagBits === null ? EMPTY_XFDF_ANNOTATION.flags : unpackFlagBits(flagBits),
    quadPoints: asNumbers(entry(objects, map, 'QuadPoints')),
    paths: readPathsFromDict(objects, map, subtype),
    icon: asName(entry(objects, map, 'Name')),
    state: asString(entry(objects, map, 'State')),
    stateModel: asString(entry(objects, map, 'StateModel')),
    inReplyTo: readReplyTarget(objects, map),
    replyType: asName(entry(objects, map, 'RT')),
    intent: asName(entry(objects, map, 'IT')),
    defaultAppearance: asString(entry(objects, map, 'DA')),
    defaultStyle: asString(entry(objects, map, 'DS')),
    rotate: asNumber(entry(objects, map, 'Rotate')),
    align: asNumber(entry(objects, map, 'Q')),
    callout: asNumbers(entry(objects, map, 'CL')),
    padding: asNumbers(entry(objects, map, 'RD')),
    lineEnding: lineEndValue?.kind === 'name' ? lineEndValue.value : null,
    lineEndings: lineEndings?.length === 2 ? lineEndings : null,
    dashArray: dashes.length > 0 ? dashes : null,
    cloudy,
    attachmentName: readFileName(objects, map),
  };
}

/** `/IRT` is a reference in a PDF and either a reference or a name in an FDF; both give a `/NM`. */
function readReplyTarget(objects: Objects, map: ReadonlyMap<string, PdfValue>): string | null {
  const raw = map.get('IRT');
  if (!raw) return null;
  if (raw.kind === 'string') return raw.value;
  const target = asDict(resolve(objects, raw));
  return target ? asString(entry(objects, target, 'NM')) : null;
}

function readFileName(objects: Objects, map: ReadonlyMap<string, PdfValue>): string | null {
  const fs = entry(objects, map, 'FS');
  if (!fs) return null;
  if (fs.kind === 'string') return fs.value;
  const spec = asDict(fs);
  if (!spec) return null;
  return asString(entry(objects, spec, 'UF')) ?? asString(entry(objects, spec, 'F'));
}

function readPathsFromDict(
  objects: Objects,
  map: ReadonlyMap<string, PdfValue>,
  subtype: string,
): PdfPoint[][] {
  const pairs = (numbers: ReadonlyArray<number>): PdfPoint[] => {
    const out: PdfPoint[] = [];
    for (let i = 0; i + 1 < numbers.length; i += 2) {
      out.push({ x: numbers[i] ?? 0, y: numbers[i + 1] ?? 0 });
    }
    return out;
  };
  if (subtype === 'Ink') {
    return asArray(entry(objects, map, 'InkList'))
      .map((stroke) => pairs(asNumbers(resolve(objects, stroke))))
      .filter((stroke) => stroke.length > 0);
  }
  if (subtype === 'Line') {
    const line = pairs(asNumbers(entry(objects, map, 'L')));
    return line.length >= 2 ? [line.slice(0, 2)] : [];
  }
  if (subtype === 'Polygon' || subtype === 'PolyLine') {
    const vertices = pairs(asNumbers(entry(objects, map, 'Vertices')));
    return vertices.length > 0 ? [vertices] : [];
  }
  return [];
}

// ---- writing ------------------------------------------------------------------------------------

/**
 * Writes an FDF file. Object 1 is the root, the annotations follow, and the trailer names the
 * root — the shape every reader expects, with a real cross-reference table so a strict one is
 * happy too.
 */
export function writeFdf(doc: XfdfDocument): Uint8Array {
  const bodies: string[] = [];
  const annotRefs: PdfValue[] = [];
  // Object 1 is the root; the annotations start at 2 and each is written once.
  let next = 2;
  const numberByName = new Map<string, number>();
  for (const a of doc.annotations) {
    if (a.name !== null && a.name !== '' && !numberByName.has(a.name)) {
      numberByName.set(a.name, next);
    }
    annotRefs.push({ kind: 'ref', number: next, generation: 0 });
    next++;
  }

  doc.annotations.forEach((a, index) => {
    const number = index + 2;
    bodies.push(
      `${String(number)} 0 obj\n${writeValue(annotationDict(a, numberByName))}\nendobj\n`,
    );
  });

  const fieldRefs: PdfValue[] = [];
  for (const field of doc.fields) {
    fieldRefs.push({ kind: 'ref', number: next, generation: 0 });
    bodies.push(
      `${String(next)} 0 obj\n${writeValue(
        dict({ T: pdfString(field.name), V: pdfString(field.value) }),
      )}\nendobj\n`,
    );
    next++;
  }

  const root = dict({
    FDF: dict({
      F: doc.href === null || doc.href === '' ? null : pdfString(doc.href),
      ID: doc.ids ? pdfArray([hexString(doc.ids.original), hexString(doc.ids.modified)]) : null,
      Annots: annotRefs.length > 0 ? pdfArray(annotRefs) : null,
      Fields: fieldRefs.length > 0 ? pdfArray(fieldRefs) : null,
    }),
  });

  const header = '%FDF-1.2\n';
  let out = header;
  const offsets: number[] = [];
  offsets[1] = out.length;
  out += `1 0 obj\n${writeValue(root)}\nendobj\n`;
  let number = 2;
  for (const body of bodies) {
    offsets[number] = out.length;
    out += body;
    number++;
  }
  const xrefAt = out.length;
  const count = number;
  out += `xref\n0 ${String(count)}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) {
    out += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n${writeValue(dict({ Root: { kind: 'ref', number: 1, generation: 0 } }))}\n`;
  out += `startxref\n${String(xrefAt)}\n%%EOF\n`;
  return binaryToBytes(out);
}

/** A hex `/ID` half, written as the bytes it names rather than as its own text. */
function hexString(hex: string): PdfValue {
  let raw = '';
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  for (let i = 0; i + 1 < clean.length; i += 2) {
    raw += String.fromCharCode(Number.parseInt(clean.slice(i, i + 2), 16));
  }
  return pdfString(raw);
}

function annotationDict(a: XfdfAnnotation, numberByName: ReadonlyMap<string, number>): PdfValue {
  const border =
    a.borderWidth !== null || (a.dashArray && a.dashArray.length > 0)
      ? dict({
          Type: pdfName('Border'),
          W: a.borderWidth === null ? null : pdfNumber(a.borderWidth),
          S: a.dashArray && a.dashArray.length > 0 ? pdfName('D') : null,
          D: a.dashArray && a.dashArray.length > 0 ? pdfNumbers(a.dashArray) : null,
        })
      : null;
  const parent = a.inReplyTo === null ? undefined : numberByName.get(a.inReplyTo);

  const entries: Record<string, PdfValue | null> = {
    Type: pdfName('Annot'),
    Subtype: pdfName(a.subtype),
    Page: pdfNumber(a.page),
    Rect: pdfNumbers([a.rect.x0, a.rect.y0, a.rect.x1, a.rect.y1]),
    F: pdfNumber(packFlagBits(a.flags)),
    NM: a.name === null ? null : pdfString(a.name),
    Contents: a.contents === null ? null : pdfString(a.contents),
    RC: a.richContents === null ? null : pdfString(a.richContents),
    T: a.author === null ? null : pdfString(a.author),
    Subj: a.subject === null ? null : pdfString(a.subject),
    CreationDate: a.created === null ? null : stringOrNull(isoToPdfDate(a.created)),
    M: a.modified === null ? null : stringOrNull(isoToPdfDate(a.modified)),
    C: a.color === null ? null : pdfNumbers(colorComponents(a.color)),
    IC: a.interiorColor === null ? null : pdfNumbers(colorComponents(a.interiorColor)),
    CA: a.opacity === null ? null : pdfNumber(a.opacity),
    BS: border,
    BE:
      a.cloudy !== null && a.cloudy > 0 ? dict({ S: pdfName('C'), I: pdfNumber(a.cloudy) }) : null,
    QuadPoints: a.quadPoints.length > 0 ? pdfNumbers(a.quadPoints) : null,
    Name: a.icon === null ? null : pdfName(a.icon),
    State: a.state === null ? null : pdfString(a.state),
    StateModel: a.stateModel === null ? null : pdfString(a.stateModel),
    // A reference when the parent is in the same file, its `/NM` otherwise — which is what a
    // reader that meets an unresolvable reply needs in order to still thread it.
    IRT:
      a.inReplyTo === null
        ? null
        : parent === undefined
          ? pdfString(a.inReplyTo)
          : { kind: 'ref', number: parent, generation: 0 },
    RT: a.replyType === null ? null : pdfName(a.replyType),
    IT: a.intent === null ? null : pdfName(a.intent),
    DA: a.defaultAppearance === null ? null : pdfString(a.defaultAppearance),
    DS: a.defaultStyle === null ? null : pdfString(a.defaultStyle),
    Rotate: a.rotate === null ? null : pdfNumber(a.rotate),
    Q: a.align === null ? null : pdfNumber(a.align),
    CL: a.callout.length > 0 ? pdfNumbers(a.callout) : null,
    RD: a.padding.length > 0 ? pdfNumbers(a.padding) : null,
    LE:
      a.lineEndings?.length === 2
        ? pdfArray(a.lineEndings.map(pdfName))
        : a.lineEnding === null
          ? null
          : pdfName(a.lineEnding),
    FS: a.attachmentName === null ? null : pdfString(a.attachmentName),
  };

  if (a.subtype === 'Ink' && a.paths.length > 0) {
    entries['InkList'] = pdfArray(
      a.paths.map((stroke) => pdfNumbers(stroke.flatMap((p) => [p.x, p.y]))),
    );
  }
  if (a.subtype === 'Line') {
    const line = a.paths[0] ?? [];
    const start = line[0];
    const end = line[1];
    if (start && end) entries['L'] = pdfNumbers([start.x, start.y, end.x, end.y]);
  }
  if (a.subtype === 'Polygon' || a.subtype === 'PolyLine') {
    const vertices = a.paths[0] ?? [];
    if (vertices.length > 0) {
      entries['Vertices'] = pdfNumbers(vertices.flatMap((p) => [p.x, p.y]));
    }
  }
  return dict(entries);
}

function stringOrNull(value: string | null): PdfValue | null {
  return value === null ? null : pdfString(value);
}
