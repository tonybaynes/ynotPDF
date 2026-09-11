/**
 * M91 manifest — Create PDF from images, web pages, clipboard, HTML/Markdown and plain text.
 *
 * Everything the reader can reach: six creation commands (Blank has Ctrl+N), a Create PDF group
 * on the Convert ribbon tab, the tiles on the File → New page and the empty state (`creators`),
 * and the settings the dialogs start from. The hidden `create.convert` is the headless path the
 * e2e suite and later modules use; the developer commands at the bottom read a created document
 * back through the engine so a test can assert on page sizes, links, bookmarks and text.
 */

import type { ShellServices } from '@app/services';
import { registerIcon } from '@app/icons';
import { FileCode2, Globe, ImagePlus } from 'lucide';
import type { Document } from '@core/Document';
import type { Registry } from '@core/Registry';
import {
  DOCUMENT_SERVICE,
  type DocumentService,
} from '@modules/M20-document-model/DocumentService';
import type { ConvertInput } from '@engine/create/types';
import { hasBridge, invoke, type OpenedFile } from '@shared/ipc';
import { defineModule, type ServiceContext } from '@shared/module';
import { CreateService, CREATE_SERVICE, type CreateKind } from './CreateService';
import { CREATE_SETTINGS_SCHEMA } from './settings';

export { CreateService, CREATE_SERVICE } from './CreateService';
export type { CreateOutcome, CreateState } from './CreateService';

registerIcon('globe', Globe);
registerIcon('file-code', FileCode2);
registerIcon('image-plus', ImagePlus);

const creates = (ctx: ServiceContext): CreateService => ctx.service<CreateService>(CREATE_SERVICE);

const hasService = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(CREATE_SERVICE);

const idle = (ctx: ServiceContext): boolean => hasService(ctx) && !creates(ctx).state.busy;

function activeDocument(ctx: ServiceContext): Document {
  const doc = ctx.service<DocumentService>(DOCUMENT_SERVICE).active;
  if (!doc) throw new Error('No document is open');
  return doc;
}

/** Playwright's structured clone turns a `Uint8Array` into a plain array; accept both. */
function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as ArrayLike<number>);
  if (value && typeof value === 'object') {
    const values = Object.values(value as Record<string, unknown>);
    if (values.every((v) => typeof v === 'number')) return Uint8Array.from(values);
  }
  return null;
}

/** `{ files }` from the shell's drop handler or a test into converter inputs. */
function toInputs(value: unknown): ConvertInput[] {
  if (!Array.isArray(value)) return [];
  const out: ConvertInput[] = [];
  for (const item of value as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<OpenedFile> & { mime?: unknown };
    const bytes = toBytes(record.bytes);
    if (!bytes || typeof record.name !== 'string') continue;
    out.push({
      name: record.name,
      bytes,
      // A dropped file has no path, and an empty one is not a path. The `!== record.name` half
      // is older: it was working around the shell handing over the *filename* as the path, which
      // is fixed at source now but may still arrive from a caller that has not been updated.
      ...(typeof record.path === 'string' && record.path !== '' && record.path !== record.name
        ? { path: record.path }
        : {}),
      ...(typeof record.mime === 'string' ? { mime: record.mime } : {}),
    });
  }
  return out;
}

const KINDS: ReadonlyArray<CreateKind> = ['image', 'text', 'html', 'web', 'blank'];

const MENU = [
  { command: 'create.blank' },
  { command: 'create.fromImages' },
  { command: 'create.fromFiles' },
  '-',
  { command: 'create.fromWebPage' },
  { command: 'create.fromHtml' },
  { command: 'create.fromText' },
  '-',
  { command: 'create.fromClipboard' },
] as const;

