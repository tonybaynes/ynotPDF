/**
 * The document's annotations as a review thread (M32). Pure: model annotations in, comment
 * entries out, nothing touched.
 *
 * Three things here are decisions rather than transcription.
 *
 * **A status is history, not a field.** ISO 32000-1 12.5.6.4 has a status set by a *reply*
 * carrying `/State` and `/StateModel`, not by writing over the comment. So a comment's current
 * status is the state of its newest status reply, and the older ones stay in the file as the
 * record of who set what and when — which is what a reviewer is actually asking when they ask
 * "who rejected this?". Acrobat and Foxit both work this way.
 *
 * **A status reply is not a comment.** A reply that carries a `/State` and no text is a status
 * change; it shows in the thread as one line saying who set what, and never as an empty note.
 *
 * **The checkmark is the `/Marked` state model**, which is a per-reader flag rather than a review
 * decision — Foxit and Acrobat both keep it separate from the five review states, and so do we.
 */

import type { ModelId } from '@core/Ids';
import type { ModelAnnotation } from '@core/model';
import type { PdfPoint } from '@shared/pdf';
import { REVIEW_MODEL, MARKED_MODEL, MARKED_ON, statusOf, type StatusId } from './status';

/** A comment or a reply, as the panel and the summary both want it. */
export interface CommentEntry {
  readonly id: ModelId;
  readonly pageId: ModelId;
  /** 0-based page index. */
  readonly page: number;
  readonly subtype: ModelAnnotation['subtype'];
  /** The kind in words: "Highlight", "Sticky note", "Callout". */
  readonly type: string;
  readonly author: string;
  /** ISO 8601, or null. */
  readonly created: string | null;
  readonly modified: string | null;
  readonly text: string;
  /** The comment's own colour, `0xRRGGBB`, or null. */
  readonly color: number | null;
  /** Where the comment sits on its page, for "jump to" and for the summary's connector. */
  readonly anchor: PdfPoint;
  /** The current review status; `'none'` when nobody has set one. */
  readonly status: StatusId;
  /** Who set the current status, when someone did. */
  readonly statusBy: string | null;
  /** The `/Marked` checkmark. */
  readonly checked: boolean;
  /** The state this entry itself set, when it is a status reply. */
  readonly setsStatus: StatusId | null;
  readonly replies: ReadonlyArray<CommentEntry>;
  /** True for a reply that only carries a status — shown as a line, never as an empty note. */
  readonly isStatusOnly: boolean;
}

/** Annotation subtypes that are never comments: they are page furniture or form plumbing. */
const NOT_A_COMMENT = new Set(['Popup', 'Widget', 'Link', 'Screen', 'Movie', 'PrinterMark']);

/** Whether an annotation belongs in the Comments panel at all. */
export function isComment(a: ModelAnnotation): boolean {
  return !NOT_A_COMMENT.has(a.subtype);
}

const TYPE_WORDS: Readonly<Record<string, string>> = {
  Highlight: 'Highlight',
  Underline: 'Underline',
  Squiggly: 'Squiggly',
  StrikeOut: 'Strikeout',
  Text: 'Sticky note',
  FreeText: 'Text box',
  Caret: 'Inserted text',
  Square: 'Rectangle',
  Circle: 'Oval',
  Line: 'Line',
  Polygon: 'Polygon',
  PolyLine: 'Polyline',
  Ink: 'Pencil',
  Stamp: 'Stamp',
  FileAttachment: 'Attachment',
  Sound: 'Sound',
  Redact: 'Redaction',
};

/**
 * The kind of comment in words, refined by `/IT` where that is what tells two apart: a typewriter
 * from a callout, an arrow from a line, an area highlight from a text one.
 */
export function typeOf(a: ModelAnnotation): string {
  const intent = typeof a.extra['intent'] === 'string' ? a.extra['intent'] : '';
  switch (intent) {
    case 'FreeTextCallout':
      return 'Callout';
    case 'FreeTextTypewriter':
      return 'Typewriter';
    case 'LineArrow':
      return 'Arrow';
    case 'PolygonCloud':
      return 'Cloud';
    case 'AreaHighlight':
      return 'Area highlight';
    case 'Replace':
      return 'Replaced text';
    default:
      break;
  }
  return TYPE_WORDS[a.subtype] ?? a.subtype;
}

/** The point a comment is anchored to: the top-left of its rectangle, which is where it reads. */
export function anchorOf(a: ModelAnnotation): PdfPoint {
  return { x: a.rect.x0, y: a.rect.y1 };
}

/** The words a comment shows in the list: its text, or its type when it has none. */
export function textOf(a: ModelAnnotation): string {
  return (a.contents ?? '').trim();
}

