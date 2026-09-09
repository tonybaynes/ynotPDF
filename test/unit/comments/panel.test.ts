/**
 * M32: the pure halves of the panel — comment threads, rows, row geometry, the status catalogue
 * and the page-range parser. No DOM, no engine: every rule the panel obeys is arithmetic or a
 * predicate, and this is where each of them is stated once.
 */

import { describe, expect, it } from 'vitest';
import type { ModelId } from '@core/Ids';
import type { ModelAnnotation } from '@core/model';
import { buildComments, isComment, typeOf } from '@modules/M32-comments-panel/model';
import {
  ALL_COMMENTS,
  buildRows,
  DEFAULT_ROW_OPTIONS,
  isUnfiltered,
  keeps,
  type CommentFilter,
} from '@modules/M32-comments-panel/rows';
import {
  CLAMPED_LINES,
  heightOf,
  lineCount,
  rowMetrics,
  visibleRange,
} from '@modules/M32-comments-panel/metrics';
import { STATUSES, statusOf, statusSpec } from '@modules/M32-comments-panel/status';
import { parseRange } from '@modules/M32-comments-panel/dialogs';
import { must } from '../find/helpers';
import { iconForType, rowLabel } from '@modules/M32-comments-panel/CommentsPanel';

let seq = 0;

function annotation(over: Partial<ModelAnnotation> = {}): ModelAnnotation {
  const id = `an-${String(++seq)}` as ModelId;
  return {
    id,
    pageId: 'pg-0' as ModelId,
    subtype: 'Highlight',
    family: 'markup',
    rect: { x0: 60, y0: 700, x1: 300, y1: 714 },
    flags: { hidden: false, print: true, noView: false, readOnly: false, locked: false },
    contents: 'Something to say',
    author: 'A. Reviewer',
    created: '2026-09-01T10:00:00Z',
    modified: '2026-09-01T10:00:00Z',
    color: 0xffff00,
    interiorColor: null,
    opacity: null,
    borderWidth: null,
    appearanceState: null,
    name: null,
    subject: null,
    inReplyTo: null,
    state: null,
    extra: {},
    quadPoints: [],
    ...over,
  } as ModelAnnotation;
}

const pageOf = (): number => 0;

describe('buildComments', () => {
  it('leaves page furniture out of the panel', () => {
    expect(isComment(annotation({ subtype: 'Widget', family: 'widget' } as never))).toBe(false);
    expect(isComment(annotation({ subtype: 'Link', family: 'link' } as never))).toBe(false);
    expect(isComment(annotation({ subtype: 'Popup', family: 'other' } as never))).toBe(false);
    expect(isComment(annotation())).toBe(true);
  });

  it('names a comment’s kind in words, refined by its intent', () => {
    expect(typeOf(annotation())).toBe('Highlight');
    expect(typeOf(annotation({ subtype: 'Text', family: 'note' } as never))).toBe('Sticky note');
    expect(
      typeOf(
        annotation({
          subtype: 'FreeText',
          family: 'freeText',
          extra: { intent: 'FreeTextCallout' },
        } as never),
      ),
    ).toBe('Callout');
    expect(
      typeOf(
        annotation({ subtype: 'Line', family: 'shape', extra: { intent: 'LineArrow' } } as never),
      ),
    ).toBe('Arrow');
  });

  it('flattens a chained /IRT into one thread, in date order', () => {
    const root = annotation({ contents: 'Root' });
    const first = annotation({
      contents: 'First reply',
      inReplyTo: root.id,
      created: '2026-09-01T11:00:00Z',
    });
    const nested = annotation({
      contents: 'Reply to the reply',
      inReplyTo: first.id,
      created: '2026-09-01T12:00:00Z',
    });
    const threads = buildComments([nested, first, root], pageOf);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.replies.map((r) => r.text)).toEqual(['First reply', 'Reply to the reply']);
  });

  it('takes the newest status in the thread, and says who set it', () => {
    const root = annotation({ contents: 'Root' });
    const older = annotation({
      inReplyTo: root.id,
      author: 'B. Author',
      state: 'Rejected',
      extra: { stateModel: 'Review' },
      created: '2026-09-01T11:00:00Z',
      contents: '',
    });
    const newer = annotation({
      inReplyTo: root.id,
      author: 'C. Editor',
      state: 'Accepted',
      extra: { stateModel: 'Review' },
      created: '2026-09-01T12:00:00Z',
      contents: '',
    });
    const [thread] = buildComments([root, older, newer], pageOf);
    expect(thread?.status).toBe('accepted');
    expect(thread?.statusBy).toBe('C. Editor');
    // The earlier decision stays in the thread as the record of who said what.
    expect(thread?.replies.map((r) => r.setsStatus)).toEqual(['rejected', 'accepted']);
    expect(thread?.replies.every((r) => r.isStatusOnly)).toBe(true);
  });

  it('keeps the checkmark separate from the review status', () => {
    const root = annotation();
    const mark = annotation({
      inReplyTo: root.id,
      state: 'Marked',
      extra: { stateModel: 'Marked' },
      contents: '',
    });
    const [thread] = buildComments([root, mark], pageOf);
    expect(thread?.checked).toBe(true);
    expect(thread?.status).toBe('none');
  });

  it('a reply whose target is gone becomes a comment rather than vanishing', () => {
    const orphan = annotation({ inReplyTo: 'an-missing' as ModelId, contents: 'Orphaned' });
    const threads = buildComments([orphan], pageOf);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.text).toBe('Orphaned');
  });

  it('gives an unsigned comment a name rather than an empty one', () => {
    const [thread] = buildComments([annotation({ author: '  ' })], pageOf);
    expect(thread?.author).toBe('Unknown author');
  });

  it('reads down the page, not up it', () => {
    const low = annotation({ rect: { x0: 0, y0: 100, x1: 10, y1: 120 } });
    const high = annotation({ rect: { x0: 0, y0: 700, x1: 10, y1: 720 } });
    expect(buildComments([low, high], pageOf).map((c) => c.anchor.y)).toEqual([720, 120]);
  });
});

