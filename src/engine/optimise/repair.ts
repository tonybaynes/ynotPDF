/**
 * Repairing a damaged file (M100, ADR 0019 §1a).
 *
 * Two engines disagree about what is fatal in a PDF, and the repair uses both:
 *
 * 1. **PDFium first.** It rebuilds the cross-reference table on the way in — that is what
 *    "PDFium reconstructs" in the corpus notes means — so opening the bytes and writing the
 *    document straight back out produces a file with a correct one. The repaired
 *    `broken-xref.pdf` comes back `qpdf --check` clean.
 * 2. **qpdf second**, for a file PDFium refuses. Its own recovery does nothing in the build we
 *    ship (ADR 0019 measures it), but a plain rewrite still fixes a file it *can* read, and the
 *    two engines do not draw the line in the same place.
 * 3. **Otherwise, say so.** A file neither will read is beyond repair with the tools we have, and
 *    the reader is told that with whatever qpdf said about it, rather than handed an unchanged
 *    copy to wonder about.
 *
 * This file has no engine and no qpdf of its own: both arrive as functions, which is what lets
 * the renderer pass its Worker-backed engine, a test pass a real PDFium, and M120's batch pass
 * whatever it has. `src/engine/optimise/` may not import a Worker or Electron.
 */

import { OpFailed, type RepairResult } from './types';

/** The two things a repair needs, however the caller happens to have them. */
export interface RepairTools {
  /**
   * Opens bytes and writes them back out, or throws. In the app this is the engine Worker's
   * open/save pair; a caller that has no engine passes nothing and gets the qpdf path alone.
   */
  readonly reopen?: (bytes: Uint8Array) => Promise<Uint8Array>;
  /** A qpdf rewrite — `QpdfTasks.repair`. */
  readonly rewrite?: (bytes: Uint8Array) => Promise<RepairResult>;
}

/**
 * Repairs `bytes`, or throws {@link OpFailed} with a sentence saying why it could not be done.
 *
 * `whatIsWrong` is what the check said, so a failure can quote it rather than inventing a reason.
 */
export async function repairBytes(
  bytes: Uint8Array,
  tools: RepairTools,
  whatIsWrong: ReadonlyArray<string> = [],
): Promise<RepairResult> {
  const attempts: string[] = [];

  if (tools.reopen) {
    try {
      const out = await tools.reopen(bytes.slice());
      if (out.length > 0) {
        return {
          bytes: out,
          repaired: true,
          warnings: [
            'The file was rebuilt from what could still be read of it. Compare it with the ' +
              'original before you keep it: anything too damaged to read is not in the repaired copy.',
          ],
        };
      }
    } catch (error) {
      attempts.push(messageOf(error));
    }
  }

  if (tools.rewrite) {
    try {
      return await tools.rewrite(bytes.slice());
    } catch (error) {
      attempts.push(messageOf(error));
    }
  }

  const reason = whatIsWrong[0] ?? attempts[0] ?? '';
  throw new OpFailed(
    reason === ''
      ? 'This file is too badly damaged to repair.'
      : `This file is too badly damaged to repair: ${reason}`,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
