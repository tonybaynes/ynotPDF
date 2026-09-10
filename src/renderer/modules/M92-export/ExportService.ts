/**
 * `ExportService` (M92) — registered as `"export"`.
 *
 * Where the two halves meet: the pure exporters in `src/engine/export/`, which know nothing about
 * a document or a tab, and the open `Document`, which is the authority on what the reader meant.
 * The commands in `manifest.ts` are thin — read arguments, ask a dialog when there is something to
 * ask, call a method here — and everything headless is what M120's batch runner and the e2e suite
 * will call.
 *
 * Three things worth knowing:
 *
 * - **Nothing here is a `Command`.** An export reads a document and writes files beside it; the
 *   document is not touched, so there is nothing to undo. Every action is still a registered
 *   command with a palette entry, and every one can be driven entirely from its arguments.
 * - **Pages are rendered one at a time and the pixels are handed straight on** to the export
 *   worker, which encodes them while the engine renders the next one. Nothing holds a whole
 *   document's worth of bitmaps.
 * - **Files are written one at a time** through `file:writeInto` (M42's channel), so a 500-page
 *   export costs one page of memory rather than five hundred.
 */

import type { ShellServices } from '@app/services';
import type { Document } from '@core/Document';
import type { Registry } from '@core/Registry';
import type { DocHandle, PdfEngine } from '@engine/PdfEngine';
import { hasBridge, invoke } from '@shared/ipc';
import {
  DEFAULT_IMAGE_BUDGET,
  ExportCancelled,
  ExportFailed,
  IMAGE_FORMATS,
  documentStem,
  encodePngRgb,
  isExportCancelled,
  type EmbeddedImageLike,
  type ExportPage,
  type ExportPageImage,
  type ExportResult,
  type ExportedFile,
  type ImageExportOptions,
  type Raster,
} from '@engine/export';
import { buildPageText } from '@view/TextLayer';
import {
  DOCUMENT_SERVICE,
  type DocumentService,
} from '@modules/M20-document-model/DocumentService';
import {
  ORGANISE_SERVICE,
  type OrganiseService,
} from '@modules/M40-organise-pages/OrganiseService';
import { ExportClient, type ExportHandle } from './ExportClient';
import {
  DEFAULT_EXPORT_SETTINGS,
  ipcSettingsStorage,
  readExportSettings,
  writeExportSettings,
  type ExportSettings,
  type SettingsStorage,
} from './settings';

export const EXPORT_SERVICE = 'export';

/** What one export did, for the status command and the e2e suite to read back. */
export interface ExportOutcome {
  readonly kind: string;
  /** File names, in the order they were written. */
  readonly files: ReadonlyArray<string>;
  readonly bytes: number;
  readonly warnings: ReadonlyArray<string>;
  /** Where they went; `null` when the caller took the bytes instead of a folder. */
  readonly directory: string | null;
}

export interface ExportServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
  readonly storage?: SettingsStorage;
  readonly client?: ExportClient;
}

/** Where an export should put its files. */
export interface Destination {
  /** A folder; every file is written into it. */
  readonly directory?: string;
  /** A single file's path, for an export that produces exactly one. */
  readonly path?: string;
  /** Ask the reader. The default when neither is given and there is a bridge. */
  readonly ask?: boolean;
}

export class ExportService {
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly storage: SettingsStorage;
  private clientValue: ExportClient | null;
  private settingsValue: ExportSettings = DEFAULT_EXPORT_SETTINGS;
  private readonly listeners = new Set<(settings: ExportSettings) => void>();
  /** What the last export did, for `dev.exportState`. */
  lastOutcome: ExportOutcome | null = null;

  constructor(options: ExportServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.storage = options.storage ?? ipcSettingsStorage();
    this.clientValue = options.client ?? null;
  }

  // ---- wiring ------------------------------------------------------------------------------

  get settings(): ExportSettings {
    return this.settingsValue;
  }

  /**
   * The export Worker, started the first time something needs it — as M21's writer, M91's
   * converters and M41's operations are. Most sessions never export anything, and a Worker costs
   * a thread and a parsed bundle at boot.
   */
  get client(): ExportClient {
    this.clientValue ??= ExportClient.spawn();
    return this.clientValue;
  }