describe('statuses', () => {
  it('reads the five review states and ignores a /Marked one', () => {
    expect(statusOf('Accepted', 'Review')).toBe('accepted');
    expect(statusOf('rejected', 'Review')).toBe('rejected');
    expect(statusOf('Marked', 'Marked')).toBeNull();
    expect(statusOf(null, 'Review')).toBeNull();
    expect(statusOf('Something else', 'Review')).toBeNull();
  });

  it('every status has a word and an icon of its own', () => {
    const labels = new Set(STATUSES.map((s) => s.label));
    const icons = new Set(STATUSES.map((s) => s.icon));
    expect(labels.size).toBe(STATUSES.length);
    expect(icons.size).toBe(STATUSES.length);
    for (const spec of STATUSES) {
      expect(spec.label.trim()).not.toBe('');
      expect(spec.token.startsWith('--')).toBe(true);
    }
  });

  it('an unknown status reads as "No status" rather than as nothing', () => {
    expect(statusSpec('nonsense' as never).label).toBe('No status');
  });
});

describe('buildRows', () => {
  const comments = () => {
    seq = 0;
    const a = annotation({ contents: 'Alpha comment', author: 'A. Reviewer' });
    const b = annotation({
      contents: 'Beta comment',
      author: 'B. Author',
      subtype: 'Text',
      family: 'note',
      created: '2026-09-02T10:00:00Z',
    } as never);
    const reply = annotation({
      contents: 'A reply to alpha',
      author: 'B. Author',
      inReplyTo: a.id,
      created: '2026-09-01T11:00:00Z',
    });
    return buildComments([a, b, reply], pageOf);
  };

  it('groups by page with a heading that counts', () => {
    const { rows, shown, total } = buildRows(comments(), DEFAULT_ROW_OPTIONS);
    expect(rows[0]).toMatchObject({ kind: 'group', label: 'Page 1', count: 2 });
    expect(shown).toBe(2);
    expect(total).toBe(2);
    expect(rows.filter((r) => r.kind === 'reply')).toHaveLength(1);
  });

  it('a collapsed group still counts its comments but shows none of them', () => {
    const { rows } = buildRows(comments(), {
      ...DEFAULT_ROW_OPTIONS,
      collapsed: new Set(['p0']),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'group', count: 2, collapsed: true });
  });

  it('a folded thread hides its replies', () => {
    const list = comments();
    const first = must(list[0], 'thread');
    const { rows } = buildRows(list, {
      ...DEFAULT_ROW_OPTIONS,
      folded: new Set([first.id]),
    });
    expect(rows.filter((r) => r.kind === 'reply')).toHaveLength(0);
  });

  it('groups by author, type, date and status', () => {
    const list = comments();
    for (const group of ['author', 'type', 'date', 'status'] as const) {
      const { rows } = buildRows(list, { ...DEFAULT_ROW_OPTIONS, group });
      expect(rows.filter((r) => r.kind === 'group').length).toBeGreaterThan(0);
    }
    const none = buildRows(list, { ...DEFAULT_ROW_OPTIONS, group: 'none' });
    expect(none.rows.filter((r) => r.kind === 'group')).toHaveLength(0);
  });

  it('sorts, and reverses when asked', () => {
    const list = comments();
    const up = buildRows(list, { ...DEFAULT_ROW_OPTIONS, group: 'none', sort: 'author' });
    const down = buildRows(list, {
      ...DEFAULT_ROW_OPTIONS,
      group: 'none',
      sort: 'author',
      direction: 'desc',
    });
    const names = (r: typeof up) =>
      r.rows.filter((row) => row.kind === 'comment').map((row) => row.entry.author);
    expect(names(up)).toEqual(['A. Reviewer', 'B. Author']);
    expect(names(down)).toEqual(['B. Author', 'A. Reviewer']);
  });

  it('searches the whole thread, not just the comment', () => {
    const list = comments();
    const hit = buildRows(list, { ...DEFAULT_ROW_OPTIONS, search: 'reply to alpha' });
    expect(hit.shown).toBe(1);
    const miss = buildRows(list, { ...DEFAULT_ROW_OPTIONS, search: 'nothing like this' });
    expect(miss.shown).toBe(0);
    // The match is reported so the panel can mark it.
    const marked = buildRows(list, { ...DEFAULT_ROW_OPTIONS, search: 'Alpha' });
    const row = marked.rows.find((r) => r.kind === 'comment');
    expect(row?.kind === 'comment' ? row.match : null).toEqual([0, 5]);
  });

  it('ignores case and accents when searching', () => {
    const list = buildComments([annotation({ contents: 'Café société' })], pageOf);
    expect(buildRows(list, { ...DEFAULT_ROW_OPTIONS, search: 'CAFE' }).shown).toBe(1);
  });

  it('lists every author and type for the filter popover', () => {
    const { authors, types } = buildRows(comments(), DEFAULT_ROW_OPTIONS);
    expect(authors).toEqual(['A. Reviewer', 'B. Author']);
    expect(types).toEqual(['Highlight', 'Sticky note']);
  });
});

