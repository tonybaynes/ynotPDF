/**
 * The qpdf command lines M100 uses, and the reading of what qpdf says back (M100, ADR 0019).
 *
 * Kept apart from `tasks.ts` so the argv is testable without a 1.3 MB WebAssembly module: these
 * are pure functions from options to strings and from qpdf's output to facts. `tasks.ts` is the
 * part that actually runs.
 *
 * Every command names its input `in.pdf` and its output `out.pdf`; `Qpdf.run` rewrites those two
 * into the run's own private directory (see `src/engine/security/qpdf.ts`), which is why they
 * appear here as bare names.
 */

import { QPDF_OK, QPDF_WARNINGS } from '../../security/qpdf';
import type { QpdfCheck, StructureOptions } from '../types';

export const IN = 'in.pdf';
export const OUT = 'out.pdf';

/**
 * The structural pass.
 *
 * `--deterministic-id` rather than qpdf's default random `/ID`: optimising the same file twice
 * must give the same bytes, or every test that compares two runs is a coin toss and the
 * operator's "did anything change?" is unanswerable.
 *
 * `--stream-data=compress` is *not* passed. It would deflate streams that are deliberately
 * uncompressed — inline-image-heavy content, and anything a later module wants to read — and
 * `--recompress-flate` already re-deflates what is flate to begin with, which is where the
 * saving is. `--compression-level` only bites with one of those two, so it is passed with them.
 */
export function structureArgs(options: StructureOptions): string[] {
  const args = [IN, OUT, '--deterministic-id'];
  args.push(options.objectStreams ? '--object-streams=generate' : '--object-streams=preserve');
  if (options.recompressStreams) {
    args.push('--recompress-flate', '--compression-level=9');
  }
  if (options.removeUnused) args.push('--remove-unreferenced-resources=yes');
  else args.push('--remove-unreferenced-resources=no');
  if (options.linearise) args.push('--linearize');
  return args;
}

/** Linearisation on its own, for the save-pipeline stage, which changes nothing else. */
export function lineariseArgs(): string[] {
  return [IN, OUT, '--linearize', '--deterministic-id'];
}

/**
 * `--check`: read the file thoroughly and say what is wrong with it. Produces no output file.
 *
 * `--check` implies `--show-linearization` for a linearised file, which is where
 * {@link readCheck} learns whether the file has hint tables.
 */
export function checkArgs(): string[] {
  return [IN, '--check'];
}

/**
 * The repair: a plain qpdf rewrite.
 *
 * That is what repair *is* — qpdf reconstructs the cross-reference table when it cannot trust the
 * one in the file, and writing the document out again fixes the offsets, drops objects it could
 * not parse and rebuilds the trailer. `--object-streams=preserve` keeps the file's own shape, so
 * a repair changes as little as it can get away with; making it smaller is a separate decision
 * the reader takes separately.
 */
export function repairArgs(): string[] {
  return [IN, OUT, '--object-streams=preserve', '--deterministic-id'];
}

/** qpdf's version string from `--check` output, e.g. `"1.7"` for the PDF version. */
const VERSION_RE = /PDF Version:\s*([0-9]+\.[0-9]+)/i;

/** The sentences qpdf prints about a file it read happily; not complaints, whatever the exit code. */
const STATUS =
  /^(?:checking |PDF Version:|File is (?:not )?(?:encrypted|linearized)|No syntax or stream|errors that qpdf cannot detect|R = |P = |User password|extract for accessibility|extract for any purpose|print low resolution|print high resolution|modify (?:document assembly|forms|annotations|other)|stream encoding|Supplied password)/i;

/**
 * Reads `--check` output.
 *
 * qpdf prints a paragraph, not a record, so this is a parser and it is deliberately generous: the
 * only things read out of it are facts qpdf states in a fixed form, and everything else becomes a
 * warning or an error line for the reader to look at. A phrasing that changes between qpdf
 * releases therefore degrades to "qpdf had something to say", never to a wrong answer.
 *
 * `code` is qpdf's exit status: 0 clean, 3 warnings only, 2 errors.
 */
export function readCheck(output: string, code: number): QpdfCheck {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');

  const warnings: string[] = [];
  const errors: string[] = [];
  for (const line of lines) {
    if (/^WARNING:/i.test(line)) warnings.push(strip(line));
    else if (/^ERROR:/i.test(line)) errors.push(strip(line));
    else if (code !== QPDF_OK && code !== QPDF_WARNINGS && !STATUS.test(line)) {
      // qpdf's fatal complaints carry no prefix at all: `in.pdf (xref stream, offset 999):
      // expected n n obj` is the whole of what it says about an unreadable file. When the exit
      // code says something went wrong, every line that is not one of its ordinary status
      // sentences is what went wrong.
      errors.push(strip(line));
    }
  }

  const text = output.toLowerCase();
  // "File is linearized" / "File is not linearized" — qpdf says one of the two for every file it
  // can read at all, so the negative form has to be excluded explicitly.
  const linearised =
    text.includes('file is linearized') && !text.includes('file is not linearized');
  const encrypted = text.includes('file is encrypted') && !text.includes('file is not encrypted');

  return {
    ok: code === QPDF_OK && errors.length === 0 && warnings.length === 0,
    unreadable: code !== QPDF_OK && code !== QPDF_WARNINGS && !/^checking/im.test(output),
    linearised,
    encrypted,
    version: VERSION_RE.exec(output)?.[1] ?? null,
    warnings,
    errors,
  };
}

/** Removes qpdf's own `WARNING:` / `ERROR:` prefix and any trailing full stop it doubles up. */
function strip(line: string): string {
  return line.replace(/^(?:WARNING|ERROR):\s*/i, '').trim();
}
