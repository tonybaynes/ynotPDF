/**
 * The qpdf runner (M70, ADR 0011).
 *
 * qpdf ships as WebAssembly — `@neslinesli93/qpdf-wasm`, qpdf 12.2.0 — and this file is the only
 * one that knows that. Its whole surface is {@link Qpdf.run}: an argv array and a set of input
 * files in, an exit code, the two output streams and any files the command produced out. Nothing
 * above it mentions Emscripten, MEMFS or `callMain`, so replacing the build (or dropping in a
 * real CLI, if qpdf ever publishes portable binaries) is a change to this file alone.
 *
 * Three things it takes care of that a caller should not have to:
 *
 * - **Each run gets its own directory** under MEMFS and every file in it is deleted afterwards,
 *   so a document's bytes never outlive the call that needed them. That matters more than usual
 *   here: those bytes are the decrypted contents of a protected file.
 * - **Each run gets its own module.** qpdf is a command-line program: `main` returning means
 *   `exit()`, and a second `callMain` on the same instance runs a program that has already ended.
 *   Instantiating costs about 40 ms — the price of the only arrangement that is correct.
 * - **Passwords never reach a shell.** `callMain` takes argv as an array, so a password
 *   containing a space, a quote or a leading dash is passed through untouched, and nothing is
 *   ever interpolated into a command string.
 *
 * The wasm comes from wherever the caller says. In the app that is main, where the module's own
 * default reads it off disk (`src/main/security.ts`); in a Node test it is the same default. ADR
 * 0011 explains why it is not a renderer Worker.
 */

import { SecurityError, type SecurityErrorCode } from './types';

/**
 * The Emscripten factory's options, narrowed to the two this build actually honours.
 *
 * It was compiled with property renaming on, so `print`, `printErr`, `wasmBinary` and
 * `thisProgram` are not read at all — they were minified out of existence, and passing them does
 * nothing. What survives is `locateFile` and `noInitialRun`. Output is dealt with in
 * {@link Qpdf.create}; the wasm arrives through `locateFile`.
 */
interface QpdfModuleOptions {
  noInitialRun: boolean;
  locateFile?: (path: string) => string;
}

interface EmscriptenFs {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  unlink(path: string): void;
  rmdir(path: string): void;
}

interface QpdfModule {
  callMain(args: string[]): number;
  FS: EmscriptenFs;
}

export type QpdfFactory = (options: QpdfModuleOptions) => Promise<QpdfModule>;

export interface QpdfRun {
  /** qpdf's exit code: 0 success, 2 error, 3 warnings only. */
  readonly code: number;
  /** stdout and stderr interleaved, as qpdf printed them. Never contains a password. */
  readonly output: string;
  /** Files the command wrote, by the name they were asked for. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export interface QpdfOptions {
  /** The Emscripten factory. Injected so a test can run a fake without a 1.3 MB wasm. */
  readonly factory: QpdfFactory;
  /**
   * Where the `.wasm` is. Omitted everywhere today: under Node the module's own default finds the
   * file next to itself, in `node_modules` or inside the asar. It stays because a future host
   * that cannot read from disk would need it.
   */
  readonly locateFile?: (path: string) => string;
}

/**
 * qpdf's exit codes. 3 means "it worked, but qpdf had something to say" — a damaged file it
 * repaired, for instance — and is a success as far as we are concerned, with the warnings passed
 * up so the save can report them.
 */
export const QPDF_OK = 0;
export const QPDF_WARNINGS = 3;

/**
 * The argv[0] qpdf puts in front of its messages.
 *
 * Deliberately not a catch-all `^\S+:` — qpdf's own messages are `argv0: file.pdf: reason`, and
 * a greedy rule would eat the filename, which is the part the reader needs. Only the shapes
 * argv[0] actually takes are matched: this build's hard-coded `this.program`, a real `qpdf`, and
 * whatever script or executable is hosting it.
 */
const PROGRAM_PREFIX = /^(?:\S*[/\\])?(?:this\.program|qpdf|[\w.-]+\.(?:js|mjs|cjs|exe)):\s*/;

let nextRun = 0;