/** The state model an annotation's `/State` belongs to; `/Review` when the file does not say. */
function modelOf(a: ModelAnnotation): string {
  const value = a.extra['stateModel'];
  return typeof value === 'string' && value !== '' ? value : REVIEW_MODEL;
}

/** Sorts by date, oldest first; an entry with no date sorts before one that has one. */
function byDate(a: ModelAnnotation, b: ModelAnnotation): number {
  const left = a.created ?? a.modified ?? '';
  const right = b.created ?? b.modified ?? '';
  return left.localeCompare(right);
}

/**
 * Builds the comment threads for a set of annotations.
 *
 * `pageIndex` gives the 0-based position of a page id — the panel is ordered by page, and the
 * model holds page *ids* so that reordering pages does not move an annotation.
 */
export function buildComments(
  annotations: ReadonlyArray<ModelAnnotation>,
  pageIndex: (pageId: ModelId) => number,
): CommentEntry[] {
  const comments = annotations.filter(isComment);
  const repliesBy = new Map<ModelId, ModelAnnotation[]>();
  const byId = new Map<ModelId, ModelAnnotation>();
  for (const a of comments) byId.set(a.id, a);
  const roots: ModelAnnotation[] = [];
  for (const a of comments) {
    // A reply whose target is gone is a comment in its own right rather than an orphan nobody
    // can see — losing it because its parent was deleted would be the worse failure.
    if (a.inReplyTo !== null && byId.has(a.inReplyTo)) {
      const list = repliesBy.get(a.inReplyTo) ?? [];
      list.push(a);
      repliesBy.set(a.inReplyTo, list);
    } else {
      roots.push(a);
    }
  }

  /**
   * A thread is flat. `/IRT` may chain — a reply to a reply to a comment — but every reader
   * shows one thread per comment, and a nested indent that can go five deep is unreadable at a
   * panel's width. So the whole subtree under a comment becomes its replies, in date order.
   */
  const descendants = (root: ModelId): ModelAnnotation[] => {
    const out: ModelAnnotation[] = [];
    const queue = [...(repliesBy.get(root) ?? [])];
    const seen = new Set<ModelId>([root]);
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next || seen.has(next.id)) continue;
      seen.add(next.id);
      out.push(next);
      queue.push(...(repliesBy.get(next.id) ?? []));
    }
    return out.sort(byDate);
  };

  const entryOf = (
    a: ModelAnnotation,
    depth: number,
    status: StatusId,
    statusBy: string | null,
    checked: boolean,
    replies: ReadonlyArray<CommentEntry>,
  ): CommentEntry => {
    const own = statusOf(a.state, modelOf(a));
    const author = (a.author ?? '').trim();
    return {
      id: a.id,
      pageId: a.pageId,
      page: pageIndex(a.pageId),
      subtype: a.subtype,
      type: typeOf(a),
      author: author === '' ? 'Unknown author' : author,
      created: a.created,
      modified: a.modified,
      text: textOf(a),
      color: a.color,
      anchor: anchorOf(a),
      status,
      statusBy,
      checked,
      setsStatus: depth > 0 ? own : null,
      replies,
      isStatusOnly: depth > 0 && own !== null && (a.contents ?? '').trim() === '',
    };
  };

  const build = (a: ModelAnnotation): CommentEntry => {
    const children = descendants(a.id);
    // The current status is the newest one set anywhere in the thread — by a reply, or by the
    // comment itself when a file wrote it there. `/Marked` is the reader's checkmark, not a
    // review decision, so it is tracked separately.
    let status: StatusId = 'none';
    let statusBy: string | null = null;
    let checked = false;
    for (const entry of [a, ...children]) {
      if (modelOf(entry) === MARKED_MODEL) {
        checked = entry.state === MARKED_ON;
        continue;
      }
      const review = statusOf(entry.state, modelOf(entry));
      if (review !== null) {
        status = review;
        statusBy = (entry.author ?? '').trim() === '' ? null : entry.author;
      }
    }
    const replies = children.map((child) =>
      entryOf(child, 1, statusOf(child.state, modelOf(child)) ?? 'none', child.author, false, []),
    );
    return entryOf(a, 0, status, statusBy, checked, replies);
  };

  return roots
    .map(build)
    .sort((a, b) => a.page - b.page || b.anchor.y - a.anchor.y || a.anchor.x - b.anchor.x);
}

/** Every entry in a thread — the comment and its replies — for counting and searching. */
export function flattenThread(entry: CommentEntry): CommentEntry[] {
  return [entry, ...entry.replies];
}
