/**
 * M40 manifest — the Organize tab: insert, delete, extract, replace, rotate, move, duplicate,
 * reverse, swap, copy to another document, and page numbering.
 *
 * Every one of these is a registered command, so it is in the command palette, the e2e suite can
 * drive it by id, and the thumbnail context menu and the ribbon are two views of the same list
 * rather than two implementations. The commands themselves are thin: they read their arguments,
 * ask a dialog when there is something to ask, and call `OrganiseService`, which is where the
 * targeting rule and the engine work live.
 *
 * Arguments are uniform. Anything that acts on pages accepts `{ pages: number[] }` or
 * `{ range: "1-3,5" }`; with neither, it uses the thumbnail selection, and failing that the
 * current page. Passing `{ confirm: false }` skips a confirmation, which is how the tests drive
 * a destructive command without a dialog in the way.
 */

import { registerIcon } from '@app/icons';
import { SERVICE, type ShellServices } from '@app/services';
import type { Registry } from '@core/Registry';
import type { Selection } from '@core/Selection';
import type { Documents } from '@app/tabs/Documents';
import type { Document } from '@core/Document';
import { hasBridge, invoke } from '@shared/ipc';
import { el } from '@app/dom';
import {
  defineModule,
  type CommandSpec,
  type ServiceContext,
  type StatusItemSpec,
} from '@shared/module';
import { ArrowDownUp, BetweenHorizontalStart, Copy, FileOutput, Replace, Scissors } from 'lucide';
import { OrganiseService, ORGANISE_SERVICE, baseName, looksLikePdf } from './OrganiseService';
import { registerOrganiseCodecs } from './commands';
import {
  askBlankPages,
  askDocument,
  askExtract,
  askInsertFromFile,
  askMove,
  askPageLabels,
  askReplace,
  askRotate,
  askSwap,
  confirmDelete,
} from './dialogs';
import { danglingBookmarks } from './commands';
import { installThumbnailDrag, type ThumbnailDragController } from './dnd';
import { DEFAULT_LABEL_SPEC, LABEL_STYLES, type LabelStyle } from './labels';
import { countPages, formatRange } from './range';
import { ORGANISE_SETTINGS_SCHEMA } from './settings';

export { OrganiseService, ORGANISE_SERVICE } from './OrganiseService';
export { registerOrganiseCodecs } from './commands';

/** Set in `activate`, so the drag controller reaches the live service without a captured context. */
let live: OrganiseService | null = null;
let drag: ThumbnailDragController | null = null;

const org = (ctx: ServiceContext): OrganiseService =>
  ctx.service<OrganiseService>(ORGANISE_SERVICE);

const hasOrg = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(ORGANISE_SERVICE);

/** True when a document is open — every command here is gated on it. */
const hasDocument = (ctx: ServiceContext): boolean => hasOrg(ctx) && org(ctx).document !== null;

/** True when there is more than one page, so "delete" and "reverse" have something to do. */
const hasPages = (ctx: ServiceContext): boolean =>
  hasDocument(ctx) && (org(ctx).document?.pageCount ?? 0) > 1;

/** The target of a command, from its arguments or the selection. */
function target(ctx: ServiceContext & { args?: Readonly<Record<string, unknown>> }) {
  const service = org(ctx);
  return service.target({
    ...(ctx.args?.['pages'] === undefined ? {} : { pages: ctx.args['pages'] }),
    ...(ctx.args?.['range'] === undefined ? {} : { range: ctx.args['range'] }),
  });
}

// ---- insert --------------------------------------------------------------------------------------

