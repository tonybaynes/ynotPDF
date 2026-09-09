/**
 * Running a comment summary (M32): the model's comments plus the engine's pictures of the pages,
 * through the pure layout, into a new PDF.
 *
 * The pages are rendered one at a time and released as they go, so a summary of a long document
 * never holds more than one page bitmap; the progress dialog is the same one M21 uses for a save,
 * and cancelling it stops the render between pages rather than at the end.
 */

import type { ShellServices } from '@app/services';
import type { Document } from '@core/Document';
import {
  buildSummary,
  layoutSummary,
  type SummaryComment,
  type SummaryOptions,
} from '@engine/summary';
import { renderSnapshot } from '@modules/M13-select-find-print/snapshot/snapshot';
import { pageSizeOf } from '@core/model';
import type { CommentEntry } from './model';
import { statusSpec } from './status';

export interface SummaryRun {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly commentCount: number;
  readonly unrendered: ReadonlyArray<number>;
  readonly fileName: string;
}

/** The panel's comment threads as the summary's own records. */
export function toSummaryComments(entries: ReadonlyArray<CommentEntry>): SummaryComment[] {
  return entries.map((entry) => ({
    id: entry.id,
    page: entry.page,
    type: entry.type,
    author: entry.author,
    date: entry.created ?? entry.modified,
    status: entry.status === 'none' ? null : statusSpec(entry.status).label,
    text: entry.text,
    anchor: entry.anchor,
    replies: entry.replies
      // A status change is a line in the thread, not an empty reply — the summary says who set
      // what rather than printing a blank.
      .map((reply) => ({
        author: reply.author,
        date: reply.created ?? reply.modified,
        text: reply.text,
        status: reply.setsStatus === null ? null : statusSpec(reply.setsStatus).label,
      }))
      .filter((reply) => reply.text !== '' || reply.status !== null),
  }));
}

/** A file name for the summary, derived from the document's own. */
export function summaryFileName(title: string): string {
  const base = title.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/gu, '-') || 'document';
  return `${base} - comments.pdf`;
}

export async function runSummary(options: {
  readonly shell: ShellServices;
  readonly document: Document;
  readonly comments: ReadonlyArray<CommentEntry>;
  readonly summary: SummaryOptions;
  readonly dpi: number;
}): Promise<SummaryRun | null> {
  const { document, shell } = options;
  const sizes = document.state.pages.map((page) => {
    const size = pageSizeOf(page);
    return { width: size.width, height: size.height };
  });
  const plan = layoutSummary(toSummaryComments(options.comments), sizes, options.summary);

  const progress = shell.dialogs.progress({
    title: 'Summarising comments',
    text: `${String(plan.ordered.length)} comments`,
    cancellable: true,
  });
  try {
    const built = await buildSummary({
      plan,
      options: options.summary,
      sourceTitle: document.state.title,
      signal: progress.signal,
      onProgress: (fraction) => {
        progress.set(fraction);
      },
      render: async (page) => {
        const model = document.state.pages[page];
        if (!model) return null;
        const box = model.cropBox;
        try {
          const shot = await renderSnapshot({
            engine: document.engine,
            doc: document.handle,
            page: document.enginePage(model.id) ?? page,
            rect: box,
            dpi: options.dpi,
            annotations: true,
            forms: true,
            grayscale: false,
          });
          return { png: shot.png, width: box.x1 - box.x0, height: box.y1 - box.y0 };
        } catch {
          // A page the engine cannot draw is one page of the summary with a note on it, not a
          // failed summary — the comments on it are still worth having.
          return null;
        }
      },
    });
    return {
      bytes: built.bytes,
      pageCount: built.pageCount,
      commentCount: plan.ordered.length,
      unrendered: built.unrendered,
      fileName: summaryFileName(document.state.title),
    };
  } catch (error) {
    if (progress.cancelled) return null;
    throw error;
  } finally {
    progress.close();
  }
}
