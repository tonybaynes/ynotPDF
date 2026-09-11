/**
 * What a link *is*, in the model (M53, ADR 0020 §5).
 *
 * A link is an ordinary annotation of subtype `Link`, so M20's own add / update / delete commands
 * do all the work and nothing new is undoable here. What is new is the shape of its action, which
 * lives in `Annotation.extra` under two keys:
 *
 * `linkActionJson` — the whole action as JSON. It is one string on purpose: PDFium creates a
 * Link annotation but has no `/A` setter, so anything held only in the model is lost the moment
 * the page is read again. A string PDFium *can* write survives, and it is also what makes a link
 * this application wrote editable in a file opened a year later.
 *
 * M21's plan turns that JSON into the `/A` dictionary the file wants, and — for a destination
 * inside this document, which names a page **object** rather than a value — into
 * `PlannedAnnotation.dest`.
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

/** A link as the module works with it: where it is, what it does, and how it is drawn. */
export interface LinkInfo {
  /** Identity for the overlay and the panel: the model id when there is one, else `e<page>.<n>`. */
  readonly id: string;
  /**
   * The model annotation behind it, when the page's annotations have been read.
   *
   * A file's own links are visible and followable from `PdfEngine.links` alone, which costs
   * nothing and changes nothing. Editing one needs a model annotation, and that needs the page
   * loaded — which the link tool does when it is chosen, because by then the reader has asked to
   * work on links (M53).
   */
  readonly modelId: ModelId | null;
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
  const json = extra['linkActionJson'];
  if (typeof json !== 'string' || json === '') return { kind: 'none' };
  let action: unknown;
  try {
    action = JSON.parse(json);
  } catch {
    return { kind: 'none' };
  }
  return parseAction(action);
}

/** One action value, validated. Exported so M21's plan reads it exactly as the module does. */
export function parseAction(action: unknown): LinkAction {
  if (!isRecord(action)) return { kind: 'none' };
  switch (action['kind']) {
    case 'page': {
      const page = action['page'];
      if (typeof page !== 'string' || page === '') return { kind: 'none' };
      const fit =
        typeof action['fit'] === 'string' && FITS.has(action['fit']) ? action['fit'] : 'fit';
      return { kind: 'page', page: page as ModelId, fit: fit as Destination['fit'] };
    }
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

/**
 * The `extra` entry an action comes to. An empty string is a removal, which is what "this link
 * does nothing" has to say: a key left behind would outlive the action the reader cleared.
 */
export function actionExtra(action: LinkAction): Record<string, unknown> {
  return { linkActionJson: action.kind === 'none' ? '' : JSON.stringify(action) };
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