const INSERT_COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    id: 'organize.insertBlank',
    label: 'Insert Blank Pages…',
    category: 'Organize',
    icon: 'file-plus',
    permission: 'assemble',
    description: 'Add empty pages of any size, anywhere in the document',
    when: hasDocument,
    run: async (ctx) => {
      const service = org(ctx);
      const doc = service.require();
      const where = target(ctx);
      const current = doc.state.pages[where.indexes[0] ?? 0];
      const size = current ? doc.pageSize(current.id) : null;
      const answer =
        ctx.args['count'] !== undefined
          ? {
              count: numberArg(ctx.args, 'count') ?? 1,
              size: {
                kind: 'preset' as const,
                id: stringArg(ctx.args, 'size') ?? service.settings.blankPageSize,
              },
              orientation:
                ctx.args['orientation'] === 'landscape'
                  ? ('landscape' as const)
                  : ('portrait' as const),
              position: service.settings.insertPosition,
              matchCurrent: false,
            }
          : await askBlankPages(service.dialogs, {
              settings: service.settings,
              matchSize: size
                ? `${String(Math.round(size.width))} × ${String(Math.round(size.height))} pt`
                : null,
            });
      if (!answer) return null;
      const at = numberArg(ctx.args, 'at') ?? service.insertIndex(answer.position, where, doc);
      // "Same as the current page" means exactly that: the size in points, not a preset that is
      // merely close to it.
      const ids =
        answer.matchCurrent && size
          ? await service.insertBlankExact({
              at,
              count: answer.count,
              width: size.width,
              height: size.height,
            })
          : await service.insertBlank({
              at,
              count: answer.count,
              size: answer.size,
              orientation: answer.orientation,
            });
      return service.record({ inserted: ids.length, at });
    },
  },
  {
    id: 'organize.insertFromFile',
    label: 'Insert Pages from a File…',
    category: 'Organize',
    icon: 'between-horizontal-start',
    shortcut: 'Mod+Shift+I',
    permission: 'assemble',
    description: 'Insert pages from a PDF — or from an image, a text file, HTML or Markdown',
    when: hasDocument,
    run: async (ctx) => {
      const service = org(ctx);
      const doc = service.require();
      const chosen = await filesFromArgsOrDialog(service, ctx.args);
      if (chosen.length === 0) return null;
      const where = target(ctx);
      let inserted = 0;
      // Where the *next* file goes. Recomputing this from `where` every time round would
      // put every file at the same index, so three chosen files would arrive back to front.
      let nextAt: number | null = numberArg(ctx.args, 'at') ?? null;
      for (const file of chosen) {
        const bytes = await service.pdfBytesOf(file);
        const source = await doc.engine.open(new Uint8Array(bytes), { name: file.name });
        let pages: ReadonlyArray<number>;
        let position = service.settings.insertPosition;
        let keepBookmarks = service.settings.keepBookmarksOnInsert;
        try {
          const count = await doc.engine.pageCount(source);
          // Only `sourcePages` says which pages of the *file* to take. `range` means what it
          // means everywhere else in this module — where in **this** document to put them —
          // so it must not also suppress the picker and quietly bring in all five hundred.
          const wanted = numbersArg(ctx.args, 'sourcePages');
          if (wanted !== undefined) {
            pages = wanted;
          } else {
            const answer = await askInsertFromFile(service.dialogs, {
              name: file.name,
              engine: doc.engine,
              doc: source,
              pageCount: count,
              settings: service.settings,
            });
            if (!answer) continue;
            pages = answer.pages;
            position = answer.position;
            keepBookmarks = answer.keepBookmarks;
          }
        } finally {
          await doc.engine.close(source).catch(() => undefined);
        }
        const at = nextAt ?? service.insertIndex(position, where, doc);
        const ids = await service.cancellable(() =>
          service.withProgress(
            { title: `Inserting from ${file.name}`, pages: pages.length },
            async (report, signal) =>
              await service.insertFrom({
                bytes,
                pages,
                at,
                keepBookmarks,
                name: file.name,
                label: `Insert ${countPages(pages.length)}`,
                report,
                signal,
              }),
          ),
        );
        if (ids === null) break;
        inserted += ids.length;
        nextAt = at + ids.length;
      }
      return service.record({ inserted });
    },
  },
  {
    id: 'organize.insertFromClipboard',
    label: 'Insert Pages from the Clipboard',
    category: 'Organize',
    icon: 'clipboard',
    permission: 'assemble',
    description: 'Turn whatever you copied — a picture, some text, a PDF — into pages here',
    when: hasDocument,
    run: async (ctx) => {
      const service = org(ctx);
      const doc = service.require();
      if (!hasBridge()) {
        await service.dialogs.error('Insert from the clipboard', 'The clipboard is not available.');
        return null;
      }
      const contents = await invoke('clipboard:read');
      const file =
        contents.image !== null
          ? { name: 'clipboard.png', bytes: contents.image }
          : contents.text.trim() !== ''
            ? { name: 'clipboard.txt', bytes: new TextEncoder().encode(contents.text) }
            : null;
      if (!file) {
        await service.dialogs.info(
          'Insert from the clipboard',
          'There is nothing on the clipboard that can become a page. Copy a picture or some text and try again.',
        );
        return null;
      }
      const bytes = await service.pdfBytesOf(file);
      const at = service.insertIndex(service.settings.insertPosition, target(ctx), doc);
      const ids = await service.cancellable(() =>
        service.withProgress(
          { title: 'Inserting from the clipboard' },
          async (report, signal) =>
            await service.insertFrom({
              bytes,
              at,
              keepBookmarks: false,
              name: file.name,
              label: 'Insert from the clipboard',
              report,
              signal,
            }),
        ),
      );
      if (ids === null) return null;
      return service.record({ inserted: ids.length, at });
    },
  },
];

/** Files named in the arguments (the e2e path) or chosen from the OS dialog. */
async function filesFromArgsOrDialog(
  service: OrganiseService,
  args: Readonly<Record<string, unknown>>,
): Promise<Array<{ name: string; bytes: Uint8Array; path?: string }>> {
  const given = args['files'];
  if (Array.isArray(given)) {
    return (given as unknown[]).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as { name?: unknown; bytes?: unknown; path?: unknown };
      const bytes = toBytes(record.bytes);
      if (!bytes || typeof record.name !== 'string') return [];
      return [
        {
          name: record.name,
          bytes,
          ...(typeof record.path === 'string' ? { path: record.path } : {}),
        },
      ];
    });
  }
  const path = stringArg(args, 'path');
  if (path !== undefined && hasBridge()) {
    const file = await invoke('file:read', path);
    return [{ name: file.name, bytes: file.bytes, path: file.path }];
  }
  return await service.chooseFiles();
}

/**
 * Typed argument readers.
 *
 * A command's arguments cross the e2e bridge and the command palette, so they arrive as
 * `unknown` and have to be *checked* rather than coerced: `String(args.style)` on an object
 * silently produces "[object Object]" and then a page label nobody asked for.
 */
