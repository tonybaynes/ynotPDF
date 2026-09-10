/**
 * `OptimiseService` (M100) — registered as `"optimise"`, and as `"repair"` for M11's open path.
 *
 * The commands in `manifest.ts` are thin: they read arguments, ask a dialog, and call a method
 * here. This is where the three halves of the module meet — the pure passes in
 * `src/engine/optimise/` running in a Worker, qpdf running in main, and the open `Document`,
 * which is the authority on what the reader meant.
 *
 * Two things worth knowing before reading it.
 *
 * **Optimising produces a file; it never rewrites the open document underneath its model.** The
 * engine owns bytes and the `Document` owns intent, `Document.handle` is `readonly`, and every
 * model page is bound to an engine index — so swapping optimised bytes under a live model is not
 * something the contract allows, and faking it would cost the reader their undo history without
 * saying so. Foxit's Reduce File Size and Advanced Optimization both end in a Save As, so this is
 * also what the reference does. Writing over the document's own path is allowed and reloads that
 * tab, after saying in words that the undo history goes with it.
 *
 * **The bytes an optimise starts from are the file's, not the engine's, whenever there is a
 * file.** A document with unsaved changes is optimised from what the engine holds — which is what
 * the reader is looking at — and one that has never been touched is optimised from the file on
 * disk, so that "make this smaller" on a freshly opened document does not first go through a
 * PDFium rewrite that has nothing to do with the reader's request.
 */

import type { ShellServices } from '@app/services';
import type { Document } from '@core/Document';
import type { Registry } from '@core/Registry';
import { hasBridge, invoke, type OpenedFile } from '@shared/ipc';
import type { SavePipelineStage, SaveStageInput, SaveStageResult } from '@engine/Writer';
import {
  isCancelled,
  presetById,
  repairBytes,
  type OptimiseOptions,
  type OptimisePreset,
  type OptimiseResult,
  type QpdfCheck,
  type RepairResult,
  type SpaceAudit,
} from '@engine/optimise';
import {
  DOCUMENT_SERVICE,
  type DocumentService,
} from '@modules/M20-document-model/DocumentService';
import {
  ORGANISE_SERVICE,
  type OrganiseService,
} from '@modules/M40-organise-pages/OrganiseService';
import { OptimiseClient, type StructureRunner } from './OptimiseClient';
import {
  DEFAULT_OPTIMISE_SETTINGS,
  ipcSettingsStorage,
  parseCustomPresets,
  readOptimiseSettings,
  serialiseCustomPresets,
  writeOptimiseSetting,
  type OptimiseSettings,
  type SettingsStorage,
} from './settings';

export const OPTIMISE_SERVICE = 'optimise';

/** The name M11 looks under when the engine refuses a file (ADR 0019 §2). */
export const REPAIR_SERVICE = 'repair';

/**
 * The service M11's `ViewerService` looks for when the engine refuses a file (ADR 0019 §2).
 *
 * Declared here and imported by M11 as a type only, so the dependency runs one way and disappears
 * at compile time. A build without M100 registers nothing under `"repair"` and M11's open path is
 * exactly what it was.
 */
export interface RepairService {
  /**
   * The engine refused these bytes. Returns repaired bytes to try again with, or `null` when the
   * reader declined or nothing could be done — in which case the caller reports the original
   * failure, because a repair that was not wanted is not a new problem.
   */
  offerRepair(bytes: Uint8Array, name: string, error: unknown): Promise<Uint8Array | null>;
}

export interface OptimiseServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
  readonly storage?: SettingsStorage;
  readonly client?: OptimiseClient;
  readonly structure?: StructureRunner;
}

/** What the last optimise did, in the shape the e2e suite reads back. */
export interface OptimiseOutcome {
  readonly before: number;
  readonly after: number;
  readonly path: string | null;
  readonly changes: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly linearised: boolean;
}

export class OptimiseService implements RepairService {
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly storage: SettingsStorage;
  private readonly structure: StructureRunner | undefined;
  private clientValue: OptimiseClient | null;
  private settingsValue: OptimiseSettings = DEFAULT_OPTIMISE_SETTINGS;
  private readonly listeners = new Set<(settings: OptimiseSettings) => void>();
  /** Documents already checked this session, so reopening a tab does not ask twice. */
  private readonly checked = new Set<string>();
  /** What the last operation did, for the e2e suite to read back. */
  lastOutcome: OptimiseOutcome | null = null;
  /** What the last check said, likewise. */
  lastCheck: QpdfCheck | null = null;

