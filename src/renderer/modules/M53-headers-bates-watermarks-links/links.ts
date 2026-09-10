/**
 * What a link *is*, in the model (M53, ADR 0020 §5).
 *
 * A link is an ordinary annotation of subtype `Link`, so M20's own add / update / delete commands
 * do all the work and nothing new is undoable here. What is new is the shape of its action, which
 * lives in `Annotation.extra` under two keys:
 *
 * - `linkAction` — the whole `/A` dictionary in model terms: a URL, a page of another file, a
 *   file to open. `engine/appearance/dict.ts` encodes it; the writer writes it.
 * - `linkDest` — a destination *inside this document*, which cannot be an `/A` because a
 *   destination names a page **object** and the plan carries values, not references. M21's plan
 *   turns the model page id here into `PlannedAnnotation.dest`.
 *
 * Everything in this file is pure.
 */

import type { ModelId } from '@core/Ids';
import type { ModelAnnotation } from '@core/model';
import type { Destination } from '@engine/PdfEngine';

/** What following a link does. */
export type LinkAction =
  | { readonly kind: 'none' }
  /** A web address, or anything else with a scheme. Only `http(s)` is ever actually opened. */
  | { readonly kind: 'uri'; readonly uri: string }
  /** A page of this document. */
  | { readonly kind: 'page'; readonly page: ModelId; readonly fit: Destination['fit'] }
  /** A page of another PDF. */
  | { readonly kind: 'file'; readonly path: string; readonly page: number }
  /** Any file, handed to the operating system. */
  | { readonly kind: 'open'; readonly path: string };

/** How a link is drawn by a viewer that draws links at all. */
export interface LinkBorder {
  /** 0 hides the border, which is what "invisible rectangle" means. */
  readonly width: number;
  readonly style: 'solid' | 'dashed' | 'underline';
  /** `0xRRGGBB`. */
  readonly colour: number;
  /** `/H`: what happens while the link is held down. */
  readonly highlight: 'none' | 'invert' | 'outline' | 'push';
}

export const DEFAULT_BORDER: LinkBorder = {
  width: 0,
  style: 'solid',
  colour: 0x0000ff,
  highlight: 'invert',
};

/** A link as the module works with it: a model annotation plus what it means. */
export interface LinkInfo {
  readonly id: ModelId;
  readonly pageId: ModelId;
  /** 0-based page index at the time it was read. */
  readonly page: number;
  readonly rect: ModelAnnotation['rect'];
  readonly action: LinkAction;
  readonly border: LinkBorder;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const FITS = new Set<string>(['xyz', 'fit', 'fitH', 'fitV', 'fitR', 'fitB', 'fitBH', 'fitBV']);

/** The action stored on an annotation, validated. */
export function readAction(extra: Readonly<Record<string, unknown>>): LinkAction {
  const dest = extra['linkDest'];
  if (isRecord(dest) && typeof dest['page'] === 'string') {
    const fit = typeof dest['fit'] === 'string' && FITS.has(dest['fit']) ? dest['fit'] : 'fit';
    return { kind: 'page', page: dest['page'] as ModelId, fit: fit as Destination['fit'] };
  }
  const action = extra['linkAction'];
  if (!isRecord(action)) return { kind: 'none' };
  switch (action['kind']) {
    case 'uri':
      return typeof action['uri'] === 'string' && action['uri'] !== ''
        ? { kind: 'uri', uri: action['uri'] }
        : { kind: 'none' };
    case 'file':
      return typeof action['path'] === 'string' && action['path'] !== ''
        ? {
            kind: 'file',
            path: action['path'],
            page: typeof action['page'] === 'number' ? Math.max(0, action['page']) : 0,
          }
        : { kind: 'none' };
    case 'open':
      return typeof action['path'] === 'string' && action['path'] !== ''
        ? { kind: 'open', path: action['path'] }
        : { kind: 'none' };
    default:
      return { kind: 'none' };
  }
}

/** The `extra` entries an action comes to. Both keys are always written, so a change clears. */
export function actionExtra(action: LinkAction): Record<string, unknown> {
  switch (action.kind) {
    case 'page':
      return { linkAction: null, linkDest: { page: action.page, fit: action.fit } };
    case 'uri':
      return { linkAction: { kind: 'uri', uri: action.uri }, linkDest: null };
    case 'file':
      return {
        linkAction: { kind: 'file', path: action.path, page: action.page },
        linkDest: null,
      };
    case 'open':
      return { linkAction: { kind: 'open', path: action.path }, linkDest: null };
    default:
      return { linkAction: null, linkDest: null };
  }
}

/** The border stored on an annotation, validated. */
export function readBorder(annotation: ModelAnnotation): LinkBorder {
  const extra = annotation.extra;
  const raw = extra['linkBorder'];
  const style = isRecord(raw) && typeof raw['style'] === 'string' ? raw['style'] : 'solid';
  const highlight =
    isRecord(raw) && typeof raw['highlight'] === 'string' ? raw['highlight'] : 'invert';
  return {
    width: annotation.borderWidth ?? DEFAULT_BORDER.width,
    style: style === 'dashed' || style === 'underline' ? style : 'solid',
    colour: annotation.color ?? DEFAULT_BORDER.colour,
    highlight:
      highlight === 'none' || highlight === 'outline' || highlight === 'push'
        ? highlight
        : 'invert',
  };
}

/** What a link does, in a sentence — the tooltip, the list, and what a screen reader says. */
export function describeAction(
  action: LinkAction,
  pageNumber: (id: ModelId) => number | null,
): string {
  switch (action.kind) {
    case 'uri':
      return `Opens ${action.uri}`;
    case 'page': {
      const number = pageNumber(action.page);
      return number === null
        ? 'Goes to a page that is no longer here'
        : `Goes to page ${String(number)}`;
    }
    case 'file':
      return `Opens page ${String(action.page + 1)} of ${action.path}`;
    case 'open':
      return `Opens ${action.path}`;
    default:
      return 'Does nothing yet';
  }
}

/** Whether a URL is one this application is willing to hand to the operating system. */
export function isFollowableUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

/** A `mailto:` link, which the reader is offered as an e-mail rather than refused outright. */
export function isMailto(uri: string): boolean {
  return /^mailto:/i.test(uri);
}
