/**
 * `CreateService` (M91) — what File → Create actually does: pick files, ask the options, run the
 * converter (in the Worker when it is CPU work, through main when it is Chromium's), open the
 * result as an unsaved document, and say in words what happened.
 *
 * Everything headless — `convert()` and `convertFile()` — is what M40, M41, M120 and the e2e
 * suite call; the dialogs sit on top of it and never inside it.
 */

import type { ShellServices } from '@app/services';
import type { ProgressHandle } from '@app/dialog/Dialogs';
import type { Registry } from '@core/Registry';
import {
  DEFAULT_WEB_PRINT_SETTINGS,
  type WebPrintSettings,
  type WebRenderResult,
  type WebRenderSource,
} from '@shared/create';
import { hasBridge, invoke, type OpenedFile } from '@shared/ipc';
import {
  DEFAULT_BLANK_OPTIONS,
  type BlankConvertOptions,
} from '@engine/create/blank/BlankConverter';
import {
  DEFAULT_HTML_OPTIONS,
  isMarkdown,
  type HtmlConvertOptions,
} from '@engine/create/html/HtmlConverter';
import type { ImageConvertOptions } from '@engine/create/images/ImageConverter';
import { DEFAULT_IMAGE_LAYOUT } from '@engine/create/images/layout';
import { createRegistry, type ConverterRegistry } from '@engine/create/registry';
import { DEFAULT_TEXT_OPTIONS, type TextConvertOptions } from '@engine/create/text/TextConverter';
import { decodeText } from '@engine/create/text/decode';
import {
  ConvertCancelled,
  ConvertUnsupported,
  type ConvertInput,
  type ConvertProgress,
  type ConvertResult,
  type Converter,
  type HtmlPrinter,
} from '@engine/create/types';
import { DEFAULT_WEB_OPTIONS, type WebConvertOptions } from '@engine/create/web/WebConverter';
import markdownStylesheet from '../../../../resources/create/markdown.css?raw';
import { ConvertClient, type ConvertHandle } from './ConvertClient';
import {
  askBlankOptions,
  askHtmlOptions,
  askImageOptions,
  askTextOptions,
  askWebOptions,
} from './dialogs';
import { openCreatedDocument, type OpenedCreated } from './open';
import { windowRasterDecoder } from './rasterDecoder';
import {
  DEFAULT_CREATE_SETTINGS,
  ipcSettingsStorage,
  readCreateSettings,
  readLastOptions,
  writeCreateSetting,
  writeLastOptions,
  type CreateSettings,
  type SettingsStorage,
} from './settings';

export const CREATE_SERVICE = 'create';

const PROGRESS_DELAY_MS = 400;

/** What one creation did, as the status command reports it. */
export interface CreateOutcome {
  readonly kind: string;
  readonly title: string;
  readonly pageCount: number;
  readonly warnings: ReadonlyArray<string>;
  readonly tabId: string | null;
}

export interface CreateState {
  readonly busy: boolean;
  readonly untitled: number;
  readonly last: CreateOutcome | null;
  readonly offThread: boolean;
}

export interface CreateServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
  readonly settingsStorage?: SettingsStorage;
  /** The worker client; tests pass an in-process one. */
  readonly client?: ConvertClient;
  readonly printer?: HtmlPrinter;
}

/** The kinds a caller can name headlessly. */
export type CreateKind = 'image' | 'text' | 'html' | 'web' | 'blank';

export class CreateService {
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly settingsStorage: SettingsStorage;
  private settingsValue: CreateSettings = DEFAULT_CREATE_SETTINGS;
  private clientValue: ConvertClient | null;
  private readonly printer: HtmlPrinter;
  /** In-process converters for what needs main (the printer) or the window (the OS decoder). */
  private readonly local: ConvertClient;
  private readonly routing: ConverterRegistry = createRegistry();
  private untitledCount = 0;
  private busyCount = 0;
  private last: CreateOutcome | null = null;
  private readonly disposers: Array<() => void> = [];

  constructor(options: CreateServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.settingsStorage = options.settingsStorage ?? ipcSettingsStorage();
    this.clientValue = options.client ?? null;
    this.printer = options.printer ?? ipcPrinter();
    this.local = new ConvertClient(null, {
      printer: this.printer,
      rasterDecoder: windowRasterDecoder,
    });
  }