function numberArg(args: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArg(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * A numbering style the dialog actually offers.
 *
 * `numeral()` is an exhaustive switch with no default, so a style it has never heard of
 * returns `undefined` and every page in the range ends up labelled with the literal string
 * "undefined" — as a real, undoable change. A plausible typo (`roman` for `romanLower`) is
 * enough to do it, so the value is checked against the list rather than cast to it.
 */
function labelStyleArg(args: Readonly<Record<string, unknown>>): LabelStyle {
  const given = stringArg(args, 'style');
  const known = LABEL_STYLES.find((option) => option.value === given);
  return known?.value ?? DEFAULT_LABEL_SPEC.style;
}

function numbersArg(args: Readonly<Record<string, unknown>>, key: string): number[] | undefined {
  const value = args[key];
  return Array.isArray(value)
    ? (value as unknown[]).filter((p): p is number => typeof p === 'number')
    : undefined;
}

/** Playwright's structured clone turns a `Uint8Array` into a plain array; accept both. */
function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as ArrayLike<number>);
  return null;
}

// ---- the page operations ---------------------------------------------------------------------

const PAGE_COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    id: 'organize.deletePages',
    label: 'Delete Pages',
    category: 'Organize',
    icon: 'trash-2',
    shortcut: 'Mod+Shift+D',
    permission: 'assemble',
    description: 'Delete the selected pages, and the bookmarks that pointed at them',
    when: hasPages,
    run: async (ctx) => {
      const service = org(ctx);
      const doc = service.require();
      const where = target(ctx);
      if (where.ids.length === 0) return service.record({ deleted: 0 });
      const bookmarks = service.settings.pruneBookmarksOnDelete
        ? danglingBookmarks(doc, new Set<string>(where.ids)).length
        : 0;
      const ask = ctx.args['confirm'] !== false && service.settings.confirmDelete;
      if (ask && !(await confirmDelete(service.dialogs, { pages: where.indexes, bookmarks }))) {
        return service.record({ deleted: 0 });
      }
      const deleted = await service.deletePages(where);
      return service.record({ deleted, pages: where.text, bookmarks });
    },
  },
  {
    id: 'organize.extractPages',
    label: 'Extract Pages…',
    category: 'Organize',
    icon: 'file-output',
    shortcut: 'Mod+Shift+X',
    permission: 'assemble',
    description: 'Copy pages out into a new document, a file, or one file per page',
    when: hasDocument,
    run: async (ctx) => {
      const service = org(ctx);
      const doc = service.require();
      const where = target(ctx);
      const answer =
        ctx.args['destination'] === undefined
          ? await askExtract(service.dialogs, {
              context: service.rangeContext(doc),
              value: where.text,
              settings: service.settings,
            })
          : {
              pages: where.indexes,
              destination: (stringArg(ctx.args, 'destination') ?? 'tab') as
                'tab' | 'file' | 'perPage',
              withComments: ctx.args['withComments'] !== false,
              deleteAfter: ctx.args['deleteAfter'] === true,
            };
      if (!answer) return null;
      const chosen = service.targetOf(answer.pages, doc);
      if (chosen.ids.length === 0) return null;
      const outcome = await service.cancellable(() => extractTo(service, chosen, answer, ctx.args));
      if (outcome === null || outcome === undefined) return null;
      // `doc`, named explicitly. Extracting into a new tab *activates* that tab, so asking
      // for the active document here would delete from the extract rather than from its
      // source — and the extract holds exactly these pages, so it would refuse and then
      // report that they had gone.
      if (answer.deleteAfter) await service.deletePages(chosen, doc);
      return service.record({ ...outcome, deletedAfter: answer.deleteAfter });
    },
  },
  {
    id: 'organize.replacePages',
    label: 'Replace Pages…',
    category: 'Organize',
    icon: 'replace',
    permission: 'assemble',
    description: 'Put pages from another file in the place of these ones',
    when: hasDocument,
    run: async (ctx) => {
      const service = org(ctx);
      const doc = service.require();
      const chosen = await filesFromArgsOrDialog(service, ctx.args);
      const file = chosen[0];
      if (!file) return null;
      const bytes = await service.pdfBytesOf(file);
      const where = target(ctx);
      const source = await doc.engine.open(new Uint8Array(bytes), { name: file.name });
      let answer;
      try {
        const count = await doc.engine.pageCount(source);
        answer =
          ctx.args['sourcePages'] === undefined && ctx.args['range'] === undefined
            ? await askReplace(service.dialogs, {
                context: service.rangeContext(doc),
                value: where.text,
                sourceName: file.name,
                sourcePageCount: count,
              })
            : {
                target: where.indexes,
                source:
                  numbersArg(ctx.args, 'sourcePages') ?? Array.from({ length: count }, (_, i) => i),
              };
      } finally {
        await doc.engine.close(source).catch(() => undefined);
      }
      if (!answer) return null;
      const chosenTarget = service.targetOf(answer.target, doc);
      if (chosenTarget.ids.length === 0) return null;
      const inserted = await service.cancellable(() =>
        service.withProgress(
          {
            title: `Replacing ${countPages(chosenTarget.ids.length)}`,
            pages: answer.source.length,
          },
          async (report, signal) =>
            await service.replace({
              target: chosenTarget,
              bytes,
              pages: answer.source,
              name: file.name,
              report,
              signal,
            }),
        ),
      );
      if (inserted === null) return null;
      return service.record({ replaced: chosenTarget.ids.length, inserted });
    },
  },
  {
    id: 'organize.duplicatePages',
    label: 'Duplicate Pages',
    category: 'Organize',
    icon: 'copy',
    permission: 'assemble',
    description: 'Put a copy of the selected pages straight after them',
    when: hasDocument,
    run: async (ctx) => {
      const service = org(ctx);
      const where = target(ctx);
      if (where.ids.length === 0) return service.record({ duplicated: 0 });
      const at = (where.indexes[where.indexes.length - 1] ?? 0) + 1;
      const ids = await service.cancellable(() =>
        service.withProgress(
          { title: `Duplicating ${countPages(where.ids.length)}`, pages: where.ids.length },
          async () => await service.duplicate(where, at),
        ),
      );
      if (ids === null) return null;
      return service.record({ duplicated: ids.length, at });
    },
  },
  {
    id: 'organize.reversePages',
    label: 'Reverse Pages',
    category: 'Organize',
    icon: 'arrow-down-up',
    permission: 'assemble',
    description: 'Turn the selected pages back to front; with none selected, the whole document',
    when: hasPages,
    run: async (ctx) => {
      const service = org(ctx);
      const doc = service.require();
      // Reversing "the current page" means nothing, so with no selection this is the document.
      const explicit = ctx.args['pages'] !== undefined || ctx.args['range'] !== undefined;
      const where =
        explicit || service.selectedPages().length > 1
          ? target(ctx)
          : service.targetOf(
              doc.state.pages.map((_, i) => i),
              doc,
            );
      const changed = await service.reversePages(where.ids);
      return service.record({ reversed: changed ? where.ids.length : 0 });
    },
  },
  {
    id: 'organize.movePages',
    label: 'Move Pages…',
    category: 'Organize',
    icon: 'move',
    permission: 'assemble',
    description: 'Move the selected pages somewhere else in the document',
    when: hasPages,
    run: async (ctx) => {
      const service = org(ctx);
      const doc = service.require();
      const where = target(ctx);
      const answer =
        numberArg(ctx.args, 'to') !== undefined
          ? { pages: where.indexes, to: numberArg(ctx.args, 'to') ?? 0 }
          : await askMove(service.dialogs, {
              context: service.rangeContext(doc),
              value: where.text,
            });
      if (!answer) return null;
      const chosen = service.targetOf(answer.pages, doc);
      const moved = await service.movePages(chosen.ids, answer.to);
      return service.record({ moved: moved ? chosen.ids.length : 0, to: answer.to });
    },
  },
  {
    id: 'organize.swapPages',
    label: 'Swap Two Pages…',
    category: 'Organize',
    icon: 'arrow-down-up',
    permission: 'assemble',
    when: hasPages,
    run: async (ctx) => {
      const service = org(ctx);
      const doc = service.require();
      const where = target(ctx);
      const answer =
        numberArg(ctx.args, 'a') !== undefined && numberArg(ctx.args, 'b') !== undefined
          ? { a: numberArg(ctx.args, 'a') ?? 0, b: numberArg(ctx.args, 'b') ?? 0 }
          : await askSwap(service.dialogs, {
              pageCount: doc.pageCount,
              first: where.indexes[0] ?? 0,
            });
      if (!answer) return null;
      const a = doc.state.pages[answer.a]?.id;
      const b = doc.state.pages[answer.b]?.id;
      if (!a || !b) return null;
      const swapped = await service.swapPages(a, b);
      return service.record({ swapped });
    },
  },
  {
    id: 'organize.copyToDocument',
    label: 'Copy Pages to Another Document…',
    category: 'Organize',
    icon: 'copy',
    permission: 'assemble',
    description: 'The same thing dragging pages onto another document’s tab does',
    when: hasDocument,
    run: async (ctx) => {
      const service = org(ctx);
      const where = target(ctx);
      const active = service.documents.active;
      const others = service.documents.tabs.filter((t) => t.id !== active?.id);
      const tabId =
        stringArg(ctx.args, 'tabId') ??
        (await askDocument(service.dialogs, {
          title: 'Copy pages to another document',
          tabs: others.map((t) => ({ id: t.id, title: t.title })),
        }));
      if (tabId === null) return null;
      const copied = await service.cancellable(() =>
        service.withProgress(
          { title: `Copying ${countPages(where.ids.length)}`, pages: where.ids.length },
          async () => await service.copyToDocument(where, tabId),
        ),
      );
      if (copied === null) return null;
      service.toasts.show({
        kind: 'success',
        text: `Copied ${countPages(copied)} into ${service.documents.get(tabId)?.title ?? 'the other document'}.`,
      });
      return service.record({ copied, tabId });
    },
  },
];

