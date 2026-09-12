/**
 * M41 manifest — whole-document operations: combine, split, crop, flatten and straighten.
 *
 * Every one is a registered command, so it is in the command palette, the e2e suite can drive it
 * by id, and the ribbon and the thumbnail context menu are two views of one list rather than two
 * implementations. The commands themselves are thin: they read their arguments, ask a dialog
 * when there is something to ask, and call `MergeService`.
 *
 * Arguments are M40's: anything that acts on pages accepts `{ pages: number[] }` or
 * `{ range: "1-3,5" }`; with neither it uses the thumbnail selection, and failing that the
 * current page. Every command that would otherwise open a dialog can be driven entirely from its
 * arguments, which is how the tests run it without a dialog in the way.
 */

import { registerIcon } from '@app/icons';
import { SERVICE, type ShellServices } from '@app/services';
import type { Registry } from '@core/Registry';
import { el } from '@app/dom';
import {
  defineModule,
  type CommandArgs,
  type CommandSpec,
  type ServiceContext,
} from '@shared/module';
import type { PageBoxName, PdfRect } from '@shared/pdf';
import { Combine, Crop, CircleSlash, Layers2, SquareSplitVertical, WandSparkles } from 'lucide';
import { OpFailed, type OpSource } from '@engine/ops/types';
import { formatBytes } from '@engine/ops/split';
import { countPages, formatRange } from '@modules/M40-organise-pages/range';
import { VIEWER_SERVICE, type ViewerService } from '@modules/M11-viewer/ViewerService';
import { MERGE_SERVICE, MergeService, renderRaster } from './MergeService';
import { registerMergeCodecs } from './commands';
import { askCombine, entryFor, type CombineEntry } from './combineDialog';
import { askSplit } from './splitDialog';
import { askCrop } from './cropDialog';
import { askFlatten } from './flattenDialog';
import { askDeskew, type DeskewRow } from './deskewDialog';
import { cropTool } from './cropTool';
import { FREE_CROP_RATIO, readCropRatio } from './cropRatio';
import { askCropRatio } from './cropRatioField';
import { applyCropChoice } from './applyCropChoice';
import { cropPreview } from './cropPreview';
import { CROP_BOXES, MERGE_SETTINGS_SCHEMA } from './settings';

export { MergeService, MERGE_SERVICE } from './MergeService';
export { registerMergeCodecs } from './commands';

/** Set in `activate`, so the tool reaches the live service without a captured context. */
let live: MergeService | null = null;
let cropRatio = FREE_CROP_RATIO;

const ops = (ctx: ServiceContext): MergeService => ctx.service<MergeService>(MERGE_SERVICE);

const hasOps = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(MERGE_SERVICE);

const hasDocument = (ctx: ServiceContext): boolean => hasOps(ctx) && ops(ctx).document !== null;

/** Splitting a one-page document is a copy, not a split. */
const hasPages = (ctx: ServiceContext): boolean =>
  hasDocument(ctx) && (ops(ctx).document?.pageCount ?? 0) > 1;

