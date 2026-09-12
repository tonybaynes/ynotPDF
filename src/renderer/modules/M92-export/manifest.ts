/**
 * M92 manifest — exporting a document to something that is not a PDF: pages as images, the
 * pictures inside it, and its text as plain text, HTML or RTF.
 *
 * Every one is a registered command, so it is in the command palette, the e2e suite can drive it
 * by id, and the ribbon and the menu are two views of one list rather than two implementations.
 * The commands themselves are thin: they read their arguments, ask a dialog when there is
 * something to ask, and call `ExportService`.
 *
 * Arguments follow M40's convention — anything acting on pages accepts `{ pages: number[] }` or
 * `{ range: "1-3,5" }` — plus a destination (`{ directory }` or `{ path }`) and `{ ask: false }`,
 * so every command can be driven entirely from its arguments with no dialog in the way. That is
 * how the tests run them, and it is what M120's batch runner will call.
 *
 * **No `Command` is written by any of this.** The rule is that every *document change* is
 * undoable; an export reads a document and writes files beside it, and there is nothing to undo.
 */

import { registerIcon } from '@app/icons';
import type { ShellServices } from '@app/services';
import type { Registry } from '@core/Registry';
import {
  defineModule,
  type CommandArgs,
  type CommandSpec,
  type ServiceContext,
} from '@shared/module';
import { formatRange } from '@modules/M40-organise-pages/range';
import {
  ORGANISE_SERVICE,
  type OrganiseService,
} from '@modules/M40-organise-pages/OrganiseService';
import { FileCode2, FileImage, FileOutput, FileText, FileType2, Images } from 'lucide';
import {
  ExportService,
  EXPORT_SERVICE,
  type Destination,
  type ExportOutcome,
} from './ExportService';
import {
  askEmbeddedOptions,
  askHtmlOptions,
  askImageOptions,
  askRtfOptions,
  askTextOptions,
} from './dialogs';
import { EXPORT_SETTINGS_SCHEMA } from './settings';

export { ExportService, EXPORT_SERVICE } from './ExportService';

registerIcon('file-output', FileOutput);
registerIcon('file-image', FileImage);
registerIcon('file-text', FileText);
registerIcon('file-code-2', FileCode2);
registerIcon('file-type-2', FileType2);
registerIcon('images', Images);

/** Set in `activate`, so the unit tests reach the live service without a captured context. */
let live: ExportService | null = null;

const exports_ = (ctx: ServiceContext): ExportService => ctx.service<ExportService>(EXPORT_SERVICE);

const hasService = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(EXPORT_SERVICE);

const hasDocument = (ctx: ServiceContext): boolean =>
  hasService(ctx) && exports_(ctx).document !== null;

/** The destination an argument names, or "ask the reader". */
function destinationOf(args: CommandArgs): Destination {
  const directory = typeof args['directory'] === 'string' ? args['directory'] : undefined;
  const path = typeof args['path'] === 'string' ? args['path'] : undefined;
  const ask = args['ask'] !== false;
  return {
    ...(directory === undefined ? {} : { directory }),
    ...(path === undefined ? {} : { path }),
    ask,
  };
}

/**
 * True when the caller gave enough to run without a dialog (a test, a batch, a command line).
 *
 * Naming a destination is the usual way of saying "you have everything, get on with it", and
 * `ask: false` says it outright. An explicit `ask: true` overrides both: it means "put the files
 * *there*, but let me choose the rest", which is what a test of the dialog needs.
 */
function headless(args: CommandArgs): boolean {
  if (args['ask'] === true) return false;
  return args['ask'] === false || args['directory'] !== undefined || args['path'] !== undefined;
}

function boolArg(args: CommandArgs, key: string): boolean | undefined {
  return typeof args[key] === 'boolean' ? args[key] : undefined;
}