/** Where extracted pages go. Returns null when the reader backed out of the file dialog. */
async function extractTo(
  service: OrganiseService,
  chosen: ReturnType<OrganiseService['target']>,
  answer: { destination: 'tab' | 'file' | 'perPage'; withComments: boolean },
  args: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown> | null> {
  const doc = service.require();
  const name = baseName(doc.state.title);

  if (answer.destination === 'perPage') {
    const folder =
      stringArg(args, 'folder') ??
      (await service.askWhereToSave(service.fileNameForPage(chosen.indexes[0] ?? 0, doc)));
    if (folder === null) return null;
    const directory = folder.replace(/[^/\\]*$/u, '');
    const written: string[] = [];
    await service.withProgress(
      { title: 'Extracting one file per page', pages: chosen.indexes.length },
      async (report, signal) => {
        for (const [i, index] of chosen.indexes.entries()) {
          const one = service.targetOf([index], doc);
          const bytes = await service.extractBytes(one, {
            withComments: answer.withComments,
            signal,
          });
          const path = `${directory}${service.fileNameForPage(index, doc)}`;
          await service.writeFile(path, bytes);
          written.push(path);
          report((i + 1) / chosen.indexes.length, `Page ${String(index + 1)}`);
        }
      },
    );
    service.toasts.show({
      kind: 'success',
      text: `Extracted ${countPages(written.length)} into ${written.length === 1 ? 'a file' : 'separate files'}.`,
    });
    return { extracted: chosen.indexes.length, files: written.length, destination: 'perPage' };
  }

  const bytes = await service.withProgress(
    { title: `Extracting ${countPages(chosen.ids.length)}`, pages: chosen.ids.length },
    async (report, signal) =>
      await service.extractBytes(chosen, { withComments: answer.withComments, report, signal }),
  );

  if (answer.destination === 'file') {
    const path =
      stringArg(args, 'path') ??
      (await service.askWhereToSave(`${name} ${formatRange(chosen.indexes)}.pdf`));
    if (path === null) return null;
    const written = await service.writeFile(path, bytes);
    if (written) {
      service.toasts.show({
        kind: 'success',
        text: `Extracted ${countPages(chosen.ids.length)} to ${path}.`,
      });
    }
    return { extracted: chosen.ids.length, path, destination: 'file' };
  }

  const tab = await service.openInNewTab(bytes, `${name} ${formatRange(chosen.indexes)}`);
  return { extracted: chosen.ids.length, tabId: tab.id, destination: 'tab' };
}

// ---- rotate ----------------------------------------------------------------------------------

/**
 * Range-aware rotation.
 *
 * M20 registered `page.rotateRight` / `page.rotateLeft` as scaffolding "so the model is reachable
 * before M40 lands", and they act on a page named by argument, defaulting to the first. These act
 * on what is selected, which is what a reader pressing a button on the Organize tab means — so
 * these are the ones the Organize ribbon carries now.
 */
const ROTATE_COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    id: 'organize.rotateRight',
    label: 'Rotate Right',
    category: 'Organize',
    icon: 'rotate-cw',
    permission: 'assemble',
    description: 'Turn the selected pages 90° clockwise',
    when: hasDocument,
    run: async (ctx) => {
      const service = org(ctx);
      const where = target(ctx);
      return service.record({ rotated: await service.rotate(where, 90) });
    },
  },
  {
    id: 'organize.rotateLeft',
    label: 'Rotate Left',
    category: 'Organize',
    icon: 'rotate-ccw',
    permission: 'assemble',
    description: 'Turn the selected pages 90° anticlockwise',
    when: hasDocument,
    run: async (ctx) => {
      const service = org(ctx);
      const where = target(ctx);
      return service.record({ rotated: await service.rotate(where, 270) });
    },
  },
  {
    id: 'organize.rotate180',
    label: 'Turn Pages Upside Down',
    category: 'Organize',
    icon: 'rotate-cw',
    permission: 'assemble',
    description: 'Turn the selected pages 180°',
    when: hasDocument,
    run: async (ctx) => {
      const service = org(ctx);
      const where = target(ctx);
      return service.record({ rotated: await service.rotate(where, 180) });
    },
  },
  {
    id: 'organize.rotatePages',
    label: 'Rotate Pages…',
    category: 'Organize',
    icon: 'rotate-cw',
    permission: 'assemble',
    description: 'Choose a range and an angle',
    when: hasDocument,
    run: async (ctx) => {
      const service = org(ctx);
      const doc = service.require();
      const where = target(ctx);
      const answer = await askRotate(service.dialogs, {
        context: service.rangeContext(doc),
        value: where.text,
      });
      if (!answer) return null;
      const chosen = service.targetOf(answer.pages, doc);
      return service.record({ rotated: await service.rotate(chosen, answer.degrees) });
    },
  },
];

