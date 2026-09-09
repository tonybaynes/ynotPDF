/**
 * M32 manifest — the Comments panel, replies and status, FDF/XFDF, and the comment summary.
 *
 * Every action is a registered command, so it is in the palette, M130's shortcut editor can
 * rebind it, and the e2e suite drives it by id rather than by pixel. The ones that take arguments
 * take them as plain data — `{ comment, text }` for a reply, `{ comment, status }` for a status,
 * `{ path, policy }` for an import — so a batch (M120) can run the same code with no UI at all.
 *
 * The probes at the bottom are how the acceptance tests read this module out of the running app.
 */

import { CircleSlash, Eye, EyeOff, MessageSquare, MessageSquarePlus, Reply } from 'lucide';
import { registerIcon } from '@app/icons';
import type { ShellServices } from '@app/services';
import { SERVICE } from '@app/services';
import type { Registry } from '@core/Registry';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import { hasBridge, invoke } from '@shared/ipc';
import { defineModule, type CommandSpec, type ServiceContext } from '@shared/module';
import { clampFontSize, type SummaryOptions } from '@engine/summary';
import { formatOfName, readComments, XfdfError, type CommentFormat } from '@engine/xfdf';
import {
  ANNOTATION_SERVICE,
  type AnnotationService,
} from '@modules/M30-markup-annotations/AnnotationService';
import { CommentsService, COMMENTS_PANEL_ID, COMMENTS_SERVICE } from './CommentsService';
import { mountCommentsPanel } from './CommentsPanel';
import { askExportOptions, askImportOptions, askSummaryOptions, parseRange } from './dialogs';
import { exportComments, importComments, serialiseComments } from './exchange';
import { COMMENT_SETTINGS_SCHEMA, ipcSettingsStorage } from './settings';
import { STATUSES, statusSpec, type StatusId } from './status';
import { runSummary } from './summarise';
import type { GroupBy, SortBy } from './rows';

export { CommentsService, COMMENTS_SERVICE, COMMENTS_PANEL_ID } from './CommentsService';

/*
 * Registered at module scope, not in `activate`: the ribbon is built before manifests are
 * activated, and an icon registered later paints as a placeholder on the first frame.
 */
registerIcon('message-square-plus', MessageSquarePlus);
registerIcon('reply', Reply);
registerIcon('circle-slash', CircleSlash);
registerIcon('eye', Eye);
registerIcon('eye-off', EyeOff);
registerIcon('message-square', MessageSquare);

let live: CommentsService | null = null;

const service = (ctx: ServiceContext): CommentsService =>
  ctx.service<CommentsService>(COMMENTS_SERVICE);

const hasService = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(COMMENTS_SERVICE);

const open = (ctx: ServiceContext): boolean =>
  hasService(ctx) && service(ctx).activeDocument() !== null;

const hasComments = (ctx: ServiceContext): boolean =>
  hasService(ctx) && service(ctx).comments().length > 0;

/** The comment a command acts on: the argument, else the panel's selection. */
function target(
  ctx: { readonly args: Readonly<Record<string, unknown>> },
  s: CommentsService,
): ModelId | null {
  const given = ctx.args['comment'];
  if (typeof given === 'string') return given as ModelId;
  const selected = s.annotations.selection[0];
  if (selected !== undefined && s.threadOf(selected)) return selected;
  return null;
}

const hasSelection = (ctx: ServiceContext): boolean =>
  open(ctx) && target({ args: {} }, service(ctx)) !== null;

function statusCommand(spec: (typeof STATUSES)[number]): CommandSpec {
  return {
    id: `comments.status.${spec.id}`,
    label: `Mark as ${spec.label}`,
    category: 'Comment',
    icon: spec.icon,
    description: `Set the selected comment's review status to ${spec.label}`,
    permission: 'annotate',
    when: hasSelection,
    run: async (ctx) => {
      const s = service(ctx);
      const id = target(ctx, s);
      if (!id) return null;
      return s.setStatus(id, spec.id);
    },
  };
}