describe('the filter', () => {
  const list = () => {
    seq = 0;
    const a = annotation({ contents: 'Alpha', author: 'A. Reviewer' });
    const status = annotation({
      inReplyTo: a.id,
      author: 'B. Author',
      state: 'Accepted',
      extra: { stateModel: 'Review' },
      contents: '',
    });
    const b = annotation({
      contents: 'Beta',
      author: 'C. Editor',
      subtype: 'Text',
      family: 'note',
      created: '2026-10-01T10:00:00Z',
    } as never);
    return buildComments([a, status, b], pageOf);
  };

  const filter = (over: Partial<CommentFilter>): CommentFilter => ({ ...ALL_COMMENTS, ...over });

  it('an empty filter keeps everything and says so', () => {
    expect(isUnfiltered(ALL_COMMENTS)).toBe(true);
    expect(isUnfiltered(filter({ checked: 'checked' }))).toBe(false);
    expect(list().every((entry) => keeps(entry, ALL_COMMENTS))).toBe(true);
  });

  it('by author, counting the people who replied as well', () => {
    const kept = list().filter((entry) =>
      keeps(entry, filter({ authors: new Set(['B. Author']) })),
    );
    expect(kept.map((k) => k.text)).toEqual(['Alpha']);
  });

  it('by type and by status', () => {
    expect(
      list()
        .filter((e) => keeps(e, filter({ types: new Set(['Sticky note']) })))
        .map((e) => e.text),
    ).toEqual(['Beta']);
    expect(
      list()
        .filter((e) => keeps(e, filter({ statuses: new Set(['accepted' as const]) })))
        .map((e) => e.text),
    ).toEqual(['Alpha']);
  });

  it('by date, taking the last day whole', () => {
    const kept = list().filter((e) => keeps(e, filter({ from: '2026-09-15', to: '2026-10-01' })));
    expect(kept.map((k) => k.text)).toEqual(['Beta']);
  });

  it('by checkmark', () => {
    expect(list().filter((e) => keeps(e, filter({ checked: 'checked' })))).toHaveLength(0);
    expect(list().filter((e) => keeps(e, filter({ checked: 'unchecked' })))).toHaveLength(2);
  });
});

