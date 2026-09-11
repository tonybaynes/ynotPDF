/**
 * M53 manifest — headers and footers, Bates numbering, watermarks, backgrounds and links.
 *
 * Every user action is a registered command, so it is in the palette, on a shortcut where one is
 * free, and drivable by id from the e2e suite. The ones that take arguments (`link.create` with
 * a rectangle, `decorate.headerFooter` with a spec) exist so a test — or M120's batch — can do
 * without a pointer, and the `decorate.probe` command at the bottom is how the acceptance tests
 * read this module out of the running app.
 */

import {
  FileDigit,
  Layers as LayersIcon,
  Link2,
  Link2Off,
  PanelTop,
  Stamp,
  TextSearch,
} from 'lucide';
import { registerIcon } from '@app/icons';
import type { ShellServices } from '@app/services';
import { SERVICE } from '@app/services';
import type { Registry } from '@core/Registry';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import { SetCustomCommand } from '@core/commands';
import { defineModule, type CommandSpec, type ServiceContext } from '@shared/module';
import type { PdfRect } from '@shared/pdf';
import { XOBJECTS_NAMESPACE } from '@modules/M21-save/plan';
import { parseRange } from '@modules/M40-organise-pages/range';
import {
  DEFAULT_MARGINS,
  type BatesSpec,
  type DecorationKind,
  type HeaderFooterSpec,
  type WatermarkSpec,
} from '@engine/decorations/types';
import { DECORATION_SERVICE, DecorationService } from './DecorationService';
import { LINK_SERVICE, LINK_TOOL_ID, LinkService } from './LinkService';
import { LINKS_PANEL_ID, mountLinksPanel } from './LinksPanel';
import { openBatesDialog, openHeaderFooterDialog, openWatermarkDialog } from './dialogs';
import { openDetectedLinksDialog, openLinkDialog } from './linkDialogs';
import { registerDecorationCodec, withDecoration, withoutDecorations } from './commands';
import { readDecorationsState, type ModelDecoration } from './model';
import { DEFAULT_BORDER, readBorder, readAction } from './links';
import {
  DECORATION_SETTINGS_SCHEMA,
  DEFAULT_DECORATION_SETTINGS,
  type DecorationSettings,
} from './settings';
import { linkTool } from './tools';
import './decorations.css';

export { DECORATION_SERVICE, DecorationService } from './DecorationService';
export { LINK_SERVICE, LinkService } from './LinkService';

registerIcon('panel-top', PanelTop);
registerIcon('file-digit', FileDigit);
registerIcon('stamp', Stamp);
registerIcon('layers', LayersIcon);
registerIcon('link-2', Link2);
registerIcon('link-2-off', Link2Off);
registerIcon('text-search', TextSearch);

/** The live services, so the tool and the panel can reach them without a context. */
let decorationService: DecorationService | null = null;
let linkService: LinkService | null = null;
let shellServices: ShellServices | null = null;

/** What the reader has chosen, as the service holds it now. */
const settings = (): DecorationSettings =>
  decorationService?.settings ?? DEFAULT_DECORATION_SETTINGS;

const has = (ctx: ServiceContext, name: string): boolean =>
  ctx.service<Registry>('registry').hasService(name);

const decorations = (ctx: ServiceContext): DecorationService =>
  ctx.service<DecorationService>(DECORATION_SERVICE);

const links = (ctx: ServiceContext): LinkService => ctx.service<LinkService>(LINK_SERVICE);

const open = (ctx: ServiceContext): boolean =>
  has(ctx, DECORATION_SERVICE) && decorations(ctx).activeDocument() !== null;

const linksOpen = (ctx: ServiceContext): boolean =>
  has(ctx, LINK_SERVICE) && links(ctx).activeDocument() !== null;

// ---- defaults the dialogs open on --------------------------------------------------------------

const DEFAULT_HEADER: HeaderFooterSpec = {
  kind: 'header-footer',
  zones: { 'footer-centre': '<<1 of n>>' },
  font: 'Helvetica',
  size: 9,
  colour: 0x000000,
  margins: DEFAULT_MARGINS,
  underline: false,
  shrink: 0,
  startNumber: 1,
  totalOverride: 0,
};