export default defineModule({
  id: 'M32',
  name: 'Comments',

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(COMMENTS_SERVICE)) return undefined;
    if (!registry.hasService(ANNOTATION_SERVICE)) return undefined;
    const shell = registry.service<ShellServices>('shellServices');
    const annotations = registry.service<AnnotationService>(ANNOTATION_SERVICE);
    const comments = new CommentsService({
      registry,
      shell,
      annotations,
      storage: ipcSettingsStorage(),
    });
    live = comments;
    registry.provide(COMMENTS_SERVICE, comments);
    void comments.load();
    return () => {
      live = null;
      comments.dispose();
    };
  },

  settings: COMMENT_SETTINGS_SCHEMA,

  panels: [
    {
      id: COMMENTS_PANEL_ID,
      title: 'Comments',
      dock: 'left',
      icon: 'message-square',
      order: 50,
      toggleCommand: 'comments.panel',
      mount: (element, context) => mountCommentsPanel(element, context, service(context)),
    },
  ],

  commands: [
    {
      id: 'comments.panel',
      label: 'Comments',
      category: 'Comment',
      icon: 'message-square',
      shortcut: 'Mod+Alt+C',
      keyTip: 'CP',
      description: 'Show or hide the Comments panel',
      when: hasService,
      run: (ctx) => {
        ctx.service<{ toggle(id: string): void }>(SERVICE.panels).toggle(COMMENTS_PANEL_ID);
      },
    },

    {
      id: 'comments.select',
      label: 'Go to comment',
      category: 'Comment',
      hidden: true,
      description: 'Selects a comment and brings its page into view (pass { comment })',
      when: hasComments,
      run: (ctx) => {
        const s = service(ctx);
        const id = ctx.args['comment'];
        if (typeof id !== 'string') return null;
        s.select(id as ModelId, { jump: ctx.args['jump'] !== false });
        return id;
      },
    },

    // ---- replies and status --------------------------------------------------------------------
    {
      id: 'comments.reply',
      label: 'Reply',
      category: 'Comment',
      icon: 'reply',
      shortcut: 'Mod+Alt+R',
      keyTip: 'CR',
      description: 'Reply to the selected comment (pass { comment, text })',
      permission: 'annotate',
      when: hasSelection,
      run: async (ctx) => {
        const s = service(ctx);
        const id = target(ctx, s);
        if (!id) return null;
        const given = ctx.args['text'];
        const text =
          typeof given === 'string'
            ? given
            : await s.shell.dialogs.prompt({
                id: 'comments-reply-dialog',
                title: 'Reply',
                label: 'Your reply',
                value: '',
              });
        if (typeof text !== 'string' || text.trim() === '') return null;
        return s.reply(id, text);
      },
    },
    {
      id: 'comments.status',
      label: 'Set status…',
      category: 'Comment',
      icon: 'circle-check',
      keyTip: 'CS',
      description: 'Set the review status of the selected comment (pass { comment, status })',
      permission: 'annotate',
      when: hasSelection,
      run: async (ctx) => {
        const s = service(ctx);
        const id = target(ctx, s);
        if (!id) return null;
        const given = ctx.args['status'];
        if (typeof given === 'string') {
          const spec = STATUSES.find((entry) => entry.id === given || entry.state === given);
          return spec ? s.setStatus(id, spec.id) : null;
        }
        // No argument: the reader picks from the panel's own menu, which the ribbon's split
        // button and the palette entries below also reach.
        return ctx.run('comments.status.accepted');
      },
    },
    ...STATUSES.map(statusCommand),
    {
      id: 'comments.check',
      label: 'Checkmark',
      category: 'Comment',
      icon: 'square-check',
      keyTip: 'CK',
      description: 'Tick or clear the checkmark on the selected comment',
      permission: 'annotate',
      when: hasSelection,
      run: async (ctx) => {
        const s = service(ctx);
        const id = target(ctx, s);
        if (!id) return null;
        await s.toggleCheck(id);
        return s.threadOf(id)?.checked ?? null;
      },
    },
    {
      id: 'comments.setText',
      label: 'Edit comment text',
      category: 'Comment',
      hidden: true,
      description: 'Internal: set a comment’s text (pass { comment, text })',
      permission: 'annotate',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        const id = target(ctx, s);
        const text = ctx.args['text'];
        if (!id || typeof text !== 'string') return null;
        await s.setText(id, text);
        return id;
      },
    },
    {
      id: 'comments.delete',
      label: 'Delete comment',
      category: 'Comment',
      icon: 'trash-2',
      keyTip: 'CD',
      description: 'Delete the selected comment and its replies',
      permission: 'annotate',
      when: hasSelection,
      run: async (ctx) => {
        const s = service(ctx);
        const id = target(ctx, s);
        return id ? s.delete(id) : 0;
      },
    },
    {
      id: 'comments.deleteAll',
      label: 'Delete all comments shown',
      category: 'Comment',
      icon: 'trash-2',
      description: 'Delete every comment the panel is currently showing',
      permission: 'annotate',
      when: hasComments,
      run: async (ctx) => {
        const s = service(ctx);
        const { shown } = s.rows();
        if (shown === 0) return 0;
        const answer = await s.shell.dialogs.message({
          kind: 'question',
          title: 'Delete comments',
          text: `Delete ${String(shown)} ${shown === 1 ? 'comment' : 'comments'} and their replies? This can be undone.`,
          buttons: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'delete', label: 'Delete', danger: true, primary: true },
          ],
        });
        if (answer !== 'delete') return 0;
        return s.deleteShown();
      },
    },

    // ---- moving about --------------------------------------------------------------------------
    {
      id: 'comments.next',
      label: 'Next comment',
      category: 'Comment',
      icon: 'chevron-down',
      description: 'Select the next comment in the panel’s order',
      when: hasComments,
      run: (ctx) => step(service(ctx), 1),
    },
    {
      id: 'comments.previous',
      label: 'Previous comment',
      category: 'Comment',
      icon: 'chevron-up',
      description: 'Select the previous comment in the panel’s order',
      when: hasComments,
      run: (ctx) => step(service(ctx), -1),
    },
    {
      id: 'comments.expandAll',
      label: 'Expand all comments',
      category: 'Comment',
      icon: 'chevrons-right',
      description: 'Open every group and every reply thread',
      when: hasService,
      run: (ctx) => {
        service(ctx).expandAll();
      },
    },
    {
      id: 'comments.collapseAll',
      label: 'Collapse all comments',
      category: 'Comment',
      icon: 'chevrons-left',
      description: 'Close every group and every reply thread',
      when: hasService,
      run: (ctx) => {
        service(ctx).collapseAll();
      },
    },

    // ---- arranging -----------------------------------------------------------------------------
    {
      id: 'comments.group',
      label: 'Group comments by…',
      category: 'Comment',
      icon: 'list-tree',
      description: 'Group the panel by page, author, type, date or status (pass { value })',
      when: hasService,
      run: async (ctx) => {
        const value = ctx.args['value'];
        if (typeof value !== 'string') return service(ctx).settings.group;
        await service(ctx).setGrouping(value as GroupBy);
        return value;
      },
    },
    {
      id: 'comments.sort',
      label: 'Sort comments by…',
      category: 'Comment',
      icon: 'list',
      description: 'Sort the panel by page, author, date, type or status (pass { value })',
      when: hasService,
      run: async (ctx) => {
        const value = ctx.args['value'];
        if (typeof value !== 'string') return service(ctx).settings.sort;
        const direction = ctx.args['direction'];
        await service(ctx).setSort(
          value as SortBy,
          direction === 'desc' ? 'desc' : direction === 'asc' ? 'asc' : undefined,
        );
        return value;
      },
    },
    {
      id: 'comments.search',
      label: 'Search comments',
      category: 'Comment',
      icon: 'search',
      description: 'Filter the panel to comments containing some text (pass { text })',
      when: hasService,
      run: (ctx) => {
        const text = ctx.args['text'];
        const s = service(ctx);
        if (typeof text === 'string') s.setSearch(text);
        const input = document.querySelector<HTMLInputElement>('[data-role="comment-search"]');
        if (typeof text === 'string' && input) input.value = text;
        else input?.focus();
        return s.rows().shown;
      },
    },
    {
      id: 'comments.filter',
      label: 'Filter comments',
      category: 'Comment',
      icon: 'sliders-horizontal',
      description:
        'Show only some comments (pass { authors, types, statuses, checked, from, to }; no arguments clears it)',
      when: hasService,
      run: (ctx) => {
        const s = service(ctx);
        const list = (key: string): ReadonlySet<string> | null => {
          const value = ctx.args[key];
          return Array.isArray(value) && value.length > 0
            ? new Set(value.filter((v): v is string => typeof v === 'string'))
            : null;
        };
        const checked = ctx.args['checked'];
        s.setFilter({
          authors: list('authors'),
          types: list('types'),
          statuses: list('statuses') as ReadonlySet<StatusId> | null,
          checked: checked === 'checked' || checked === 'unchecked' ? checked : 'all',
          from: typeof ctx.args['from'] === 'string' ? ctx.args['from'] : null,
          to: typeof ctx.args['to'] === 'string' ? ctx.args['to'] : null,
        });
        return s.rows().shown;
      },
    },

    // ---- show and hide on the page --------------------------------------------------------------
    {
      id: 'comments.showAll',
      label: 'Show all comments',
      category: 'Comment',
      icon: 'eye',
      keyTip: 'CH',
      description: 'Draw every comment on the page again',
      when: hasService,
      run: (ctx) => {
        service(ctx).showAll();
      },
    },
    {
      id: 'comments.hideAll',
      label: 'Hide all comments',
      category: 'Comment',
      icon: 'eye-off',
      description: 'Stop drawing comments on the page. The document is not changed.',
      when: hasService,
      run: (ctx) => {
        service(ctx).hideAll();
      },
    },
    {
      id: 'comments.hideType',
      label: 'Show or hide comments of one type',
      category: 'Comment',
      icon: 'eye-off',
      description: 'Toggle one kind of comment on the page (pass { type })',
      when: hasService,
      run: (ctx) => {
        const type = ctx.args['type'];
        if (typeof type !== 'string') return null;
        service(ctx).toggleType(type);
        return !service(ctx).visibility.hiddenTypes.has(type);
      },
    },
    {
      id: 'comments.hideAuthor',
      label: 'Show or hide one reviewer’s comments',
      category: 'Comment',
      icon: 'eye-off',
      description: 'Toggle one author’s comments on the page (pass { author })',
      when: hasService,
      run: (ctx) => {
        const author = ctx.args['author'];
        if (typeof author !== 'string') return null;
        service(ctx).toggleAuthor(author);
        return !service(ctx).visibility.hiddenAuthors.has(author);
      },
    },

    // ---- exchange -------------------------------------------------------------------------------
    {
      id: 'comments.import',
      label: 'Import comments…',
      category: 'Comment',
      icon: 'upload',
      keyTip: 'CI',
      description: 'Bring comments in from an FDF or XFDF file (pass { path, policy })',
      permission: 'annotate',
      when: open,
      run: (ctx) => runImport(ctx),
    },
    {
      id: 'comments.export',
      label: 'Export comments…',
      category: 'Comment',
      icon: 'download',
      keyTip: 'CE',
      description: 'Write this document’s comments to an FDF or XFDF file (pass { path, format })',
      when: hasComments,
      run: (ctx) => runExport(ctx),
    },
    {
      id: 'comments.summarise',
      label: 'Summarise comments…',
      category: 'Comment',
      icon: 'file-text',
      keyTip: 'CM',
      description: 'Build a new PDF listing every comment (pass { layout, sort, fontSize, range })',
      when: hasComments,
      run: (ctx) => runSummarise(ctx),
    },
    {
      id: 'comments.print',
      label: 'Print with comments',
      category: 'Comment',
      icon: 'printer',
      description: 'Open the print dialog with comment printing turned on',
      permission: 'print',
      when: open,
      run: async (ctx) => {
        const registry = ctx.service<Registry>('registry');
        // M13 owns printing; this only makes sure its "annotations" setting is on first.
        if (hasBridge()) await invoke('settings:set', 'print.annotations', true);
        if (registry.has('file.print')) return ctx.run('file.print');
        return null;
      },
    },

    // ---- probes (hidden; the acceptance tests read the module through these) ---------------------
    {
      id: 'dev.comments',
      label: 'Developer: comments state',
      category: 'Developer',
      hidden: true,
      description: 'The panel’s rows, counts, filter and visibility as plain data',
      when: hasService,
      run: (ctx) => {
        const s = service(ctx);
        const { rows, shown, total, authors, types } = s.rows();
        return {
          shown,
          total,
          authors: [...authors],
          types: [...types],
          filtering: s.filtering,
          everythingVisible: s.everythingVisible,
          group: s.settings.group,
          sort: s.settings.sort,
          rows: rows.map((row) =>
            row.kind === 'group'
              ? { kind: row.kind, id: row.id, label: row.label, count: row.count }
              : {
                  kind: row.kind,
                  id: row.id,
                  page: row.entry.page,
                  type: row.entry.type,
                  author: row.entry.author,
                  text: row.entry.text,
                  status: row.entry.status,
                  checked: row.entry.checked,
                  replies: row.kind === 'comment' ? row.replyCount : 0,
                },
          ),
        };
      },
    },
    {
      id: 'dev.commentThread',
      label: 'Developer: one comment thread',
      category: 'Developer',
      hidden: true,
      description: 'The thread a comment id belongs to (pass { comment })',
      when: hasService,
      run: (ctx) => {
        const s = service(ctx);
        const id = target(ctx, s);
        const thread = id ? s.threadOf(id) : null;
        if (!thread) return null;
        return {
          id: thread.id,
          status: thread.status,
          statusBy: thread.statusBy,
          checked: thread.checked,
          text: thread.text,
          replies: thread.replies.map((reply) => ({
            id: reply.id,
            text: reply.text,
            author: reply.author,
            setsStatus: reply.setsStatus,
          })),
        };
      },
    },
  ],

  shortcuts: [
    { key: 'F7', command: 'comments.next' },
    { key: 'Shift+F7', command: 'comments.previous' },
  ],

  ribbon: [
    {
      id: 'comment.review',
      tab: 'comment',
      label: 'Review',
      order: 40,
      large: ['comments.panel'],
      items: [
        'comments.panel',
        'comments.reply',
        {
          kind: 'dropdown',
          id: 'comments.statusMenu',
          label: 'Status',
          icon: 'circle-check',
          menu: STATUSES.map((spec) => ({
            command: `comments.status.${spec.id}`,
            label: spec.label,
            icon: spec.icon,
          })),
        },
        'comments.check',
        '-',
        'comments.delete',
      ],
    },
    {
      id: 'comment.show',
      tab: 'comment',
      label: 'Show',
      order: 41,
      items: [
        {
          kind: 'toggle',
          command: 'comments.hideAll',
          pressed: (ctx) => hasService(ctx) && !service(ctx).visibility.all,
          dynamicLabel: (ctx) =>
            hasService(ctx) && !service(ctx).visibility.all ? 'Comments hidden' : 'Hide comments',
        },
        'comments.showAll',
        'comments.expandAll',
        'comments.collapseAll',
      ],
    },
    {
      id: 'comment.exchange',
      tab: 'comment',
      label: 'Comments',
      order: 42,
      large: ['comments.summarise'],
      items: ['comments.import', 'comments.export', 'comments.summarise', 'comments.print'],
    },
  ],

  contextMenus: [
    {
      id: 'comments.rowMenu',
      region: '.comments-row',
      order: 10,
      items: [
        'comments.reply',
        {
          label: 'Set status',
          submenu: STATUSES.map((spec) => ({
            command: `comments.status.${spec.id}`,
            label: spec.label,
            icon: spec.icon,
          })),
        },
        'comments.check',
        '-',
        'comments.delete',
      ],
    },
  ],
});

