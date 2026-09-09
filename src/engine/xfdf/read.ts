/**
 * XFDF reader (M32). Pure: text in, {@link XfdfDocument} out.
 *
 * Written against the XFDF grammar (Adobe XFDF 3.0, now ISO 19444-1) rather than against any one
 * producer, then checked against what Acrobat and Foxit actually emit — which differ in three
 * places the spec leaves room in, and all three are handled here rather than in the caller:
 *
 * - **Coordinates** appear as `x,y;x,y` (the spec), and as one flat comma-separated list.
 * - **A note's icon** is `icon="Comment"` in both, but a stamp's name is `icon=` in one and
 *   `name=` in the other — and `name` is *also* `/NM`. A stamp takes `icon` when it has one and
 *   only then falls back, which keeps `/NM` intact.
 * - **Rich text** is a `<contents-richtext>` element in the spec and, in older exports, a
 *   `richtext` attribute. Both are read; the element wins.
 *
 * Anything the reader does not recognise is skipped, never thrown: an export from a tool we have
 * not seen should still bring in the comments it names in the ordinary way.
 */

import { XMLParser } from 'fast-xml-parser';
import type { AnnotationSubtype } from '@engine/PdfEngine';
import {
  EMPTY_XFDF_ANNOTATION,
  XfdfError,
  XFDF_SUBTYPE_BY_ELEMENT,
  type XfdfAnnotation,
  type XfdfDocument,
  type XfdfField,
} from './types';
import {
  num,
  numberList,
  parseColor,
  parseFlagWords,
  parsePoints,
  parseRect,
  pdfDateToIso,
} from './values';

/** Attribute prefix the parser uses, kept short and distinctive. */
const ATTR = '@';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR,
  // Element names keep their case in the file but are matched lower-case: `<Highlight>` from a
  // producer that ignored the spec's casing still reads.
  transformTagName: (name) => name.toLowerCase().replace(/^.*:/, ''),
  transformAttributeName: (name) => name.toLowerCase().replace(/^.*:/, ''),
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  textNodeName: '#text',
  // Rich text is XHTML inside the XFDF; keeping it as a string is the only way to hand it on
  // unharmed, and `/RC` wants the markup rather than the words.
  stopNodes: ['*.contents-richtext'],
  // Elements repeat and attributes do not, so only elements are forced into arrays — otherwise
  // every attribute arrives as a one-item list and nothing reads.
  isArray: (_name, _path, _leaf, isAttribute) => !isAttribute,
});

type Node = Record<string, unknown>;