  get settings(): CreateSettings {
    return this.settingsValue;
  }

  get state(): CreateState {
    return {
      busy: this.busyCount > 0,
      untitled: this.untitledCount,
      last: this.last,
      offThread: this.clientValue?.offThread ?? false,
    };
  }

  /** The registry, for callers that route files themselves (drag-and-drop, M40, M41). */
  get converters(): ConverterRegistry {
    return this.routing;
  }

  /** Spawned on first use: the Worker loads pdf-lib and utif, which nothing needs until then. */
  private get client(): ConvertClient {
    this.clientValue ??= ConvertClient.spawn();
    return this.clientValue;
  }

  async load(): Promise<void> {
    this.settingsValue = await readCreateSettings(this.settingsStorage);
  }

  async setSetting<K extends keyof CreateSettings>(
    name: K,
    value: CreateSettings[K],
  ): Promise<void> {
    this.settingsValue = { ...this.settingsValue, [name]: value };
    await writeCreateSetting(this.settingsStorage, name, value);
    this.shell.invalidate();
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.clientValue?.dispose();
    this.local.dispose();
  }

  // ---- defaults ---------------------------------------------------------------------------------

  private get pageDefaults(): {
    pageSize: { kind: 'preset'; id: string };
    margins: { top: number; right: number; bottom: number; left: number };
  } {
    const mm = this.settingsValue.marginsMm;
    return {
      pageSize: { kind: 'preset', id: this.settingsValue.pageSize },
      margins: { top: mm, right: mm, bottom: mm, left: mm },
    };
  }

  private get printDefaults(): WebPrintSettings {
    return {
      ...DEFAULT_WEB_PRINT_SETTINGS,
      ...this.pageDefaults,
      backgroundGraphics: this.settingsValue.webBackgroundGraphics,
      timeoutMs: this.settingsValue.webTimeoutSeconds * 1000,
    };
  }