/** Moves the selection one comment along the panel's own order. */
function step(s: CommentsService, delta: number): ModelId | null {
  const rows = s.rows().rows.filter((row) => row.kind !== 'group');
  if (rows.length === 0) return null;
  const current = s.annotations.selection[0];
  const at = rows.findIndex((row) => row.id === current);
  const next = rows[Math.min(rows.length - 1, Math.max(0, at < 0 ? 0 : at + delta))];
  if (!next) return null;
  s.select(next.id);
  return next.id;
}

// ---- import -------------------------------------------------------------------------------------

async function runImport(ctx: {
  readonly args: Readonly<Record<string, unknown>>;
  service<T>(name: string): T;
}): Promise<unknown> {
  const s = ctx.service<CommentsService>(COMMENTS_SERVICE);
  const document = s.activeDocument();
  if (!document) return null;

  let bytes: Uint8Array | null = null;
  let name = '';
  const path = ctx.args['path'];
  const given = ctx.args['bytes'];
  if (given instanceof Uint8Array) {
    bytes = given;
    name = typeof ctx.args['name'] === 'string' ? ctx.args['name'] : 'comments.xfdf';
  } else if (typeof path === 'string' && hasBridge()) {
    const file = await invoke('file:read', path);
    bytes = file.bytes;
    name = file.name;
  } else if (hasBridge()) {
    const files = await invoke('file:openFilesDialog', {
      title: 'Import comments',
      buttonLabel: 'Import',
      multi: false,
      filters: [
        { name: 'Comment files', extensions: ['xfdf', 'fdf'] },
        { name: 'XFDF', extensions: ['xfdf'] },
        { name: 'FDF', extensions: ['fdf'] },
      ],
    });
    const file = files[0];
    if (!file) return null;
    bytes = file.bytes;
    name = file.name;
  }
  if (!bytes) {
    await s.shell.dialogs.info('Import comments', 'File dialogs need the Electron shell.');
    return null;
  }

  let source;
  try {
    source = readComments(bytes, formatOfName(name));
  } catch (error) {
    const message = error instanceof XfdfError ? error.message : String(error);
    await s.shell.dialogs.error('Import comments', message);
    return null;
  }
  if (source.annotations.length === 0) {
    await s.shell.dialogs.info('Import comments', `${name} has no comments in it.`);
    return { added: 0, replaced: 0, offPage: 0, replies: 0 };
  }

  await s.load();
  const argPolicy = ctx.args['policy'];
  const policy =
    argPolicy === 'add' || argPolicy === 'replace'
      ? argPolicy
      : (
          await askImportOptions(s.shell.dialogs, {
            fileName: name,
            count: source.annotations.length,
            policy: s.settings.importPolicy,
          })
        )?.policy;
  if (!policy) return null;
  if (policy !== s.settings.importPolicy) await s.setSetting('importPolicy', policy);

  await s.loadAll();
  const result = await importComments(document, s.annotations, source, { policy });
  s.notify();
  const parts = [
    `${String(result.added)} added`,
    result.replaced > 0 ? `${String(result.replaced)} replaced` : '',
    result.replies > 0 ? `${String(result.replies)} threaded as replies` : '',
    result.offPage > 0 ? `${String(result.offPage)} on pages this document does not have` : '',
  ].filter((part) => part !== '');
  s.shell.toasts.show({ kind: 'success', text: `Comments imported: ${parts.join(', ')}` });
  return result;
}