const DEFAULT_BATES: BatesSpec = {
  kind: 'bates',
  prefix: '',
  suffix: '',
  digits: 6,
  startAt: 1,
  zone: 'footer-right',
  font: 'Courier',
  size: 9,
  colour: 0x000000,
  margins: DEFAULT_MARGINS,
};

const DEFAULT_WATERMARK: WatermarkSpec = {
  kind: 'watermark',
  source: { kind: 'text', text: 'DRAFT' },
  font: 'Helvetica-Bold',
  size: 64,
  colour: 0xbbbbbb,
  rotation: 45,
  scale: 0.7,
  position: 'centre',
  offsetX: 0,
  offsetY: 0,
  behind: true,
  print: true,
  screen: true,
};

const DEFAULT_BACKGROUND: WatermarkSpec = {
  ...DEFAULT_WATERMARK,
  kind: 'background',
  source: { kind: 'colour' },
  colour: 0xfffff0,
  rotation: 0,
  scale: 0,
  behind: true,
};

/** The page ids a range names, in document order. */
function pageIdsFor(doc: Document, pages: ReadonlyArray<number>): ModelId[] {
  const out: ModelId[] = [];
  for (const index of pages) {
    const page = doc.state.pages[index];
    if (page) out.push(page.id);
  }
  return out;
}

/** Every page of a document, for a command given no range. */
function allPages(doc: Document): number[] {
  return doc.state.pages.map((_p, i) => i);
}

/** The range a command was given, or every page. */
function rangeFrom(doc: Document, value: unknown): { pages: number[]; text: string } {
  if (typeof value !== 'string' || value.trim() === '') return { pages: allPages(doc), text: '' };
  const parsed = parseRange(value, {
    pageCount: doc.state.pages.length,
    currentPage: 0,
    selectedPages: [],
  });
  return { pages: [...parsed.pages], text: value };
}

/** Applies one decoration, replacing whatever of that kind was there. */
async function putDecoration(
  service: DecorationService,
  doc: Document,
  kind: DecorationKind,
  decoration: Omit<ModelDecoration, 'id' | 'appliedAt'>,
  label: string,
): Promise<void> {
  const state = service.state(doc);
  const existing = state.items.find((d) => d.kind === kind);
  const id = existing?.id ?? `d${String(state.seq)}`;
  await service.change(doc, label, (current) => {
    const cleared = withoutDecorations(current, new Set([id]));
    return withDecoration(
      { ...cleared, seq: existing ? cleared.seq : cleared.seq + 1 },
      { ...decoration, id, appliedAt: new Date().toISOString() },
    );
  });
}

const dialogDeps = (
  ctx: ServiceContext,
  doc: Document,
): {
  shell: ShellServices;
  document: Document;
  units: DecorationSettings['units'];
  presets: string;
  savePresets(json: string): Promise<void>;
} => ({
  shell: ctx.service<ShellServices>('shellServices'),
  document: doc,
  units: settings().units,
  presets: settings().presets,
  savePresets: async (json: string) => {
    await decorations(ctx).setSetting('presets', json);
  },
});

// ---- pictures and PDFs a watermark can be made of -----------------------------------------------

/**
 * Asks for a file and stores it under a key the decoration can name.
 *
 * A picture becomes PNG on the way in, whatever it was, exactly as M31 does for a custom stamp:
 * one stored format, and its alpha channel is the transparency. A PDF is kept as it is, because
 * `embedPdf` brings the page's own resources with it.
 */