// ---- moving with the keyboard ------------------------------------------------------------------

/** The keyboard alternative to dragging, which the brief asks for by name. */
const NUDGE_COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    id: 'organize.movePageUp',
    label: 'Move Pages Earlier',
    category: 'Organize',
    icon: 'chevron-up',
    shortcut: 'Mod+Shift+ArrowUp',
    permission: 'assemble',
    description: 'Move the selected pages one place towards the start',
    when: hasPages,
    run: async (ctx) => await nudge(ctx, -1),
  },
  {
    id: 'organize.movePageDown',
    label: 'Move Pages Later',
    category: 'Organize',
    icon: 'chevron-down',
    shortcut: 'Mod+Shift+ArrowDown',
    permission: 'assemble',
    description: 'Move the selected pages one place towards the end',
    when: hasPages,
    run: async (ctx) => await nudge(ctx, 1),
  },
  {
    id: 'organize.movePagesToStart',
    label: 'Move Pages to the Start',
    category: 'Organize',
    icon: 'chevrons-up',
    permission: 'assemble',
    when: hasPages,
    run: async (ctx) => {
      const service = org(ctx);
      const where = target(ctx);
      const moved = await service.movePages(where.ids, 0);
      return service.record({ moved: moved ? where.ids.length : 0, to: 0 });
    },
  },
  {
    id: 'organize.movePagesToEnd',
    label: 'Move Pages to the End',
    category: 'Organize',
    icon: 'chevrons-down',
    permission: 'assemble',
    when: hasPages,
    run: async (ctx) => {
      const service = org(ctx);
      const doc = service.require();
      const where = target(ctx);
      const moved = await service.movePages(where.ids, doc.pageCount);
      return service.record({ moved: moved ? where.ids.length : 0, to: doc.pageCount });
    },
  },
];