// ---- export -------------------------------------------------------------------------------------

async function runExport(ctx: {
  readonly args: Readonly<Record<string, unknown>>;
  service<T>(name: string): T;
}): Promise<unknown> {
  const s = ctx.service<CommentsService>(COMMENTS_SERVICE);
  const document = s.activeDocument();
  if (!document) return null;
  await s.load();
  await s.loadAll();

  const count = s.comments().reduce((total, entry) => total + 1 + entry.replies.length, 0);
  const raw = ctx.args['format'];
  const argFormat: CommentFormat | null = raw === 'fdf' ? 'fdf' : raw === 'xfdf' ? 'xfdf' : null;
  const chosen =
    argFormat !== null
      ? { format: argFormat, formData: ctx.args['formData'] === true }
      : await askExportOptions(s.shell.dialogs, {
          count,
          format: 'xfdf',
          formData: s.settings.exportFormData,
          hasFields: document.state.fields.length > 0,
        });
  if (!chosen) return null;
  if (chosen.formData !== s.settings.exportFormData) {
    await s.setSetting('exportFormData', chosen.formData);
  }

  const doc = exportComments(document, { format: chosen.format, formData: chosen.formData });
  const bytes = serialiseComments(doc, chosen.format);

  const argPath = ctx.args['path'];
  let path = typeof argPath === 'string' ? argPath : null;
  if (path === null) {
    if (!hasBridge()) {
      await s.shell.dialogs.info('Export comments', 'File dialogs need the Electron shell.');
      return null;
    }
    path = await invoke('file:saveAsDialog', {
      title: 'Export comments',
      buttonLabel: 'Export',
      defaultPath: defaultExportName(document, chosen.format),
      filters: [
        chosen.format === 'fdf'
          ? { name: 'FDF', extensions: ['fdf'] }
          : { name: 'XFDF', extensions: ['xfdf'] },
      ],
    });
    if (path === null) return null;
  }
  if (hasBridge()) await invoke('file:writeAtomic', path, bytes, { backup: false });
  s.shell.toasts.show({
    kind: 'success',
    text: `${String(doc.annotations.length)} comments exported`,
  });
  return { path, count: doc.annotations.length, bytes: bytes.byteLength };
}