/** Every child of `parent` called `name`, whatever shape the parser gave them. */
function children(parent: unknown, name: string): unknown[] {
  if (!parent || typeof parent !== 'object') return [];
  const value = (parent as Node)[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function nodes(parent: unknown, name: string): Node[] {
  return children(parent, name).filter((v): v is Node => !!v && typeof v === 'object');
}

/** The one child called `name`, for the elements that appear at most once. */
function child(parent: unknown, name: string): Node | null {
  return nodes(parent, name)[0] ?? null;
}

function attr(node: Node, name: string): string | null {
  const value = node[`${ATTR}${name}`];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** A child element's text: the parser gives a bare string when the element has no attributes. */
function childText(node: Node, name: string): string | null {
  const first = children(node, name)[0];
  if (first === undefined) return null;
  if (typeof first === 'string') return first;
  if (typeof first === 'number' || typeof first === 'boolean') return String(first);
  if (first && typeof first === 'object') {
    const text = (first as Node)['#text'];
    if (typeof text === 'string') return text;
    if (typeof text === 'number') return String(text);
    return '';
  }
  return null;
}

/** The raw markup of a stop-node child (`<contents-richtext>`). */
function childMarkup(node: Node, name: string): string | null {
  return childText(node, name);
}

/** One `<gesture>`, which the parser gives as a bare string or as a node with a text child. */
function gestureText(gesture: unknown): string {
  if (typeof gesture === 'string') return gesture;
  if (!gesture || typeof gesture !== 'object') return '';
  const text = (gesture as Node)['#text'];
  return typeof text === 'string' ? text : '';
}

/**
 * Reads an XFDF file. Throws {@link XfdfError} only when the input is not XFDF at all — a file
 * with no comments in it is an empty result, which is a legitimate thing to import.
 */
export function readXfdf(source: string): XfdfDocument {
  let parsed: unknown;
  try {
    parsed = parser.parse(source);
  } catch (error) {
    throw new XfdfError('malformed', `This XFDF file could not be read: ${String(error)}`);
  }
  const doc = child(parsed, 'xfdf');
  if (!doc) throw new XfdfError('not-xfdf', 'This file is not an XFDF comment file');

  const fNode = child(doc, 'f');
  const href = fNode ? attr(fNode, 'href') : null;

  const idNode = child(doc, 'ids');
  const ids = idNode
    ? {
        original: attr(idNode, 'original') ?? '',
        modified: attr(idNode, 'modified') ?? '',
      }
    : null;

  const annotations: XfdfAnnotation[] = [];
  for (const annots of nodes(doc, 'annots')) {
    for (const [element, subtype] of Object.entries(XFDF_SUBTYPE_BY_ELEMENT)) {
      for (const node of nodes(annots, element)) {
        annotations.push(readAnnotation(node, subtype));
      }
    }
  }
  // The file's own order is what a reader expects to see, and the loop above walked it by
  // element. Sorting by page then by the order each was found keeps a mixed export sensible.
  annotations.sort((a, b) => a.page - b.page);

  const fields: XfdfField[] = [];
  for (const group of nodes(doc, 'fields')) readFields(group, '', fields);

  return { href, ids, annotations, fields };
}

/** `<fields>` nests: a `<field name="a">` may hold `<field name="b">` as well as a `<value>`. */
function readFields(node: Node, prefix: string, out: XfdfField[]): void {
  for (const field of nodes(node, 'field')) {
    const own = attr(field, 'name') ?? '';
    const name = prefix === '' ? own : `${prefix}.${own}`;
    const value = childText(field, 'value');
    if (value !== null) out.push({ name, value });
    readFields(field, name, out);
  }
}

function readAnnotation(node: Node, subtype: AnnotationSubtype): XfdfAnnotation {
  const rect = parseRect(attr(node, 'rect')) ?? EMPTY_XFDF_ANNOTATION.rect;
  const flagsAttr = attr(node, 'flags');
  const iconAttr = attr(node, 'icon');
  const nameAttr = attr(node, 'name');
  // `name` is `/NM` everywhere except on a stamp with no `icon`, where a couple of producers put
  // the stamp's own name in it. Guessing wrong loses either the identity or the picture; the
  // rule below loses neither, because a stamp that has `icon` keeps `name` as its `/NM`.
  const isStampName = subtype === 'Stamp' && iconAttr === null;

  const contents = childText(node, 'contents');
  const rich = childMarkup(node, 'contents-richtext') ?? attr(node, 'richtext');

  const paths = readPaths(node, subtype);
  const dash = numberList(attr(node, 'dashes'));
  const lineEndings = readLineEndings(node);

  return {
    ...EMPTY_XFDF_ANNOTATION,
    subtype,
    page: Math.max(0, Math.trunc(num(attr(node, 'page')) ?? 0)),
    rect,
    name: isStampName ? null : nameAttr,
    contents: contents === null || contents === '' ? null : contents,
    richContents: rich === null || rich === '' ? null : rich,
    author: attr(node, 'title'),
    subject: attr(node, 'subject'),
    created: pdfDateToIso(attr(node, 'creationdate')),
    modified: pdfDateToIso(attr(node, 'date')),
    color: parseColor(attr(node, 'color')),
    interiorColor: parseColor(attr(node, 'interior-color') ?? attr(node, 'interiorcolor')),
    opacity: num(attr(node, 'opacity')),
    borderWidth: num(attr(node, 'width')),
    flags: flagsAttr === null ? EMPTY_XFDF_ANNOTATION.flags : parseFlagWords(flagsAttr),
    quadPoints: numberList(attr(node, 'coords')),
    paths,
    icon: isStampName ? nameAttr : iconAttr,
    state: attr(node, 'state'),
    stateModel: attr(node, 'statemodel'),
    inReplyTo: attr(node, 'inreplyto'),
    replyType: attr(node, 'replytype'),
    intent: attr(node, 'intent') ?? attr(node, 'it'),
    defaultAppearance: childText(node, 'defaultappearance'),
    defaultStyle: childText(node, 'defaultstyle'),
    rotate: num(attr(node, 'rotation')),
    align: num(attr(node, 'justification')),
    callout: numberList(attr(node, 'callout')),
    padding: numberList(attr(node, 'fringe')),
    lineEnding: lineEndings === null ? attr(node, 'head') : null,
    lineEndings,
    dashArray: dash.length > 0 ? dash : null,
    cloudy: readCloudy(node),
    attachmentName: attr(node, 'file'),
  };
}

/** Ink gestures, a polygon's vertices, or a line's two ends — whichever the subtype has. */
function readPaths(node: Node, subtype: AnnotationSubtype): Array<Array<{ x: number; y: number }>> {
  if (subtype === 'Ink') {
    const out: Array<Array<{ x: number; y: number }>> = [];
    for (const list of nodes(node, 'inklist')) {
      for (const gesture of children(list, 'gesture')) {
        const points = parsePoints(gestureText(gesture));
        if (points.length > 0) out.push(points);
      }
      // A producer that wrote the gestures as text straight inside `<inklist>`.
      const inline = list['#text'];
      if (out.length === 0 && typeof inline === 'string' && inline.trim() !== '') {
        const points = parsePoints(inline);
        if (points.length > 0) out.push(points);
      }
    }
    return out;
  }
  if (subtype === 'Line') {
    const start = parsePoints(attr(node, 'start'));
    const end = parsePoints(attr(node, 'end'));
    const first = start[0];
    const second = end[0];
    if (first && second) return [[first, second]];
    const flat = parsePoints(attr(node, 'vertices'));
    return flat.length >= 2 ? [flat.slice(0, 2)] : [];
  }
  if (subtype === 'Polygon' || subtype === 'PolyLine') {
    const points = parsePoints(attr(node, 'vertices'));
    return points.length > 0 ? [points] : [];
  }
  return [];
}

/** `head`/`tail` are the two ends of a line; a callout writes only `head`. */
function readLineEndings(node: Node): string[] | null {
  const head = attr(node, 'head');
  const tail = attr(node, 'tail');
  if (head !== null && tail !== null) return [head, tail];
  return null;
}

/** `<border-effect style="C" intensity="2"/>`, or the `intensity` attribute some producers use. */
function readCloudy(node: Node): number | null {
  for (const effect of nodes(node, 'border-effect')) {
    const style = attr(effect, 'style');
    const intensity = num(attr(effect, 'intensity'));
    if (style?.toUpperCase() === 'C') return intensity ?? 1;
  }
  const direct = num(attr(node, 'intensity'));
  return direct !== null && direct > 0 ? direct : null;
}
