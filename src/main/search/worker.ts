/**
 * Folder-search worker (M13, ADR 0012). A Node `worker_thread` started by `main/search/index.ts`
 * with its own PDFium instance, so searching a tree of documents never touches the window's
 * event loop and cancelling it is a `terminate()` rather than a co-operative flag no one checks.
 *
 * The wasm bytes arrive in `workerData` rather than being read here: in a packaged app they live
 * inside `app.asar`, and only the main process is certain to have Electron's asar-aware `fs`.
 *
 * The matching itself is the same pure code the find bar uses — `TextLayer` for the page model
 * and `find/search.ts` for the matcher — so a folder search cannot disagree with the search of a
 * document that happens to be open.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { PdfiumEngine } from '@engine/pdfium/PdfiumEngine';
import type { DocHandle } from '@engine/PdfEngine';
import { buildPageText } from '@view/TextLayer';
import {
  contextSnippet,
  findMatches,
  type FindOptions,
} from '@modules/M13-select-find-print/find/search';
import type { FolderSearchHit, FolderSearchRequest } from '../../shared/ipc';

interface WorkerInput {
  readonly wasm: Uint8Array;
  readonly request: FolderSearchRequest;
}

/** What the worker sends back. `done` is always last. */
export type SearchWorkerMessage =
  | {
      readonly kind: 'progress';
      readonly scanned: number;
      readonly total: number;
      readonly file: string;
    }
  | { readonly kind: 'results'; readonly hits: ReadonlyArray<FolderSearchHit> }
  | { readonly kind: 'done'; readonly hits: number; readonly error?: string };

/** Every PDF under `root`, sorted so a run is reproducible. */
export function listPdfs(root: string, recursive: boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // an unreadable folder is skipped, not fatal
    }
    for (const name of entries.sort()) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (recursive && depth < 24) walk(full, depth + 1);
      } else if (/\.pdf$/i.test(name)) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

const BATCH = 50;

async function run(input: WorkerInput): Promise<void> {
  const port = parentPort;
  if (!port) return;
  const { request } = input;
  const options: FindOptions = { ...request.options };
  const files = listPdfs(request.root, request.recursive);
  const engine = await PdfiumEngine.create({ wasm: input.wasm });
  let total = 0;
  let pending: FolderSearchHit[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    port.postMessage({ kind: 'results', hits: pending } satisfies SearchWorkerMessage);
    pending = [];
  };
  const add = (hit: FolderSearchHit): boolean => {
    pending.push(hit);
    total++;
    if (pending.length >= BATCH) flush();
    return total < request.maxHits;
  };

  try {
    for (const [index, path] of files.entries()) {
      port.postMessage({
        kind: 'progress',
        scanned: index,
        total: files.length,
        file: path,
      } satisfies SearchWorkerMessage);
      let doc: DocHandle | null = null;
      try {
        doc = await engine.open(new Uint8Array(readFileSync(path)));
        if (!(await searchDocument(engine, doc, path, request.query, options, add))) break;
      } catch {
        // An encrypted or broken file is skipped: a folder search that stops at the first bad
        // document would be useless on a real folder.
      } finally {
        if (doc !== null) await engine.close(doc).catch(() => undefined);
      }
    }
    flush();
    port.postMessage({
      kind: 'progress',
      scanned: files.length,
      total: files.length,
      file: '',
    } satisfies SearchWorkerMessage);
    port.postMessage({ kind: 'done', hits: total } satisfies SearchWorkerMessage);
  } catch (error) {
    flush();
    port.postMessage({
      kind: 'done',
      hits: total,
      error: error instanceof Error ? error.message : String(error),
    } satisfies SearchWorkerMessage);
  }
}

/** Searches one open document. Returns false when the hit limit has been reached. */
async function searchDocument(
  engine: PdfiumEngine,
  doc: DocHandle,
  path: string,
  query: string,
  options: FindOptions,
  add: (hit: FolderSearchHit) => boolean,
): Promise<boolean> {
  const name = basename(path);
  const pages = await engine.pageCount(doc);
  for (let page = 0; page < pages; page++) {
    const runs = await engine.textRuns(doc, page);
    const model = buildPageText(page, runs);
    for (const match of findMatches(model.text, query, options)) {
      if (
        !add({
          path,
          name,
          page,
          source: 'page',
          start: match.start,
          end: match.end,
          snippet: contextSnippet(model.text, match),
        })
      ) {
        return false;
      }
    }
    if (options.includeComments) {
      const annotations = await engine.annotations(doc, page);
      for (const annotation of annotations) {
        const text = [annotation.contents, annotation.subject].filter(Boolean).join(' ');
        if (!text) continue;
        for (const match of findMatches(text, query, options)) {
          if (
            !add({
              path,
              name,
              page,
              source: 'comment',
              start: match.start,
              end: match.end,
              snippet: contextSnippet(text, match),
              ...(annotation.author ? { label: annotation.author } : {}),
            })
          ) {
            return false;
          }
        }
      }
    }
  }
  if (options.includeBookmarks) {
    const titles = flattenOutline(await engine.outline(doc));
    for (const { title, page } of titles) {
      for (const match of findMatches(title, query, options)) {
        if (
          !add({
            path,
            name,
            page,
            source: 'bookmark',
            start: match.start,
            end: match.end,
            snippet: contextSnippet(title, match),
            label: title,
          })
        ) {
          return false;
        }
      }
    }
  }
  if (options.includeFormFields) {
    for (const field of await engine.formFields(doc)) {
      if (!field.value) continue;
      for (const match of findMatches(field.value, query, options)) {
        if (
          !add({
            path,
            name,
            page: field.widgets[0]?.page ?? -1,
            source: 'field',
            start: match.start,
            end: match.end,
            snippet: contextSnippet(field.value, match),
            label: field.name,
          })
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

interface OutlineLike {
  readonly title: string;
  readonly dest?: { readonly page: number } | undefined;
  readonly children: ReadonlyArray<OutlineLike>;
}

/** Bookmark titles with the page each one points at (-1 when it points nowhere). */
export function flattenOutline(
  items: ReadonlyArray<OutlineLike>,
): Array<{ title: string; page: number }> {
  const out: Array<{ title: string; page: number }> = [];
  const walk = (list: ReadonlyArray<OutlineLike>): void => {
    for (const item of list) {
      out.push({ title: item.title, page: item.dest?.page ?? -1 });
      walk(item.children);
    }
  };
  walk(items);
  return out;
}

if (parentPort) {
  void run(workerData as WorkerInput).catch((error: unknown) => {
    parentPort?.postMessage({
      kind: 'done',
      hits: 0,
      error: error instanceof Error ? error.message : String(error),
    } satisfies SearchWorkerMessage);
  });
}