  constructor(options: OptimiseServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.storage = options.storage ?? ipcSettingsStorage();
    this.clientValue = options.client ?? null;
    this.structure = options.structure;
  }

  // ---- settings ---------------------------------------------------------------------------------

  get settings(): OptimiseSettings {
    return this.settingsValue;
  }

  async load(): Promise<void> {
    this.settingsValue = await readOptimiseSettings(this.storage);
    this.notify();
  }

  async setSetting<K extends keyof OptimiseSettings>(
    name: K,
    value: OptimiseSettings[K],
  ): Promise<OptimiseSettings[K]> {
    this.settingsValue = { ...this.settingsValue, [name]: value };
    await writeOptimiseSetting(this.storage, name, value);
    this.notify();
    this.shell.invalidate();
    return value;
  }

  onSettingsChange(listener: (settings: OptimiseSettings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) listener(this.settingsValue);
  }

  /** Every preset the dialog offers: the four we ship, then the reader's own. */
  get presets(): ReadonlyArray<OptimisePreset> {
    return [...builtIns(), ...parseCustomPresets(this.settingsValue.customPresets)];
  }

  preset(id: string): OptimisePreset | null {
    return this.presets.find((p) => p.id === id) ?? null;
  }

  /** Saves a preset of the reader's own, replacing one with the same id. */
  async savePreset(preset: OptimisePreset): Promise<void> {
    const mine = parseCustomPresets(this.settingsValue.customPresets).filter(
      (p) => p.id !== preset.id,
    );
    mine.push(preset);
    await this.setSetting('customPresets', serialiseCustomPresets(mine));
  }

  async deletePreset(id: string): Promise<void> {
    const mine = parseCustomPresets(this.settingsValue.customPresets).filter((p) => p.id !== id);
    await this.setSetting('customPresets', serialiseCustomPresets(mine));
  }

  /**
   * The optimise Worker, started the first time something needs it.
   *
   * Lazily, as M21's writer and M41's ops are: a Worker costs a thread and a megabyte of parsed
   * bundle at boot, and most sessions never optimise anything.
   */
  get client(): OptimiseClient {
    this.clientValue ??= OptimiseClient.spawn(...(this.structure ? [this.structure] : []));
    return this.clientValue;
  }

  /** Whether the work runs off the main thread — answered without starting the Worker to find out. */
  get offThread(): boolean {
    return this.clientValue?.offThread ?? typeof Worker !== 'undefined';
  }

  // ---- what the commands reach through ----------------------------------------------------------

  get dialogs(): ShellServices['dialogs'] {
    return this.shell.dialogs;
  }

  get toasts(): ShellServices['toasts'] {
    return this.shell.toasts;
  }

  get document(): Document | null {
    if (!this.registry.hasService(DOCUMENT_SERVICE)) return null;
    return this.registry.service<DocumentService>(DOCUMENT_SERVICE).active;
  }

  require(): Document {
    const doc = this.document;
    if (!doc) throw new Error('No document is open');
    return doc;
  }

  /** M40's progress dialog, which only appears when the work turns out to be slow. */
  private get organise(): OrganiseService | null {
    if (!this.registry.hasService(ORGANISE_SERVICE)) return null;
    return this.registry.service<OrganiseService>(ORGANISE_SERVICE);
  }

  // ---- the bytes an operation works on ------------------------------------------------------------

  /**
   * The document as it should be optimised.
   *
   * A document with unsaved changes comes from the engine, because that is what the reader is
   * looking at. One with no changes comes from the file, because a PDFium rewrite the reader did
   * not ask for is not part of "make this smaller" — and because the *before* size the dialog
   * shows should be the size of the file they can see in their folder.
   */
  async sourceBytes(doc: Document): Promise<Uint8Array> {
    const path = doc.state.path;
    if (path !== null && !doc.isDirty && hasBridge()) {
      try {
        const file = await invoke('file:read', path);
        if (file.bytes.length > 0) return file.bytes;
      } catch {
        // Moved, renamed, or on a drive that has gone away. The engine still has it.
      }
    }
    return doc.engine.save(doc.handle);
  }

  // ---- the audit ------------------------------------------------------------------------------------

