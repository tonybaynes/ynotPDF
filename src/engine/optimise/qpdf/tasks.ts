/**
 * `QpdfTasks` — the structural half of optimising, in the shape `Security` established (M100,
 * ADR 0019).
 *
 * Four operations, and nothing above this file knows what qpdf's command line looks like:
 *
 * - {@link QpdfTasks.structure} — object streams, flate recompression, unreferenced objects,
 *   and linearisation when it is asked for, in one pass.
 * - {@link QpdfTasks.linearise} — fast web view on its own, for M21's save pipeline.
 * - {@link QpdfTasks.check} — what is wrong with this file, as facts.
 * - {@link QpdfTasks.repair} — write the file out again, which is the most this build of qpdf can
 *   do towards repairing one; the method says why, and who does the rest.
 *
 * It is *given* a `Qpdf` rather than making one, which is what keeps `src/engine/` free of Node:
 * the app builds the runner in main (`src/main/optimise.ts`, ADR 0011) and a test builds it from
 * `node_modules`. There is no UI and no model here, so M120's batch and M121's command line get
 * all four with no window open.
 */

import { warningsFrom, QPDF_OK, QPDF_WARNINGS, type Qpdf } from '../../security/qpdf';
import { OpFailed, type BytesAndWarnings, type QpdfCheck, type RepairResult } from '../types';
import {
  IN,
  OUT,
  checkArgs,
  lineariseArgs,
  readCheck,
  repairArgs,
  structureArgs,
} from './structure';
import type { StructureOptions } from '../types';

export class QpdfTasks {
  private readonly qpdf: Qpdf;

  constructor(qpdf: Qpdf) {
    this.qpdf = qpdf;
  }

  /**
   * The structural pass. When every option is off there is nothing for qpdf to do, and the bytes
   * are handed straight back — a qpdf round trip that changes nothing still costs 40 ms and a
   * rewrite, and a rewrite is not nothing when the caller asked for no change.
   */
  async structure(bytes: Uint8Array, options: StructureOptions): Promise<BytesAndWarnings> {
    if (!options.objectStreams && !options.recompressStreams && !options.removeUnused) {
      if (!options.linearise) return { bytes, warnings: [] };
    }
    return this.rewrite(structureArgs(options), bytes, 'optimised');
  }

  /** Fast web view, and nothing else. */
  linearise(bytes: Uint8Array): Promise<BytesAndWarnings> {
    return this.rewrite(lineariseArgs(), bytes, 'linearised');
  }

  /** What qpdf makes of this file. Never throws for a bad file: that is the answer, not an error. */
  async check(bytes: Uint8Array): Promise<QpdfCheck> {
    const run = await this.qpdf.run(checkArgs(), { [IN]: bytes });
    return readCheck(run.output, run.code);
  }

  /**
   * Rewrites a file, which is the most this qpdf can do towards repairing one.
   *
   * **What this build of qpdf will and will not do.** A real qpdf reconstructs the
   * cross-reference table when it cannot trust the one in the file, and says so in a warning.
   * This build never does, for any kind of damage in the corpus: every recovery
   * path inside qpdf is driven by catching its own exceptions, and the WebAssembly it is compiled
   * to does not catch them — the first throw comes straight back out as exit code 2 with one line
   * of explanation and no output file. Measured against every kind of damage in the corpus
   * (ADR 0019); it is not a guess.
   *
   * So this is the *second* string of M100's repair, not the first. PDFium reconstructs where
   * qpdf will not, so the renderer tries the engine first and comes here only for a file the
   * engine refused and qpdf can still read — which does happen, because the two disagree about
   * what is fatal. Where it works, the rewrite fixes the offsets and rebuilds the trailer.
   */
  async repair(bytes: Uint8Array): Promise<RepairResult> {
    const run = await this.qpdf.run(repairArgs(), { [IN]: bytes }, [OUT]);
    const out = run.files.get(OUT);
    if (!out || out.length === 0) {
      throw new OpFailed(firstComplaint(run.output, 'repaired'));
    }
    return { bytes: out, repaired: true, warnings: warningsFrom(run.output) };
  }

  /** qpdf's own version, for the About box and the tests. */
  version(): Promise<string> {
    return this.qpdf.version();
  }

  /** One rewriting run: argv in, bytes out, with a worded failure when nothing came back. */
  private async rewrite(
    args: ReadonlyArray<string>,
    bytes: Uint8Array,
    what: string,
  ): Promise<BytesAndWarnings> {
    const run = await this.qpdf.run(args, { [IN]: bytes }, [OUT]);
    const out = run.files.get(OUT);
    if (run.code !== QPDF_OK && run.code !== QPDF_WARNINGS) {
      throw new OpFailed(firstComplaint(run.output, what));
    }
    if (!out || out.length === 0) throw new OpFailed(firstComplaint(run.output, what));
    return { bytes: out, warnings: warningsFrom(run.output) };
  }
}

/** qpdf's first real sentence, or a worded fallback when it said nothing useful. */
function firstComplaint(output: string, what: string): string {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !/^WARNING/i.test(l));
  return line !== undefined && line !== ''
    ? `The document could not be ${what}: ${line}`
    : `The document could not be ${what}.`;
}