  async load(): Promise<void> {
    this.settingsValue = await readExportSettings(this.storage);
    for (const listener of this.listeners) listener(this.settingsValue);
  }

  onSettingsChange(listener: (settings: ExportSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Writes what a dialog just chose, so the next export opens on the same answers. */
  async remember(patch: Partial<ExportSettings>): Promise<void> {
    this.settingsValue = { ...this.settingsValue, ...patch };
    await writeExportSettings(this.storage, patch);
    for (const listener of this.listeners) listener(this.settingsValue);
  }

  get document(): Document | null {
    if (!this.registry.hasService(DOCUMENT_SERVICE)) return null;
    return this.registry.service<DocumentService>(DOCUMENT_SERVICE).active;
  }

  /** The active document, or a clear error. Commands reaching this are gated on `when`. */
  require(): Document {
    const doc = this.document;
    if (!doc) throw new ExportFailed('No document is open.');
    return doc;
  }

  private get organise(): OrganiseService | null {
    return this.registry.hasService(ORGANISE_SERVICE)
      ? this.registry.service<OrganiseService>(ORGANISE_SERVICE)
      : null;
  }

  /** The document's name without its extension — what every default file name is built from. */
  stemOf(doc: Document = this.require()): string {
    return documentStem(doc.state.path ?? doc.state.title);
  }

  /** Every page, 0-based. */
  allPages(doc: Document = this.require()): number[] {
    return Array.from({ length: doc.pageCount }, (_, i) => i);
  }

  /**
   * The pages a command acts on: what it was told, else the thumbnail selection, else all of them.
   *
   * Note the last step: M40's targeting rule ends at *the current page*, which is right for
   * "rotate this" and wrong for "export this document" — a reader who chose nothing means the
   * whole thing. The range dialect and the selection are M40's; only the fallback differs.
   */
  target(args: Readonly<Record<string, unknown>> = {}, doc: Document = this.require()): number[] {
    const organise = this.organise;
    if (Array.isArray(args['pages'])) {
      return (args['pages'] as unknown[])
        .filter((p): p is number => typeof p === 'number')
        .filter((p) => Number.isInteger(p) && p >= 0 && p < doc.pageCount);
    }
    if (typeof args['range'] === 'string' && organise) {
      return [...organise.target({ range: args['range'] }, doc).indexes];
    }
    const selected = organise?.selectedPages().filter((p) => p < doc.pageCount) ?? [];
    return selected.length > 0 ? selected : this.allPages(doc);
  }

  // ---- reading the document ----------------------------------------------------------------

  /**
   * A `RenderPage` bound to one document: `dpi / 72` device pixels per point, with the reader's
   * annotation and form choices, on white paper.
   *
   * Night Mode is deliberately not consulted. It is how the reader chose to *look* at the page on
   * a screen; an exported picture of the page is the page as its author made it.
   */
  renderer(
    doc: Document,
    options: { readonly annotations: boolean; readonly forms: boolean },
  ): (page: number, dpi: number) => Promise<Raster> {
    const engine: PdfEngine = doc.engine;
    const handle: DocHandle = doc.handle;
    return async (page, dpi) => {
      const modelPage = doc.state.pages[page];
      const enginePage = modelPage ? doc.enginePage(modelPage.id) : undefined;
      if (enginePage === undefined) {
        throw new ExportFailed(`Page ${String(page + 1)} is not in the document any more.`);
      }
      const result = await engine.render(handle, enginePage, dpi / 72, undefined, {
        annotations: options.annotations,
        forms: options.forms,
        background: 0xffffff,
        printing: true,
      });
      return rasterOf(result.bitmap);
    };
  }

  /** One page as the text exporters want it: its size, its text model and its label. */
  async pageOf(doc: Document, index: number, withImages = false): Promise<ExportPage> {
    const modelPage = doc.state.pages[index];
    if (!modelPage) throw new ExportFailed(`Page ${String(index + 1)} is not in the document.`);
    const enginePage = doc.enginePage(modelPage.id);
    const size = doc.pageSize(modelPage.id);
    let runs: Awaited<ReturnType<PdfEngine['textRuns']>> = [];
    if (enginePage !== undefined) {
      try {
        runs = await doc.engine.textRuns(doc.handle, enginePage);
      } catch {
        // A page whose text cannot be read is an empty page, not a failed export.
        runs = [];
      }
    }
    const images =
      withImages && enginePage !== undefined ? await this.pageImages(doc, enginePage) : undefined;
    return {
      index,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      text: buildPageText(index, runs),
      ...(modelPage.label === undefined || modelPage.label === null
        ? {}
        : { label: modelPage.label }),
      ...(images === undefined ? {} : { images }),
    };
  }

  /** Every page of the document, read one at a time so a long document does not spike memory. */
  async pagesOf(
    doc: Document,
    pages: ReadonlyArray<number>,
    options: {
      readonly withImages?: boolean;
      readonly onProgress?: (fraction: number, message: string) => void;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<ExportPage[]> {
    const out: ExportPage[] = [];
    for (const [i, page] of pages.entries()) {
      if (options.signal?.aborted === true) throw new ExportCancelled();
      options.onProgress?.(i / Math.max(1, pages.length), `Reading page ${String(page + 1)}`);
      out.push(await this.pageOf(doc, page, options.withImages === true));
    }
    return out;
  }

  /** The pictures on one engine page, encoded so they can be embedded in HTML. */
  private async pageImages(doc: Document, enginePage: number): Promise<ExportPageImage[]> {
    const engine = doc.engine;
    if (typeof engine.pageImages !== 'function') return [];
    let images: ReadonlyArray<EmbeddedImageLike>;
    try {
      images = await engine.pageImages(doc.handle, enginePage);
    } catch {
      return [];
    }
    const out: ExportPageImage[] = [];
    for (const image of images) {
      const withRect = image as EmbeddedImageLike & {
        rect?: { x0: number; y0: number; x1: number; y1: number };
      };
      const rect = withRect.rect ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
      if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) continue;
      if (image.encoding === 'rgba') {
        out.push({
          rect,
          mediaType: 'image/png',
          bytes: encodePngRgb(image.data, image.width, image.height, {
            level: this.settingsValue.compressionLevel,
          }),
        });
      } else {
        out.push({
          rect,
          mediaType: image.encoding === 'jpeg' ? 'image/jpeg' : 'image/jp2',
          bytes: image.data,
        });
      }
    }
    return out;
  }

  /** Every embedded image in the document, page by page. */
  async embeddedImages(
    doc: Document,
    options: {
      readonly onProgress?: (fraction: number, message: string) => void;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<EmbeddedImageLike[]> {
    const engine = doc.engine;
    if (typeof engine.pageImages !== 'function') {
      throw new ExportFailed(
        'This build of the PDF engine cannot read the pictures inside a document. Export the pages as images instead.',
      );
    }
    const out: EmbeddedImageLike[] = [];
    const pages = doc.state.pages;
    for (const [index, page] of pages.entries()) {
      if (options.signal?.aborted === true) throw new ExportCancelled();
      options.onProgress?.(index / Math.max(1, pages.length), `Page ${String(index + 1)}`);
      const enginePage = doc.enginePage(page.id);
      if (enginePage === undefined) continue;
      try {
        for (const image of await engine.pageImages(doc.handle, enginePage)) {
          // The engine numbers pages as *it* has them; the reader counts the ones on screen.
          out.push({ ...image, page: index });
        }
      } catch {
        // A page whose objects cannot be read has no pictures, rather than failing the export.
      }
    }
    return out;
  }

  // ---- running an export -------------------------------------------------------------------

  /**
   * Runs a job with M40's progress dialog — which only appears if the work turns out to be slow —
   * writes what it produced, and reports it.
   */
  async run(
    kind: string,
    title: string,
    pages: number,
    start: (
      report: (fraction: number | null, message: string) => void,
      signal: AbortSignal,
    ) => ExportHandle,
    destination: Destination,
  ): Promise<ExportOutcome | null> {
    const organise = this.organise;
    const work = async (
      report: (fraction: number, text?: string) => void,
      signal: AbortSignal,
    ): Promise<ExportResult> => {
      const handle = start((fraction, message) => {
        report(fraction ?? 0, message);
      }, signal);
      const onAbort = (): void => {
        handle.cancel();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        return await handle.promise;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    };
    let result: ExportResult;
    try {
      result = organise
        ? await organise.withProgress({ title, text: 'Starting', pages }, work)
        : await work(() => undefined, new AbortController().signal);
    } catch (error) {
      if (isExportCancelled(error)) {
        this.shell.toasts.show({ kind: 'info', text: `${title} was cancelled.` });
        return null;
      }
      this.shell.toasts.show({ kind: 'error', text: messageOf(error) });
      return null;
    }
    const written = await this.write(result.files, destination);
    if (written === null) return null;
    const outcome: ExportOutcome = {
      kind,
      files: result.files.map((f) => f.name),
      bytes: result.files.reduce((n, f) => n + f.bytes.byteLength, 0),
      warnings: result.warnings,
      directory: written.directory,
    };
    this.lastOutcome = outcome;
    this.report(title, outcome, written.directory);
    return outcome;
  }

  /**
   * Writes the files. One file goes to a Save As dialog; several go into a folder the reader
   * chooses. `directory` / `path` in the arguments skip the dialog, which is how a test and a
   * batch run drive it.
   */
  private async write(
    files: ReadonlyArray<ExportedFile>,
    destination: Destination,
  ): Promise<{ directory: string | null } | null> {
    if (files.length === 0) return { directory: null };
    if (!hasBridge()) return { directory: null };
    const single = files.length === 1 ? files[0] : undefined;
    if (destination.path !== undefined && single) {
      await invoke('file:write', destination.path, single.bytes);
      return { directory: directoryOf(destination.path) };
    }
    let directory = destination.directory;
    if (directory === undefined && single && destination.ask !== false) {
      const path = await invoke('file:saveAsDialog', {
        defaultPath: single.name,
        title: 'Export',
        buttonLabel: 'Export',
        filters: filtersFor(single),
      });
      if (path === null) return null;
      await invoke('file:write', path, single.bytes);
      return { directory: directoryOf(path) };
    }
    if (directory === undefined) {
      if (destination.ask === false) return { directory: null };
      const chosen = await invoke('dialog:pickFolder', 'Choose where to put the exported files');
      if (chosen === null) return null;
      directory = chosen;
    }
    for (const file of files) {
      await invoke('file:writeInto', directory, file.name, file.bytes);
      // One macrotask between files: a folder of five hundred keeps the window alive.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { directory };
  }

  /** Says what happened, in words, with a way to see it. */
  private report(title: string, outcome: ExportOutcome, directory: string | null): void {
    const count = outcome.files.length;
    if (count === 0) {
      this.shell.toasts.show({
        kind: 'warning',
        text: outcome.warnings[0] ?? `${title}: there was nothing to export.`,
      });
      return;
    }
    const what = count === 1 ? (outcome.files[0] ?? 'one file') : `${String(count)} files`;
    const where = directory === null ? '' : ` to ${directory}`;
    this.shell.toasts.show({
      kind: outcome.warnings.length > 0 ? 'warning' : 'success',
      text: `${title}: wrote ${what}${where}. ${outcome.warnings.join(' ')}`.trim(),
      ...(directory !== null && hasBridge()
        ? {
            actions: [
              {
                label: 'Show in folder',
                run: () => {
                  void invoke('shell:showItemInFolder', directory);
                },
              },
            ],
          }
        : {}),
    });
  }

  // ---- the five exports --------------------------------------------------------------------

  /** Pages as images. */
  async exportImages(
    options: Omit<ImageExportOptions, 'pages' | 'pageCount' | 'documentName'> & {
      readonly pages: ReadonlyArray<number>;
      readonly annotations?: boolean;
      readonly forms?: boolean;
    },
    destination: Destination = { ask: true },
  ): Promise<ExportOutcome | null> {
    const doc = this.require();
    const settings = this.settingsValue;
    const full: ImageExportOptions = {
      ...options,
      pages: [...options.pages],
      pageCount: doc.pageCount,
      documentName: this.stemOf(doc),
      labels: doc.state.pages.map((p) => p.label ?? ''),
      when: new Date(),
    };
    const render = this.renderer(doc, {
      annotations: options.annotations ?? settings.imageAnnotations,
      forms: options.forms ?? settings.imageForms,
    });
    return await this.run(
      'images',
      'Export pages as images',
      options.pages.length,
      (report) => this.client.images(full, { onProgress: report, render }),
      destination,
    );
  }

  /** Every picture inside the document. */
  async exportEmbedded(
    options: {
      readonly namePattern?: string;
      readonly minPixels?: number;
      readonly keepDuplicates?: boolean;
    } = {},
    destination: Destination = { ask: true },
  ): Promise<ExportOutcome | null> {
    const doc = this.require();
    const settings = this.settingsValue;
    return await this.run(
      'embedded',
      'Export all images',
      doc.pageCount,
      (report, signal) => {
        const promise = (async () => {
          const images = await this.embeddedImages(doc, {
            onProgress: (fraction, message) => {
              report(fraction * 0.6, message);
            },
            signal,
          });
          return this.client.embedded(
            images,
            {
              documentName: this.stemOf(doc),
              pageCount: doc.pageCount,
              namePattern: options.namePattern ?? settings.embeddedNamePattern,
              minPixels: options.minPixels ?? settings.embeddedMinPixels,
              keepDuplicates: options.keepDuplicates ?? settings.embeddedKeepDuplicates,
              level: settings.compressionLevel,
              when: new Date(),
            },
            {
              onProgress: (fraction, message) => {
                report(0.6 + (fraction ?? 0) * 0.4, message);
              },
            },
          );
        })();
        return {
          promise: promise.then((handle) => handle.promise),
          cancel: () => {
            void promise.then((handle) => {
              handle.cancel();
            });
          },
        };
      },
      destination,
    );
  }

  /** The text layer, in reading order. */
  async exportText(
    options: {
      readonly pages?: ReadonlyArray<number>;
      readonly encoding?: ExportSettings['textEncoding'];
      readonly lineEnding?: ExportSettings['textLineEnding'];
      readonly pageSeparator?: ExportSettings['textPageSeparator'];
      readonly bom?: boolean;
      readonly skipBlankLines?: boolean;
    } = {},
    destination: Destination = { ask: true },
  ): Promise<ExportOutcome | null> {
    const doc = this.require();
    const settings = this.settingsValue;
    const pages = options.pages ?? this.allPages(doc);
    return await this.run(
      'text',
      'Export text',
      pages.length,
      (report, signal) =>
        this.textLike(doc, pages, report, signal, false, (models) =>
          this.client.text(
            models,
            {
              documentName: this.stemOf(doc),
              encoding: options.encoding ?? settings.textEncoding,
              lineEnding: options.lineEnding ?? settings.textLineEnding,
              pageSeparator: options.pageSeparator ?? settings.textPageSeparator,
              bom: options.bom ?? settings.textBom,
              ...(options.skipBlankLines === undefined
                ? {}
                : { skipBlankLines: options.skipBlankLines }),
            },
            {
              onProgress: (fraction, message) => {
                report(0.6 + (fraction ?? 0) * 0.4, message);
              },
            },
          ),
        ),
      destination,
    );
  }

  /** The document as HTML. */
  async exportHtml(
    options: {
      readonly pages?: ReadonlyArray<number>;
      readonly layout?: ExportSettings['htmlLayout'];
      readonly perPage?: boolean;
      readonly embedImages?: boolean;
      readonly keepStyles?: boolean;
      readonly imageBudget?: number;
    } = {},
    destination: Destination = { ask: true },
  ): Promise<ExportOutcome | null> {
    const doc = this.require();
    const settings = this.settingsValue;
    const pages = options.pages ?? this.allPages(doc);
    const embedImages = options.embedImages ?? settings.htmlEmbedImages;
    return await this.run(
      'html',
      'Export as HTML',
      pages.length,
      (report, signal) =>
        this.textLike(doc, pages, report, signal, embedImages, (models) =>
          this.client.html(
            models,
            {
              documentName: this.stemOf(doc),
              title: doc.state.metadata.title ?? this.stemOf(doc),
              layout: options.layout ?? settings.htmlLayout,
              perPage: options.perPage ?? settings.htmlPerPage,
              embedImages,
              keepStyles: options.keepStyles ?? settings.htmlKeepStyles,
              imageBudget: options.imageBudget ?? DEFAULT_IMAGE_BUDGET,
            },
            {
              onProgress: (fraction, message) => {
                report(0.6 + (fraction ?? 0) * 0.4, message);
              },
            },
          ),
        ),
      destination,
    );
  }

  /** The document as RTF. */
  async exportRtf(
    options: {
      readonly pages?: ReadonlyArray<number>;
      readonly pageBreaks?: boolean;
      readonly keepColours?: boolean;
      readonly keepSizes?: boolean;
    } = {},
    destination: Destination = { ask: true },
  ): Promise<ExportOutcome | null> {
    const doc = this.require();
    const settings = this.settingsValue;
    const pages = options.pages ?? this.allPages(doc);
    return await this.run(
      'rtf',
      'Export as RTF',
      pages.length,
      (report, signal) =>
        this.textLike(doc, pages, report, signal, false, (models) =>
          this.client.rtf(
            models,
            {
              documentName: this.stemOf(doc),
              pageBreaks: options.pageBreaks ?? settings.rtfPageBreaks,
              keepColours: options.keepColours ?? settings.rtfKeepColours,
              keepSizes: options.keepSizes ?? settings.rtfKeepSizes,
            },
            {
              onProgress: (fraction, message) => {
                report(0.6 + (fraction ?? 0) * 0.4, message);
              },
            },
          ),
        ),
      destination,
    );
  }

  /**
   * The shape the three text exports share: read the pages (0–60 % of the bar, because that is
   * where the engine round trips are), then hand the models to the worker (60–100 %).
   */
  private textLike(
    doc: Document,
    pages: ReadonlyArray<number>,
    report: (fraction: number | null, message: string) => void,
    signal: AbortSignal,
    withImages: boolean,
    run: (models: ExportPage[]) => ExportHandle,
  ): ExportHandle {
    let inner: ExportHandle | null = null;
    let cancelled = false;
    const promise = (async () => {
      const models = await this.pagesOf(doc, pages, {
        withImages,
        signal,
        onProgress: (fraction, message) => {
          report(fraction * 0.6, message);
        },
      });
      if (cancelled) throw new ExportCancelled();
      inner = run(models);
      return await inner.promise;
    })();
    return {
      promise,
      cancel: () => {
        cancelled = true;
        inner?.cancel();
      },
    };
  }

  dispose(): void {
    this.clientValue?.terminate();
    this.clientValue = null;
    this.listeners.clear();
  }
}

/** An `ImageBitmap`'s pixels. In Node the engine hands back the pixels under the same field. */
function rasterOf(bitmap: ImageBitmap): Raster {
  const asPixels = bitmap as unknown as {
    data?: Uint8ClampedArray | Uint8Array;
    width: number;
    height: number;
  };
  if (asPixels.data) {
    return { data: asPixels.data, width: asPixels.width, height: asPixels.height };
  }
  if (typeof OffscreenCanvas === 'undefined') {
    throw new ExportFailed('This window cannot draw pages to export them.');
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (!context) throw new ExportFailed('This window cannot draw pages to export them.');
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { data: image.data, width: image.width, height: image.height };
}

/** The Save As filter for one file, from the format tables rather than from a second list. */
function filtersFor(file: ExportedFile): Array<{ name: string; extensions: string[] }> {
  const extension = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  const format = Object.values(IMAGE_FORMATS).find((f) => f.extension.slice(1) === extension);
  const name =
    format?.label ??
    (extension === 'txt'
      ? 'Text'
      : extension === 'html'
        ? 'Web page'
        : extension === 'rtf'
          ? 'Rich text'
          : 'File');
  return [
    { name, extensions: [extension] },
    { name: 'All files', extensions: ['*'] },
  ];
}

function directoryOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at > 0 ? path.slice(0, at) : path;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