describe('row geometry', () => {
  const options = { width: 240, fontSize: 12, expanded: null };

  it('counts lines from the text and the width', () => {
    expect(lineCount('', 240, 12)).toBe(1);
    expect(lineCount('short', 240, 12)).toBe(1);
    expect(lineCount('a'.repeat(200), 240, 12)).toBeGreaterThan(3);
    expect(lineCount('one\ntwo\nthree', 240, 12)).toBe(3);
  });

  it('clamps a long comment until it is the selected one', () => {
    seq = 0;
    const long = buildComments([annotation({ contents: 'word '.repeat(200) })], pageOf);
    const { rows } = buildRows(long, { ...DEFAULT_ROW_OPTIONS, group: 'none' });
    const row = rows[0];
    expect(row).toBeDefined();
    if (!row) return;
    const collapsed = heightOf(row, options);
    const expanded = heightOf(row, { ...options, expanded: row.id });
    expect(expanded).toBeGreaterThan(collapsed);
    // The clamped height is the header plus at most CLAMPED_LINES of text.
    expect(collapsed).toBeLessThan(38 + (CLAMPED_LINES + 1) * 17 + 8);
  });

  it('offsets stack and the total is their sum', () => {
    seq = 0;
    const many = buildComments(
      Array.from({ length: 50 }, (_, i) => annotation({ contents: `Comment ${String(i)}` })),
      pageOf,
    );
    const { rows } = buildRows(many, { ...DEFAULT_ROW_OPTIONS, group: 'none' });
    const metrics = rowMetrics(rows, options);
    expect(metrics.offsets).toHaveLength(rows.length);
    for (let i = 1; i < rows.length; i++) {
      expect(metrics.offsets[i]).toBe(
        (metrics.offsets[i - 1] ?? 0) + (metrics.heights[i - 1] ?? 0),
      );
    }
    expect(metrics.total).toBe(
      (metrics.offsets[rows.length - 1] ?? 0) + (metrics.heights[rows.length - 1] ?? 0),
    );
  });

  it('the visible window covers the viewport and nothing like all of it', () => {
    seq = 0;
    const many = buildComments(
      Array.from({ length: 500 }, (_, i) => annotation({ contents: `Comment ${String(i)}` })),
      pageOf,
    );
    const { rows } = buildRows(many, { ...DEFAULT_ROW_OPTIONS, group: 'none' });
    const metrics = rowMetrics(rows, options);
    const range = visibleRange(2000, 400, metrics);
    expect(range.last - range.first).toBeLessThan(30);
    // Every row the viewport touches is inside the window.
    for (let i = 0; i < rows.length; i++) {
      const top = metrics.offsets[i] ?? 0;
      const bottom = top + (metrics.heights[i] ?? 0);
      if (bottom > 2000 && top < 2400) {
        expect(i).toBeGreaterThanOrEqual(range.first);
        expect(i).toBeLessThanOrEqual(range.last);
      }
    }
  });

  it('an empty list has an empty window rather than a negative one', () => {
    const metrics = rowMetrics([], options);
    expect(metrics.total).toBe(0);
    expect(visibleRange(0, 400, metrics)).toEqual({ first: 0, last: -1 });
  });
});

describe('presentation helpers', () => {
  it('every comment type has an icon, and the fallback is a comment', () => {
    for (const type of ['Highlight', 'Sticky note', 'Pencil', 'Stamp', 'Callout']) {
      expect(iconForType(type)).not.toBe('');
    }
    expect(iconForType('Something new')).toBe('message-square');
  });

  it('a row reads out as words, status included', () => {
    seq = 0;
    const list = buildComments([annotation({ contents: 'Alpha' })], pageOf);
    const { rows } = buildRows(list, DEFAULT_ROW_OPTIONS);
    expect(rowLabel(must(rows[0], 'group row'))).toBe('Page 1, 1 comments');
    expect(rowLabel(must(rows[1], 'comment row'))).toBe(
      'Highlight by A. Reviewer, page 1, No status',
    );
  });
});

describe('parseRange', () => {
  it('reads the forms a reader actually types', () => {
    expect(parseRange('', 5)).toEqual([0, 1, 2, 3, 4]);
    expect(parseRange('1-3', 5)).toEqual([0, 1, 2]);
    expect(parseRange('1, 3, 5', 5)).toEqual([0, 2, 4]);
    expect(parseRange('1-2, 4-5', 5)).toEqual([0, 1, 3, 4]);
    expect(parseRange(' 2 ', 5)).toEqual([1]);
  });

  it('takes a backwards range the right way round and clamps to the document', () => {
    expect(parseRange('4-2', 5)).toEqual([1, 2, 3]);
    expect(parseRange('3-99', 5)).toEqual([2, 3, 4]);
    expect(parseRange('0-2', 5)).toEqual([0, 1]);
  });

  it('drops what it cannot read rather than failing the whole range', () => {
    expect(parseRange('1, banana, 3', 5)).toEqual([0, 2]);
    expect(parseRange('banana', 5)).toEqual([]);
  });
});
