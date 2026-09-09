/**
 * `ModelAnnotation` ↔ {@link XfdfAnnotation} (M32). Pure, and the only file that knows how the
 * document model spells any of what an exchange file carries.
 *
 * Two asymmetries are worth stating, because they are where a round-trip could quietly lose
 * something:
 *
 * - **The model names its parent by model id; a file names it by `/NM`.** Exporting looks the
 *   parent's `/NM` up through a callback; importing leaves the name in place and the caller
 *   resolves it once every annotation exists, because a file may list a reply before its target.
 * - **The model keeps the `extra` bag; the file keeps named attributes.** Every key that has a
 *   mapping in `engine/appearance/dict.ts` is carried across by name, and one that has no mapping
 *   is dropped rather than guessed at — the same closed-list rule the writer follows.
 */

import type { ModelAnnotation, AnnotationPatch } from '@core/model';
import type { ModelId } from '@core/Ids';
import type { PdfPoint } from '@shared/pdf';
import { EMPTY_XFDF_ANNOTATION, type XfdfAnnotation } from './types';
import { num } from './values';

/** What the model holds beside the annotation itself when one is being exported. */
export interface ExportContext {
  /** 0-based page number of the annotation's page. */
  readonly page: (a: ModelAnnotation) => number;
  /** The `/NM` of another annotation, for `/IRT`. */
  readonly nameOf: (id: ModelId) => string | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function numbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : [];
}

function names(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((n): n is string => typeof n === 'string');
  return list.length === value.length && list.length === 2 ? list : null;
}

/** The geometry an annotation carries, whichever family it is. */
function pathsOf(a: ModelAnnotation): ReadonlyArray<ReadonlyArray<PdfPoint>> {
  if (a.family === 'ink') return a.paths;
  if (a.family === 'shape') return a.vertices.length > 0 ? [a.vertices] : [];
  return [];
}

/** One model annotation as an exchange record. */
export function toXfdf(a: ModelAnnotation, ctx: ExportContext): XfdfAnnotation {
  const extra = a.extra;
  const quadPoints =
    a.family === 'markup' || a.family === 'link' ? a.quadPoints : EMPTY_XFDF_ANNOTATION.quadPoints;
  const cloudy = num(extra['cloudy']);
  const dash = numbers(extra['dashArray']);
  return {
    subtype: a.subtype,
    page: ctx.page(a),
    rect: a.rect,
    name: a.name,
    contents: a.contents,
    richContents: a.family === 'freeText' ? a.richContents : str(extra['richContents']),
    author: a.author,
    subject: a.subject,
    created: a.created,
    modified: a.modified,
    color: a.color,
    interiorColor: a.interiorColor,
    opacity: a.opacity,
    borderWidth: a.borderWidth,
    flags: a.flags,
    quadPoints,
    paths: pathsOf(a),
    icon: 'icon' in a ? (a.icon ?? str(extra['icon'])) : str(extra['icon']),
    state: a.state,
    stateModel: str(extra['stateModel']),
    inReplyTo: a.inReplyTo === null ? null : ctx.nameOf(a.inReplyTo),
    replyType: str(extra['replyType']),
    intent: str(extra['intent']),
    defaultAppearance: str(extra['defaultAppearance']),
    defaultStyle: str(extra['defaultStyle']),
    rotate: num(extra['rotate']),
    align: num(extra['align']),
    callout: numbers(extra['callout']),
    padding: numbers(extra['padding']),
    lineEnding: str(extra['lineEnding']),
    lineEndings: names(extra['lineEndings']),
    dashArray: dash.length > 0 ? dash : null,
    cloudy: cloudy !== null && cloudy > 0 ? cloudy : null,
    attachmentName: str(extra['attachmentName']),
  };
}

/**
 * The `extra` bag an exchange record implies. Only keys the record actually carries are set, so
 * an import over an existing annotation does not clear properties the file said nothing about.
 */
export function extraFrom(a: XfdfAnnotation): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (a.icon !== null) extra['icon'] = a.icon;
  if (a.stateModel !== null) extra['stateModel'] = a.stateModel;
  if (a.replyType !== null) extra['replyType'] = a.replyType;
  if (a.intent !== null) extra['intent'] = a.intent;
  if (a.defaultAppearance !== null) extra['defaultAppearance'] = a.defaultAppearance;
  if (a.defaultStyle !== null) extra['defaultStyle'] = a.defaultStyle;
  if (a.richContents !== null) extra['richContents'] = a.richContents;
  if (a.rotate !== null) extra['rotate'] = a.rotate;
  if (a.align !== null) extra['align'] = a.align;
  if (a.callout.length > 0) extra['callout'] = [...a.callout];
  if (a.padding.length > 0) extra['padding'] = [...a.padding];
  if (a.lineEnding !== null) extra['lineEnding'] = a.lineEnding;
  if (a.lineEndings) extra['lineEndings'] = [...a.lineEndings];
  if (a.dashArray) extra['dashArray'] = [...a.dashArray];
  if (a.cloudy !== null) extra['cloudy'] = a.cloudy;
  if (a.attachmentName !== null) extra['attachmentName'] = a.attachmentName;
  return extra;
}

/**
 * An exchange record as a patch over an existing annotation, or as the body of a new one. The
 * caller supplies id, pageId and family; everything here is subtype-agnostic on purpose, because
 * `AnnotationPatch` is exactly the shape that can carry any family's geometry.
 */
export function patchFrom(a: XfdfAnnotation): AnnotationPatch {
  const geometry: {
    quadPoints?: ReadonlyArray<number>;
    paths?: ReadonlyArray<ReadonlyArray<PdfPoint>>;
    vertices?: ReadonlyArray<PdfPoint>;
  } = {};
  if (a.quadPoints.length > 0) geometry.quadPoints = [...a.quadPoints];
  if (a.subtype === 'Ink') geometry.paths = a.paths.map((p) => [...p]);
  else if (a.paths.length > 0) geometry.vertices = [...(a.paths[0] ?? [])];

  return {
    rect: a.rect,
    flags: a.flags,
    contents: a.contents,
    author: a.author,
    subject: a.subject,
    created: a.created,
    modified: a.modified,
    color: a.color,
    interiorColor: a.interiorColor,
    opacity: a.opacity,
    borderWidth: a.borderWidth,
    name: a.name,
    state: a.state,
    ...(a.icon === null ? {} : { icon: a.icon }),
    ...(a.richContents === null ? {} : { richContents: a.richContents }),
    extra: extraFrom(a),
    ...geometry,
  };
}