export class Qpdf {
  private readonly factory: QpdfFactory;
  private readonly locateFile: ((path: string) => string) | undefined;
  /** Serialises runs, because the console swap in {@link Qpdf.create} is process-wide. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: QpdfOptions) {
    this.factory = options.factory;
    this.locateFile = options.locateFile;
  }

  /**
   * Builds a module with its output captured. **One per run** — see {@link Qpdf.run}.
   *
   * This build writes everything through `console.log` and `console.error`, which it binds *once*
   * while the factory runs — `var oa = console.log.bind(console)` — and there is no `print`
   * option to pass instead, because property renaming removed it. So the two functions are
   * swapped for a collector for exactly as long as the factory takes, and put back straight
   * afterwards. The binding it captured belongs to that module from then on.
   */
  private async create(): Promise<QpdfModule> {
    /* eslint-disable no-console -- capturing qpdf's output is the whole point of this method;
       there is no `print` option to pass instead, and the swap is undone in the `finally`. */
    const log = console.log;
    const error = console.error;
    const sink = (...args: unknown[]): void => {
      this.collect(args.map((a) => String(a)).join(' '));
    };
    console.log = sink;
    console.error = sink;
    try {
      return await this.factory({
        noInitialRun: true,
        ...(this.locateFile ? { locateFile: this.locateFile } : {}),
      });
    } finally {
      console.log = log;
      console.error = error;
    }
    /* eslint-enable no-console -- back to the normal rule from here. */
  }

  /** Collected for the duration of one `run`. */
  private lines: string[] = [];
  /** False between runs, when anything qpdf says is unexpected and belongs in the app's log. */
  private capturing = false;