/** One step earlier or later, keeping the selection on the pages that moved. */
async function nudge(
  ctx: ServiceContext & { args?: Readonly<Record<string, unknown>> },
  direction: 1 | -1,
): Promise<unknown> {
  const service = org(ctx);
  const doc = service.require();
  const where = target(ctx);
  if (where.indexes.length === 0) return service.record({ moved: 0 });
  const first = where.indexes[0] ?? 0;
  const last = where.indexes[where.indexes.length - 1] ?? 0;
  // Moving up by one means landing before the page above; moving down, after the page below.
  const to = direction < 0 ? Math.max(0, first - 1) : Math.min(doc.pageCount, last + 2);
  // movePages keeps the selection on the pages that moved, so pressing this again moves the
  // same ones rather than whichever pages have arrived at the index they left.
  const moved = await service.movePages(where.ids, to);
  return service.record({ moved: moved ? where.ids.length : 0 });
}

// ---- page numbering ------------------------------------------------------------------------------

const LABEL_COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    id: 'organize.pageLabels',
    label: 'Page Numbering…',
    category: 'Organize',
    icon: 'hash',
    permission: 'assemble',
    description:
      'Number a run of pages — 1, 2, 3 or i, ii, iii or A-1, A-2 — as the file records it',
    when: hasDocument,
    run: async (ctx) => {
      const service = org(ctx);
      const doc = service.require();
      const where = target(ctx);
      const answer =
        ctx.args['style'] === undefined
          ? await askPageLabels(service.dialogs, {
              context: service.rangeContext(doc),
              value: where.text,
              spec: DEFAULT_LABEL_SPEC,
            })
          : {
              pages: where.indexes,
              style: labelStyleArg(ctx.args),
              prefix: stringArg(ctx.args, 'prefix') ?? '',
              start: numberArg(ctx.args, 'start') ?? 1,
            };
      if (!answer) return null;
      const chosen = service.targetOf(answer.pages, doc);
      const changed = await service.setLabels(chosen, {
        style: answer.style,
        prefix: answer.prefix,
        start: answer.start,
      });
      return service.record({ renumbered: changed, labels: doc.state.pages.map((p) => p.label) });
    },
  },
  {
    id: 'organize.clearPageLabels',
    label: 'Remove Page Numbering',
    category: 'Organize',
    icon: 'hash',
    permission: 'assemble',
    description: 'Put the plain 1, 2, 3 numbering back on the selected pages',
    when: hasDocument,
    run: async (ctx) => {
      const service = org(ctx);
      const where = target(ctx);
      return service.record({ renumbered: await service.clearLabels(where) });
    },
  },
];

// ---- developer commands: how the e2e suite reads this module back ------------------------------

