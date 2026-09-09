/**
 * Filtering, sorting, grouping and searching, as one pure function (M32).
 *
 * The panel is a virtualised list, which means it has to be able to ask "what is at index 412?"
 * without building any DOM — so the whole visible structure is computed here as a flat array of
 * rows, and the list only ever maps an index to one of them. That also makes every rule in the
 * panel — which comments a filter keeps, what a search matches, how a group is titled and counted
 * — testable without a browser.
 */

import type { ModelId } from '@core/Ids';
import type { CommentEntry } from './model';
import { STATUSES, statusLabel, type StatusId } from './status';

export type GroupBy = 'none' | 'page' | 'author' | 'type' | 'date' | 'status';
export type SortBy = 'page' | 'author' | 'date' | 'type' | 'status';
export type SortDirection = 'asc' | 'desc';

/** What the filter popover holds. `null` for a set means "every one of them". */
export interface CommentFilter {
  readonly authors: ReadonlySet<string> | null;
  readonly types: ReadonlySet<string> | null;
  readonly statuses: ReadonlySet<StatusId> | null;
  readonly checked: 'all' | 'checked' | 'unchecked';
  /** ISO dates, inclusive. */
  readonly from: string | null;
  readonly to: string | null;
}

export const ALL_COMMENTS: CommentFilter = {
  authors: null,
  types: null,
  statuses: null,
  checked: 'all',
  from: null,
  to: null,
};

/** True when the filter would keep every comment there is. */
export function isUnfiltered(filter: CommentFilter): boolean {
  return (
    filter.authors === null &&
    filter.types === null &&
    filter.statuses === null &&
    filter.checked === 'all' &&
    filter.from === null &&
    filter.to === null
  );
}

export interface RowOptions {
  readonly filter: CommentFilter;
  readonly search: string;
  readonly group: GroupBy;
  readonly sort: SortBy;
  readonly direction: SortDirection;
  /** Group keys the reader has collapsed. */
  readonly collapsed: ReadonlySet<string>;
  /** Comment ids whose replies are hidden. */
  readonly folded: ReadonlySet<ModelId>;
}

export const DEFAULT_ROW_OPTIONS: RowOptions = {
  filter: ALL_COMMENTS,
  search: '',
  group: 'page',
  sort: 'page',
  direction: 'asc',
  collapsed: new Set(),
  folded: new Set(),
};

export type CommentRow =
  | {
      readonly kind: 'group';
      readonly id: string;
      readonly label: string;
      readonly count: number;
      readonly collapsed: boolean;
    }
  | {
      readonly kind: 'comment';
      readonly id: ModelId;
      readonly entry: CommentEntry;
      readonly replyCount: number;
      readonly folded: boolean;
      readonly depth: 0;
      /** The part of the text that matched the search, for highlighting. */
      readonly match: readonly [number, number] | null;
    }
  | {
      readonly kind: 'reply';
      readonly id: ModelId;
      readonly entry: CommentEntry;
      readonly parent: ModelId;
      readonly depth: 1;
      readonly match: readonly [number, number] | null;
    };

export interface RowResult {
  readonly rows: ReadonlyArray<CommentRow>;
  /** Threads the filter and the search kept. */
  readonly shown: number;
  /** Threads there are altogether. */
  readonly total: number;
  /** Every author present in the document, for the filter popover. */
  readonly authors: ReadonlyArray<string>;
  readonly types: ReadonlyArray<string>;
}

/** Case- and accent-insensitive contains, the same rule M13's find uses for comments. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function matchIn(text: string, needle: string): readonly [number, number] | null {
  if (needle === '') return null;
  const at = fold(text).indexOf(fold(needle));
  return at < 0 ? null : [at, at + needle.length];
}

/** Whether a thread (comment plus replies) says anything matching the search. */
function threadMatches(entry: CommentEntry, needle: string): boolean {
  if (needle === '') return true;
  const haystacks = [
    entry.text,
    entry.author,
    entry.type,
    ...entry.replies.flatMap((r) => [r.text, r.author]),
  ];
  return haystacks.some((text) => matchIn(text, needle) !== null);
}

function withinDates(entry: CommentEntry, from: string | null, to: string | null): boolean {
  const stamp = entry.created ?? entry.modified;
  if (from === null && to === null) return true;
  if (stamp === null) return false;
  const at = Date.parse(stamp);
  if (Number.isNaN(at)) return false;
  if (from !== null && at < Date.parse(from)) return false;
  // `to` is a day, and a reader who says "to the 3rd" means the whole of the 3rd.
  if (to !== null && at > Date.parse(to) + 24 * 60 * 60 * 1000 - 1) return false;
  return true;
}