function defaultExportName(document: Document, format: CommentFormat): string {
  const base = document.state.title.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/gu, '-');
  return `${base || 'comments'}.${format}`;
}

// ---- summarise ----------------------------------------------------------------------------------

async function runSummarise(ctx: {
  readonly args: Readonly<Record<string, unknown>>;
  run(commandId: string, args?: Readonly<Record<string, unknown>>): Promise<unknown>;
  service<T>(name: string): T;
}): Promise<unknown> {
  const s = ctx.service<CommentsService>(COMMENTS_SERVICE);
  const document = s.activeDocument();
  if (!document) return null;
  await s.load();
  await s.loadAll();
  const comments = s.comments();
  if (comments.length === 0) {
    await s.shell.dialogs.info('Summarise comments', 'This document has no comments.');
    return null;
  }

  const pageCount = document.state.pages.length;
  const settings = s.settings;
  const scripted = ctx.args['layout'] !== undefined || ctx.args['range'] !== undefined;
  const choice = scripted
    ? {
        layout: (ctx.args['layout'] as SummaryOptions['layout']) ?? settings.summaryLayout,
        sort: (ctx.args['sort'] as SummaryOptions['sort']) ?? settings.summarySort,
        fontSize:
          typeof ctx.args['fontSize'] === 'number'
            ? ctx.args['fontSize']
            : settings.summaryFontSize,
        sequenceNumbers:
          typeof ctx.args['sequenceNumbers'] === 'boolean'
            ? ctx.args['sequenceNumbers']
            : settings.summarySequenceNumbers,
        includeEmptyPages:
          typeof ctx.args['includeEmptyPages'] === 'boolean'
            ? ctx.args['includeEmptyPages']
            : settings.summaryIncludeEmptyPages,
        range: typeof ctx.args['range'] === 'string' ? ctx.args['range'] : '',
      }
    : await askSummaryOptions(s.shell.dialogs, {
        layout: settings.summaryLayout,
        sort: settings.summarySort,
        fontSize: settings.summaryFontSize,
        sequenceNumbers: settings.summarySequenceNumbers,
        includeEmptyPages: settings.summaryIncludeEmptyPages,
        range: '',
        pageCount,
        commentCount: comments.length,
      });
  if (!choice) return null;

  if (!scripted) {
    await s.setSetting('summaryLayout', choice.layout);
    await s.setSetting('summarySort', choice.sort);
    await s.setSetting('summaryFontSize', clampFontSize(choice.fontSize));
    await s.setSetting('summarySequenceNumbers', choice.sequenceNumbers);
    await s.setSetting('summaryIncludeEmptyPages', choice.includeEmptyPages);
  }

  const summary: SummaryOptions = {
    layout: choice.layout,
    sort: choice.sort,
    fontSize: clampFontSize(choice.fontSize),
    pages: parseRange(choice.range, pageCount),
    includeEmptyPages: choice.includeEmptyPages,
    sequenceNumbers: choice.sequenceNumbers,
    title: 'Comment summary',
  };

  const run = await runSummary({
    shell: s.shell,
    document,
    comments,
    summary,
    dpi: s.settings.summaryDpi,
  });
  if (!run) return null;

  if (run.unrendered.length > 0) {
    s.shell.toasts.show({
      kind: 'warning',
      text: `${String(run.unrendered.length)} pages could not be drawn; their comments are still listed`,
    });
  }
  // The summary opens as a document of its own, unsaved, so the reader can look at it before
  // deciding where it goes — the same thing Create PDF does.
  await ctx.run('file.openBytes', {
    file: { path: '', name: run.fileName, bytes: run.bytes },
  });
  return {
    pageCount: run.pageCount,
    commentCount: run.commentCount,
    unrendered: [...run.unrendered],
    name: run.fileName,
  };
}

/** The live service, for the tests and for another module that needs it before activation. */
export function commentsService(): CommentsService | null {
  return live;
}

export { statusSpec };