function numberArg(args: CommandArgs, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArg(args: CommandArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function boolArg(args: CommandArgs, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Accepts a `Uint8Array`, an `ArrayBuffer` or the plain array the e2e bridge produces. */
function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return null;
}

function boxArg(args: CommandArgs): PageBoxName | undefined {
  const given = stringArg(args, 'box');
  return CROP_BOXES.find((choice) => choice.value === given)?.value;
}

function rectArg(args: CommandArgs): PdfRect | undefined {
  const value = args['rect'];
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Partial<Record<keyof PdfRect, unknown>>;
  const numbers = [r.x0, r.y0, r.x1, r.y1];
  if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  return { x0: r.x0 as number, y0: r.y0 as number, x1: r.x1 as number, y1: r.y1 as number };
}

/** Whether the caller named pages at all — a range, a list, or a thumbnail selection. */
function anyTarget(ctx: ServiceContext & { args?: CommandArgs }): boolean {
  if (ctx.args?.['pages'] !== undefined || ctx.args?.['range'] !== undefined) return true;
  return ops(ctx).selection.as('pages') !== null;
}

/** The target of a command, from its arguments or the selection (M40's rule). */
function target(ctx: ServiceContext & { args?: CommandArgs }) {
  return ops(ctx).target({
    ...(ctx.args?.['pages'] === undefined ? {} : { pages: ctx.args['pages'] }),
    ...(ctx.args?.['range'] === undefined ? {} : { range: ctx.args['range'] }),
  });
}

/** A data URL of one page, for the previews the crop and straighten dialogs draw. */
async function pagePicture(
  service: MergeService,
  page: number,
  scale = 0.7,
): Promise<{ url: string; rect: PdfRect } | null> {
  const doc = service.document;
  if (!doc) return null;
  const model = doc.state.pages[page];
  if (!model) return null;
  const enginePage = doc.enginePage(model.id);
  if (enginePage === undefined) return null;
  const rendered = await renderRaster(doc.engine, doc.handle, enginePage, scale);
  if (!rendered) return null;
  const url = pngFrom(rendered.raster);
  return url === null ? null : { url, rect: rendered.rect };
}

/** Turns RGBA into a data URL through a canvas; `null` where there is no canvas (a Node test). */
function pngFrom(raster: {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}): string | null {
  if (typeof document === 'undefined') return null;
  const canvas = el('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const image = context.createImageData(raster.width, raster.height);
  image.data.set(raster.data);
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

// ---- combine -------------------------------------------------------------------------------------

const COMBINE: CommandSpec = {
  id: 'convert.combineFiles',
  label: 'Combine Files…',
  category: 'Convert',
  icon: 'combine',
  shortcut: 'Mod+Shift+M',
  description: 'Join several PDFs — or images, text and web pages — into one document',
  run: async (ctx) => {
    const service = ops(ctx);
    const engine = service.document?.engine ?? ctx.service('engine');
    const given = ctx.args['files'];
    let entries: CombineEntry[] = [];
    if (Array.isArray(given)) {
      // The e2e path: `{ files: [{ name, bytes }] }`, no picker and no dialog.
      for (const file of given as ReadonlyArray<{ name?: unknown; bytes?: unknown }>) {
        const bytes = toBytes(file.bytes);
        if (typeof file.name !== 'string' || bytes === null) continue;
        const source = await service.sourceFor({ name: file.name, bytes });
        entries.push(entryFor(source.name, source.bytes));
      }
      if (entries.length === 0) throw new OpFailed('There are no files to combine');
      const result = await service.combine(entries.map(sourceOf), {
        bookmarkPerFile: boolArg(ctx.args, 'bookmarkPerFile') ?? service.settings.bookmarkPerFile,
        keepBookmarks: boolArg(ctx.args, 'keepBookmarks') ?? service.settings.keepSourceBookmarks,
      });
      if (!result) return null;
      const tab = await service.openInNewTab(result.bytes, result.title);
      return service.record({
        combined: entries.length,
        pageCount: result.pageCount,
        tabId: tab.id,
        warnings: result.warnings,
      });
    }

    const chosen = await service.chooseFiles();
    entries = [];
    for (const file of chosen) {
      const source = await service.sourceFor(file);
      entries.push(entryFor(source.name, source.bytes, file.path));
    }
    const answer = await askCombine({
      dialogs: service.dialogs,
      engine: engine as never,
      entries,
      bookmarkPerFile: service.settings.bookmarkPerFile,
      keepBookmarks: service.settings.keepSourceBookmarks,
      toNewTab: service.settings.combineToNewTab,
      canSaveToFile: typeof window !== 'undefined',
      addFiles: async () => {
        const more = await service.chooseFiles();
        const built: CombineEntry[] = [];
        for (const file of more) {
          const source = await service.sourceFor(file);
          built.push(entryFor(source.name, source.bytes, file.path));
        }
        return built;
      },
    });
    if (!answer) return null;
    await service.setSetting('bookmarkPerFile', answer.bookmarkPerFile);
    await service.setSetting('keepSourceBookmarks', answer.keepBookmarks);
    await service.setSetting('combineToNewTab', answer.toNewTab);

    const result = await service.combine(answer.entries.map(sourceOf), {
      bookmarkPerFile: answer.bookmarkPerFile,
      keepBookmarks: answer.keepBookmarks,
      pageSize: answer.pageSize,
    });
    if (!result) return null;
    for (const warning of result.warnings) {
      service.toasts.show({ kind: 'warning', text: warning });
    }
    if (answer.toNewTab) {
      const tab = await service.openInNewTab(result.bytes, result.title);
      service.toasts.show({
        kind: 'success',
        text: `Combined ${String(answer.entries.length)} files into ${countPages(result.pageCount)}.`,
      });
      return service.record({
        combined: answer.entries.length,
        pageCount: result.pageCount,
        tabId: tab.id,
        warnings: result.warnings,
      });
    }
    const path = await service.askWhereToSave(`${result.title}.pdf`, 'Save the combined document');
    if (path === null) return null;
    await service.writeFile(path, result.bytes);
    service.toasts.show({
      kind: 'success',
      text: `Saved ${countPages(result.pageCount)} to ${path}.`,
    });
    return service.record({
      combined: answer.entries.length,
      pageCount: result.pageCount,
      path,
      warnings: result.warnings,
    });
  },
};

function sourceOf(entry: CombineEntry): OpSource {
  return {
    name: entry.name,
    bytes: entry.bytes,
    ...(entry.pages === null ? {} : { pages: entry.pages }),
  };
}

// ---- split ---------------------------------------------------------------------------------------

const SPLIT: CommandSpec = {
  id: 'organize.splitDocument',
  label: 'Split Document…',
  category: 'Organize',
  icon: 'square-split-vertical',
  permission: 'assemble',
  description: 'Cut this document into several files — by page count, size, bookmark or range',
  when: hasPages,
  run: async (ctx) => {
    const service = ops(ctx);
    const doc = service.require();
    const fromArgs = stringArg(ctx.args, 'by');
    const folderArg = stringArg(ctx.args, 'folder');
    const answer =
      fromArgs === undefined
        ? await askSplit({
            dialogs: service.dialogs,
            pageCount: doc.pageCount,
            baseName: service.baseName(doc),
            namePattern: service.settings.splitNamePattern,
            keepBookmarks: service.settings.splitKeepBookmarks,
            keepComments: service.settings.splitKeepComments,
            keepForms: service.settings.splitKeepForms,
            rangeContext: service.organise.rangeContext(doc),
            topLevelBookmarks: service.topLevelBookmarks(doc),
            chooseFolder: () => service.chooseFolder('Where the parts go'),
            canWriteFiles: typeof window !== 'undefined',
          })
        : {
            rule: ruleFromArgs(fromArgs, ctx.args),
            namePattern: stringArg(ctx.args, 'namePattern') ?? service.settings.splitNamePattern,
            keepBookmarks:
              boolArg(ctx.args, 'keepBookmarks') ?? service.settings.splitKeepBookmarks,
            keepComments: boolArg(ctx.args, 'keepComments') ?? service.settings.splitKeepComments,
            keepForms: boolArg(ctx.args, 'keepForms') ?? service.settings.splitKeepForms,
            folder: folderArg ?? null,
          };
    if (!answer) return null;
    await service.setSetting('splitNamePattern', answer.namePattern);
    await service.setSetting('splitKeepBookmarks', answer.keepBookmarks);
    await service.setSetting('splitKeepComments', answer.keepComments);
    await service.setSetting('splitKeepForms', answer.keepForms);

    const parts = await service.split({
      rule: answer.rule,
      namePattern: answer.namePattern,
      keepBookmarks: answer.keepBookmarks,
      keepComments: answer.keepComments,
      keepForms: answer.keepForms,
      baseName: service.baseName(doc),
      pageLabels: doc.state.pages.map((p) => p.label),
    });
    if (!parts) return null;
    const written: string[] = [];
    if (answer.folder !== null) {
      for (const part of parts) {
        const path = await service.writeInto(answer.folder, part.name, part.bytes);
        if (path !== null) written.push(path);
      }
      service.toasts.show({
        kind: 'success',
        text: `Wrote ${String(written.length)} ${written.length === 1 ? 'file' : 'files'} into ${answer.folder}.`,
      });
    }
    return service.record({
      parts: parts.map((p) => ({
        name: p.name,
        pages: [...p.pages],
        range: p.range,
        bytes: p.bytes.byteLength,
        size: formatBytes(p.bytes.byteLength),
      })),
      written,
    });
  },
};

function ruleFromArgs(by: string, args: CommandArgs) {
  switch (by) {
    case 'size':
      return { kind: 'size' as const, bytes: numberArg(args, 'bytes') ?? 1024 * 1024 };
    case 'bookmarks':
      return { kind: 'bookmarks' as const };
    case 'ranges': {
      const groups = args['groups'];
      return {
        kind: 'ranges' as const,
        groups: Array.isArray(groups)
          ? (groups as unknown[]).map((g) =>
              Array.isArray(g) ? g.filter((n): n is number => typeof n === 'number') : [],
            )
          : [],
      };
    }
    default:
      return { kind: 'count' as const, pages: numberArg(args, 'pages') ?? 1 };
  }
}

// ---- crop ----------------------------------------------------------------------------------------

const CROP_PAGES: CommandSpec = {
  id: 'organize.cropPages',
  label: 'Crop Pages…',
  category: 'Organize',
  icon: 'crop',
  permission: 'modify',
  description: 'Set the crop, trim, bleed or art box of a page or a run of pages',
  when: hasDocument,
  run: async (ctx) => {
    const service = ops(ctx);
    const doc = service.require();
    const cropContext = { document: doc, revision: doc.state.revision };
    const where = target(ctx);
    const page = where.indexes[0] ?? 0;
    const box = boxArg(ctx.args) ?? service.settings.cropBox;
    const givenRect = rectArg(ctx.args);
    if (givenRect) {
      const cropped = await service.crop({
        target: where,
        box,
        rect: givenRect,
        changePageSize: boolArg(ctx.args, 'changePageSize') ?? service.settings.cropChangesPageSize,
      });
      return service.record({ cropped, box, rect: givenRect });
    }

    const boxes = await service.pageBoxes(page, doc);
    const geometry = service.viewer?.pane.pageView(page)?.geometry;
    const extra = geometry?.extraRotation ?? 0;
    const picture = cropPreview(doc, page, extra, service.settings.cropMarginPoints).catch(
      () => null,
    );
    const initial = rectArg({ rect: ctx.args['initialRect'] });
    const unit = ctx.service<Registry>('registry').hasService(VIEWER_SERVICE)
      ? ctx.service<ViewerService>(VIEWER_SERVICE).settings.rulerUnits
      : 'mm';
    const answer = await askCrop({
      dialogs: service.dialogs,
      unit,
      page,
      pageLabel: doc.state.pages[page]?.label ?? String(page + 1),
      boxes,
      box,
      ratioChoice: cropRatio,
      rotation: geometry?.rotation ?? doc.state.pages[page]?.rotation ?? 0,
      changePageSize: service.settings.cropChangesPageSize,
      rangeContext: service.organise.rangeContext(doc),
      ...(initial === undefined ? {} : { initial }),
      preview: async () => await picture,
      detectMargins: async () => (await picture)?.ink ?? null,
    });
    if (!answer) return null;
    cropRatio = answer.ratioChoice;
    await service.setSetting('cropBox', answer.box);
    await service.setSetting('cropChangesPageSize', answer.changePageSize);
    const cropped = await applyCropChoice(service, answer, extra, cropContext);
    service.toasts.show({ kind: 'success', text: `Cropped ${countPages(cropped)}.` });
    return service.record({ cropped, box: answer.box, rect: answer.rect });
  },
};

const REMOVE_WHITE_MARGINS: CommandSpec = {
  id: 'organize.removeWhiteMargins',
  label: 'Remove White Margins',
  category: 'Organize',
  icon: 'crop',
  permission: 'modify',
  description: 'Crop each page to what is actually drawn on it',
  when: hasDocument,
  run: async (ctx) => {
    const service = ops(ctx);
    const doc = service.require();
    const where = target(ctx);
    const box = boxArg(ctx.args) ?? service.settings.cropBox;
    let cropped = 0;
    const blank: string[] = [];
    const result = await service.cancellable(
      async () =>
        await service.organise.withProgress(
          { title: 'Remove white margins', pages: where.indexes.length },
          async (report, signal) => {
            for (const [i, index] of where.indexes.entries()) {
              if (signal.aborted) return cropped;
              report(i / Math.max(1, where.indexes.length), `Measuring page ${String(index + 1)}`);
              const rect = await service.whiteMarginRect(index, doc);
              if (!rect) {
                blank.push(doc.state.pages[index]?.label ?? String(index + 1));
                continue;
              }
              cropped += await service.crop({
                target: service.organise.targetOf([index], doc),
                box,
                rect,
                changePageSize: service.settings.cropChangesPageSize,
                label: 'Remove white margins',
              });
            }
            report(1);
            return cropped;
          },
        ),
    );
    if (result === null) return null;
    if (blank.length > 0) {
      service.toasts.show({
        kind: 'warning',
        text: `Nothing to crop to on ${blank.length === 1 ? 'page' : 'pages'} ${blank.join(', ')}.`,
      });
    }
    if (cropped > 0) {
      service.toasts.show({ kind: 'success', text: `Cropped ${countPages(cropped)}.` });
    }
    return service.record({ cropped, blank });
  },
};

// ---- flatten -------------------------------------------------------------------------------------

const FLATTEN: CommandSpec = {
  id: 'organize.flatten',
  label: 'Flatten…',
  category: 'Organize',
  icon: 'layers-2',
  permission: 'modify',
  description: 'Draw comments and form fields into the page so they cannot be changed',
  when: hasDocument,
  run: async (ctx) => {
    const service = ops(ctx);
    const doc = service.require();
    const where = target(ctx);
    const action = stringArg(ctx.args, 'action');
    const annotations = boolArg(ctx.args, 'annotations') ?? service.settings.flattenAnnotations;
    const forms = boolArg(ctx.args, 'forms') ?? service.settings.flattenForms;
    const answer =
      action === undefined
        ? await askFlatten({
            dialogs: service.dialogs,
            annotations,
            forms,
            rangeContext: service.organise.rangeContext(doc),
            range: formatRange(doc.state.pages.map((_, i) => i)),
            counts: {
              annotations: Object.values(doc.state.annotations).reduce(
                (n, list) => n + list.length,
                0,
              ),
              fields: doc.state.fields.length,
            },
          })
        : {
            action: action === 'remove' ? ('remove' as const) : ('bake' as const),
            annotations,
            forms,
            pages: where.indexes,
          };
    if (!answer) return null;
    await service.setSetting('flattenAnnotations', answer.annotations);
    await service.setSetting('flattenForms', answer.forms);
    const flattened = await service.flatten({
      target: service.organise.targetOf(answer.pages, doc),
      annotations: answer.annotations,
      forms: answer.forms,
      remove: answer.action === 'remove',
    });
    if (flattened > 0) {
      service.toasts.show({
        kind: 'success',
        text:
          answer.action === 'remove'
            ? `Took the marks off ${countPages(flattened)}.`
            : `Flattened ${countPages(flattened)}.`,
      });
    }
    return service.record({ flattened, action: answer.action });
  },
};

// ---- straighten ----------------------------------------------------------------------------------

const DESKEW: CommandSpec = {
  id: 'organize.deskew',
  label: 'Straighten Pages…',
  category: 'Organize',
  icon: 'wand-sparkles',
  permission: 'modify',
  description: 'Measure how far a scanned page leans and turn it back',
  when: hasDocument,
  run: async (ctx) => {
    const service = ops(ctx);
    const doc = service.require();
    // Scanned documents are crooked page by page, so "Straighten Pages" means the whole document
    // unless the reader has picked some — which is not M40's usual rule, and is right here: the
    // dialog is a per-page table with a tick against each row, so offering one row would be
    // offering the wrong question.
    const where = anyTarget(ctx)
      ? target(ctx)
      : service.organise.targetOf(
          doc.state.pages.map((_, i) => i),
          doc,
        );
    const given = ctx.args['angles'];
    if (given && typeof given === 'object') {
      // The e2e path: exact angles, no measuring and no dialog.
      const angles: Record<number, number> = {};
      for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) angles[Number(key)] = value;
      }
      const straightened = await service.deskew(angles, {
        trimEdges: boolArg(ctx.args, 'trimEdges') ?? service.settings.deskewTrimEdges,
      });
      return service.record({ straightened, angles });
    }

    const measured = await service.detect(where.indexes);
    if (!measured) return null;
    const rows: DeskewRow[] = measured.map((result) => ({
      page: result.page,
      label: result.label,
      angle: result.angle,
      detected: result.angle,
      confidence: result.confidence,
      reason: result.reason,
      chosen: result.confidence !== 'none' && Math.abs(result.angle) >= 0.01,
    }));
    const answer = await askDeskew({
      dialogs: service.dialogs,
      rows,
      trimEdges: service.settings.deskewTrimEdges,
      preview: async (page) => (await pagePicture(service, page, 0.5))?.url ?? null,
    });
    if (!answer) return null;
    await service.setSetting('deskewTrimEdges', answer.trimEdges);
    const straightened = await service.deskew(answer.angles, { trimEdges: answer.trimEdges });
    if (straightened > 0) {
      service.toasts.show({ kind: 'success', text: `Straightened ${countPages(straightened)}.` });
    }
    return service.record({ straightened, angles: answer.angles });
  },
};

const AUTO_DESKEW: CommandSpec = {
  id: 'organize.autoDeskew',
  label: 'Straighten Every Page',
  category: 'Organize',
  icon: 'wand-sparkles',
  permission: 'modify',
  description: 'Measure and straighten the whole document, skipping pages it cannot measure',
  when: hasDocument,
  run: async (ctx) => {
    const service = ops(ctx);
    const doc = service.require();
    const all = doc.state.pages.map((_, i) => i);
    const measured = await service.detect(all);
    if (!measured) return null;
    const angles: Record<number, number> = {};
    const skipped: string[] = [];
    for (const result of measured) {
      if (result.confidence === 'none') {
        skipped.push(result.label);
        continue;
      }
      if (Math.abs(result.angle) >= 0.01) angles[result.page] = result.angle;
    }
    const straightened = await service.deskew(angles);
    const parts: string[] = [];
    parts.push(
      straightened === 0
        ? 'Nothing needed straightening.'
        : `Straightened ${countPages(straightened)}.`,
    );
    if (skipped.length > 0) {
      parts.push(
        `Skipped ${skipped.length === 1 ? 'page' : 'pages'} ${skipped.join(', ')} — nothing to measure against.`,
      );
    }
    service.toasts.show({ kind: straightened > 0 ? 'success' : 'info', text: parts.join(' ') });
    return service.record({ straightened, skipped, angles });
  },
};

// ---- the crop tool -------------------------------------------------------------------------------

const CROP_TOOL_COMMAND: CommandSpec = {
  id: 'organize.cropTool',
  label: 'Crop Tool',
  category: 'Organize',
  icon: 'crop',
  shortcut: 'Mod+Shift+C',
  permission: 'modify',
  description: 'Drag a rectangle on the page, then press Enter to review and crop it',
  when: hasDocument,
  run: (ctx) => {
    ctx.service<{ activate(id: string): void }>(SERVICE.tools).activate('tool.crop');
    return null;
  },
};

const CROP_RATIO: CommandSpec = {
  id: 'organize.cropRatio',
  label: 'Crop Aspect Ratio…',
  category: 'Organize',
  icon: 'crop',
  when: hasDocument,
  run: async (ctx) => {
    const answer = await askCropRatio(ops(ctx).dialogs, cropRatio);
    if (answer) cropRatio = answer;
  },
};

// ---- developer commands (e2e) --------------------------------------------------------------------

const DEV: ReadonlyArray<CommandSpec> = [
  {
    id: 'dev.documentOpsState',
    label: 'Developer: document operations state',
    category: 'Developer',
    hidden: true,
    run: (ctx) => {
      const service = ops(ctx);
      const doc = service.document;
      return {
        settings: { ...service.settings },
        last: service.lastOutcome,
        offThread: service.offThread,
        pageCount: doc?.pageCount ?? 0,
        pageIds: doc?.state.pages.map((p) => p.id) ?? [],
        boxes:
          doc?.state.pages.map((p) => ({
            crop: p.cropBox,
            media: p.mediaBox,
            trim: p.trimBox,
            bleed: p.bleedBox,
            art: p.artBox,
          })) ?? [],
        outline:
          doc?.state.outline.map((item) => {
            const destination = item.destinationId ? doc.destination(item.destinationId) : null;
            const pageId = destination?.pageId ?? null;
            return {
              title: item.title,
              page: pageId === null ? -1 : doc.pageIndex(pageId),
            };
          }) ?? [],
      };
    },
  },
  {
    id: 'dev.detectSkew',
    label: 'Developer: measure the skew of a page',
    category: 'Developer',
    hidden: true,
    when: hasDocument,
    run: async (ctx) => {
      const service = ops(ctx);
      const page = numberArg(ctx.args, 'page') ?? 0;
      const result = await service.detectOne(page);
      return { ...result };
    },
  },
  {
    id: 'dev.pageBoxes',
    label: 'Developer: every box of a page',
    category: 'Developer',
    hidden: true,
    when: hasDocument,
    run: async (ctx) => {
      const service = ops(ctx);
      return await service.pageBoxes(numberArg(ctx.args, 'page') ?? 0);
    },
  },
  {
    id: 'dev.setDocumentOpsSetting',
    label: 'Developer: change a document-operations setting',
    category: 'Developer',
    hidden: true,
    run: async (ctx) => {
      const service = ops(ctx);
      const name = stringArg(ctx.args, 'name');
      if (name === undefined || !(name in service.settings)) return null;
      const value = ctx.args['value'];
      await service.setSetting(name as keyof typeof service.settings, value as never);
      return { ...service.settings };
    },
  },
];

// ---- the module ----------------------------------------------------------------------------------

export default defineModule({
  id: 'M41',
  name: 'Combine, split, crop & flatten',

  commands: [
    COMBINE,
    SPLIT,
    CROP_TOOL_COMMAND,
    CROP_RATIO,
    CROP_PAGES,
    REMOVE_WHITE_MARGINS,
    FLATTEN,
    DESKEW,
    AUTO_DESKEW,
    ...DEV,
  ],

  settings: MERGE_SETTINGS_SCHEMA,

  tools: [
    cropTool({
      pageBox: (page) => {
        const doc = live?.document;
        return doc?.state.pages[page]?.cropBox ?? null;
      },
      geometry: (page) => live?.viewer?.pane.pageView(page)?.geometry ?? null,
      overlayFor: (page) => {
        const viewer = live?.viewer;
        return viewer?.pane.pageView(page)?.layers.tool ?? null;
      },
      commit: (page, rect) => {
        void live?.run('organize.cropPages', { pages: [page], initialRect: rect });
      },
      ratio: () => readCropRatio(cropRatio) ?? null,
      step: () => 1,
    }),
  ],

  ribbon: [
    {
      id: 'convert.combine',
      tab: 'convert',
      label: 'Combine',
      order: 5,
      items: [{ kind: 'button', command: COMBINE.id, size: 'large' }],
    },
    {
      id: 'organize.document',
      tab: 'organize',
      label: 'Document',
      order: 20,
      when: hasDocument,
      items: [
        { kind: 'button', command: SPLIT.id, size: 'large' },
        {
          kind: 'split',
          command: CROP_TOOL_COMMAND.id,
          size: 'large',
          menu: [CROP_PAGES.id, CROP_RATIO.id, REMOVE_WHITE_MARGINS.id],
        },
        {
          kind: 'split',
          command: DESKEW.id,
          size: 'large',
          menu: [AUTO_DESKEW.id],
        },
        { kind: 'button', command: FLATTEN.id, size: 'large' },
      ],
    },
  ],

  contextMenus: [
    {
      // M12's thumbnails panel: its own right-click handler selects the page under the pointer
      // first, so these act on what was clicked rather than on a stale selection.
      id: 'organize.pageOpsMenu',
      region: '[data-panel-scroll="pages"]',
      order: 20,
      when: hasDocument,
      items: [CROP_PAGES.id, REMOVE_WHITE_MARGINS.id, DESKEW.id, FLATTEN.id],
    },
  ],

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (!registry.hasService('shellServices')) return undefined;
    // `Registry.dispose()` runs the disposers but leaves the services registered, so a
    // dispose-then-activate cycle arrives here with the service still in place (M40's note).
    const existing = registry.hasService(MERGE_SERVICE)
      ? registry.service<MergeService>(MERGE_SERVICE)
      : null;
    registerIcon('combine', Combine);
    registerIcon('crop', Crop);
    registerIcon('circle-slash', CircleSlash);
    registerIcon('layers-2', Layers2);
    registerIcon('square-split-vertical', SquareSplitVertical);
    registerIcon('wand-sparkles', WandSparkles);
    registerMergeCodecs();
    const shell = registry.service<ShellServices>('shellServices');
    const service = existing ?? new MergeService({ registry, shell });
    live = service;
    if (existing === null) {
      registry.provide(MERGE_SERVICE, service);
      void service.load();
    }
    return () => {
      live = null;
    };
  },
});

/** Exposed for the unit tests, which drive the service without the shell. */
export function activeMergeService(): MergeService | null {
  return live;
}