/** Whether the filter keeps a thread. Replies count: a filter by author keeps a thread the author replied to. */
export function keeps(entry: CommentEntry, filter: CommentFilter): boolean {
  const everyone = [entry, ...entry.replies];
  if (filter.authors !== null && !everyone.some((e) => filter.authors?.has(e.author))) return false;
  if (filter.types !== null && !filter.types.has(entry.type)) return false;
  if (filter.statuses !== null && !filter.statuses.has(entry.status)) return false;
  if (filter.checked === 'checked' && !entry.checked) return false;
  if (filter.checked === 'unchecked' && entry.checked) return false;
  if (!withinDates(entry, filter.from, filter.to)) return false;
  return true;
}

function sortKey(entry: CommentEntry, sort: SortBy): string | number {
  switch (sort) {
    case 'author':
      return entry.author.toLowerCase();
    case 'date':
      return Date.parse(entry.created ?? entry.modified ?? '') || 0;
    case 'type':
      return entry.type.toLowerCase();
    case 'status':
      return STATUSES.findIndex((s) => s.id === entry.status);
    case 'page':
      return entry.page;
  }
}

function compare(a: CommentEntry, b: CommentEntry, sort: SortBy, direction: SortDirection): number {
  const left = sortKey(a, sort);
  const right = sortKey(b, sort);
  let result =
    typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right), 'en-GB');
  // Position on the page is always the tie-break, so the order is stable and reads down the page.
  if (result === 0) result = a.page - b.page || b.anchor.y - a.anchor.y || a.anchor.x - b.anchor.x;
  return direction === 'desc' ? -result : result;
}

/** The day a comment was made, as a group key and as a heading. */
function dayOf(entry: CommentEntry): { key: string; label: string } {
  const stamp = entry.created ?? entry.modified;
  if (stamp === null) return { key: 'unknown', label: 'No date' };
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return { key: 'unknown', label: 'No date' };
  const key = date.toISOString().slice(0, 10);
  return {
    key,
    label: new Intl.DateTimeFormat('en-GB', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(date),
  };
}

function groupOf(entry: CommentEntry, group: GroupBy): { key: string; label: string } | null {
  switch (group) {
    case 'none':
      return null;
    case 'page':
      return { key: `p${String(entry.page)}`, label: `Page ${String(entry.page + 1)}` };
    case 'author':
      return { key: `a:${entry.author}`, label: entry.author };
    case 'type':
      return { key: `t:${entry.type}`, label: entry.type };
    case 'status':
      return { key: `s:${entry.status}`, label: statusLabel(entry.status) };
    case 'date': {
      const day = dayOf(entry);
      return { key: `d:${day.key}`, label: day.label };
    }
  }
}

/** Turns the comment threads into the flat list the panel draws. */
export function buildRows(comments: ReadonlyArray<CommentEntry>, options: RowOptions): RowResult {
  const authors = new Set<string>();
  const types = new Set<string>();
  for (const entry of comments) {
    types.add(entry.type);
    for (const e of [entry, ...entry.replies]) authors.add(e.author);
  }

  const needle = options.search.trim();
  const kept = comments
    .filter((entry) => keeps(entry, options.filter) && threadMatches(entry, needle))
    .sort((a, b) => compare(a, b, options.sort, options.direction));

  const rows: CommentRow[] = [];
  let lastGroup: string | null = null;
  let groupAt = -1;
  let hidden = false;

  for (const entry of kept) {
    const group = groupOf(entry, options.group);
    if (group && group.key !== lastGroup) {
      lastGroup = group.key;
      groupAt = rows.length;
      hidden = options.collapsed.has(group.key);
      rows.push({
        kind: 'group',
        id: group.key,
        label: group.label,
        count: 0,
        collapsed: hidden,
      });
    }
    if (groupAt >= 0) {
      const header = rows[groupAt];
      if (header?.kind === 'group') {
        rows[groupAt] = { ...header, count: header.count + 1 };
      }
    }
    if (hidden) continue;

    const folded = options.folded.has(entry.id);
    rows.push({
      kind: 'comment',
      id: entry.id,
      entry,
      replyCount: entry.replies.length,
      folded,
      depth: 0,
      match: matchIn(entry.text, needle),
    });
    if (folded) continue;
    for (const reply of entry.replies) {
      rows.push({
        kind: 'reply',
        id: reply.id,
        entry: reply,
        parent: entry.id,
        depth: 1,
        match: matchIn(reply.text, needle),
      });
    }
  }

  return {
    rows,
    shown: kept.length,
    total: comments.length,
    authors: [...authors].sort((a, b) => a.localeCompare(b, 'en-GB')),
    types: [...types].sort((a, b) => a.localeCompare(b, 'en-GB')),
  };
}