export default defineModule({
  id: 'M91',
  name: 'Create PDF',

  settings: CREATE_SETTINGS_SCHEMA,

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(CREATE_SERVICE)) return undefined;
    if (!registry.hasService('shellServices') || !registry.hasService(DOCUMENT_SERVICE))
      return undefined;
    const shell = registry.service<ShellServices>('shellServices');
    const service = new CreateService({ registry, shell });
    registry.provide(CREATE_SERVICE, service);
    void service.load();
    return () => {
      service.dispose();
    };
  },

  commands: [
    {
      id: 'create.blank',
      label: 'New blank document…',
      category: 'File',
      description: 'A new PDF with empty pages of the size you choose',
      icon: 'file-plus',
      shortcut: 'Mod+N',
      when: idle,
      run: (ctx) => creates(ctx).createBlank(),
    },
    {
      id: 'create.fromImages',
      label: 'Create PDF from images…',
      category: 'File',
      description: 'One page per image: JPEG, PNG, TIFF, GIF, BMP, WebP',
      icon: 'image-plus',
      when: idle,
      run: (ctx) => creates(ctx).createFromImages(),
    },
    {
      id: 'create.fromFiles',
      label: 'Create PDF from files…',
      category: 'File',
      description: 'Images, text, HTML or Markdown — each kind becomes a document',
      icon: 'files',
      when: idle,
      run: (ctx) => creates(ctx).createFromFiles(),
    },
    {
      id: 'create.fromWebPage',
      label: 'Create PDF from web page…',
      category: 'File',
      description: 'Load an address, follow its links as deep as you like, one bookmark per page',
      icon: 'globe',
      when: idle,
      run: (ctx) => {
        const url = ctx.args['url'];
        return creates(ctx).createFromWebPage(typeof url === 'string' ? url : undefined);
      },
    },
    {
      id: 'create.fromHtml',
      label: 'Create PDF from HTML or Markdown…',
      category: 'File',
      description: 'A local .html or .md file, laid out by the app’s own renderer',
      icon: 'file-code',
      when: idle,
      run: (ctx) => creates(ctx).createFromHtml(),
    },
    {
      id: 'create.fromText',
      label: 'Create PDF from text file…',
      category: 'File',
      description: 'Plain text, wrapped and paginated, with a header',
      icon: 'file-text',
      when: idle,
      run: (ctx) => creates(ctx).createFromText(),
    },
    {
      id: 'create.fromClipboard',
      label: 'Create PDF from clipboard…',
      category: 'File',
      description: 'The image or text on the clipboard',
      icon: 'clipboard',
      when: idle,
      run: (ctx) => creates(ctx).createFromClipboard(),
    },
    {
      id: 'create.fromDropped',
      label: 'Create PDF from dropped files',
      category: 'File',
      hidden: true,
      description: 'Internal: files that are not PDFs, dropped on the window',
      when: hasService,
      run: (ctx) => creates(ctx).createFromFiles(toInputs(ctx.args['files'])),
    },
    {
      id: 'create.convert',
      label: 'Create PDF (headless)',
      category: 'File',
      hidden: true,
      description:
        'Internal: run one converter with explicit options and no dialog, then open the result',
      when: hasService,
      run: async (ctx) => {
        const kind = ctx.args['kind'];
        if (typeof kind !== 'string' || !KINDS.includes(kind as CreateKind)) {
          throw new Error(`create.convert needs { kind } — one of ${KINDS.join(', ')}`);
        }
        const inputs = toInputs(ctx.args['inputs']);
        const paths = ctx.args['paths'];
        if (Array.isArray(paths) && hasBridge()) {
          for (const path of paths as unknown[]) {
            if (typeof path !== 'string') continue;
            const file = await invoke('file:read', path);
            inputs.push({ name: file.name, bytes: file.bytes, path: file.path });
          }
        }
        const options = ctx.args['options'];
        const record =
          options && typeof options === 'object' ? (options as Record<string, unknown>) : {};
        return creates(ctx).createHeadless(kind as CreateKind, inputs, record);
      },
    },

    // ---- developer commands: what the e2e suite reads back ------------------------------------
    {
      id: 'dev.createState',
      label: 'Create: state',
      category: 'Developer',
      description: 'What the last creation did, and whether one is running',
      when: hasService,
      run: (ctx) => creates(ctx).state,
    },
    {
      id: 'dev.pageSizes',
      label: 'Document: page sizes',
      category: 'Developer',
      description:
        'Width, height and rotation of every page of the active document, from the engine',
      run: async (ctx) => {
        const doc = activeDocument(ctx);
        const count = await doc.engine.pageCount(doc.handle);
        const sizes = [];
        for (let i = 0; i < count; i++) {
          const s = await doc.engine.pageSize(doc.handle, i);
          sizes.push({ width: s.width, height: s.height, rotation: s.rotation });
        }
        return sizes;
      },
    },
    {
      id: 'dev.pageLinks',
      label: 'Document: links on a page',
      category: 'Developer',
      description: 'Every link on a page: its target page or URL',
      run: async (ctx) => {
        const doc = activeDocument(ctx);
        const page = typeof ctx.args['page'] === 'number' ? ctx.args['page'] : 0;
        const links = await doc.engine.links(doc.handle, page);
        return links.map((l) => ({ rect: l.rect, uri: l.uri ?? null, page: l.dest?.page ?? null }));
      },
    },
    {
      id: 'dev.pageText',
      label: 'Document: text of a page',
      category: 'Developer',
      description: 'The text runs of a page joined with spaces',
      run: async (ctx) => {
        const doc = activeDocument(ctx);
        const page = typeof ctx.args['page'] === 'number' ? ctx.args['page'] : 0;
        const runs = await doc.engine.textRuns(doc.handle, page);
        // No separator: PDFium reports one run per glyph for a page Chromium printed, so any
        // separator would put a space between every letter.
        return runs.map((r) => r.text).join('');
      },
    },
    {
      id: 'dev.outline',
      label: 'Document: outline',
      category: 'Developer',
      description: 'The bookmarks of the active document with their target pages',
      run: async (ctx) => {
        const doc = activeDocument(ctx);
        const items = await doc.engine.outline(doc.handle);
        return items.map((i) => ({
          title: i.title,
          page: i.dest?.page ?? null,
          children: i.children.length,
        }));
      },
    },
  ],

  ribbon: [
    {
      id: 'convert.create',
      tab: 'convert',
      label: 'Create PDF',
      order: 1,
      large: ['create.menu'],
      items: [
        {
          kind: 'dropdown',
          id: 'create.menu',
          label: 'Create PDF',
          icon: 'file-plus',
          size: 'large',
          menu: [...MENU],
        },
        { kind: 'button', command: 'create.fromImages', size: 'small' },
        { kind: 'button', command: 'create.fromWebPage', size: 'small' },
        { kind: 'button', command: 'create.fromClipboard', size: 'small' },
      ],
    },
  ],

  creators: [
    {
      id: 'create.blank',
      label: 'Blank document',
      description: 'Empty pages, any size',
      icon: 'file-plus',
      command: 'create.blank',
      order: 1,
    },
    {
      id: 'create.images',
      label: 'From images',
      description: 'One page per picture',
      icon: 'image-plus',
      command: 'create.fromImages',
      order: 2,
    },
    {
      id: 'create.web',
      label: 'From web page',
      description: 'An address, as deep as you like',
      icon: 'globe',
      command: 'create.fromWebPage',
      order: 3,
    },
    {
      id: 'create.clipboard',
      label: 'From clipboard',
      description: 'The image or text you copied',
      icon: 'clipboard',
      command: 'create.fromClipboard',
      order: 4,
    },
    {
      id: 'create.files',
      label: 'From files',
      description: 'Text, HTML, Markdown or images',
      icon: 'files',
      command: 'create.fromFiles',
      order: 5,
    },
  ],

  contextMenus: [
    {
      id: 'create.emptyMenu',
      region: 'document',
      order: 90,
      when: (ctx) =>
        hasService(ctx) && ctx.service<DocumentService>(DOCUMENT_SERVICE).active === null,
      items: [
        { command: 'create.blank' },
        { command: 'create.fromImages' },
        { command: 'create.fromClipboard' },
      ],
    },
  ],
});