const DEV_COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    id: 'dev.organiseState',
    label: 'Organise: state',
    category: 'Developer',
    hidden: true,
    description: 'Internal: page order, labels, the target rule and the last outcome',
    when: hasOrg,
    run: (ctx) => {
      const service = org(ctx);
      const doc = service.document;
      return {
        settings: service.settings,
        last: service.lastOutcome,
        dragging: drag?.dragging ?? false,
        selection: service.selectedPages(),
        target: doc ? service.target({}, doc).indexes : [],
        pageCount: doc?.pageCount ?? 0,
        pageIds: doc ? doc.state.pages.map((p) => String(p.id)) : [],
        labels: doc ? doc.state.pages.map((p) => p.label) : [],
        rotations: doc ? doc.state.pages.map((p) => p.rotation) : [],
        outline: doc
          ? doc.state.outline.map((o) => {
              const dest = o.destinationId === null ? null : doc.destination(o.destinationId);
              return {
                title: o.title,
                page: dest?.pageId == null ? -1 : doc.pageIndex(dest.pageId),
              };
            })
          : [],
      };
    },
  },
  {
    id: 'dev.organiseSelect',
    label: 'Organise: select pages',
    category: 'Developer',
    hidden: true,
    description: 'Internal: set the thumbnail page selection (pass { pages })',
    when: hasOrg,
    run: (ctx) => {
      const service = org(ctx);
      const pages = numbersArg(ctx.args, 'pages') ?? [];
      service.selection.set(pages.length === 0 ? { kind: 'none' } : { kind: 'pages', pages });
      return service.selectedPages();
    },
  },
  {
    id: 'dev.pageAnnotations',
    label: 'Organise: annotations on a page',
    category: 'Developer',
    hidden: true,
    description:
      'Internal: the annotations the engine reports for a page, so an extract can be checked',
    when: hasDocument,
    run: async (ctx) => {
      const doc = org(ctx).require();
      const page = numberArg(ctx.args, 'page') ?? 0;
      const index = doc.enginePage(doc.page(page).id);
      if (index === undefined) return [];
      const list = await doc.engine.annotations(doc.handle, index);
      return list.map((a) => ({ id: a.id, subtype: a.subtype }));
    },
  },
  {
    id: 'dev.activeTabId',
    label: 'Organise: the active tab',
    category: 'Developer',
    hidden: true,
    description: 'Internal: the id of the tab in front, for the copy-to-document test',
    when: hasOrg,
    run: (ctx) => org(ctx).documents.active?.id ?? null,
  },
  {
    id: 'dev.organiseDrop',
    label: 'Organise: drop dragged pages',
    category: 'Developer',
    hidden: true,
    description:
      'Internal: the effect of a drag, without a pointer (pass { pages, index } or { pages, tabId })',
    when: hasDocument,
    run: async (ctx) => {
      const service = org(ctx);
      const doc = service.require();
      const pages = numbersArg(ctx.args, 'pages') ?? service.selectedPages();
      const where = service.targetOf(pages, doc);
      const tabId = stringArg(ctx.args, 'tabId');
      if (tabId !== undefined) {
        return service.record({ copied: await service.copyToDocument(where, tabId) });
      }
      const index = numberArg(ctx.args, 'index') ?? 0;
      if (ctx.args['copy'] === true) {
        const ids = await service.duplicate(where, index);
        return service.record({ copied: ids.length, index });
      }
      const moved = await service.movePages(where.ids, index);
      return service.record({ moved: moved ? where.ids.length : 0, index });
    },
  },
];

/**
 * The page's own number, in the status bar, beside the shell's "3 of 6".
 *
 * They are not the same thing. The shell field is the page's *position*; this is what the
 * document calls it — "A-1", "iii" — which is what the reader sees printed on the paper and what
 * a colleague means on the telephone. It appears only when the document actually uses page
 * numbering, so an ordinary file gains no clutter, and it is a word plus the value rather than a
 * bare string, because "iii" on its own in a status bar means nothing.
 */
const NUMBERING_STATUS: StatusItemSpec = {
  id: 'organize.pageLabel',
  slot: 'left',
  order: 20,
  mount: (host, ctx) => {
    const wrap = el('div.status-field.status-page-label');
    const label = el('span', null, 'Numbered');
    const value = el('span.status-page-label-value', { 'aria-live': 'polite' });
    wrap.append(label, value);
    wrap.hidden = true;
    host.append(wrap);

    const refresh = (): void => {
      const service = live;
      const doc = service?.document ?? null;
      if (!service || !doc) {
        wrap.hidden = true;
        return;
      }
      const page = doc.state.pages[service.currentPage];
      // "Numbered 3" for a page that is simply the third one says nothing worth the space.
      const numbered = doc.state.pages.some((p, i) => p.label !== String(i + 1));
      if (!page || !numbered) {
        wrap.hidden = true;
        return;
      }
      wrap.hidden = false;
      value.textContent = page.label;
      wrap.title = `This page is numbered ${page.label} in the document`;
    };

    const shell = ctx.service<ShellServices>('shellServices');
    const stops = [
      shell.ui.select(
        (state) => state.view.page,
        () => {
          refresh();
        },
      ),
      shell.documents.subscribe(() => {
        refresh();
      }),
    ];
    // A renumbering is a document change, not a view change, so the document is watched too.
    let stopDocument: (() => void) | null = null;
    let watched: Document | null = null;
    const rebind = (): void => {
      const doc = live?.document ?? null;
      if (doc === watched) return;
      stopDocument?.();
      watched = doc;
      stopDocument = doc
        ? doc.store.subscribe(() => {
            refresh();
          })
        : null;
    };
    stops.push(
      shell.documents.subscribe(() => {
        rebind();
      }),
    );
    rebind();
    refresh();
    return () => {
      stopDocument?.();
      for (const stop of stops) stop();
      wrap.remove();
    };
  },
};

// ---- the manifest ---------------------------------------------------------------------------------

/** The Insert menu, shared by the ribbon split button and the thumbnail context menu. */
const INSERT_MENU = [
  'organize.insertBlank',
  'organize.insertFromFile',
  'organize.insertFromClipboard',
] as const;