async function chooseSource(
  ctx: ServiceContext,
  doc: Document,
  kind: 'image' | 'pdf',
): Promise<{ key: string } | null> {
  const shell = ctx.service<ShellServices>('shellServices');
  const { hasBridge, invoke } = await import('@shared/ipc');
  if (!hasBridge()) return null;
  const files = await invoke('file:openFilesDialog', {
    title: kind === 'pdf' ? 'Choose a PDF' : 'Choose a picture',
    buttonLabel: 'Choose',
    multi: false,
    ...(kind === 'pdf'
      ? { filters: [{ name: 'PDF', extensions: ['pdf'] }] }
      : { filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp'] }] }),
  });
  const file = files[0];
  if (!file) return null;
  try {
    const source =
      kind === 'pdf' ? await pdfSource(doc, file.bytes) : await imageSource(file.bytes);
    const key = `m53.${kind}.${String(Date.now())}`;
    await doc.apply(
      new SetCustomCommand(doc, XOBJECTS_NAMESPACE, { [key]: source }, 'Embed a picture'),
    );
    return { key };
  } catch (error) {
    shell.toasts.show({
      kind: 'error',
      text: `That file could not be used: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}

/** A picture as a PNG source, with its natural size in points. */
async function imageSource(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const copy = new Uint8Array(bytes);
  const blob = new Blob([copy.buffer]);
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('this computer cannot convert the picture');
  context.drawImage(bitmap, 0, 0);
  const png = await canvas.convertToBlob({ type: 'image/png' });
  const data = new Uint8Array(await png.arrayBuffer());
  bitmap.close();
  return {
    kind: 'image',
    format: 'png',
    data: toBase64(data),
    width: canvas.width,
    height: canvas.height,
  };
}

/** The first page of a PDF as a source, with its size in points. */
async function pdfSource(doc: Document, bytes: Uint8Array): Promise<Record<string, unknown>> {
  const handle = await doc.engine.open(new Uint8Array(bytes));
  try {
    const size = await doc.engine.pageSize(handle, 0);
    return {
      kind: 'pdf',
      data: toBase64(bytes),
      page: 0,
      width: size.width,
      height: size.height,
    };
  } finally {
    await doc.engine.close(handle);
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// ---- links ---------------------------------------------------------------------------------------

/** The properties dialog for one link, and what the reader chose. */
async function editLink(shell: ShellServices, service: LinkService, id: ModelId): Promise<void> {
  const doc = service.activeDocument();
  const link = service.link(id);
  const annotation = doc?.annotation(id);
  if (!doc || !link || !annotation) return;
  const result = await openLinkDialog(shell, doc, {
    action: link.action,
    border: readBorder(annotation),
    title: 'Link properties',
    canDelete: true,
  });
  if (result === null) return;
  if (result === 'delete') {
    await service.remove(doc, [id]);
    shell.toasts.show({ kind: 'success', text: 'Deleted the link' });
    return;
  }
  await service.update(doc, id, result.action, result.border);
}

/** The dialog for a rectangle just dragged out, and the link it makes. */
async function createLink(
  shell: ShellServices,
  service: LinkService,
  page: number,
  rect: PdfRect,
): Promise<void> {
  const doc = service.activeDocument();
  if (!doc) return;
  const result = await openLinkDialog(shell, doc, {
    action: { kind: 'uri', uri: '' },
    border: DEFAULT_BORDER,
    title: 'New link',
    canDelete: false,
  });
  if (result === null || result === 'delete') return;
  const id = await service.create(doc, page, rect, result.action, result.border);
  if (id !== null) shell.toasts.show({ kind: 'success', text: 'Added the link' });
}

// ---- commands --------------------------------------------------------------------------------------

function decorationCommands(): CommandSpec[] {
  return [
    {
      id: 'decorate.headerFooter',
      label: 'Header and Footer…',
      category: 'Organize',
      icon: 'panel-top',
      shortcut: 'Mod+Shift+H',
      description: 'Put text in the six zones at the top and bottom of the pages',
      keyTip: 'HF',
      permission: 'modify',
      when: open,
      run: async (ctx) => {
        const service = decorations(ctx);
        const doc = service.activeDocument();
        if (!doc) return false;
        const shell = ctx.service<ShellServices>('shellServices');
        const current = await service.currentOf(doc, 'header-footer');
        const spec = (current.decoration?.spec ?? current.existing?.spec ?? DEFAULT_HEADER) as
          HeaderFooterSpec | undefined;
        const result = await openHeaderFooterDialog(dialogDeps(ctx, doc), {
          spec: spec?.kind === 'header-footer' ? spec : DEFAULT_HEADER,
          range: current.decoration?.range ?? '',
          existing: current.decoration !== null || current.existing !== null,
        });
        if (result.action === 'cancel') return false;
        if (result.action === 'remove') {
          const count = await service.removeKind(doc, 'header-footer', 'Remove header and footer');
          shell.toasts.show({
            kind: 'success',
            text: count > 0 ? 'Removed the header and footer' : 'There was nothing to remove',
          });
          return true;
        }
        await putDecoration(
          service,
          doc,
          'header-footer',
          {
            kind: 'header-footer',
            range: result.range,
            pages: pageIdsFor(doc, result.pages),
            spec: result.spec,
          },
          current.decoration ? 'Update header and footer' : 'Add header and footer',
        );
        shell.toasts.show({
          kind: 'success',
          text: `Put the header and footer on ${String(result.pages.length)} pages`,
        });
        return true;
      },
    },
    removeCommand(
      'decorate.headerFooter.remove',
      'Remove Header and Footer',
      'header-footer',
      'Remove header and footer',
    ),
    {
      id: 'decorate.bates',
      label: 'Bates Numbering…',
      category: 'Organize',
      icon: 'file-digit',
      shortcut: 'Mod+Shift+B',
      description: 'Number every page with a running number, with a prefix and a suffix',
      keyTip: 'BN',
      permission: 'modify',
      when: open,
      run: async (ctx) => {
        const service = decorations(ctx);
        const doc = service.activeDocument();
        if (!doc) return false;
        const shell = ctx.service<ShellServices>('shellServices');
        const current = await service.currentOf(doc, 'bates');
        const spec = current.decoration?.spec ?? current.existing?.spec ?? DEFAULT_BATES;
        const result = await openBatesDialog(dialogDeps(ctx, doc), {
          spec: spec.kind === 'bates' ? spec : DEFAULT_BATES,
          range: current.decoration?.range ?? '',
          existing: current.decoration !== null || current.existing !== null,
        });
        if (result.action === 'cancel') return false;
        if (result.action === 'remove') {
          const count = await service.removeKind(doc, 'bates', 'Remove Bates numbering');
          shell.toasts.show({
            kind: 'success',
            text: count > 0 ? 'Removed the numbering' : 'There was nothing to remove',
          });
          return true;
        }
        await putDecoration(
          service,
          doc,
          'bates',
          {
            kind: 'bates',
            range: result.range,
            pages: pageIdsFor(doc, result.pages),
            spec: result.spec,
          },
          current.decoration ? 'Update Bates numbering' : 'Add Bates numbering',
        );
        shell.toasts.show({
          kind: 'success',
          text: `Numbered ${String(result.pages.length)} pages`,
        });
        return true;
      },
    },
    removeCommand(
      'decorate.bates.remove',
      'Remove Bates Numbering',
      'bates',
      'Remove Bates numbering',
    ),
    watermarkCommand(false),
    removeCommand('decorate.watermark.remove', 'Remove Watermark', 'watermark', 'Remove watermark'),
    watermarkCommand(true),
    removeCommand(
      'decorate.background.remove',
      'Remove Background',
      'background',
      'Remove background',
    ),
    {
      id: 'decorate.removeAll',
      label: 'Remove All Page Marks',
      category: 'Organize',
      icon: 'layers',
      description: 'Take off every header, footer, number, watermark and background',
      permission: 'modify',
      when: open,
      run: async (ctx) => {
        const service = decorations(ctx);
        const doc = service.activeDocument();
        if (!doc) return false;
        const shell = ctx.service<ShellServices>('shellServices');
        const count = await service.removeAll(doc, 'Remove all page marks');
        shell.toasts.show({
          kind: count > 0 ? 'success' : 'info',
          text:
            count > 0
              ? `Removed ${String(count)} page ${count === 1 ? 'mark' : 'marks'}`
              : 'This document has no page marks',
        });
        return count;
      },
    },
    {
      id: 'dev.decorations',
      label: 'Report Page Marks',
      category: 'Developer',
      hidden: true,
      description: 'Internal: what this module currently holds, for the tests',
      when: open,
      run: (ctx) => {
        const service = decorations(ctx);
        const doc = service.activeDocument();
        if (!doc) return null;
        const state = readDecorationsState(doc.custom('M53'));
        return {
          items: state.items.map((d) => ({
            id: d.id,
            kind: d.kind,
            pages: d.pages.length,
            range: d.range,
          })),
          capturedPages: Object.keys(state.pages).length,
        };
      },
    },
  ];
}

function removeCommand(
  id: string,
  label: string,
  kind: DecorationKind,
  commandLabel: string,
): CommandSpec {
  return {
    id,
    label,
    category: 'Organize',
    icon: 'link-2-off',
    hidden: false,
    permission: 'modify',
    when: open,
    run: async (ctx) => {
      const service = decorations(ctx);
      const doc = service.activeDocument();
      if (!doc) return 0;
      const shell = ctx.service<ShellServices>('shellServices');
      const count = await service.removeKind(doc, kind, commandLabel);
      shell.toasts.show({
        kind: count > 0 ? 'success' : 'info',
        text: count > 0 ? `${commandLabel}: done` : 'There was nothing to remove',
      });
      return count;
    },
  };
}

function watermarkCommand(background: boolean): CommandSpec {
  const kind: DecorationKind = background ? 'background' : 'watermark';
  return {
    id: background ? 'decorate.background' : 'decorate.watermark',
    label: background ? 'Background…' : 'Watermark…',
    category: 'Organize',
    icon: background ? 'layers' : 'stamp',
    ...(background ? {} : { shortcut: 'Mod+Shift+W' }),
    description: background
      ? 'Put a colour, a picture or a PDF page behind every page'
      : 'Put text, a picture or a PDF page over or under every page',
    keyTip: background ? 'BG' : 'WM',
    permission: 'modify',
    when: open,
    run: async (ctx) => {
      const service = decorations(ctx);
      const doc = service.activeDocument();
      if (!doc) return false;
      const shell = ctx.service<ShellServices>('shellServices');
      const current = await service.currentOf(doc, kind);
      const fallback = background ? DEFAULT_BACKGROUND : DEFAULT_WATERMARK;
      const spec = current.decoration?.spec ?? current.existing?.spec ?? fallback;
      const result = await openWatermarkDialog(
        {
          ...dialogDeps(ctx, doc),
          chooseFile: (fileKind) => chooseSource(ctx, doc, fileKind),
        },
        {
          spec: spec.kind === kind ? spec : fallback,
          range: current.decoration?.range ?? '',
          existing: current.decoration !== null || current.existing !== null,
          background,
        },
      );
      if (result.action === 'cancel') return false;
      if (result.action === 'remove') {
        const count = await service.removeKind(doc, kind, `Remove ${kind}`);
        shell.toasts.show({
          kind: 'success',
          text: count > 0 ? `Removed the ${kind}` : 'There was nothing to remove',
        });
        return true;
      }
      await putDecoration(
        service,
        doc,
        kind,
        { kind, range: result.range, pages: pageIdsFor(doc, result.pages), spec: result.spec },
        current.decoration ? `Update ${kind}` : `Add ${kind}`,
      );
      shell.toasts.show({
        kind: 'success',
        text: `Put the ${kind} on ${String(result.pages.length)} pages`,
      });
      return true;
    },
  };
}

/** The one selected link that has a model annotation behind it, or null. */
function editableSelection(ctx: ServiceContext): ModelId | null {
  const service = links(ctx);
  if (service.selection.length !== 1) return null;
  const id = service.selection[0];
  return id === undefined ? null : (service.link(id)?.modelId ?? null);
}

function linkCommands(): CommandSpec[] {
  return [
    {
      id: 'link.tool',
      label: 'Link',
      category: 'Edit',
      icon: 'link-2',
      shortcut: 'Mod+Shift+K',
      description: 'Draw a rectangle on the page and say where it goes',
      keyTip: 'LK',
      permission: 'modify',
      when: linksOpen,
      run: (ctx) => {
        ctx.service<{ activate(id: string): void }>(SERVICE.tools).activate(LINK_TOOL_ID);
      },
    },
    {
      id: 'link.create',
      label: 'Create Link',
      category: 'Edit',
      icon: 'link-2',
      hidden: true,
      description: 'Internal: add a link over a rectangle, for the tests and for batch',
      when: linksOpen,
      run: async (ctx) => {
        const service = links(ctx);
        const doc = service.activeDocument();
        if (!doc) return null;
        const page = Number(ctx.args['page'] ?? 0);
        const rect = ctx.args['rect'] as PdfRect | undefined;
        const raw = ctx.args['uri'];
        const uri = typeof raw === 'string' ? raw : '';
        if (!rect) return null;
        const id = await service.create(doc, page, rect, { kind: 'uri', uri });
        return id === null ? null : String(id);
      },
    },
    {
      id: 'link.edit',
      label: 'Edit Link…',
      category: 'Edit',
      icon: 'link-2',
      description: 'Change where the selected link goes',
      permission: 'modify',
      when: (ctx) => linksOpen(ctx) && editableSelection(ctx) !== null,
      run: async (ctx) => {
        const id = editableSelection(ctx);
        if (id === null) return false;
        await links(ctx).editLink(id);
        return true;
      },
    },
    {
      id: 'link.delete',
      label: 'Delete Link',
      category: 'Edit',
      icon: 'link-2-off',
      description: 'Remove the selected links',
      permission: 'modify',
      when: (ctx) => linksOpen(ctx) && links(ctx).selection.length > 0,
      run: async (ctx) => {
        const service = links(ctx);
        const doc = service.activeDocument();
        if (!doc) return 0;
        const count = await service.remove(doc, service.selection);
        ctx
          .service<ShellServices>('shellServices')
          .toasts.show({ kind: 'success', text: `Deleted ${String(count)} links` });
        return count;
      },
    },
    {
      id: 'link.detect',
      label: 'Create Links from Text…',
      category: 'Edit',
      icon: 'text-search',
      description: 'Find the web and e-mail addresses written in the text and offer to link them',
      keyTip: 'LD',
      permission: 'modify',
      when: linksOpen,
      run: async (ctx) => {
        const service = links(ctx);
        const doc = service.activeDocument();
        if (!doc) return 0;
        const shell = ctx.service<ShellServices>('shellServices');
        const { pages } = rangeFrom(doc, ctx.args['range']);
        const progress =
          pages.length > 24
            ? shell.dialogs.progress({
                title: 'Reading the text',
                text: `0 of ${String(pages.length)} pages`,
                cancellable: false,
              })
            : null;
        let candidates;
        try {
          candidates = await service.detect(doc, pages);
        } finally {
          progress?.close();
        }
        const kept =
          ctx.args['all'] === true ? candidates : await openDetectedLinksDialog(shell, candidates);
        if (kept.length === 0) return 0;
        const made = await service.createAll(doc, kept);
        shell.toasts.show({
          kind: 'success',
          text: `Created ${String(made)} ${made === 1 ? 'link' : 'links'}`,
        });
        return made;
      },
    },
    {
      id: 'link.follow',
      label: 'Open Link',
      category: 'View',
      hidden: true,
      description: 'Internal: follow a link by id',
      when: linksOpen,
      run: async (ctx) => {
        const id = ctx.args['id'];
        if (typeof id !== 'string') return false;
        return await links(ctx).follow(id);
      },
    },
    {
      id: 'dev.links',
      label: 'Report Links',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the links this module holds, for the tests',
      when: linksOpen,
      run: async (ctx) => {
        const service = links(ctx);
        const doc = service.activeDocument();
        await service.readEveryPage();
        return service.all().map((link) => {
          const action = link.action;
          return {
            id: link.id,
            page: link.page,
            action: action.kind,
            uri: action.kind === 'uri' ? action.uri : '',
            target:
              action.kind === 'page'
                ? (doc?.state.pages.findIndex((p) => p.id === action.page) ?? -1) + 1
                : 0,
            rect: link.rect,
          };
        });
      },
    },
  ];
}

export default defineModule({
  id: 'M53',
  name: 'Page marks and links',

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(DECORATION_SERVICE)) return undefined;
    const shell = ctx.service<ShellServices>('shellServices');
    shellServices = shell;
    const created = new DecorationService({ registry, shell });
    decorationService = created;
    registry.provide(DECORATION_SERVICE, created);
    registerDecorationCodec(created);

    const linksCreated = new LinkService({ registry, shell });
    linkService = linksCreated;
    registry.provide(LINK_SERVICE, linksCreated);
    linksCreated.editLink = (id) => editLink(shell, linksCreated, id);

    // M130 calls `load()` after a preference changes; this is the first read.
    const settingsWatch = created.onSettings((next) => {
      linksCreated.setSettings(next);
    });
    void created.load();

    // A tab that appears gets a link layer; one that goes takes its layer with it.
    const bindAll = (): void => {
      for (const tab of shell.documents.state.tabs) linksCreated.bind(tab.id);
    };
    const unsubscribe = shell.documents.subscribe(() => {
      bindAll();
    });
    const closed = shell.documents.onClosed((tab) => {
      linksCreated.unbind(tab.id);
      created.forget(tab.id);
    });
    bindAll();

    return () => {
      settingsWatch();
      unsubscribe();
      closed();
      linksCreated.dispose();
      created.dispose();
      decorationService = null;
      linkService = null;
      shellServices = null;
    };
  },

  settings: DECORATION_SETTINGS_SCHEMA,

  tools: [
    linkTool({
      service: () => linkService,
      create: async (page, rect) => {
        if (shellServices && linkService) await createLink(shellServices, linkService, page, rect);
      },
    }),
  ],

  panels: [
    {
      id: LINKS_PANEL_ID,
      title: 'Links',
      dock: 'left',
      icon: 'link-2',
      order: 70,
      mount: mountLinksPanel,
    },
  ],

  commands: [...decorationCommands(), ...linkCommands()],

  ribbon: [
    {
      id: 'organize.pageMarks',
      tab: 'organize',
      label: 'Page marks',
      order: 40,
      /*
       * One large button, two small, and everything else in one menu.
       *
       * Four large buttons made the Organize tab wide enough that a group collapsed even on a
       * full-screen window, which `shell.spec.ts` rightly calls a defect: a reader should not
       * have to open a popup to reach a top-level command at a normal size. The three a person
       * reaches for stay on the ribbon; the background and the five removals are one click
       * further in, where Foxit also puts its less-used marks.
       */
      items: [
        { kind: 'button', command: 'decorate.headerFooter', size: 'large' },
        'decorate.watermark',
        'decorate.bates',
        {
          kind: 'dropdown',
          id: 'decorate.more',
          label: 'More Marks',
          icon: 'layers',
          menu: [
            'decorate.background',
            '-',
            'decorate.headerFooter.remove',
            'decorate.bates.remove',
            'decorate.watermark.remove',
            'decorate.background.remove',
            '-',
            'decorate.removeAll',
          ],
        },
      ],
    },
    {
      id: 'edit.links',
      tab: 'edit',
      label: 'Links',
      order: 60,
      items: [
        { kind: 'button', command: 'link.tool', size: 'large' },
        { kind: 'button', command: 'link.detect', size: 'large' },
        'link.edit',
        'link.delete',
      ],
    },
  ],

  contextMenus: [
    {
      id: 'link.context',
      region: 'document',
      order: 55,
      when: (ctx) => linksOpen(ctx) && links(ctx).selection.length > 0,
      items: ['link.edit', 'link.delete'],
    },
  ],
});

/** The live decoration service, for tests that need it without a command context. */
export function liveDecorationService(): DecorationService | null {
  return decorationService;
}

/** The live link service, likewise. */
export function liveLinkService(): LinkService | null {
  return linkService;
}

export { readAction, SERVICE };