  /**
   * qpdf prefixes every message with argv[0], and this build ignores the `thisProgram` option —
   * so what a reader would otherwise be shown is "this.program: invalid password" in the app and
   * "forks.js: invalid password" under vitest. Neither is anything to do with them.
   *
   * The prefix is stripped here, once, rather than in every place a message might be displayed;
   * so is the run's own directory, which is an implementation detail of `run()`.
   */
  private collect(line: string): void {
    const clean = line.replace(PROGRAM_PREFIX, '').replace(/\/run\d+\//g, '');
    if (this.capturing) this.lines.push(clean);
    // Nothing should reach here — qpdf says nothing except while running — but swallowing it
    // would make a future surprise invisible.
    else console.warn(`qpdf: ${clean}`);
  }

  /**
   * Runs one qpdf command.
   *
   * **A fresh module every time, and that is not wasteful — it is the only thing that works.**
   * qpdf is a command-line program, and `main` returning means `exit()`: the runtime is torn down,
   * and calling `callMain` a second time on the same instance runs a program that has already
   * ended. Node survives that and returns nonsense; a Chromium renderer does not survive it at
   * all — the whole process dies with no exception to catch, taking the window with it. So each
   * run gets its own instance, exactly as each invocation of a real `qpdf` would be its own
   * process. It costs about 40 ms, once per save.
   *
   * Runs are serialised for the same reason `create` exists: the console swap it performs is
   * global, so two overlapping runs would collect each other's output.
   *
   * `inputs` are written into a private directory before the run and `outputs` are read back
   * after it; both are named without a path and this method supplies one, so a caller cannot
   * accidentally reach another run's files. Everything is deleted before returning, including
   * when the command failed.
   */
  run(
    args: ReadonlyArray<string>,
    inputs: Readonly<Record<string, Uint8Array>>,
    outputs: ReadonlyArray<string> = [],
  ): Promise<QpdfRun> {
    const next = this.queue.then(
      () => this.runNow(args, inputs, outputs),
      () => this.runNow(args, inputs, outputs),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runNow(
    args: ReadonlyArray<string>,
    inputs: Readonly<Record<string, Uint8Array>>,
    outputs: ReadonlyArray<string>,
  ): Promise<QpdfRun> {
    const module = await this.create();
    const dir = `/run${String(++nextRun)}`;
    const fs = module.FS;
    fs.mkdir(dir);
    this.lines = [];
    this.capturing = true;
    try {
      for (const [name, bytes] of Object.entries(inputs)) fs.writeFile(`${dir}/${name}`, bytes);
      const argv = args.map((a) => (isFileArg(a, inputs, outputs) ? `${dir}/${a}` : a));
      let code: number;
      try {
        code = module.callMain([...argv]);
      } catch (error) {
        // Emscripten throws `ExitStatus` when the program calls exit(); anything else is a crash.
        const status = (error as { status?: number }).status;
        if (typeof status !== 'number') throw error;
        code = status;
      }
      // Which outputs the command actually produced. `readdir` rather than a stat per name
      // because this build of Emscripten does not export `analyzePath`, and a missing output is
      // an ordinary result — qpdf writes nothing when it refuses.
      const produced = new Set(fs.readdir(dir));
      const files = new Map<string, Uint8Array>();
      for (const name of outputs) {
        if (!produced.has(name)) continue;
        // The copy matters: MEMFS hands back a view into the heap, which the next run reuses.
        files.set(name, Uint8Array.from(fs.readFile(`${dir}/${name}`)));
      }
      return { code, output: this.lines.join('\n'), files };
    } finally {
      this.capturing = false;
      this.lines = [];
      wipe(fs, dir);
    }
  }

  /** Runs a command and throws a worded {@link SecurityError} when it did not work. */
  async expect(
    args: ReadonlyArray<string>,
    inputs: Readonly<Record<string, Uint8Array>>,
    outputs: ReadonlyArray<string> = [],
  ): Promise<QpdfRun> {
    const run = await this.run(args, inputs, outputs);
    if (run.code !== QPDF_OK && run.code !== QPDF_WARNINGS) {
      throw new SecurityError(classify(run.output), messageFor(run.output), run.output);
    }
    return run;
  }

  /** qpdf's version string, e.g. `"12.2.0"`. For the About box and the tests. */
  async version(): Promise<string> {
    const run = await this.run(['--version'], {});
    return /version (\d+\.\d+\.\d+)/.exec(run.output)?.[1] ?? 'unknown';
  }
}

/** True when this argument names one of the files we placed, so it needs the run's directory. */
function isFileArg(
  arg: string,
  inputs: Readonly<Record<string, Uint8Array>>,
  outputs: ReadonlyArray<string>,
): boolean {
  return Object.prototype.hasOwnProperty.call(inputs, arg) || outputs.includes(arg);
}

/** Deletes a run's directory and everything in it. Never throws: this runs in a `finally`. */
function wipe(fs: EmscriptenFs, dir: string): void {
  try {
    for (const name of fs.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      try {
        fs.unlink(`${dir}/${name}`);
      } catch {
        // A directory, or already gone. Nothing useful to do either way.
      }
    }
    fs.rmdir(dir);
  } catch {
    // The run failed before the directory existed.
  }
}

/** Turns qpdf's message into one of our codes, so callers can offer the right next step. */
export function classify(output: string): SecurityErrorCode {
  if (/invalid password/i.test(output)) return 'wrong-password';
  if (/is encrypted|password.*required/i.test(output)) return 'password-required';
  if (/unable to (find|read).*(xref|trailer)|not a pdf file|damaged/i.test(output)) {
    return 'damaged';
  }
  return 'failed';
}

/** qpdf's warnings, as lines a reader can act on. Exported because it is a parser, not a policy. */
export function warningsFrom(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => /^WARNING/i.test(line.trim()))
    .map((line) => line.replace(/^\s*WARNING:\s*/i, '').trim())
    .filter((line) => line !== '');
}

/** qpdf's first real complaint, said the way a reader would want to hear it. */
export function messageFor(output: string): string {
  switch (classify(output)) {
    case 'wrong-password':
      return 'That password did not open the file.';
    case 'password-required':
      return 'The file is protected and needs a password.';
    case 'damaged':
      return 'The file is damaged and could not be read.';
    default: {
      const line = output
        .split('\n')
        .map((l) => l.replace(/^qpdf:\s*/, '').trim())
        .find((l) => l !== '' && !l.startsWith('WARNING'));
      return line ?? 'The file could not be processed.';
    }
  }
}
