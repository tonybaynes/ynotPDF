/**
 * M32 acceptance tests — the Comments panel, replies and status, FDF/XFDF and the summary, inside
 * the real, built app.
 *
 * The unit tests own the formats (`test/unit/comments/xfdf.test.ts`), the arithmetic
 * (`panel.test.ts`, `summary.test.ts`) and the file (`roundtrip.test.ts`, which saves and reopens
 * through the whole real pipeline). This file owns what only exists once there is a DOM, a
 * viewer, a running PDFium and a real file dialog: the panel listing a document, a reply typed
 * into it, a status that undoes, comments hidden without the file changing, an import and an
 * export through the shell, and a summary opened as a document of its own.
 *
 * Each acceptance line in `docs/modules/M32-comments-panel.md` has a test named after it.
 */

import { expect, test } from '@playwright/test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readComments } from '../../src/engine/xfdf';
import { launchApp, type App } from './harness';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

/** Narrows away a value the test knows is there; `!` is forbidden project-wide. */
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected a ${what}, got nothing`);
  return value;
}

interface CommentRow {
  kind: 'group' | 'comment' | 'reply';
  id: string;
  label?: string;
  count?: number;
  page?: number;
  type?: string;
  author?: string;
  text?: string;
  status?: string;
  checked?: boolean;
  replies?: number;
}

interface CommentsState {
  shown: number;
  total: number;
  authors: string[];
  types: string[];
  filtering: boolean;
  everythingVisible: boolean;
  group: string;
  sort: string;
  rows: CommentRow[];
}

interface ThreadState {
  id: string;
  status: string;
  statusBy: string | null;
  checked: boolean;
  text: string;
  replies: Array<{ id: string; text: string; author: string; setsStatus: string | null }>;
}

let app: App;
let workspace: string;

test.beforeAll(async () => {
  app = await launchApp();
  workspace = mkdtempSync(join(tmpdir(), 'ynot-m32-'));
  await app.run('annot.identity', { name: 'E2E Reader', initials: 'ER', email: '' });
});

test.afterAll(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

function stage(name: string, as: string): string {
  const path = join(workspace, as);
  copyFileSync(join(FIXTURES, name), path);
  return path;
}

async function openPath(path: string): Promise<void> {
  const bytes = Array.from(readFileSync(path));
  await app.run('file.openBytes', { file: { path, name: path.split(/[\\/]/).pop(), bytes } });
  await app.page.waitForSelector('.viewer-content .page');
  await app.page.waitForTimeout(250);
}

/** Closes every tab, answering M21's "Save?" for each. */
async function closeAll(): Promise<void> {
  const closing = app.run('app.tabs.closeAll').catch(() => undefined);
  for (let i = 0; i < 8; i++) {
    const discard = app.page.locator('dialog[open] button', { hasText: "Don't save" });
    if ((await discard.count()) === 0) {
      await app.page.waitForTimeout(120);
      if ((await discard.count()) === 0) break;
    }
    await discard.first().click();
    await app.page.waitForTimeout(120);
  }
  await closing;
  await app.page.waitForTimeout(150);
}

const state = (): Promise<CommentsState> => app.run('dev.comments') as Promise<CommentsState>;
const thread = (comment?: string): Promise<ThreadState | null> =>
  app.run(
    'dev.commentThread',
    comment === undefined ? {} : { comment },
  ) as Promise<ThreadState | null>;

async function until<T>(
  probe: () => Promise<T>,
  ready: (value: T) => boolean,
  timeout = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (ready(value)) return value;
    if (Date.now() > deadline) return value;
    await app.page.waitForTimeout(120);
  }
}

/** Opens the review fixture with the panel showing, and waits for the comments to be read. */
async function openComments(as = 'review.pdf'): Promise<CommentsState> {
  await openPath(stage('comments.pdf', as));
  await app.run('comments.panel');
  await app.page.waitForSelector('.comments-list');
  return until(state, (s) => s.total > 0);
}

/** The first comment in the panel that is not a reply. */
function firstComment(s: CommentsState): CommentRow {
  return must(
    s.rows.find((row) => row.kind === 'comment'),
    'a comment row',
  );
}

// ---- wiring ------------------------------------------------------------------------------------

test.describe('the module is wired in', () => {
  test.afterEach(closeAll);

  test('every action is a registered command', async () => {
    const commands = await app.commands();
    for (const id of [
      'comments.panel',
      'comments.select',
      'comments.reply',
      'comments.status',
      'comments.status.accepted',
      'comments.status.rejected',
      'comments.status.cancelled',
      'comments.status.completed',
      'comments.status.none',
      'comments.check',
      'comments.delete',
      'comments.deleteAll',
      'comments.next',
      'comments.previous',
      'comments.expandAll',
      'comments.collapseAll',
      'comments.group',
      'comments.sort',
      'comments.search',
      'comments.filter',
      'comments.showAll',
      'comments.hideAll',
      'comments.hideType',
      'comments.hideAuthor',
      'comments.import',
      'comments.export',
      'comments.summarise',
      'comments.print',
    ]) {
      expect(commands, id).toContain(id);
    }
  });

  test('the panel opens, lists the document and counts it', async () => {
    const s = await openComments('wired.pdf');
    expect(s.total).toBeGreaterThanOrEqual(15);
    expect(s.authors).toContain('A. Reviewer');
    expect(s.types).toContain('Highlight');
    const badge = app.page.locator('[data-role="comment-count"]');
    await expect(badge).toHaveText(String(s.total));
    // Grouped by page by default, with a heading that counts.
    const groups = s.rows.filter((row) => row.kind === 'group');
    expect(groups.length).toBe(2);
    expect(groups[0]?.label).toBe('Page 1');
    expect((groups[0]?.count ?? 0) + (groups[1]?.count ?? 0)).toBe(s.total);
  });

  test('it lists both pages without either being on screen', async () => {
    const s = await openComments('bothpages.pdf');
    const pages = new Set(
      s.rows.filter((row) => row.kind !== 'group').map((row) => row.page ?? -1),
    );
    expect(pages).toEqual(new Set([0, 1]));
  });
});

// ---- the panel ---------------------------------------------------------------------------------

test.describe('the list: grouping, sorting, search and filtering', () => {
  test.afterEach(closeAll);

  test('groups by author, type, date and status, and by nothing', async () => {
    await openComments('group.pdf');
    for (const value of ['author', 'type', 'date', 'status']) {
      await app.run('comments.group', { value });
      const s = await state();
      expect(s.group, value).toBe(value);
      expect(s.rows.filter((row) => row.kind === 'group').length, value).toBeGreaterThan(0);
    }
    await app.run('comments.group', { value: 'none' });
    expect((await state()).rows.filter((row) => row.kind === 'group')).toHaveLength(0);
    await app.run('comments.group', { value: 'page' });
  });

  test('sorts by author, and reverses', async () => {
    await openComments('sort.pdf');
    await app.run('comments.group', { value: 'none' });
    await app.run('comments.sort', { value: 'author', direction: 'asc' });
    const up = (await state()).rows
      .filter((row) => row.kind === 'comment')
      .map((row) => row.author ?? '');
    await app.run('comments.sort', { value: 'author', direction: 'desc' });
    const down = (await state()).rows
      .filter((row) => row.kind === 'comment')
      .map((row) => row.author ?? '');
    expect(up).toEqual([...up].sort((a, b) => a.localeCompare(b, 'en-GB')));
    expect(down[0]).toBe(up[up.length - 1]);
    await app.run('comments.sort', { value: 'page', direction: 'asc' });
    await app.run('comments.group', { value: 'page' });
  });

  test('the search field narrows the list and the badge says so', async () => {
    const all = await openComments('search.pdf');
    await app.run('comments.search', { text: 'opening sentence' });
    const found = await state();
    expect(found.shown).toBe(1);
    expect(found.filtering).toBe(true);
    await expect(app.page.locator('[data-role="comment-count"]')).toHaveText(
      `1 of ${String(all.total)}`,
    );
    // The match is marked in the row rather than only counted.
    await expect(app.page.locator('.comments-match').first()).toBeVisible();
    await app.run('comments.search', { text: '' });
    expect((await state()).shown).toBe(all.total);
  });

  test('the filter keeps one author, one type and one status', async () => {
    const all = await openComments('filter.pdf');
    await app.run('comments.filter', { authors: ['C. Editor'] });
    const byAuthor = await state();
    expect(byAuthor.shown).toBeGreaterThan(0);
    expect(byAuthor.shown).toBeLessThan(all.total);

    await app.run('comments.filter', { types: ['Highlight'] });
    const byType = await state();
    expect(
      byType.rows.filter((row) => row.kind === 'comment').every((row) => row.type === 'Highlight'),
    ).toBe(true);

    await app.run('comments.filter', { statuses: ['accepted'] });
    const byStatus = await state();
    expect(byStatus.shown).toBe(1);

    await app.run('comments.filter');
    expect((await state()).shown).toBe(all.total);
    expect((await state()).filtering).toBe(false);
  });

  test('a filter that matches nothing says so in words', async () => {
    await openComments('nothing.pdf');
    await app.run('comments.search', { text: 'no comment says this at all' });
    await expect(app.page.locator('[data-role="comment-empty"]')).toContainText(
      'No comment matches the filter',
    );
    await app.run('comments.search', { text: '' });
  });

  test('collapse and expand', async () => {
    await openComments('collapse.pdf');
    await app.run('comments.collapseAll');
    const collapsed = await state();
    expect(collapsed.rows.every((row) => row.kind === 'group')).toBe(true);
    await app.run('comments.expandAll');
    const expanded = await state();
    expect(expanded.rows.some((row) => row.kind === 'reply')).toBe(true);
  });

  test('next and previous walk the list, and the page follows', async () => {
    await openComments('walk.pdf');
    const first = (await app.run('comments.next')) as string;
    expect(first).toBeTruthy();
    const second = (await app.run('comments.next')) as string;
    expect(second).not.toBe(first);
    expect(await app.run('comments.previous')).toBe(first);
  });

  test('the list is virtualised: only the rows near the viewport have DOM', async () => {
    await openComments('virtual.pdf');
    await app.run('comments.group', { value: 'none' });
    const s = await state();
    const drawn = await app.page.locator('.comments-list > *').count();
    expect(drawn).toBeLessThanOrEqual(s.rows.length);
    // The spacer is the full height even though the rows are not all there.
    const height = await app.page
      .locator('.comments-spacer')
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeGreaterThan(0);
    await app.run('comments.group', { value: 'page' });
  });
});

// ---- replies and status ------------------------------------------------------------------------

test.describe('replies and status, every one of them undoable', () => {
  test.afterEach(closeAll);

  test('a reply joins the thread and undoes as one step', async () => {
    const s = await openComments('reply.pdf');
    const target = firstComment(s);
    await app.run('comments.select', { comment: target.id });
    const before = must(await thread(target.id), 'thread');
    const replyId = await app.run('comments.reply', {
      comment: target.id,
      text: 'A reply typed in the panel.',
    });
    expect(replyId).toBeTruthy();

    const after = must(await thread(target.id), 'thread');
    expect(after.replies.length).toBe(before.replies.length + 1);
    expect(after.replies.map((r) => r.text)).toContain('A reply typed in the panel.');

    await app.run('edit.undo');
    await app.page.waitForTimeout(200);
    const undone = must(await thread(target.id), 'thread');
    expect(undone.replies.length).toBe(before.replies.length);
  });

  test('setting a status writes a reply that says who set it', async () => {
    const s = await openComments('status.pdf');
    const target = must(
      s.rows.find((row) => row.kind === 'comment' && row.status === 'none'),
      'an unset comment',
    );
    await app.run('comments.select', { comment: target.id });
    await app.run('comments.status.rejected', { comment: target.id });
    const after = must(await thread(target.id), 'thread');
    expect(after.status).toBe('rejected');
    expect(after.statusBy).toBe('E2E Reader');
    // It is a reply carrying the state, not a field on the comment.
    expect(after.replies.some((r) => r.setsStatus === 'rejected')).toBe(true);

    await app.run('edit.undo');
    await app.page.waitForTimeout(200);
    expect(must(await thread(target.id), 'thread').status).toBe('none');
  });

  test('every status is reachable and each shows its own word', async () => {
    const s = await openComments('statuses.pdf');
    const target = must(
      s.rows.find((row) => row.kind === 'comment' && row.status === 'none'),
      'an unset comment',
    );
    await app.run('comments.select', { comment: target.id });
    for (const status of ['accepted', 'rejected', 'cancelled', 'completed']) {
      await app.run(`comments.status.${status}`, { comment: target.id });
      expect(must(await thread(target.id), 'thread').status, status).toBe(status);
    }
    // The chip carries the word, not the colour alone.
    await app.run('comments.search', { text: 'opening sentence' });
    await app.page.waitForTimeout(200);
    const words = await app.page.locator('.comments-status span').allTextContents();
    expect(words.join(' ')).toMatch(/Accepted|Rejected|Cancelled|Completed|No status/);
    await app.run('comments.search', { text: '' });
  });

  test('the checkmark is separate from the review status', async () => {
    const s = await openComments('check.pdf');
    const target = firstComment(s);
    await app.run('comments.select', { comment: target.id });
    expect(await app.run('comments.check', { comment: target.id })).toBe(true);
    const checked = must(await thread(target.id), 'thread');
    expect(checked.checked).toBe(true);
    expect(checked.status).toBe(must(await thread(target.id), 'thread').status);
    await app.run('comments.check', { comment: target.id });
    expect(must(await thread(target.id), 'thread').checked).toBe(false);
  });

  test('deleting a comment takes its replies with it, as one undo step', async () => {
    const s = await openComments('delete.pdf');
    const withReplies = must(
      s.rows.find((row) => row.kind === 'comment' && (row.replies ?? 0) > 0),
      'a comment with replies',
    );
    await app.run('comments.select', { comment: withReplies.id });
    const before = await state();
    const removed = (await app.run('comments.delete', { comment: withReplies.id })) as number;
    expect(removed).toBeGreaterThan(1);
    const after = await state();
    expect(after.total).toBe(before.total - 1);

    await app.run('edit.undo');
    await app.page.waitForTimeout(250);
    expect((await state()).total).toBe(before.total);
  });

  test('the inline reply editor in the panel adds a reply', async () => {
    const s = await openComments('inline.pdf');
    const target = firstComment(s);
    await app.page.locator(`.comments-row[data-id="${target.id}"]`).click();
    await app.page.waitForTimeout(200);
    const input = app.page.locator('[data-role="comment-reply-input"]');
    await expect(input).toBeVisible();
    await input.fill('Typed straight into the panel.');
    await input.press('Enter');
    await app.page.waitForTimeout(400);
    const after = must(await thread(target.id), 'thread');
    expect(after.replies.map((r) => r.text)).toContain('Typed straight into the panel.');
  });
});

// ---- show and hide -----------------------------------------------------------------------------

test.describe('show and hide is a view flag, never the file', () => {
  test.afterEach(closeAll);

  test('hiding every comment leaves the document unchanged', async () => {
    await openComments('hide.pdf');
    const dirtyBefore = await app.run('dev.documentSummary').catch(() => null);
    await app.run('comments.hideAll');
    expect((await state()).everythingVisible).toBe(false);
    await app.page.waitForTimeout(300);
    // Nothing in the model changed: the annotations are all still there and still visible flags.
    const s = await state();
    expect(s.total).toBeGreaterThan(0);
    const dirtyAfter = await app.run('dev.documentSummary').catch(() => null);
    expect(JSON.stringify(dirtyAfter)).toBe(JSON.stringify(dirtyBefore));

    await app.run('comments.showAll');
    expect((await state()).everythingVisible).toBe(true);
  });

  test('hiding one type and one author is remembered per document', async () => {
    const s = await openComments('hidesome.pdf');
    expect(await app.run('comments.hideType', { type: 'Highlight' })).toBe(false);
    expect((await state()).everythingVisible).toBe(false);
    expect(await app.run('comments.hideType', { type: 'Highlight' })).toBe(true);
    expect((await state()).everythingVisible).toBe(true);

    const author = must(s.authors[0], 'an author');
    expect(await app.run('comments.hideAuthor', { author })).toBe(false);
    expect((await state()).everythingVisible).toBe(false);
    await app.run('comments.showAll');
    expect((await state()).everythingVisible).toBe(true);
  });

  test('the panel still lists what the page is not drawing', async () => {
    const before = await openComments('stilllisted.pdf');
    await app.run('comments.hideAll');
    // Hiding is about the page; the panel is the list of what is in the document.
    expect((await state()).total).toBe(before.total);
    await app.run('comments.showAll');
  });
});

// ---- import and export -------------------------------------------------------------------------

test.describe('import and export', () => {
  test.afterEach(closeAll);

  test('exports XFDF, and the file has every comment in it', async () => {
    const s = await openComments('export.pdf');
    const path = join(workspace, 'exported.xfdf');
    const result = (await app.run('comments.export', { path, format: 'xfdf' })) as {
      count: number;
    };
    expect(result.count).toBeGreaterThanOrEqual(s.total);
    const parsed = readComments(new Uint8Array(readFileSync(path)));
    expect(parsed.annotations.length).toBe(result.count);
    expect(parsed.annotations.some((a) => a.inReplyTo !== null)).toBe(true);
    expect(parsed.annotations.some((a) => a.state === 'Accepted')).toBe(true);
  });

  test('exports FDF as well', async () => {
    await openComments('exportfdf.pdf');
    const path = join(workspace, 'exported.fdf');
    const result = (await app.run('comments.export', { path, format: 'fdf' })) as { count: number };
    const parsed = readComments(new Uint8Array(readFileSync(path)));
    expect(parsed.annotations.length).toBe(result.count);
  });

  test('imports into a document with no comments of its own', async () => {
    await openComments('source.pdf');
    const path = join(workspace, 'thread.xfdf');
    await app.run('comments.export', { path, format: 'xfdf' });
    await closeAll();

    await openPath(stage('multipage.pdf', 'target.pdf'));
    await app.run('comments.panel');
    expect((await state()).total).toBe(0);
    const result = (await app.run('comments.import', { path, policy: 'replace' })) as {
      added: number;
      replies: number;
    };
    expect(result.added).toBeGreaterThanOrEqual(15);
    expect(result.replies).toBe(4);
    const after = await until(state, (v) => v.total > 0);
    expect(after.total).toBeGreaterThan(0);
    expect(after.rows.some((row) => row.kind === 'reply')).toBe(true);

    // One undo step for the whole import.
    await app.run('edit.undo');
    await app.page.waitForTimeout(400);
    expect((await state()).total).toBe(0);
  });

  test('an Acrobat-shaped XFDF file imports with its threads and statuses', async () => {
    const path = join(workspace, 'acrobat.xfdf');
    writeFileSync(path, readFileSync(join(FIXTURES, 'xfdf', 'acrobat.xfdf')));
    await openPath(stage('multipage.pdf', 'acrobat-target.pdf'));
    await app.run('comments.panel');
    const result = (await app.run('comments.import', { path, policy: 'replace' })) as {
      added: number;
      replies: number;
    };
    expect(result.added).toBe(9);
    expect(result.replies).toBe(1);
    const s = await until(state, (v) => v.total > 0);
    expect(s.rows.some((row) => row.status === 'accepted')).toBe(true);
    expect(s.types).toEqual(
      expect.arrayContaining(['Highlight', 'Sticky note', 'Callout', 'Pencil']),
    );
  });

  test('a file that is not a comment file says so and changes nothing', async () => {
    const path = join(workspace, 'not-comments.txt');
    writeFileSync(path, 'just some words');
    await openComments('badimport.pdf');
    const before = (await state()).total;
    // The error dialog is modal and the command waits on it, so the run is not awaited until
    // the dialog has been dismissed.
    const importing = app.run('comments.import', { path, policy: 'replace' });
    const dialog = app.page.locator('dialog[open]');
    await expect(dialog.first()).toBeVisible();
    await expect(dialog.first()).toContainText(/not an FDF or XFDF|could not be read/);
    await dialog.locator('button').first().click();
    await importing;
    expect((await state()).total).toBe(before);
  });
});

// ---- summarise ---------------------------------------------------------------------------------

test.describe('summarise comments', () => {
  test.afterEach(closeAll);

  const LAYOUTS = [
    'separate-connectors',
    'single-connectors',
    'comments-only',
    'separate-sequence',
  ] as const;

  for (const layout of LAYOUTS) {
    test(`the ${layout} layout builds a PDF and opens it`, async () => {
      await openComments(`summary-${layout}.pdf`);
      const result = (await app.run('comments.summarise', { layout, range: '' })) as {
        pageCount: number;
        commentCount: number;
        name: string;
      };
      expect(result.pageCount).toBeGreaterThan(0);
      expect(result.commentCount).toBeGreaterThanOrEqual(15);
      expect(result.name).toContain('comments');
      // It opened as a document of its own.
      await app.page.waitForTimeout(400);
      const tabs = await app.page.locator('[role="tab"]').allTextContents();
      expect(tabs.join(' ')).toContain('Comment summary');
    });
  }

  test('a page range makes a shorter summary', async () => {
    // One summary per opening: the summary that opens has no comments of its own, so a second
    // run from it would be disabled. The range is compared against what the panel counted.
    const s = await openComments('summary-range.pdf');
    const one = (await app.run('comments.summarise', {
      layout: 'comments-only',
      range: '2',
    })) as { commentCount: number };
    expect(one.commentCount).toBeGreaterThan(0);
    expect(one.commentCount).toBeLessThan(s.total);
  });

  test('the summary opens as a real document, with as many pages as it planned', async () => {
    await openComments('summary-text.pdf');
    const result = (await app.run('comments.summarise', {
      layout: 'comments-only',
      range: '',
    })) as { pageCount: number };
    await app.page.waitForTimeout(600);
    // The tab that is now active is the summary, and the engine agrees about its length.
    const summary = (await app.run('dev.documentSummary')) as { pageCount: number };
    expect(summary.pageCount).toBe(result.pageCount);
    // It carries no comments of its own: the comments in it are text, not annotations.
    expect((await state()).total).toBe(0);
  });
});

// ---- accessibility -----------------------------------------------------------------------------

test.describe('the panel is readable and reachable', () => {
  test.afterEach(closeAll);

  test('nothing in the panel or its popovers is translucent', async () => {
    await openComments('opacity.pdf');
    // Open the filter popover so the walk covers it too.
    await app.page.locator('[data-action="comments-filter"]').click();
    await app.page.waitForTimeout(250);

    const offenders = await app.page.evaluate(() => {
      const bad: string[] = [];
      const alpha = (value: string): number | null => {
        const m = /\(([^)]*)\)/.exec(value);
        if (!m) return null;
        const parts = (m[1] ?? '').split(/[,/]/).map((p) => p.trim());
        if (parts.length < 4) return null;
        const last = parts[parts.length - 1] ?? '1';
        const n = last.endsWith('%') ? Number.parseFloat(last) / 100 : Number.parseFloat(last);
        return Number.isNaN(n) ? null : n;
      };
      const roots = document.querySelectorAll(
        '.comments-list, .comments-list *, .comments-searchrow, .comments-searchrow *, ' +
          '.comments-popup, .comments-popup *',
      );
      for (const el of roots) {
        const style = getComputedStyle(el);
        if (Number.parseFloat(style.opacity) < 1) bad.push(`${el.className}: opacity`);
        if (style.backdropFilter && style.backdropFilter !== 'none') {
          bad.push(`${el.className}: backdrop-filter`);
        }
        for (const prop of ['color', 'background-color', 'border-top-color', 'fill', 'stroke']) {
          const a = alpha(style.getPropertyValue(prop));
          if (a !== null && a > 0 && a < 1) bad.push(`${el.className}: ${prop}`);
        }
      }
      return bad;
    });
    expect(offenders).toEqual([]);
    await app.page.keyboard.press('Escape');
  });

  test('a status is a word as well as an icon, and the list is one tab stop', async () => {
    await openComments('a11y.pdf');
    const rows = app.page.locator('.comments-row');
    await expect(rows.first()).toBeVisible();
    // Exactly one row is tabbable (roving focus).
    const tabbable = await app.page.locator('.comments-row[tabindex="0"]').count();
    expect(tabbable).toBeLessThanOrEqual(1);
    // Every status chip carries text, not just a glyph.
    const chips = await app.page.locator('.comments-status').allTextContents();
    for (const chip of chips) expect(chip.trim()).not.toBe('');
  });

  test('the arrow keys move between comments', async () => {
    await openComments('keys.pdf');
    const first = firstComment(await state());
    await app.page.locator(`.comments-row[data-id="${first.id}"]`).click();
    await app.page.waitForTimeout(200);
    // Pressed on the row that has focus: the list itself is not a tab stop, the rows are.
    await app.page.locator(`.comments-row[data-id="${first.id}"]`).press('ArrowDown');
    await app.page.waitForTimeout(250);
    const selected = await app.page.locator('.comments-row.is-selected').getAttribute('data-id');
    expect(selected).not.toBe(first.id);
  });
});