  /** Where a document's bytes went. Runs in the Worker; changes nothing. */
  audit(bytes: Uint8Array): Promise<SpaceAudit> {
    return this.client.audit(bytes).promise;
  }

  // ---- optimising ------------------------------------------------------------------------------------

  /**
   * Runs the whole pipeline over a copy, under a progress dialog, and hands back the result
   * without writing anything.
   *
   * This is both the preview and the operation: the dialog shows what it produced and then writes
   * exactly those bytes, so the size the reader was promised is the size they get. Estimating
   * would be cheaper and would be wrong for exactly the files where the number matters.
   */
  async run(bytes: Uint8Array, options: OptimiseOptions): Promise<OptimiseResult | null> {
    const organise = this.organise;
    const work = async (
      report: (fraction: number, text?: string) => void,
      signal: AbortSignal,
    ): Promise<OptimiseResult | null> => {
      const handle = this.client.run(bytes.slice(), options, (fraction, message) => {
        report(fraction ?? 0, message);
      });
      const abort = (): void => {
        handle.cancel();
      };
      signal.addEventListener('abort', abort);
      try {
        return await handle.promise;
      } catch (error) {
        if (isCancelled(error)) return null;
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
      }
    };

    if (!organise) {
      const controller = new AbortController();
      return work(() => undefined, controller.signal);
    }
    return organise.withProgress(
      { title: 'Optimising', text: 'Reading the document', pages: Number.MAX_SAFE_INTEGER },
      work,
    );
  }

  /** Writes the optimised bytes where the reader asked, and remembers what happened. */
  async writeResult(result: OptimiseResult, path: string): Promise<OptimiseOutcome> {
    if (!hasBridge()) throw new Error('Saving needs the app shell');
    await invoke('file:writeAtomic', path, result.bytes, { backup: false });
    const outcome: OptimiseOutcome = {
      before: result.before,
      after: result.after,
      path,
      changes: result.changes.map((c) => c.what),
      warnings: result.warnings,
      linearised: result.linearised,
    };
    this.lastOutcome = outcome;
    return outcome;
  }

  // ---- checking and repairing --------------------------------------------------------------------------

  /** What qpdf makes of these bytes. `null` when there is no main process to ask. */
  async check(bytes: Uint8Array): Promise<QpdfCheck | null> {
    if (!hasBridge()) return null;
    const check = await invoke('optimise:check', bytes);
    this.lastCheck = check;
    return check;
  }

  /**
   * Repairs bytes with whichever engine can read them (ADR 0019 §1a): PDFium first, because it
   * reconstructs a cross-reference table and this build of qpdf does not, then qpdf, because the
   * two disagree about what is fatal.
   */
  repair(bytes: Uint8Array, whatIsWrong: ReadonlyArray<string> = []): Promise<RepairResult> {
    const doc = this.document;
    const engine = doc?.engine ?? null;
    return repairBytes(
      bytes,
      {
        ...(engine
          ? {
              reopen: async (input: Uint8Array) => {
                const handle = await engine.open(input);
                try {
                  return await engine.save(handle);
                } finally {
                  await engine.close(handle);
                }
              },
            }
          : {}),
        ...(hasBridge()
          ? {
              rewrite: async (input: Uint8Array) => {
                const result = await invoke('optimise:repair', input);
                return {
                  bytes: result.bytes,
                  repaired: result.repaired,
                  warnings: result.warnings,
                };
              },
            }
          : {}),
      },
      whatIsWrong,
    );
  }

  /**
   * M11's hook: the engine refused a file, so offer to repair it (ADR 0019 §2).
   *
   * The reader is asked first and told what a repair costs, because a repaired file is not the
   * file they had — anything too damaged to read is not in it. Declining, or a repair that cannot
   * be done, returns `null` and the caller reports the original failure.
   */
  async offerRepair(bytes: Uint8Array, name: string, error: unknown): Promise<Uint8Array | null> {
    const check = await this.check(bytes).catch(() => null);
    const complaint = check?.errors[0] ?? messageOf(error);
    const wanted = await this.shell.dialogs.confirm({
      title: 'This file is damaged',
      text:
        `${name} could not be opened: ${complaint}\n\n` +
        'ynotPDF can try to rebuild it from what is still readable. The rebuilt copy opens ' +
        'instead of the original, and the original file is not touched.',
      confirmLabel: 'Repair and open',
      cancelLabel: 'Do not open it',
      kind: 'warning',
      id: 'optimise-repair-open',
    });
    if (!wanted) return null;

    try {
      const repaired = await this.repair(bytes, check?.errors ?? []);
      this.shell.toasts.show({
        kind: 'warning',
        title: 'Repaired',
        text:
          `${name} was rebuilt from what could be read of it. Check it against the original ` +
          'before you rely on it.',
      });
      return repaired.bytes;
    } catch (repairError) {
      await this.shell.dialogs.error('Could not repair', messageOf(repairError));
      return null;
    }
  }