export default defineModule({
  id: 'M40',
  name: 'Organise pages',
  settings: ORGANISE_SETTINGS_SCHEMA,

  commands: [
    ...INSERT_COMMANDS,
    ...PAGE_COMMANDS,
    ...ROTATE_COMMANDS,
    ...NUDGE_COMMANDS,
    ...LABEL_COMMANDS,
    ...DEV_COMMANDS,
  ],

  ribbon: [
    {
      id: 'organize.insert',
      tab: 'organize',
      label: 'Insert',
      order: 5,
      when: hasDocument,
      large: ['organize.insertFromFile'],
      items: [
        { kind: 'button', command: 'organize.insertFromFile', size: 'large' },
        {
          kind: 'dropdown',
          id: 'organize.insertMenu',
          label: 'Insert',
          icon: 'between-horizontal-start',
          menu: [...INSERT_MENU],
        },
      ],
    },
    {
      id: 'organize.pages',
      tab: 'organize',
      label: 'Pages',
      order: 8,
      when: hasDocument,
      large: ['organize.deletePages'],
      items: [
        { kind: 'button', command: 'organize.deletePages', size: 'large' },
        'organize.extractPages',
        'organize.replacePages',
        '-',
        'organize.duplicatePages',
        'organize.reversePages',
        'organize.movePages',
        'organize.swapPages',
        'organize.copyToDocument',
      ],
    },
    {
      id: 'organize.rotate',
      tab: 'organize',
      label: 'Rotate',
      order: 10,
      when: hasDocument,
      items: [
        'organize.rotateLeft',
        'organize.rotateRight',
        {
          kind: 'dropdown',
          id: 'organize.rotateMenu',
          label: 'More rotations',
          icon: 'rotate-cw',
          menu: ['organize.rotate180', 'organize.rotatePages'],
        },
      ],
    },
    {
      id: 'organize.numbering',
      tab: 'organize',
      label: 'Page numbering',
      order: 12,
      when: hasDocument,
      items: ['organize.pageLabels', 'organize.clearPageLabels'],
    },
  ],

  statusBar: [NUMBERING_STATUS],

  contextMenus: [
    {
      // M12's thumbnails panel. Its own right-click handler selects the page under the pointer
      // first, so these act on what was clicked rather than on a stale selection.
      id: 'organize.thumbnailMenu',
      region: '[data-panel-scroll="pages"]',
      order: 10,
      when: hasDocument,
      items: [
        'organize.rotateLeft',
        'organize.rotateRight',
        '-',
        { label: 'Insert', submenu: [...INSERT_MENU] },
        'organize.duplicatePages',
        'organize.extractPages',
        'organize.replacePages',
        'organize.deletePages',
        '-',
        'organize.movePages',
        'organize.movePageUp',
        'organize.movePageDown',
        'organize.reversePages',
        'organize.copyToDocument',
        '-',
        'organize.pageLabels',
      ],
    },
  ],

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (!registry.hasService('shellServices')) return undefined;
    // `Registry.dispose()` runs the disposers but leaves the services registered, so a
    // dispose-then-activate cycle arrives here with the service still in place. Bailing out
    // would leave `live` and `drag` null for the rest of the session: the commands would go on
    // working, because they resolve the service by name, while the drag and the status field
    // silently did not.
    const existing = registry.hasService(ORGANISE_SERVICE)
      ? registry.service<OrganiseService>(ORGANISE_SERVICE)
      : null;
    registerIcon('between-horizontal-start', BetweenHorizontalStart);
    registerIcon('file-output', FileOutput);
    registerIcon('replace', Replace);
    registerIcon('arrow-down-up', ArrowDownUp);
    registerIcon('scissors', Scissors);
    registerIcon('copy', Copy);
    registerOrganiseCodecs();
    const shell = registry.service<ShellServices>('shellServices');
    const service = existing ?? new OrganiseService({ registry, shell });
    live = service;
    if (existing === null) {
      registry.provide(ORGANISE_SERVICE, service);
      void service.load();
    }
    // Never two controllers on one window: the second would move every dragged page twice.
    drag?.dispose();

    // The drag controller is installed once, for the whole window: M12's grid builds and drops
    // cells as it scrolls, so anything bound to a cell would not survive its own auto-scroll.
    const documents = registry.service<Documents>(SERVICE.documents);
    const selection = registry.service<Selection>('selection');
    drag = installThumbnailDrag({
      selection,
      pageCount: () => service.document?.pageCount ?? 0,
      activeTabId: () => documents.active?.id ?? null,
      onDrop: async (pages, dropTarget) => {
        const doc = service.document;
        if (!doc) return;
        const where = service.targetOf(pages, doc);
        try {
          if (dropTarget.kind === 'tab') {
            const copied = await service.copyToDocument(where, dropTarget.tabId);
            service.toasts.show({
              kind: 'success',
              text: `Copied ${countPages(copied)} into ${documents.get(dropTarget.tabId)?.title ?? 'the other document'}.`,
            });
            return;
          }
          if (dropTarget.copy) await service.duplicate(where, dropTarget.index);
          else await service.movePages(where.ids, dropTarget.index);
        } catch (error) {
          if (OrganiseService.cancelled(error)) return;
          await service.dialogs.error(
            'Move pages',
            error instanceof Error ? error.message : 'The pages could not be moved.',
          );
        }
      },
    });

    return () => {
      drag?.dispose();
      drag = null;
      live = null;
    };
  },
});

/** Exposed for the unit tests, which drive the service without the shell. */
export function activeOrganiseService(): OrganiseService | null {
  return live;
}

/** Re-exported so the tests can name the same helper the commands use. */
export { looksLikePdf };