  /** The options a kind starts from: the settings, then whatever the reader chose last time. */
  async defaultsFor(kind: CreateKind): Promise<Record<string, unknown>> {
    const base: Record<string, unknown> = (() => {
      switch (kind) {
        case 'image':
          return {
            ...DEFAULT_IMAGE_LAYOUT,
            ...this.pageDefaults,
            margins: { top: 10, right: 10, bottom: 10, left: 10 },
            defaultDpi: this.settingsValue.defaultDpi,
          } satisfies ImageConvertOptions;
        case 'text':
          return {
            ...DEFAULT_TEXT_OPTIONS,
            ...this.pageDefaults,
            font: this.settingsValue.textFont,
            fontSize: this.settingsValue.textFontSize,
          } satisfies TextConvertOptions;
        case 'html':
          return {
            ...DEFAULT_HTML_OPTIONS,
            settings: this.printDefaults,
            markdownStylesheet,
          } satisfies HtmlConvertOptions;
        case 'web':
          return {
            ...DEFAULT_WEB_OPTIONS,
            settings: this.printDefaults,
          } satisfies WebConvertOptions;
        default:
          return {
            ...DEFAULT_BLANK_OPTIONS,
            pageSize: this.pageDefaults.pageSize,
          } satisfies BlankConvertOptions;
      }
    })();
    const last = await readLastOptions(this.settingsStorage, kind);
    if (!last) return base;
    // Only keys the defaults know, with the same type — a stale or malformed memory is ignored.
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(last)) {
      if (key === 'url' || key === 'title') continue;
      if (key in base && typeof base[key] === typeof value) merged[key] = value;
    }
    return merged;
  }

  private async remember(kind: CreateKind, options: unknown): Promise<void> {
    await writeLastOptions(this.settingsStorage, kind, options).catch(() => undefined);
  }

  /** "Untitled 1", "Untitled 2"… for documents with no source to be named after. */
  nextUntitled(): string {
    this.untitledCount++;
    return `Untitled ${String(this.untitledCount)}`;
  }

  // ---- headless ---------------------------------------------------------------------------------

  /**
   * Runs one converter with explicit options and no dialog. Image, text and blank go to the
   * Worker; HTML and web run here, where main's printer can be reached. A Worker that has no
   * decoder for an image is retried here with the OS's.
   */
  convert(
    kind: CreateKind,
    inputs: ReadonlyArray<ConvertInput>,
    options: unknown,
    hooks: { readonly progress?: ConvertProgress; readonly signal?: AbortSignal } = {},
  ): ConvertHandle {
    const needsWindow = kind === 'html' || kind === 'web';
    const first = needsWindow ? this.local : this.client;
    const start = (client: ConvertClient): ConvertHandle =>
      client.convert({
        converter: kind,
        inputs,
        options,
        ...(hooks.progress === undefined ? {} : { onProgress: hooks.progress }),
      });
    let current = start(first);
    let cancelled = false;
    const promise = current.promise.catch(async (error: unknown) => {
      if (
        cancelled ||
        needsWindow ||
        !(error instanceof ConvertUnsupported) ||
        error.reason !== 'no-decoder'
      ) {
        throw error;
      }
      current = start(this.local);
      return current.promise;
    });
    hooks.signal?.addEventListener('abort', () => {
      cancelled = true;
      current.cancel();
    });
    return {
      promise,
      cancel: () => {
        cancelled = true;
        current.cancel();
      },
    };
  }

  /** Converts one file by its type with default options — M40's insert-from-file path. */
  async convertFile(
    file: OpenedFile | ConvertInput,
    options?: Record<string, unknown>,
  ): Promise<ConvertResult> {
    const converter = this.routing.require({
      name: file.name,
      ...('mime' in file && file.mime ? { mime: file.mime } : {}),
    });
    const kind = converter.id as CreateKind;
    const input: ConvertInput = { name: file.name, bytes: file.bytes, path: file.path ?? '' };
    const defaults = await this.defaultsFor(kind);
    return this.convert(kind, [input], { ...defaults, ...options }).promise;
  }

  /** The whole headless flow: convert, open, report. Used by `create.convert`. */
  async createHeadless(
    kind: CreateKind,
    inputs: ReadonlyArray<ConvertInput>,
    options: Record<string, unknown>,
  ): Promise<CreateOutcome> {
    const defaults = await this.defaultsFor(kind);
    const result = await this.convert(kind, inputs, { ...defaults, ...options }).promise;
    return this.finish(kind, result, kind === 'blank' ? this.nextUntitled() : null);
  }

  // ---- interactive ------------------------------------------------------------------------------

  async createBlank(): Promise<CreateOutcome | null> {
    const defaults = (await this.defaultsFor('blank')) as unknown as BlankConvertOptions;
    const options = await askBlankOptions(this.shell.dialogs, defaults);
    if (!options) return null;
    await this.remember('blank', options);
    const title = this.nextUntitled();
    return this.run('blank', 'Creating a blank document', [], { ...options, title });
  }

  async createFromImages(given?: ReadonlyArray<ConvertInput>): Promise<CreateOutcome | null> {
    const inputs = given ?? (await this.pickFiles('image'));
    if (inputs.length === 0) return null;
    const defaults = (await this.defaultsFor('image')) as unknown as ImageConvertOptions;
    const options = await askImageOptions(this.shell.dialogs, inputs, defaults);
    if (!options) return null;
    await this.remember('image', options);
    return this.run(
      'image',
      `Creating a PDF from ${String(inputs.length)} ${inputs.length === 1 ? 'image' : 'images'}`,
      inputs,
      options,
    );
  }

  async createFromText(given?: ConvertInput): Promise<CreateOutcome | null> {
    const input = given ?? (await this.pickFiles('text'))[0];
    if (!input) return null;
    return this.textFlow(input, null);
  }

  async createFromHtml(given?: ConvertInput): Promise<CreateOutcome | null> {
    const input = given ?? (await this.pickFiles('html'))[0];
    if (!input) return null;
    return this.htmlFlow(input);
  }

  async createFromWebPage(url?: string): Promise<CreateOutcome | null> {
    const defaults = (await this.defaultsFor('web')) as unknown as WebConvertOptions;
    const options = await askWebOptions(this.shell.dialogs, { ...defaults, url: url ?? '' });
    if (!options) return null;
    await this.remember('web', options);
    return this.run('web', `Loading ${options.url}`, [], options);
  }

  async createFromClipboard(): Promise<CreateOutcome | null> {
    if (!hasBridge()) {
      await this.shell.dialogs.info(
        'Nothing to paste',
        'The clipboard can only be read inside the app.',
      );
      return null;
    }
    const contents = await invoke('clipboard:read');
    if (contents.image) {
      const input: ConvertInput = {
        name: 'Clipboard image.png',
        bytes: contents.image,
        mime: 'image/png',
      };
      const defaults = (await this.defaultsFor('image')) as unknown as ImageConvertOptions;
      const options = await askImageOptions(this.shell.dialogs, [input], defaults);
      if (!options) return null;
      await this.remember('image', options);
      return this.run('image', 'Creating a PDF from the clipboard', [input], {
        ...options,
        title: this.nextUntitled(),
      });
    }
    if (contents.text.trim() !== '') {
      const input: ConvertInput = {
        name: 'Clipboard text.txt',
        bytes: new TextEncoder().encode(contents.text),
        mime: 'text/plain',
      };
      return this.textFlow(input, this.nextUntitled());
    }
    await this.shell.dialogs.info(
      'Nothing to paste',
      'The clipboard holds neither an image nor text.',
    );
    return null;
  }

  /** Any files at all — the Open-with-anything path and drag-and-drop. */
  async createFromFiles(
    given?: ReadonlyArray<ConvertInput>,
  ): Promise<ReadonlyArray<CreateOutcome>> {
    const inputs = given ?? (await this.pickFiles('any'));
    if (inputs.length === 0) return [];
    const { groups, rejected } = this.routing.group(inputs);
    if (rejected.length > 0) {
      const names = rejected.map((r) => r.name ?? 'a file').join(', ');
      this.shell.toasts.show({
        kind: 'warning',
        text: `${rejected.length === 1 ? 'This file is' : 'These files are'} not something ynotPDF can turn into a PDF: ${names}`,
      });
    }
    const outcomes: CreateOutcome[] = [];
    for (const group of groups) {
      const files = group.inputs as ReadonlyArray<ConvertInput>;
      const converter: Converter = group.converter;
      let outcome: CreateOutcome | null = null;
      if (converter.id === 'image') outcome = await this.createFromImages(files);
      else if (converter.id === 'text')
        outcome = files[0] ? await this.textFlow(files[0], null) : null;
      else if (converter.id === 'html') outcome = files[0] ? await this.htmlFlow(files[0]) : null;
      if (outcome) outcomes.push(outcome);
    }
    return outcomes;
  }

  private async textFlow(input: ConvertInput, title: string | null): Promise<CreateOutcome | null> {
    const defaults = (await this.defaultsFor('text')) as unknown as TextConvertOptions;
    const preview = decodeText(input.bytes.subarray(0, 4000));
    const options = await askTextOptions(
      this.shell.dialogs,
      title ?? input.name,
      preview,
      defaults,
    );
    if (!options) return null;
    await this.remember('text', options);
    return this.run(
      'text',
      `Creating a PDF from ${input.name}`,
      [input],
      title ? { ...options, title } : options,
      title,
    );
  }

  private async htmlFlow(input: ConvertInput): Promise<CreateOutcome | null> {
    const defaults = (await this.defaultsFor('html')) as unknown as HtmlConvertOptions;
    const options = await askHtmlOptions(this.shell.dialogs, input.name, defaults);
    if (!options) return null;
    await this.remember('html', options);
    return this.run('html', `Rendering ${input.name}`, [input], {
      ...options,
      markdownStylesheet: isMarkdown(input) ? markdownStylesheet : undefined,
    });
  }

  // ---- plumbing ---------------------------------------------------------------------------------

  private async pickFiles(kind: 'image' | 'text' | 'html' | 'any'): Promise<ConvertInput[]> {
    if (!hasBridge()) return [];
    const converter = kind === 'any' ? null : this.routing.get(kind);
    const filters =
      kind === 'any'
        ? [
            { name: 'Everything ynotPDF can convert', extensions: this.routing.extensions() },
            ...this.routing
              .all()
              .filter((c) => c.extensions.length > 0)
              .map((c) => ({ name: c.label, extensions: [...c.extensions] })),
            { name: 'All files', extensions: ['*'] },
          ]
        : [
            {
              name: converter?.label ?? 'Files',
              extensions: [...(converter?.extensions ?? ['*'])],
            },
            { name: 'All files', extensions: ['*'] },
          ];
    const title =
      kind === 'any'
        ? 'Create PDF from files'
        : `Create PDF from ${converter?.label.toLowerCase() ?? 'files'}`;
    const files = await invoke('file:openFilesDialog', {
      title,
      filters,
      multi: kind === 'image' || kind === 'any',
      buttonLabel: 'Create',
    });
    return files.map((f) => ({ name: f.name, bytes: f.bytes, path: f.path }));
  }

  /** Converts with a progress dialog (after a moment) and Cancel, then opens the result. */
  private async run(
    kind: CreateKind,
    title: string,
    inputs: ReadonlyArray<ConvertInput>,
    options: unknown,
    untitled: string | null = null,
  ): Promise<CreateOutcome | null> {
    this.busyCount++;
    this.shell.invalidate();
    let progress: ProgressHandle | null = null;
    let latest: { fraction: number | null; message: string } = {
      fraction: null,
      message: 'Starting',
    };
    const handle = this.convert(kind, inputs, options, {
      progress: (fraction, message) => {
        latest = { fraction, message };
        progress?.set(fraction, message);
      },
    });
    const timer = setTimeout(() => {
      progress = this.shell.dialogs.progress({
        id: 'create-progress-dialog',
        title,
        text: latest.message,
        cancellable: true,
      });
      progress.set(latest.fraction, latest.message);
      void progress.onCancel.then(() => {
        handle.cancel();
      });
    }, PROGRESS_DELAY_MS);
    try {
      const result = await handle.promise;
      return await this.finish(kind, result, untitled);
    } catch (error) {
      if (error instanceof ConvertCancelled) {
        this.shell.toasts.show({ kind: 'info', text: 'Creating the PDF was cancelled.' });
        return null;
      }
      await this.shell.dialogs.error('The PDF could not be created', explain(error));
      return null;
    } finally {
      clearTimeout(timer);
      (progress as ProgressHandle | null)?.close();
      this.busyCount--;
      this.shell.invalidate();
    }
  }

  private async finish(
    kind: CreateKind,
    result: ConvertResult,
    untitled: string | null,
  ): Promise<CreateOutcome> {
    const title = untitled ?? result.title;
    const opened: OpenedCreated = await openCreatedDocument(this.registry, result.bytes, title);
    const outcome: CreateOutcome = {
      kind,
      title,
      pageCount: result.pageCount,
      warnings: result.warnings,
      tabId: opened.tab.id,
    };
    this.last = outcome;
    const pages = `${String(result.pageCount)} ${result.pageCount === 1 ? 'page' : 'pages'}`;
    if (result.warnings.length > 0) {
      const shown = result.warnings.slice(0, 3).join(' · ');
      const more =
        result.warnings.length > 3 ? ` · and ${String(result.warnings.length - 3)} more` : '';
      this.shell.toasts.show({
        kind: 'warning',
        title: `Created "${title}" (${pages}), with notes`,
        text: `${shown}${more}`,
        timeout: 12_000,
      });
    } else {
      this.shell.toasts.show({
        kind: 'success',
        text: `Created "${title}" (${pages}). It is not saved yet.`,
      });
    }
    return outcome;
  }
}

/** The printer behind IPC: one hidden window in main per job, cancelled through the signal. */
export function ipcPrinter(): HtmlPrinter {
  let seq = 0;
  return {
    async render(
      source: WebRenderSource,
      settings: WebPrintSettings,
      signal?: AbortSignal,
    ): Promise<WebRenderResult> {
      if (!hasBridge())
        throw new ConvertUnsupported('no-printer', 'Web pages can only be rendered inside the app');
      const jobId = `create-${String(Date.now())}-${String(++seq)}`;
      const onAbort = (): void => {
        void invoke('webpdf:cancel', jobId).catch(() => undefined);
      };
      if (signal?.aborted) throw new ConvertCancelled();
      signal?.addEventListener('abort', onAbort);
      try {
        return await invoke('webpdf:render', { jobId, source, settings });
      } catch (error) {
        if (signal?.aborted) throw new ConvertCancelled();
        throw error;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** A sentence for the error dialog. */
export function explain(error: unknown): string {
  if (error instanceof ConvertUnsupported) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
