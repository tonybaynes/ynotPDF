/**
 * XFDF writer (M32). Pure: {@link XfdfDocument} in, UTF-8 XML text out.
 *
 * Written by hand rather than through a builder, for two reasons. The output has to be *stable* —
 * the round-trip test compares files, and a builder that reorders attributes turns that into a
 * test of the builder. And `<contents-richtext>` holds XHTML that must reach the file as markup
 * while `<contents>` beside it must reach the file as text; one escaping rule for both would
 * either break the rich text or leave the plain text unescaped.
 *
 * Attribute order follows the XFDF grammar's own listing (Adobe XFDF 3.0 / ISO 19444-1) so a
 * diff against another producer's export lines up.
 */

import {
  XFDF_ELEMENT_BY_SUBTYPE,
  type XfdfAnnotation,
  type XfdfDocument,
  type XfdfField,
} from './types';
import {
  fmt,
  fmtList,
  formatColor,
  formatFlagWords,
  formatPoints,
  formatRect,
  isoToPdfDate,
} from './values';

const NS = 'http://ns.adobe.com/xfdf/';

/** XML text escaping. `>` is escaped too: harmless, and it keeps `]]>` out of the output. */
export function escapeXmlText(value: string): string {
  return (
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // A lone carriage return would be normalised away by an XML reader, which would silently
      // change the text; as a character reference it survives.
      .replace(/\r/g, '&#13;')
  );
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

type Attrs = Array<readonly [string, string | null]>;

function attrText(attrs: Attrs): string {
  return attrs
    .filter((pair): pair is readonly [string, string] => pair[1] !== null && pair[1] !== '')
    .map(([name, value]) => ` ${name}="${escapeXmlAttribute(value)}"`)
    .join('');
}

/** Serialises a whole exchange file. The result is UTF-8 text with the declaration on line 1. */
export function writeXfdf(doc: XfdfDocument): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<xfdf xmlns="${NS}" xml:space="preserve">`);
  if (doc.href !== null && doc.href !== '') {
    lines.push(`  <f${attrText([['href', doc.href]])}/>`);
  }
  if (doc.ids) {
    lines.push(
      `  <ids${attrText([
        ['original', doc.ids.original],
        ['modified', doc.ids.modified],
      ])}/>`,
    );
  }
  if (doc.annotations.length > 0) {
    lines.push('  <annots>');
    for (const a of doc.annotations) lines.push(...annotationLines(a, '    '));
    lines.push('  </annots>');
  }
  if (doc.fields.length > 0) {
    lines.push('  <fields>');
    for (const field of doc.fields) lines.push(...fieldLines(field, '    '));
    lines.push('  </fields>');
  }
  lines.push('</xfdf>');
  return `${lines.join('\n')}\n`;
}

function fieldLines(field: XfdfField, indent: string): string[] {
  return [
    `${indent}<field${attrText([['name', field.name]])}>`,
    `${indent}  <value>${escapeXmlText(field.value)}</value>`,
    `${indent}</field>`,
  ];
}

function annotationLines(a: XfdfAnnotation, indent: string): string[] {
  const element = XFDF_ELEMENT_BY_SUBTYPE[a.subtype] ?? a.subtype.toLowerCase();
  const isStamp = a.subtype === 'Stamp';
  const attrs: Attrs = [
    ['page', String(a.page)],
    ['rect', formatRect(a.rect)],
    ['color', a.color === null ? null : formatColor(a.color)],
    ['interior-color', a.interiorColor === null ? null : formatColor(a.interiorColor)],
    ['opacity', a.opacity === null ? null : fmt(a.opacity)],
    ['flags', formatFlagWords(a.flags)],
    ['date', isoToPdfDate(a.modified)],
    ['creationdate', isoToPdfDate(a.created)],
    ['name', a.name],
    ['title', a.author],
    ['subject', a.subject],
    ['width', a.borderWidth === null ? null : fmt(a.borderWidth)],
    ['intent', a.intent],
    ['rotation', a.rotate === null ? null : fmt(a.rotate)],
    ['justification', a.align === null ? null : fmt(a.align)],
    ['state', a.state],
    ['statemodel', a.stateModel],
    ['inreplyto', a.inReplyTo],
    ['replyType', a.replyType],
    ['coords', a.quadPoints.length > 0 ? fmtList(a.quadPoints) : null],
    ['callout', a.callout.length > 0 ? fmtList(a.callout) : null],
    ['fringe', a.padding.length > 0 ? fmtList(a.padding) : null],
    ['dashes', a.dashArray && a.dashArray.length > 0 ? fmtList(a.dashArray) : null],
    ['file', a.attachmentName],
  ];

  // A stamp is exported *by reference*: its name, never its picture. An export that carried the
  // appearance would be a copy of the artwork in every file it touched.
  if (isStamp) attrs.push(['icon', a.icon], ['name', a.name]);
  else if (a.icon !== null) attrs.push(['icon', a.icon]);

  const heads = a.lineEndings;
  if (heads?.length === 2) {
    attrs.push(['head', heads[0] ?? null], ['tail', heads[1] ?? null]);
  } else if (a.lineEnding !== null) {
    attrs.push(['head', a.lineEnding]);
  }

  if (a.subtype === 'Line') {
    const line = a.paths[0] ?? [];
    const start = line[0];
    const end = line[1];
    if (start && end) {
      attrs.push(['start', `${fmt(start.x)},${fmt(start.y)}`]);
      attrs.push(['end', `${fmt(end.x)},${fmt(end.y)}`]);
    }
  } else if (a.subtype === 'Polygon' || a.subtype === 'PolyLine') {
    const vertices = a.paths[0] ?? [];
    if (vertices.length > 0) attrs.push(['vertices', formatPoints(vertices)]);
  }

  const children: string[] = [];
  if (a.contents !== null) {
    children.push(`${indent}  <contents>${escapeXmlText(a.contents)}</contents>`);
  }
  if (a.richContents !== null) {
    // Markup, not text: `/RC` is an XHTML fragment and escaping it would show the tags.
    children.push(`${indent}  <contents-richtext>${a.richContents}</contents-richtext>`);
  }
  if (a.defaultAppearance !== null) {
    children.push(
      `${indent}  <defaultappearance>${escapeXmlText(a.defaultAppearance)}</defaultappearance>`,
    );
  }
  if (a.defaultStyle !== null) {
    children.push(`${indent}  <defaultstyle>${escapeXmlText(a.defaultStyle)}</defaultstyle>`);
  }
  if (a.cloudy !== null && a.cloudy > 0) {
    children.push(
      `${indent}  <border-effect${attrText([
        ['style', 'C'],
        ['intensity', fmt(a.cloudy)],
      ])}/>`,
    );
  }
  if (a.subtype === 'Ink' && a.paths.length > 0) {
    children.push(`${indent}  <inklist>`);
    for (const gesture of a.paths) {
      children.push(`${indent}    <gesture>${formatPoints(gesture)}</gesture>`);
    }
    children.push(`${indent}  </inklist>`);
  }

  const open = `${indent}<${element}${attrText(attrs)}`;
  if (children.length === 0) return [`${open}/>`];
  return [`${open}>`, ...children, `${indent}</${element}>`];
}