  /**
   * Checks a document that opened *successfully* and offers a repair when qpdf finds damage.
   *
   * A toast rather than a modal: the file opened, the reader can read it, and interrupting them
   * with a dialog about damage they may not care about would be the wrong shape of attention.
   * The check runs on the **file**, not on what the engine holds — PDFium has already rebuilt the
   * cross-reference table on the way in, so asking the engine would always come back clean.
   */
  async checkOnOpen(doc: Document): Promise<void> {
    if (!this.settingsValue.checkOnOpen || !hasBridge()) return;
    if (doc.state.path === null || this.checked.has(doc.state.path)) return;
    this.checked.add(doc.state.path);
    let bytes: Uint8Array;
    try {
      bytes = (await invoke('file:read', doc.state.path)).bytes;
    } catch {
      return;
    }
    const check = await this.check(bytes).catch(() => null);
    if (!check || check.ok || check.encrypted) return;
    const problems = [...check.errors, ...check.warnings];
    if (problems.length === 0) return;

    this.shell.toasts.show({
      kind: 'warning',
      title: 'Damaged file',
      text: `${doc.state.title}: ${problems[0] ?? 'qpdf found something wrong with this file.'}`,
      id: 'optimise-damaged',
      actions: [
        {
          label: 'Repair a copy…',
          run: async () => {
            await this.shell.run('optimise.repair');
          },
        },
      ],
    });
  }

  // ---- fast web view on save (ADR 0019 §3) -----------------------------------------------------------

  /**
   * The save-pipeline stage that linearises.
   *
   * Order 50, before M70's encryption at 100 — and it **skips when M70 owns this document's
   * protection**, because M70 re-protects by running qpdf again and a qpdf rewrite without
   * `--linearize` is not linearised. A file cannot come out of this pipeline both password
   * protected and linearised; saying so is better than quietly producing one of the two.
   */
  stage(handlesSecurity: (documentId: string) => boolean): SavePipelineStage {
    return {
      id: 'optimise.linearise',
      order: 50,
      run: (input) => this.runStage(input, handlesSecurity),
    };
  }

  private async runStage(
    input: SaveStageInput,
    handlesSecurity: (documentId: string) => boolean,
  ): Promise<SaveStageResult> {
    if (!this.settingsValue.linearizeOnSave || !hasBridge()) return { bytes: input.bytes };
    if (handlesSecurity(input.context.documentId)) {
      return {
        bytes: input.bytes,
        warnings: [
          'Fast web view was not applied, because this document is being password protected and ' +
            'the two cannot both be produced in one save.',
        ],
      };
    }
    try {
      const result = await invoke('optimise:linearise', input.bytes);
      return { bytes: result.bytes, warnings: result.warnings };
    } catch (error) {
      // A stage that throws fails the save, and a file that is merely not linearised is a fine
      // file. So this is a warning, not an error.
      return {
        bytes: input.bytes,
        warnings: [`Fast web view was not applied: ${messageOf(error)}`],
      };
    }
  }

  // ---- odds and ends ---------------------------------------------------------------------------------

  /** Opens bytes as a document in a new tab, through M00's own open path. */
  async openBytes(name: string, bytes: Uint8Array, path?: string): Promise<void> {
    const file: OpenedFile = { name, path: path ?? '', bytes };
    await this.shell.run('file.openBytes', { file });
  }

  dispose(): void {
    this.clientValue?.dispose();
    this.clientValue = null;
  }
}

/** The four presets we ship. A function so the resource is read once, at first use. */
function builtIns(): ReadonlyArray<OptimisePreset> {
  return ['lossless', 'standard', 'small', 'smallest']
    .map((id) => presetById(id))
    .filter((p): p is OptimisePreset => p !== null);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