function numberArg(args: CommandArgs, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArg(args: CommandArgs, key: string): string | undefined {
  return typeof args[key] === 'string' ? args[key] : undefined;
}

/** The range context and the text the range field opens with. */
function rangeContextOf(ctx: ServiceContext): {
  range: ReturnType<OrganiseService['rangeContext']>;
  initial: string;
} {
  const service = exports_(ctx);
  const doc = service.require();
  const organise = ctx.service<Registry>('registry').hasService(ORGANISE_SERVICE)
    ? ctx.service<OrganiseService>(ORGANISE_SERVICE)
    : null;
  const range = organise?.rangeContext(doc) ?? {
    pageCount: doc.pageCount,
    currentPage: 0,
    selectedPages: [],
    pageSizes: doc.state.pages.map((page) => {
      const size = doc.pageSize(page.id);
      return { width: size?.width ?? 0, height: size?.height ?? 0 };
    }),
  };
  const selected = range.selectedPages;
  return {
    range,
    initial: selected.length > 0 ? formatRange(selected) : `1-${String(doc.pageCount)}`,
  };
}

const EXPORT_IMAGES: CommandSpec = {
  id: 'convert.exportImages',
  label: 'Export pages as images…',
  category: 'Convert',
  icon: 'file-image',
  shortcut: 'Mod+Shift+E',
  description: 'PNG, JPEG, TIFF or BMP at a resolution you choose',
  permission: 'copy',
  when: hasDocument,
  async run(ctx): Promise<ExportOutcome | null> {
    const service = exports_(ctx);
    const doc = service.require();
    const pages = service.target(ctx.args, doc);
    const settings = service.settings;
    if (headless(ctx.args)) {
      return await service.exportImages(
        {
          pages,
          format:
            (stringArg(ctx.args, 'format') as typeof settings.imageFormat | undefined) ??
            settings.imageFormat,
          dpi: numberArg(ctx.args, 'dpi') ?? settings.imageDpi,
          colour:
            (stringArg(ctx.args, 'colour') as typeof settings.imageColour | undefined) ??
            settings.imageColour,
          mono: { threshold: settings.monoThreshold, dither: settings.imageDither },
          quality: numberArg(ctx.args, 'quality') ?? settings.jpegQuality,
          level: numberArg(ctx.args, 'level') ?? settings.compressionLevel,
          tiffCompression: settings.tiffCompression,
          multiPage: boolArg(ctx.args, 'multiPage') ?? settings.tiffMultiPage,
          namePattern: stringArg(ctx.args, 'namePattern') ?? settings.imageNamePattern,
          annotations: boolArg(ctx.args, 'annotations') ?? settings.imageAnnotations,
          forms: boolArg(ctx.args, 'forms') ?? settings.imageForms,
        },
        destinationOf(ctx.args),
      );
    }
    const shell = ctx.service<ShellServices>('shellServices');
    const context = rangeContextOf(ctx);
    const sizes = context.range.pageSizes ?? [];
    const first = sizes[pages[0] ?? 0] ?? { width: 595.28, height: 841.89 };
    const answer = await askImageOptions(shell.dialogs, settings, {
      range: context.range,
      initialRange: context.initial,
      pageWidth: first.width,
      pageHeight: first.height,
    });
    if (!answer) return null;
    await service.remember({
      imageFormat: answer.format,
      imageDpi: answer.dpi,
      imageColour: answer.colour,
      imageDither: answer.dither,
      monoThreshold: answer.monoThreshold,
      jpegQuality: answer.quality,
      compressionLevel: answer.level,
      tiffCompression: answer.tiffCompression,
      tiffMultiPage: answer.multiPage,
      imageNamePattern: answer.namePattern,
      imageAnnotations: answer.annotations,
      imageForms: answer.forms,
    });
    return await service.exportImages(
      {
        pages: answer.pages,
        format: answer.format,
        dpi: answer.dpi,
        colour: answer.colour,
        mono: { threshold: answer.monoThreshold, dither: answer.dither },
        quality: answer.quality,
        level: answer.level,
        tiffCompression: answer.tiffCompression,
        multiPage: answer.multiPage,
        namePattern: answer.namePattern,
        annotations: answer.annotations,
        forms: answer.forms,
      },
      destinationOf(ctx.args),
    );
  },
};

const EXPORT_ALL_IMAGES: CommandSpec = {
  id: 'convert.exportAllImages',
  label: 'Export all images…',
  category: 'Convert',
  icon: 'images',
  description: 'Every picture inside the document, in the format the document stores it in',
  permission: 'copy',
  when: hasDocument,
  async run(ctx): Promise<ExportOutcome | null> {
    const service = exports_(ctx);
    service.require();
    if (headless(ctx.args)) {
      const namePattern = stringArg(ctx.args, 'namePattern');
      const minPixels = numberArg(ctx.args, 'minPixels');
      const keepDuplicates = boolArg(ctx.args, 'keepDuplicates');
      return await service.exportEmbedded(
        {
          ...(namePattern === undefined ? {} : { namePattern }),
          ...(minPixels === undefined ? {} : { minPixels }),
          ...(keepDuplicates === undefined ? {} : { keepDuplicates }),
        },
        destinationOf(ctx.args),
      );
    }
    const shell = ctx.service<ShellServices>('shellServices');
    const answer = await askEmbeddedOptions(shell.dialogs, service.settings);
    if (!answer) return null;
    await service.remember({
      embeddedNamePattern: answer.namePattern,
      embeddedMinPixels: answer.minPixels,
      embeddedKeepDuplicates: answer.keepDuplicates,
    });
    return await service.exportEmbedded(answer, destinationOf(ctx.args));
  },
};

const EXPORT_TEXT: CommandSpec = {
  id: 'convert.exportText',
  label: 'Export text…',
  category: 'Convert',
  icon: 'file-text',
  description: 'The document’s text layer, in reading order',
  permission: 'copy',
  when: hasDocument,
  async run(ctx): Promise<ExportOutcome | null> {
    const service = exports_(ctx);
    const doc = service.require();
    const settings = service.settings;
    if (headless(ctx.args)) {
      return await service.exportText(
        {
          pages: service.target(ctx.args, doc),
          encoding:
            (stringArg(ctx.args, 'encoding') as typeof settings.textEncoding | undefined) ??
            settings.textEncoding,
          lineEnding:
            (stringArg(ctx.args, 'lineEnding') as typeof settings.textLineEnding | undefined) ??
            settings.textLineEnding,
          pageSeparator:
            (stringArg(ctx.args, 'pageSeparator') as
              typeof settings.textPageSeparator | undefined) ?? settings.textPageSeparator,
          bom: boolArg(ctx.args, 'bom') ?? settings.textBom,
          skipBlankLines: boolArg(ctx.args, 'skipBlankLines') ?? false,
        },
        destinationOf(ctx.args),
      );
    }
    const shell = ctx.service<ShellServices>('shellServices');
    const context = rangeContextOf(ctx);
    const answer = await askTextOptions(shell.dialogs, settings, {
      range: context.range,
      initialRange: context.initial,
    });
    if (!answer) return null;
    await service.remember({
      textEncoding: answer.encoding,
      textLineEnding: answer.lineEnding,
      textPageSeparator: answer.pageSeparator,
      textBom: answer.bom,
    });
    return await service.exportText(answer, destinationOf(ctx.args));
  },
};

const EXPORT_HTML: CommandSpec = {
  id: 'convert.exportHtml',
  label: 'Export as HTML…',
  category: 'Convert',
  icon: 'file-code-2',
  description: 'A web page, laid out as the document is or as flowing paragraphs',
  permission: 'copy',
  when: hasDocument,
  async run(ctx): Promise<ExportOutcome | null> {
    const service = exports_(ctx);
    const doc = service.require();
    const settings = service.settings;
    if (headless(ctx.args)) {
      return await service.exportHtml(
        {
          pages: service.target(ctx.args, doc),
          layout:
            (stringArg(ctx.args, 'layout') as typeof settings.htmlLayout | undefined) ??
            settings.htmlLayout,
          perPage: boolArg(ctx.args, 'perPage') ?? settings.htmlPerPage,
          embedImages: boolArg(ctx.args, 'embedImages') ?? settings.htmlEmbedImages,
          keepStyles: boolArg(ctx.args, 'keepStyles') ?? settings.htmlKeepStyles,
        },
        destinationOf(ctx.args),
      );
    }
    const shell = ctx.service<ShellServices>('shellServices');
    const context = rangeContextOf(ctx);
    const answer = await askHtmlOptions(shell.dialogs, settings, {
      range: context.range,
      initialRange: context.initial,
    });
    if (!answer) return null;
    await service.remember({
      htmlLayout: answer.layout,
      htmlPerPage: answer.perPage,
      htmlEmbedImages: answer.embedImages,
      htmlKeepStyles: answer.keepStyles,
    });
    return await service.exportHtml(answer, destinationOf(ctx.args));
  },
};

const EXPORT_RTF: CommandSpec = {
  id: 'convert.exportRtf',
  label: 'Export as RTF…',
  category: 'Convert',
  icon: 'file-type-2',
  description: 'Rich text, for a word processor',
  permission: 'copy',
  when: hasDocument,
  async run(ctx): Promise<ExportOutcome | null> {
    const service = exports_(ctx);
    const doc = service.require();
    const settings = service.settings;
    if (headless(ctx.args)) {
      return await service.exportRtf(
        {
          pages: service.target(ctx.args, doc),
          pageBreaks: boolArg(ctx.args, 'pageBreaks') ?? settings.rtfPageBreaks,
          keepColours: boolArg(ctx.args, 'keepColours') ?? settings.rtfKeepColours,
          keepSizes: boolArg(ctx.args, 'keepSizes') ?? settings.rtfKeepSizes,
        },
        destinationOf(ctx.args),
      );
    }
    const shell = ctx.service<ShellServices>('shellServices');
    const context = rangeContextOf(ctx);
    const answer = await askRtfOptions(shell.dialogs, settings, {
      range: context.range,
      initialRange: context.initial,
    });
    if (!answer) return null;
    await service.remember({
      rtfPageBreaks: answer.pageBreaks,
      rtfKeepColours: answer.keepColours,
      rtfKeepSizes: answer.keepSizes,
    });
    return await service.exportRtf(answer, destinationOf(ctx.args));
  },
};

/** What the last export did — the e2e suite's window on to a folder full of files. */
const EXPORT_STATE: CommandSpec = {
  id: 'dev.exportState',
  label: 'Developer: export state',
  category: 'Developer',
  hidden: true,
  run(ctx): Readonly<Record<string, unknown>> {
    if (!hasService(ctx)) return { available: false };
    const service = exports_(ctx);
    return {
      available: true,
      offThread: service.client.offThread,
      settings: service.settings,
      last: service.lastOutcome,
      pageCount: service.document?.pageCount ?? 0,
      hasEmbeddedImages: typeof service.document?.engine.pageImages === 'function',
    };
  },
};

export default defineModule({
  id: 'M92',
  name: 'Export',
  commands: [EXPORT_IMAGES, EXPORT_ALL_IMAGES, EXPORT_TEXT, EXPORT_HTML, EXPORT_RTF, EXPORT_STATE],
  settings: EXPORT_SETTINGS_SCHEMA,
  ribbon: [
    {
      id: 'convert.export',
      tab: 'convert',
      label: 'Export',
      order: 10,
      large: ['export.menu'],
      items: [
        {
          kind: 'dropdown',
          id: 'export.menu',
          label: 'Export',
          icon: 'file-output',
          size: 'large',
          menu: [
            EXPORT_IMAGES.id,
            EXPORT_ALL_IMAGES.id,
            '-',
            EXPORT_TEXT.id,
            EXPORT_HTML.id,
            EXPORT_RTF.id,
          ],
        },
      ],
    },
  ],
  contextMenus: [
    {
      id: 'export.document',
      region: 'document',
      order: 60,
      when: hasDocument,
      items: [{ command: EXPORT_IMAGES.id, label: 'Export pages as images…' }],
    },
  ],
  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (!registry.hasService('shellServices')) return undefined;
    // `Registry.dispose()` runs the disposers but leaves the services registered, so a
    // dispose-then-activate cycle arrives here with the service still in place (M40's note).
    const existing = registry.hasService(EXPORT_SERVICE)
      ? registry.service<ExportService>(EXPORT_SERVICE)
      : null;
    const shell = registry.service<ShellServices>('shellServices');
    const service = existing ?? new ExportService({ registry, shell });
    live = service;
    if (existing === null) {
      registry.provide(EXPORT_SERVICE, service);
      void service.load();
    }
    return () => {
      live = null;
    };
  },
});

/** Exposed for the unit tests, which drive the service without the shell. */
export function activeExportService(): ExportService | null {
  return live;
}
